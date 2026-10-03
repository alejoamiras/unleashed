/** Exits (cells 27–31): who pays the burn, what the credit covers, and what stops one before any authwit. */
import {
	balanceOf,
	erc20BalanceOf,
	flowPrivateDeposit,
	flowPublicDeposit,
	fundPublicFeeJuice,
	mintPrivateGasNote,
	privateCreditOf,
	privateFpc,
	readHandle,
	writeL1,
} from "@unleashed/bridge-core/sandbox"
import { PRIVATE_HUB_EXIT_GAS } from "@unleashed/bridge-core"
import { parseAbi } from "viem"
import { trimAddress } from "../../../src/lib/format"
import { TESTIDS } from "../../../src/lib/testids"
import type { RunEnv } from "../env"
import { type ActorHandle, expect, test } from "../fixtures/test"
import { connectAztec, driveToConnected, tid, walletCalls, walletFrame } from "../pages/connect"
import { reviewExit, startExit } from "../pages/exit"
import { keptFor, walletExitCeiling } from "../pages/fees"
import { exitRecords } from "../pages/journal"
import { confirmReview, connectL1, openSend, waitForReceipt } from "../pages/send"

test.use({ family: "exits", cells: 8, l1Index: 3 })

const USDC = 10n ** 6n
const FJ = 10n ** 18n
const L1 = 31337
const SET_PAUSED_ABI = parseAbi(["function setPaused(bool deposits, bool withdraws)"])

/** An actor holding USDC on L2, deposited through the harness (the sponsor pays that scaffolding). */
async function holding(
	actor: ActorHandle,
	sandbox: { tokens: { usdc: import("@unleashed/bridge-core").ManifestToken } },
	kind: "public" | "private",
) {
	const { usdc } = sandbox.tokens
	const l2Token = await actor.l2TokenOf(usdc)
	if (kind === "public") await flowPublicDeposit(actor.s, usdc, l2Token)
	else await flowPrivateDeposit(actor.s, usdc, l2Token)
	return { usdc, l2Token }
}

async function connect(page: import("@playwright/test").Page, actor: ActorHandle) {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
}

test("cell 27 — a public exit: the authwit and the exit are paid by the wallet's default, the actor's public Fee Juice; L1 releases", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc, l2Token } = await holding(actor, sandbox, "public")
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")
	const l2Before = await balanceOf(l2Token, actor.actor.address, "public")
	const l1Before = await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address)

	await connect(page, actor)
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", isPrivate: false })
	await confirmReview(page)
	const receipt = await waitForReceipt(page, 10 * 60_000)
	expect(receipt.hero).toContain("10")
	// Aztec addresses carry no checksum casing, so the comparison ignores case.
	expect(receipt.from?.toLowerCase(), "From is the Aztec account the exit was recorded from").toBe(
		`aztec · ${trimAddress(actor.address).toLowerCase()}`,
	)

	expect(await balanceOf(l2Token, actor.actor.address, "public")).toBe(l2Before - 10n * USDC)
	expect(await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address), "L1 released the burn").toBe(
		l1Before + 10n * USDC,
	)
	const fjAfter = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")
	expect(fjAfter, "two transactions were paid from the held public Fee Juice").toBeLessThan(fjBefore)
	expect(await privateCreditOf(actor.s, await privateFpc(actor.s)), "no credit was involved").toBe(0n)
})

test("cell 28 — a private exit from one credit note, then from three notes none of which covers the ceiling", async ({
	page,
	sandbox,
	actor,
	l1,
	run,
}) => {
	const { usdc, l2Token } = await holding(actor, sandbox, "private")
	const fpc = await privateFpc(actor.s)
	const ceiling = await walletExitCeiling(actor)
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 14n) / 10n)
	const creditBefore = await privateCreditOf(actor.s, fpc)
	const l2Before = await balanceOf(l2Token, actor.actor.address, "private")
	const l1Before = await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address)

	await connect(page, actor)
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "5", isPrivate: true })
	await confirmReview(page)
	await waitForReceipt(page, 10 * 60_000)
	const keptOne = await keptFor(page, run, "plain", actor, [
		{ hash: (await exitRecords(page)).at(-1)?.exitTxHash, gas: PRIVATE_HUB_EXIT_GAS },
	])
	expect(await privateCreditOf(actor.s, fpc), "the FPC kept the exit's ceiling from the one note").toBe(creditBefore - keptOne)
	expect(await balanceOf(l2Token, actor.actor.address, "private"), "the burn left the private balance").toBe(l2Before - 5n * USDC)
	expect(await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address)).toBe(l1Before + 5n * USDC)

	// Two more notes of 0.45× beside the ≈0.4× change: no note and no pair covers, so pay_fee selects all three.
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 45n) / 100n)
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 45n) / 100n)
	const creditMid = await privateCreditOf(actor.s, fpc)
	await page.locator(tid(TESTIDS.receiptNewBridge)).click()
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "5", isPrivate: true })
	await confirmReview(page)
	await waitForReceipt(page, 10 * 60_000)
	const keptThree = await keptFor(page, run, "plain", actor, [
		{ hash: (await exitRecords(page)).at(-1)?.exitTxHash, gas: PRIVATE_HUB_EXIT_GAS },
	])
	expect(await privateCreditOf(actor.s, fpc), "three notes paid one ceiling").toBe(creditMid - keptThree)
	expect(await balanceOf(l2Token, actor.actor.address, "private"), "a second burn").toBe(l2Before - 10n * USDC)
	expect(await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address), "L1 released both").toBe(
		l1Before + 10n * USDC,
	)
})

