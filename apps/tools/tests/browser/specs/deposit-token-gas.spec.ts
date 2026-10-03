/** Token + gas deposits (cells 13–17): the fueled claim pays for itself, and what that leaves alone. */
import {
	balanceOf,
	freshToken,
	fundPublicFeeJuice,
	mint,
	mintPrivateGasNote,
	privateCreditOf,
	privateFpc,
	setRoutable,
} from "@unleashed/bridge-core/sandbox"
import { ownGasTxs } from "@unleashed/bridge-core"
import { getAddress } from "viem"
import { trimAddress } from "../../../src/lib/format"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { keptFor } from "../pages/fees"
import { depositCalldata, depositRecords, fuelConservation } from "../pages/journal"
import { confirmReview, connectL1, openSend, reviewDeposit, setVisibility, startDeposit, waitForReceipt } from "../pages/send"

test.use({ family: "deposit-token-gas", cells: 7, l1Index: 4 })

const USDC = 10n ** 6n
const FJ = 10n ** 18n
const L1 = 31337

test("cell 13 — plain, public, nothing held: the claim pays from the fuel the same send bridged", async ({ page, sandbox, actor, l1 }) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const usdtL2 = await actor.l2TokenOf(usdt)
	const before = await balanceOf(usdtL2, actor.actor.address, "public")
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await expect(page.locator(tid(TESTIDS.sendReviewGas))).toBeVisible()
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.gas, "the receipt carries the gas leg").not.toBeNull()
	expect(receipt.from, "From is the L1 account the send was recorded from").toBe(`Ethereum · ${trimAddress(getAddress(l1.address))}`)

	const gained = (await balanceOf(usdtL2, actor.actor.address, "public")) - before
	expect(gained, "the token leg arrived, minus the slice that became gas").toBeGreaterThan(0n)
	expect(gained).toBeLessThan(100n * USDC)
	const { received, fee } = await fuelConservation(page, actor.s.l2.node)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "public FJ = the fuel minus the claim's own fee").toBe(
		fjBefore + received - fee,
	)
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "no credit was minted or spent").toBe(0n)

	// One permit for the WHOLE amount (token leg + the slice that became gas), bound to the router
	// and to the exact nonce + deadline the bridgeWithFuel call then carried.
	const permits = l1.permits()
	expect(permits, "exactly one permit was signed").toHaveLength(1)
	const permit = permits[0]
	const router = (sandbox.manifest.bridge?.l1.router ?? "").toLowerCase()
	expect(permit.spender.toLowerCase()).toBe(router)
	expect(permit.permitted.token.toLowerCase()).toBe(usdt.erc20.toLowerCase())
	expect(permit.permitted.amount).toBe(100n * USDC)
	expect(permit.deadline).toBeGreaterThan(BigInt(permit.signedAt))
	const calldata = await depositCalldata(sandbox.clients.l1.pub, (await depositRecords(page)).at(-1)?.depositTxHash ?? "")
	expect(calldata.functionName).toBe("bridgeWithFuel")
	expect(calldata.to).toBe(router)
	expect(calldata.nonce).toBe(permit.nonce)
	expect(calldata.deadline).toBe(permit.deadline)
	expect(calldata.amount).toBe(100n * USDC)
})

test("cell 13b — selfpay, public FJ held: conservation, after = before + claimed − the fee charged", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "selfpay", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.gas).not.toBeNull()

	const { received, fee } = await fuelConservation(page, actor.s.l2.node)
	expect(received).toBeGreaterThan(0n)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")).toBe(fjBefore + received - fee)
})

test("cell 14 — plain, public, credit held: the fueled claim leaves the credit untouched", async ({ page, sandbox, actor, l1 }) => {
	const { usdt } = sandbox.tokens
	const fpc = await privateFpc(actor.s)
	await mintPrivateGasNote(actor.s, fpc, FJ / 10n)
	const creditBefore = await privateCreditOf(actor.s, fpc)
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await confirmReview(page)
	await waitForReceipt(page)

	const { received, fee } = await fuelConservation(page, actor.s.l2.node)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")).toBe(fjBefore + received - fee)
	expect(await privateCreditOf(actor.s, fpc), "the credit was never a payer").toBe(creditBefore)
})

