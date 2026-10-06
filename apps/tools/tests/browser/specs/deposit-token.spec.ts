/** Token-only deposits (cells 1–6): what pays the claim, and what the wallet's shape changes about it. */
import {
	balanceOf,
	freshToken,
	fundPublicFeeJuice,
	mint,
	mintPrivateGasNote,
	privateCreditOf,
	privateFpc,
	fuelSwapperOf,
	setFuelRate,
} from "@unleashed/bridge-core/sandbox"
import { ownGasTxs } from "@unleashed/bridge-core"
import { TESTIDS } from "../../../src/lib/testids"
import { type ActorHandle, expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { keptFor, walletCeiling } from "../pages/fees"
import { depositCalldata, depositRecords } from "../pages/journal"
import { confirmReview, connectL1, newSend, openSend, reviewDeposit, waitForReceipt } from "../pages/send"

test.use({ family: "deposit-token", cells: 6, l1Index: 2 })

const USDC = 10n ** 6n
const FJ = 10n ** 18n
const L1 = 31337

/** What the FPC keeps for a claim of this shape — the wallet's pricing, which the app reads the same way. */
const ceilingOf = walletCeiling

/** One credit note sized to `multiple` claim ceilings, so the FPC has something to keep. */
async function fundCredit(actor: ActorHandle, amount: bigint): Promise<bigint> {
	const fpc = await privateFpc(actor.s)
	await mintPrivateGasNote(actor.s, fpc, amount)
	return privateCreditOf(actor.s, fpc)
}

test("cell 1 — plain, public, registered token: the claim is paid from one private credit note", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const { usdc } = sandbox.tokens
	const ceiling = await ceilingOf(actor, { isPrivate: false, registers: false })
	// Funded to the ceiling EXACTLY: the wizard's gate must price the claim from the same clamped
	// limits the claim is submitted under, or a claim the FPC would accept is refused on screen.
	const creditBefore = await fundCredit(actor, (ceiling * 14n) / 10n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	const usdcL2 = await actor.l2TokenOf(usdc)
	const usdcBefore = await balanceOf(usdcL2, actor.actor.address, "public")
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: false })
	await confirmReview(page)
	await expect(page.locator(`${tid(TESTIDS.stepper)} ${tid(TESTIDS.stepperLog)} p`).first()).toBeVisible()
	const receipt = await waitForReceipt(page)
	expect(receipt.gas).toBeNull()

	expect(await balanceOf(usdcL2, actor.actor.address, "public")).toBe(usdcBefore + 10n * USDC)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "no public Fee Juice was touched").toBe(fjBefore)
	const record = (await depositRecords(page)).at(-1)
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: record?.claimTxHash, gas: ownGasTxs({ isPrivate: false, registers: false }).claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "the FPC kept the claim's ceiling").toBe(creditBefore - kept)

	// The one Permit2 signature names the router as spender, the ERC-20 and the whole amount, and
	// the nonce + deadline the deposit transaction then carried — the drain shape, pinned.
	const permits = l1.permits()
	expect(permits, "exactly one permit was signed").toHaveLength(1)
	const permit = permits[0]
	const router = (sandbox.manifest.bridge?.l1.depositRouter ?? "").toLowerCase()
	expect(permit.spender.toLowerCase()).toBe(router)
	expect(permit.permitted.token.toLowerCase()).toBe(usdc.erc20.toLowerCase())
	expect(permit.permitted.amount).toBe(10n * USDC)
	expect(permit.deadline).toBeGreaterThan(BigInt(permit.signedAt))
	const calldata = await depositCalldata(sandbox.clients.l1.pub, record?.depositTxHash ?? "")
	expect(calldata.functionName).toBe("bridgeWithPermit")
	expect(calldata.to).toBe(router)
	expect(calldata.fuelSlice).toBe(0n)
	expect(calldata.swapData).toBe("0x")
	expect(calldata.nonce).toBe(permit.nonce)
	expect(calldata.deadline).toBe(permit.deadline)
	expect(calldata.bridgeToken).toBe(usdc.erc20.toLowerCase())
	expect(calldata.amount).toBe(10n * USDC)
})

test("cell 2 — plain, private, registered token: the private claim is paid from credit", async ({ page, sandbox, actor, l1, run }) => {
	const { usdc } = sandbox.tokens
	const ceiling = await ceilingOf(actor, { isPrivate: true, registers: false })
	const creditBefore = await fundCredit(actor, (ceiling * 14n) / 10n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	const usdcL2 = await actor.l2TokenOf(usdc)
	const privateBefore = await balanceOf(usdcL2, actor.actor.address, "private")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: true })
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.gas).toBeNull()

	expect(await balanceOf(usdcL2, actor.actor.address, "private")).toBe(privateBefore + 10n * USDC)
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: (await depositRecords(page)).at(-1)?.claimTxHash, gas: ownGasTxs({ isPrivate: true, registers: false }).claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "the FPC kept the private claim's ceiling").toBe(creditBefore - kept)
})