test("cell 31b — the wallet sends the private exit but the page never hears back: the reloaded row's FINISH attaches the exit and finishes it, never a second burn", async ({
	page,
	sandbox,
	actor,
	run,
	l1,
}) => {
	const { usdc, l2Token } = await holding(actor, sandbox, "private")
	const fpc = await privateFpc(actor.s)
	const ceiling = await walletExitCeiling(actor)
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 14n) / 10n)
	const creditBefore = await privateCreditOf(actor.s, fpc)
	const l2Before = await balanceOf(l2Token, actor.actor.address, "private")
	const hub = sandbox.manifest.bridge?.l2.hub.address ?? ""
	expect(hub).not.toBe("")

	// The attach matches on the recomputed message alone (hub → portal, recipient, amount): an exit of
	// the same amount to the same L1 address from ANOTHER cell in this file would be a second match.
	// Each attach cell exits an amount no other cell uses.
	await connect(page, actor)
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "7", isPrivate: true })
	// A private exit's authwit is `createAuthWit`, so the one `sendTx` against the hub IS the exit: it
	// runs, the transaction lands, and the page never gets its hash.
	await walletFrame(page, run, "plain").evaluate((hubAddress) => window.__unleashedTestWallet!.swallowNext("sendTx", hubAddress), hub)
	await confirmReview(page)
	await expect.poll(async () => (await walletCalls(page, run, "plain")).sendTx ?? 0, { timeout: 180_000 }).toBe(1)
	await expect.poll(async () => (await exitRecords(page)).length, { timeout: 60_000 }).toBe(1)
	await expect.poll(() => balanceOf(l2Token, actor.actor.address, "private"), { timeout: 180_000 }).toBe(l2Before - 7n * USDC)
	expect((await exitRecords(page)).at(-1)?.exitTxHash, "the page never learned the hash").toBeUndefined()
	const kept = creditBefore - (await privateCreditOf(actor.s, fpc))
	expect(kept, "the FPC kept one exit's fee").toBeGreaterThan(0n)
	const submitted = await walletFrame(page, run, "plain").evaluate(() => window.__unleashedTestWallet!.submitted())
	expect(submitted.length, "the wallet reported exactly one burn").toBe(1)
	const l1Before = await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address)

	await page.reload()
	await openSend(page)
	await connectL1(page)
	await driveToConnected(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card = page.locator(tid(TESTIDS.journalCard)).first()
	await expect(card).toBeVisible()
	await expect(card).toHaveAttribute("data-stage", "exiting")
	await expect(card.locator(tid(TESTIDS.journalStage))).toContainText("look for it on Aztec")
	// Nothing ran on its own after the reload: no second authwit, no second burn, the credit charged once.
	const calls = await walletCalls(page, run, "plain")
	expect(calls.sendTx ?? 0).toBe(0)
	expect(calls.createAuthWit ?? 0).toBe(0)

	await card.locator(tid(TESTIDS.journalFinish)).click()
	// The card is re-keyed onto the exit hash: the same element now carries the found transaction.
	await expect(page.locator(tid(TESTIDS.journalCard)).first()).toHaveAttribute("data-id", submitted[0].hash, { timeout: 120_000 })
	await expect(page.locator(tid(TESTIDS.journalCard)).first()).toHaveAttribute("data-stage", "done", { timeout: 10 * 60_000 })
	const attached = (await exitRecords(page)).at(-1)
	expect(attached?.exitTxHash, "the record carries the burn the wallet reported").toBe(submitted[0].hash)
	expect(attached?.consumeTxHash).toBeTruthy()
	expect(await erc20BalanceOf(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address), "L1 released the burn once").toBe(
		l1Before + 7n * USDC,
	)
	expect(await balanceOf(l2Token, actor.actor.address, "private"), "no second burn").toBe(l2Before - 7n * USDC)
	expect(creditBefore - (await privateCreditOf(actor.s, fpc)), "the credit was charged once").toBe(kept)
	const after = await walletCalls(page, run, "plain")
	expect(after.sendTx ?? 0).toBe(0)
	expect(after.createAuthWit ?? 0).toBe(0)
})

