/** Activity (cell 39): a bridge's recovery file round-trips, and a backgrounded send reports back. */
import { isProvisionalRecordId } from "@unleashed/bridge-core"
import { freshToken, mint, setRoutable } from "@unleashed/bridge-core/sandbox"
import type { Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid, walletFrame } from "../pages/connect"
import { depositRecords } from "../pages/journal"
import { confirmReview, connectL1, openSend, reviewDeposit, waitForReceipt } from "../pages/send"

test.use({ family: "activity", cells: 4, l1Index: 5 })

const USDC = 10n ** 6n
const L1 = 31337

/**
 * The id the journal files `who`'s deposit under once the send has named it. A public send opens
 * its row under a provisional id and renames it onto the claim hash before the deposit is signed,
 * and a stepper follows the rename — so an id read before it is not one to hold a stepper to.
 */
async function namedRecordOf(page: Page, who: string): Promise<string> {
	let id = ""
	await expect
		.poll(
			async () => {
				id = (await depositRecords(page)).find((r) => r.recipient?.toLowerCase() === who.toLowerCase())?.id ?? ""
				return id !== "" && !isProvisionalRecordId(id)
			},
			{ timeout: 60_000, message: `the deposit to ${who} is filed under a named id, not a provisional one` },
		)
		.toBe(true)
	return id
}

test("cell 39 — the recovery file of a finished bridge restores it into an empty journal, under one Ethereum signature", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await confirmReview(page)
	// A recovery file is offered while a bridge is in flight (a finished card offers Clear); the
	// stepper's export needs the row named, which the journal shows by holding the deposit's hash.
	const stepper = page.locator(tid(TESTIDS.stepper))
	await expect(stepper).toBeVisible({ timeout: 120_000 })
	await expect.poll(async () => (await depositRecords(page)).at(-1)?.depositTxHash, { timeout: 180_000 }).toBeTruthy()
	const signaturesBefore = l1.signatures
	// The toast is read alongside the download, on a shorter clock: an export that fails says why
	// there, briefly, and that reason is what a failure must report.
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 60_000 }),
		stepper.locator(tid(TESTIDS.stepperBackup)).click(),
		expect(page.locator(tid(TESTIDS.toast))).toContainText("Recovery file downloaded", { timeout: 20_000 }),
	])
	const file = await download.path()
	expect(file).toBeTruthy()
	await waitForReceipt(page)
	const record = (await depositRecords(page)).at(-1)
	expect(record?.claimTxHash).toBeTruthy()
	// The key IS a signature over the record's binding. A provider the app cannot fingerprint (the
	// shim is "injected") never caches its determinism proof, so every export signs twice: once for
	// the key, once to prove the wallet re-derives it.
	expect(l1.signatures - signaturesBefore, "the export derives its key from the signature, proven deterministic").toBe(2)

	// An empty journal on the same Ethereum account takes the file back.
	await page.evaluate(() => localStorage.clear())
	await page.reload()
	await openSend(page)
	await connectL1(page)
	await page.locator(tid(TESTIDS.tabActivity)).click()
	await expect(page.locator(tid(TESTIDS.journalEmpty))).toBeVisible()
	await page.locator(tid(TESTIDS.journalRestoreInput)).setInputFiles(file as string)
	await expect(page.locator(tid(TESTIDS.journalCard)).first()).toBeVisible({ timeout: 60_000 })
	expect(
		(await depositRecords(page)).some((r) => r.id === record?.id),
		"the same record is back",
	).toBe(true)
})

test("cell 39 — a send sent to the background keeps running: the strip follows it, and its completion is announced", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await confirmReview(page)
	await expect(page.locator(tid(TESTIDS.stepper))).toBeVisible({ timeout: 120_000 })
	await page.locator(tid(TESTIDS.stepperBackground)).click()
	await expect(page.locator(tid(TESTIDS.sendBackgroundStrip))).toBeVisible()
	await expect(page.locator(tid(TESTIDS.sendStepToken)), "the wizard starts over").toBeVisible()

	await expect(page.locator(tid(TESTIDS.toast))).toBeVisible({ timeout: 8 * 60_000 })
	await page.locator(tid(TESTIDS.tabActivity)).click()
	await expect(page.locator(tid(TESTIDS.journalCard)).first()).toHaveAttribute("data-stage", "done", { timeout: 60_000 })
	expect((await depositRecords(page)).at(-1)?.claimTxHash).toBeTruthy()
})