test("cell 3 — plain, public, first-time token from credit: register + claim, then a cheaper second send", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const erc20 = await freshToken(sandbox.clients.l1, { name: "Fresh Public", symbol: "FRSHP", decimals: 6 }, [l1.address], 1000n * USDC)
	await setFuelRate(sandbox.clients.l1, fuelSwapperOf(sandbox), erc20)
	const first = await ceilingOf(actor, { isPrivate: false, registers: true })
	const second = await ceilingOf(actor, { isPrivate: false, registers: false })
	expect(first).toBeGreaterThan(second)
	const creditBefore = await fundCredit(actor, ((first + second) * 12n) / 10n)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20, amount: "10", intent: "token", isPrivate: false, viaLookup: true })
	await expect(page.locator(tid(TESTIDS.sendReviewFirstTime)), "the review says this send registers the token").toBeVisible()
	await confirmReview(page)
	await waitForReceipt(page)
	const record = (await depositRecords(page)).at(-1)
	expect(record?.claimTxHash, "the claim landed").toBeTruthy()
	expect(record?.registerTxHash, "a public first-time token registers inside its claim, not in a transaction of its own").toBeUndefined()
	const fpc = await privateFpc(actor.s)
	const afterFirst = await privateCreditOf(actor.s, fpc)
	const keptFirst = await keptFor(page, run, "plain", actor, [
		{ hash: record?.claimTxHash, gas: ownGasTxs({ isPrivate: false, registers: true }).claim },
	])
	expect(afterFirst, "the FPC kept the register + claim ceiling").toBe(creditBefore - keptFirst)
	// The block the send read back from the factory names the token it registered: its L2 balance is
	// the exact amount, twice over.
	expect(record?.token?.erc20.toLowerCase()).toBe(erc20.toLowerCase())
	const freshL2 = await actor.s.l2TokenOf(record?.token as never)
	expect(await balanceOf(freshL2, actor.actor.address, "public"), "the whole amount arrived").toBe(10n * USDC)

	await newSend(page)
	await reviewDeposit(page, { l1ChainId: L1, erc20, amount: "10", intent: "token", isPrivate: false })
	await expect(page.locator(tid(TESTIDS.sendReviewFirstTime))).toHaveCount(0)
	await confirmReview(page)
	await waitForReceipt(page)
	const keptSecond = await keptFor(page, run, "plain", actor, [
		{ hash: (await depositRecords(page)).at(-1)?.claimTxHash, gas: ownGasTxs({ isPrivate: false, registers: false }).claim },
	])
	expect(keptSecond, "a plain claim is the smaller ceiling").toBeLessThan(keptFirst)
	expect(await privateCreditOf(actor.s, fpc), "the second send is a plain claim at the smaller ceiling").toBe(afterFirst - keptSecond)
	expect(await balanceOf(freshL2, actor.actor.address, "public")).toBe(20n * USDC)
})

test("cell 4 — plain, private, first-time token from credit: a registration of its own, then the claim", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const erc20 = await freshToken(sandbox.clients.l1, { name: "Fresh Private", symbol: "FRSHV", decimals: 6 }, [l1.address], 1000n * USDC)
	await setFuelRate(sandbox.clients.l1, fuelSwapperOf(sandbox), erc20)
	const ceiling = await ceilingOf(actor, { isPrivate: true, registers: true })
	const creditBefore = await fundCredit(actor, (ceiling * 14n) / 10n)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20, amount: "10", intent: "token", isPrivate: true, viaLookup: true })
	await expect(page.locator(tid(TESTIDS.sendReviewFirstTime))).toBeVisible()
	await confirmReview(page)
	await waitForReceipt(page)
	const record = (await depositRecords(page)).at(-1)
	expect(record?.registerTxHash, "a private first-time token registers in a transaction of its own").toBeTruthy()
	expect(record?.claimTxHash, "then claims").toBeTruthy()
	const txs = ownGasTxs({ isPrivate: true, registers: true })
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: record?.registerTxHash, gas: txs.register },
		{ hash: record?.claimTxHash, gas: txs.claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "the FPC kept the register + claim ceiling").toBe(creditBefore - kept)
	expect(record?.token?.erc20.toLowerCase()).toBe(erc20.toLowerCase())
	const freshL2 = await actor.s.l2TokenOf(record?.token as never)
	expect(await balanceOf(freshL2, actor.actor.address, "private"), "the whole amount arrived, privately").toBe(10n * USDC)
})

test("cell 5 — selfpay, public, registered token: the claim is paid from held public Fee Juice", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")
	const usdcL2 = await actor.l2TokenOf(usdc)
	const usdcBefore = await balanceOf(usdcL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "selfpay", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: false })
	await expect(page.locator(tid(TESTIDS.sendReviewNetworkFee))).toContainText("Fee Juice you already hold")
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.gas).toBeNull()

	expect(await balanceOf(usdcL2, actor.actor.address, "public")).toBe(usdcBefore + 10n * USDC)
	const fjAfter = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")
	expect(fjAfter, "the claim's fee came out of the held public Fee Juice").toBeLessThan(fjBefore)
	expect(fjAfter, "and only the fee").toBeGreaterThan(fjBefore - FJ / 100n)
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "no credit existed and none was minted").toBe(0n)
})

test("cell 6 — plain, public FJ held AND credit: the wallet lacks the feature, so credit pays and the public FJ is untouched", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const { usdc } = sandbox.tokens
	const ceiling = await ceilingOf(actor, { isPrivate: false, registers: false })
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	const creditBefore = await fundCredit(actor, (ceiling * 14n) / 10n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: false })
	await expect(page.locator(tid(TESTIDS.sendReviewNetworkFee))).toContainText("private gas you already hold")
	await confirmReview(page)
	await waitForReceipt(page)

	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "the public Fee Juice was never a payer").toBe(fjBefore)
	const kept = await keptFor(page, run, "plain", actor, [
		{ hash: (await depositRecords(page)).at(-1)?.claimTxHash, gas: ownGasTxs({ isPrivate: false, registers: false }).claim },
	])
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "the FPC kept the claim's ceiling").toBe(creditBefore - kept)
})