test("cell 31c — two tabs press FINISH on the same swallowed exit: one attaches and consumes, the other is told a tab is finishing it, one portal transaction", async ({
	page,
	sandbox,
	actor,
	run,
	l1,
}) => {
	const { usdc, l2Token } = await holding(actor, sandbox, "private")
	const fpc = await privateFpc(actor.s)
	const ceiling = await walletExitCeiling(actor)
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 14n) / 10n)
	const l2Before = await balanceOf(l2Token, actor.actor.address, "private")
	const hub = sandbox.manifest.bridge?.l2.hub.address ?? ""
	expect(hub).not.toBe("")

	// The attach matches on the recomputed message alone (hub → portal, recipient, amount): an exit of
	// the same amount to the same L1 address from ANOTHER cell in this file would be a second match.
	// Each attach cell exits an amount no other cell uses.
	await connect(page, actor)
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "9", isPrivate: true })
	await walletFrame(page, run, "plain").evaluate((hubAddress) => window.__unleashedTestWallet!.swallowNext("sendTx", hubAddress), hub)
	await confirmReview(page)
	await expect.poll(async () => (await walletCalls(page, run, "plain")).sendTx ?? 0, { timeout: 180_000 }).toBe(1)
	await expect.poll(() => balanceOf(l2Token, actor.actor.address, "private"), { timeout: 180_000 }).toBe(l2Before - 9n * USDC)
	const submitted = await walletFrame(page, run, "plain").evaluate(() => window.__unleashedTestWallet!.submitted())
	const portal = (await exitRecords(page)).at(-1)?.portal ?? ""
	expect(portal).not.toBe("")
	const sendsBefore = l1.calls("eth_sendTransaction")

	// Tab 1 reloads and presses FINISH with its portal transaction parked: the attach has re-keyed
	// and the consume holds the hash's lock while the wallet prompt stays open.
	await page.reload()
	await openSend(page)
	await connectL1(page)
	await driveToConnected(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card1 = page.locator(tid(TESTIDS.journalCard)).first()
	await expect(card1).toBeVisible()
	l1.holdNext("transaction", { to: portal as `0x${string}` })
	await card1.locator(tid(TESTIDS.journalFinish)).click()
	await expect(card1).toHaveAttribute("data-id", submitted[0].hash, { timeout: 120_000 })
	await expect.poll(() => l1.holdsArmed(), { timeout: 10 * 60_000 }).toBe(0)

	// Tab 2, same browser context (one journal): the re-keyed record is what it loads; FINISH
	// contends on the hash's lock and is told so.
	const page2 = await page.context().newPage()
	await page2.goto("/")
	await openSend(page2)
	await connectL1(page2)
	await driveToConnected(page2, { profile: "selfpay", account: actor.address })
	await page2.locator(tid(TESTIDS.tabActivity)).click()
	const card2 = page2.locator(tid(TESTIDS.journalCard)).first()
	await expect(card2).toHaveAttribute("data-id", submitted[0].hash)
	await card2.locator(tid(TESTIDS.journalFinish)).click()
	await expect(card2.locator(tid(TESTIDS.journalStep))).toContainText(/another tab/i, { timeout: 60_000 })

	await l1.release()
	await expect(card1).toHaveAttribute("data-stage", "done", { timeout: 10 * 60_000 })
	expect(l1.calls("eth_sendTransaction") - sendsBefore, "exactly one portal transaction across both tabs").toBe(1)
	expect(await balanceOf(l2Token, actor.actor.address, "private"), "no second burn").toBe(l2Before - 9n * USDC)
	await page2.close()
})

/** "Nothing authorized" is read from the wallet itself: an exit's authwit and its transaction are
 *  Aztec calls, which no count of Ethereum signatures can exclude. */
async function nothingSubmitted(page: import("@playwright/test").Page, run: Pick<RunEnv, "testWalletOrigins">): Promise<void> {
	const calls = await walletCalls(page, run, "plain")
	expect(calls.createAuthWit ?? 0, "no authwit was created").toBe(0)
	expect(calls.sendTx ?? 0, "no transaction was sent").toBe(0)
}