test("cell 40 — two tabs, two sends racing: each stepper adopts only its own record, both land, both feeds list both", async ({
	page,
	context,
	run,
	sandbox,
	actor,
	pool,
	l1,
}) => {
	const b = pool.take()
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	// Tab 2 sends a token its wallet has not granted, so its send opens with the grant prompt — the
	// one wallet call that comes before its record exists.
	const fresh = await freshToken(sandbox.clients.l1, { name: "Fresh Raced", symbol: "FRSHR", decimals: 6 }, [l1.address], 1000n * USDC)
	await setRoutable(sandbox.clients.l1, sandbox.clients.deployment.quoter, fresh)

	// Tab 1 as A, tab 2 as B: the same origin, so the journal is one localStorage both tabs read —
	// and so is the remembered wallet, which tab 2 forgets so it connects on its own. Tab 2 takes
	// another wallet profile: a profile's origin holds one embedded-wallet store, so a second frame
	// of the SAME profile cannot open it.
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	const tab2 = await context.newPage()
	await tab2.goto("/")
	await tab2.evaluate(() => {
		for (const key of Object.keys(localStorage)) if (key.endsWith(":preferred-wallet")) localStorage.removeItem(key)
	})
	await tab2.reload()
	await openSend(tab2)
	await connectL1(tab2)
	await connectAztec(tab2, { profile: "selfpay", account: b.address })
	await reviewDeposit(tab2, { l1ChainId: L1, erc20: fresh, amount: "100", intent: "token+gas", isPrivate: false, viaLookup: true })
	// Tab 2 is parked on its grant: its submit baseline is taken, no record of its own exists yet.
	// Tab 1's record then appears — the exact shape a wizard adopting by recency would take.
	await walletFrame(tab2, run, "selfpay").evaluate(() => window.__unleashedTestWallet!.holdNext("requestCapabilities"))
	await confirmReview(tab2)
	await expect(tab2.locator(tid(TESTIDS.stepper))).toHaveAttribute("data-id", /^dep-pending-permit-/, { timeout: 60_000 })
	await confirmReview(page)
	await expect(page.locator(tid(TESTIDS.stepper))).toBeVisible({ timeout: 120_000 })
	await expect.poll(async () => (await depositRecords(page)).length, { timeout: 180_000 }).toBe(1)
	const first = await namedRecordOf(page, actor.address)
	await expect(page.locator(tid(TESTIDS.stepper))).toHaveAttribute("data-id", first)
	// Tab 2 has seen the foreign record — its own journal renders it — and still sits on its prompt.
	await tab2.locator(tid(TESTIDS.tabActivity)).click()
	await expect(tab2.locator(`${tid(TESTIDS.journalCard)}[data-id="${first}"]`)).toBeVisible({ timeout: 30_000 })
	// The held grant keeps tab 2's wallet frame raised over the rail, so the tab switch is forced.
	await tab2.locator(tid(TESTIDS.tabSend)).dispatchEvent("click")
	await expect(tab2.locator(tid(TESTIDS.sendView))).toBeVisible()
	await expect(tab2.locator(tid(TESTIDS.stepper)), "tab 2 stays on its own prompt").toHaveAttribute("data-id", /^dep-pending-permit-/)
	expect(await walletFrame(tab2, run, "selfpay").evaluate(() => window.__unleashedTestWallet!.release())).toBe(1)
	await expect.poll(async () => (await depositRecords(page)).length, { timeout: 180_000 }).toBe(2)
	await expect(tab2.locator(tid(TESTIDS.stepper))).toHaveAttribute("data-id", await namedRecordOf(page, b.address))

	const [r1, r2] = await Promise.all([waitForReceipt(page), waitForReceipt(tab2)])
	expect(r1.hero).toContain("USDT")
	expect(r2.hero).toContain("FRSHR")
	const records = await depositRecords(page)
	expect(records).toHaveLength(2)
	expect(records.every((r) => r.claimTxHash)).toBe(true)
	const recipients = records.map((r) => (r.recipient ?? "").toLowerCase()).sort()
	expect(recipients).toEqual([actor.address.toLowerCase(), b.address.toLowerCase()].sort())

	for (const tab of [page, tab2]) {
		await tab.locator(tid(TESTIDS.tabActivity)).click()
		await expect(tab.locator(tid(TESTIDS.journalCard))).toHaveCount(2)
		await expect(tab.locator(`${tid(TESTIDS.journalCard)}[data-stage="done"]`)).toHaveCount(2)
	}
	await tab2.close()
})