test("cell 15 — plain, private: the fuel becomes credit at the FPC, which pays the private claim", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const usdtL2 = await actor.l2TokenOf(usdt)
	const before = await balanceOf(usdtL2, actor.actor.address, "private")
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: true })
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.gas).not.toBeNull()
	// The gas row is the gross quote; the kept ceiling below is what comes out of it.
	expect(receipt.gas).toContain("before claim fees")
	expect(receipt.gas).not.toContain("you got")
	// Labels live in the row's `dt`, so only the whole receipt can show a regressed one.
	expect(receipt.text).toContain("Gas bridged")
	for (const label of ["Gas ready", "Gas used"]) expect(receipt.text).not.toContain(label)

	const gained = (await balanceOf(usdtL2, actor.actor.address, "private")) - before
	expect(gained, "the token leg arrived privately, minus the slice that became gas").toBeGreaterThan(0n)
	expect(gained).toBeLessThan(100n * USDC)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "nothing public was touched").toBe(fjBefore)
	const { received } = await fuelConservation(page, actor.s.l2.node)
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: (await depositRecords(page)).at(-1)?.claimTxHash, gas: ownGasTxs({ isPrivate: true, registers: false }).claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "credit = the fuel minus exactly the claim's ceiling").toBe(
		received - kept,
	)
})

test("cell 15b — selfpay, private, public FJ held: the private fence leaves it untouched", async ({ page, sandbox, actor, l1, run }) => {
	const { usdt } = sandbox.tokens
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "selfpay", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: true })
	await confirmReview(page)
	await waitForReceipt(page)

	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "a private claim never pays from public Fee Juice").toBe(
		fjBefore,
	)
	const { received } = await fuelConservation(page, actor.s.l2.node)
	const kept = await keptFor(page, run, "selfpay", actor, [
		{ hash: (await depositRecords(page)).at(-1)?.claimTxHash, gas: ownGasTxs({ isPrivate: true, registers: false }).claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s))).toBe(received - kept)
})

test("cell 16 — plain, private, first-time token: registration, then the credit-paid claim", async ({ page, sandbox, actor, l1, run }) => {
	const erc20 = await freshToken(sandbox.clients.l1, { name: "Fresh Fueled", symbol: "FRSHG", decimals: 6 }, [l1.address], 1000n * USDC)
	await setRoutable(sandbox.clients.l1, sandbox.clients.deployment.quoter, erc20)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20, amount: "100", intent: "token+gas", isPrivate: true, viaLookup: true })
	await expect(page.locator(tid(TESTIDS.sendReviewFirstTime))).toBeVisible()
	await confirmReview(page)
	await waitForReceipt(page)
	const record = (await depositRecords(page)).at(-1)
	expect(record?.registerTxHash, "a private first-time token registers in a transaction of its own").toBeTruthy()
	expect(record?.claimTxHash, "then claims").toBeTruthy()
	const { received } = await fuelConservation(page, actor.s.l2.node)
	const txs = ownGasTxs({ isPrivate: true, registers: true })
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: record?.registerTxHash, gas: txs.register },
		{ hash: record?.claimTxHash, gas: txs.claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "credit = the fuel minus the register + claim ceilings").toBe(
		received - kept,
	)
	// The token leg is the record's amount (the send minus the slice that became gas), delivered whole.
	expect(record?.token?.erc20.toLowerCase()).toBe(erc20.toLowerCase())
	const freshL2 = await actor.s.l2TokenOf(record?.token as never)
	expect(await balanceOf(freshL2, actor.actor.address, "private"), "the token leg arrived privately, whole").toBe(
		BigInt(record?.amount ?? "0"),
	)
	expect(BigInt(record?.amount ?? "0")).toBeGreaterThan(0n)
})

test("cell 17 — the slice under the claim minimum is refused at the amount step, nothing signed", async ({ page, sandbox, actor, l1 }) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	// One USDT buys one FJ on the venue; half of it as gas is under the network's 1 FJ claim minimum.
	await startDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "1" })
	await setVisibility(page, false)
	await page.locator(tid(TESTIDS.sendChoiceTokenGas)).click()
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).not.toHaveAttribute("data-route-loading", "true", { timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.sendGasBreakdown))).toContainText("minimum a claim needs")
	await expect(page.locator(tid(TESTIDS.sendAmountNext))).toBeDisabled()
	expect(l1.signatures).toBe(0)
})