test("cell 29 — a private exit with no credit is refused on the amount step, before any authwit", async ({
	page,
	run,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc } = await holding(actor, sandbox, "private")
	await connect(page, actor)
	await startExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "5", isPrivate: true })
	const blocked = page.locator(tid(TESTIDS.sendAmountBlocked))
	await expect(blocked).toBeVisible({ timeout: 60_000 })
	await expect(blocked).toContainText("holds none at the fee contract")
	await expect(page.locator(tid(TESTIDS.sendAmountNext))).toBeDisabled()
	expect(l1.signatures).toBe(0)
	await nothingSubmitted(page, run)
})

test("cell 30 — fees that rise between the review and the confirm stand the private exit down; nothing authorized", async ({
	page,
	context,
	run,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc } = await holding(actor, sandbox, "private")
	const fpc = await privateFpc(actor.s)
	await mintPrivateGasNote(actor.s, fpc, (await walletExitCeiling(actor)) * 4n)
	const creditBefore = await privateCreditOf(actor.s, fpc)

	await connect(page, actor)
	await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "5", isPrivate: true })

	// From here the node's prediction triples: the wallet's next quote — the confirm's re-read — moves
	// the ceiling. The node client namespaces the method (`aztec_…`) and batches calls into arrays,
	// so the patch follows the request ids.
	type Rpc = { id?: unknown; method?: string }
	type Fees = { feePerDaGas: string; feePerL2Gas: string }
	type Reply = { id?: unknown; result?: Fees[] }
	const tripled = (f: Fees): Fees => ({
		feePerDaGas: (BigInt(f.feePerDaGas) * 3n).toString(),
		feePerL2Gas: (BigInt(f.feePerL2Gas) * 3n).toString(),
	})
	await context.route(`${readHandle(run.artifactsDir).nodeUrl}/**`, async (route) => {
		const body = route.request().postDataJSON() as Rpc | Rpc[] | null
		const calls = Array.isArray(body) ? body : body ? [body] : []
		const ids = new Set(calls.filter((c) => /^(aztec_|node_)?getPredictedMinFees$/.test(c.method ?? "")).map((c) => c.id))
		if (ids.size === 0) return route.fallback()
		const json = (await (await route.fetch()).json()) as Reply | Reply[]
		const patch = (r: Reply): Reply => (ids.has(r.id) && Array.isArray(r.result) ? { ...r, result: r.result.map(tripled) } : r)
		const patched = Array.isArray(json) ? json.map(patch) : patch(json)
		return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(patched) })
	})
	const confirm = page.locator(tid(TESTIDS.sendReviewConfirm))
	await expect(confirm).toBeEnabled({ timeout: 60_000 })
	await confirm.click()
	const stale = page.locator(tid(TESTIDS.sendReviewStale))
	await expect(stale).toBeVisible({ timeout: 60_000 })
	await expect(stale).toContainText(/fees moved|sets aside more/)
	expect(await privateCreditOf(actor.s, fpc), "nothing was spent").toBe(creditBefore)
	expect(l1.signatures).toBe(0)
	await nothingSubmitted(page, run)
})

test("cell 31 — a paused hub (L2) and paused withdrawals (L1) each stop the exit at confirm with a notice; nothing burned", async ({
	page,
	run,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc, l2Token } = await holding(actor, sandbox, "public")
	await fundPublicFeeJuice(actor.s, 5n * FJ)
	const l2Before = await balanceOf(l2Token, actor.actor.address, "public")
	const factory = sandbox.manifest.bridge?.l1.factory as `0x${string}`

	await connect(page, actor)
	await actor.s.hub.methods.set_exits_paused(true).send(actor.s.guardianOpts as never)
	try {
		await reviewExit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "1", isPrivate: false })
		await page.locator(tid(TESTIDS.sendReviewConfirm)).click()
		const notice = page.locator(tid(TESTIDS.sendPausedNotice))
		await expect(notice).toBeVisible({ timeout: 60_000 })
		await expect(notice).toContainText("Exits from Aztec are paused")
	} finally {
		await actor.s.hub.methods.set_exits_paused(false).send(actor.s.guardianOpts as never)
	}

	await writeL1(sandbox.clients.l1, factory, SET_PAUSED_ABI, "setPaused", [false, true])
	try {
		await page.locator(tid(TESTIDS.sendReviewConfirm)).click()
		const notice = page.locator(tid(TESTIDS.sendPausedNotice))
		await expect(notice).toBeVisible({ timeout: 60_000 })
		await expect(notice).toContainText("Withdrawals to Ethereum are paused")
	} finally {
		await writeL1(sandbox.clients.l1, factory, SET_PAUSED_ABI, "setPaused", [false, false])
	}
	expect(await balanceOf(l2Token, actor.actor.address, "public"), "nothing was burned").toBe(l2Before)
	expect(l1.signatures).toBe(0)
	await nothingSubmitted(page, run)
})
