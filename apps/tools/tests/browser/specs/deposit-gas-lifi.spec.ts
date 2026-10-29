/** The LI.FI gas venue through the SDK, on the bundle whose manifest lists no swapper (served under `/lifi/`), as
 *  mainnet's lists none: li.quest answers from the recorded mainnet quote, re-encoded for the sandbox, and the router
 *  calls the swapper standing in for LI.FI's Diamond. */
import { balanceOf, fuelSwapperOf, mint } from "@unleashed/bridge-core/sandbox"
import { type Hex, parseAbi, parseEventLogs } from "viem"
import { TESTIDS } from "../../../src/lib/testids"
import { RECORDED_TRANSACTION_ID } from "../fixtures/lifi-quote"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { depositRecords, fuelConservation } from "../pages/journal"
import { confirmReview, connectL1, openSend, reviewDeposit, setVisibility, startDeposit, waitForReceipt } from "../pages/send"

test.use({ family: "deposit-gas-lifi", cells: 3, l1Index: 10, lifiQuote: "recorded" })

const LIFI_BUNDLE = "/lifi/"
const L1 = 31337
const USDC = 10n ** 6n
/** The swapper's rate for the fixture's 6-decimal tokens: one base unit buys this many FJ-wei. */
const RATE = 10n ** 12n
const SWAPPED = parseAbi([
	"event Swapped(bytes32 indexed transactionId, address indexed token, address indexed receiver, uint256 amountIn, uint256 out)",
])

test("cell A — the review names LI.FI's venue, and a gas-only send through its quote settles", async ({
	page,
	sandbox,
	actor,
	l1,
	egress,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 30n * USDC)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")

	await page.goto(LIFI_BUNDLE)
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "30", intent: "gas", isPrivate: false })
	await page.locator(tid(TESTIDS.sendReviewDetailsToggle)).click()
	await expect(page.locator(tid(TESTIDS.sendReviewRoute))).toContainText("through LI.FI (sushiswap)")
	await confirmReview(page)
	const receipt = await waitForReceipt(page)
	expect(receipt.hero, "a gas-only receipt's hero is the Fee Juice row").toContain("FJ")

	// The swap the router ran is the quote li.quest answered: the swapper echoes the recorded call's id.
	const rec = (await depositRecords(page)).at(-1)
	const deposit = await sandbox.clients.l1.pub.getTransactionReceipt({ hash: rec?.depositTxHash as Hex })
	const swaps = parseEventLogs({ abi: SWAPPED, logs: deposit.logs }).filter(
		(l) => l.address.toLowerCase() === fuelSwapperOf(sandbox).toLowerCase(),
	)
	expect(swaps.map((l) => l.args.transactionId)).toEqual([RECORDED_TRANSACTION_ID])
	expect(egress.quoted.length, "the probe and the signing re-quote both asked li.quest").toBeGreaterThanOrEqual(2)

	const { received, fee } = await fuelConservation(page, actor.s.l2.node)
	expect(received, "the stand-in pays at its fixed rate").toBe(30n * USDC * RATE)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")).toBe(fjBefore + received - fee)
})

test("cell B — a quote aimed at another contract leaves the gas route blocked, so the review cannot offer gas", async ({
	page,
	sandbox,
	actor,
	l1,
	egress,
	lifi,
}) => {
	lifi.set("hostile")
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 30n * USDC)

	await page.goto(LIFI_BUNDLE)
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await startDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "30" })
	await setVisibility(page, false)
	await expect(page.locator(tid(TESTIDS.sendRouteStatus))).toHaveAttribute("data-route", "no-route", { timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.sendChoiceTokenGas))).toBeDisabled()
	await expect(page.locator(tid(TESTIDS.sendChoiceGas))).toBeDisabled()
	expect(egress.quoted.length, "the route was asked for, and refused").toBeGreaterThan(0)
})

test("cell C — a quote that turns hostile after the review is refused at the signature's re-quote, before any prompt", async ({
	page,
	sandbox,
	actor,
	l1,
	lifi,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 30n * USDC)

	await page.goto(LIFI_BUNDLE)
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "30", intent: "gas", isPrivate: false })
	lifi.set("hostile")
	await expect(confirmReview(page)).rejects.toThrow(/The gas price moved since you reviewed this send/)
	for (const method of ["eth_signTypedData_v4", "eth_sendTransaction"]) {
		expect(l1.calls(method), `${method} never reached the Ethereum wallet`).toBe(0)
	}
	expect(await depositRecords(page), "a send refused before its signature leaves no row").toEqual([])
})
