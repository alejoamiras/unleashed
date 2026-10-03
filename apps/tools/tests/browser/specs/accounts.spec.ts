/**
 * The multi-account path (cells 41–45): a wallet that shares several accounts, and one that grows.
 * Every cell takes its actors from the file's pool — the pair cells take two — and nothing here
 * re-asserts the whole-pool grant the spike already pins.
 */
import { balanceOf, freshActorSecret, mint, mintPrivateGasNote, privateFpc } from "@unleashed/bridge-core/sandbox"
import { TESTIDS } from "../../../src/lib/testids"
import { type ActorHandle, expect, type SandboxAccess, test } from "../fixtures/test"
import { connectAztec, grantedAccounts, reconnectedAs, switchAccount, tid, walletCalls, walletFrame } from "../pages/connect"
import { walletCeiling } from "../pages/fees"
import { depositRecords } from "../pages/journal"
import { confirmReview, connectL1, openSend, reviewDeposit } from "../pages/send"

test.use({ family: "accounts", cells: 8, l1Index: 8 })

const USDC = 10n ** 6n
const L1 = 31337

const lower = (s: string) => s.toLowerCase()

/** Open the chip's menu and read the "Add accounts…" status line after one click. */
async function addAccountsOnce(page: import("@playwright/test").Page): Promise<string> {
	await page.locator(tid(TESTIDS.accountChip)).first().click()
	await page.locator(tid(TESTIDS.accountMenuAddAccounts)).click()
	const status = page.locator(tid(TESTIDS.accountMenuAddStatus))
	await expect(status).toBeVisible({ timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.accountMenuAddAccounts))).toBeEnabled({ timeout: 60_000 })
	const text = (await status.textContent()) ?? ""
	// The button was disabled while the wallet answered, so focus left the menu: close it from the
	// chip (a toggle), not with Escape, which the menu would never hear.
	await page.locator(tid(TESTIDS.accountChip)).first().click()
	await expect(page.locator(tid(TESTIDS.accountMenu))).toBeHidden()
	return text.trim()
}

/** A fueled public deposit as `actor` whose claim never runs: the claim's first simulation against
 *  the hub is held (24a's shape), so the Ethereum leg lands and the record stays "claim me". */
async function depositWithHeldClaim(
	page: import("@playwright/test").Page,
	run: { testWalletOrigins: Record<string, string> },
	sandbox: SandboxAccess,
	actor: ActorHandle,
): Promise<void> {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: sandbox.tokens.usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	const hub = sandbox.manifest.bridge?.l2.hub.address ?? ""
	expect(hub).not.toBe("")
	await walletFrame(page, run, "plain").evaluate((hubAddress) => window.__unleashedTestWallet!.holdNext("simulateTx", hubAddress), hub)
	await confirmReview(page)
	await expect.poll(async () => (await depositRecords(page)).at(-1)?.depositTxHash, { timeout: 180_000 }).toBeTruthy()
	await expect.poll(async () => (await walletCalls(page, run, "plain")).simulateTx ?? 0, { timeout: 180_000 }).toBeGreaterThan(0)
	expect((await walletCalls(page, run, "plain")).sendTx ?? 0, "no claim left this page's wallet").toBe(0)
}

test("cell 41 — Add accounts…: an account created in the wallet after the connect joins the session on one click", async ({
	page,
	run,
	actor,
}) => {
	await page.goto("/")
	await openSend(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	const before = await grantedAccounts(page)

	const added = await walletFrame(page, run, "plain").evaluate((s) => window.__unleashedTestWallet!.addAccount(s), freshActorSecret())
	expect(before.map(lower)).not.toContain(lower(added))

	expect(await addAccountsOnce(page)).toBe("Added 1 account")
	const after = await grantedAccounts(page)
	expect(after.map(lower)).toContain(lower(added))
	expect(after).toHaveLength(before.length + 1)
	// The chip never moved: the active account is the one the user chose.
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(actor.address.slice(2, 6), { ignoreCase: true })

	expect(await addAccountsOnce(page)).toBe("No accounts were added")
	expect(await grantedAccounts(page)).toHaveLength(after.length)
})

test("cell 42 — a record owned by another granted account: the feed shows it with Switch to, sends nothing under B, and claims after the switch", async ({
	page,
	run,
	sandbox,
	actor,
	pool,
	l1,
}) => {
	const b = pool.take()
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const usdtL2 = await actor.l2TokenOf(usdt)
	const before = await balanceOf(usdtL2, actor.actor.address, "public")
	await depositWithHeldClaim(page, run, sandbox, actor)

	// The reload reconnects as the REMEMBERED account (A); the switch to B is the user's own move.
	await page.reload()
	await openSend(page)
	await connectL1(page)
	await reconnectedAs(page, "plain", actor.address)
	await switchAccount(page, b.address)
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card = page.locator(tid(TESTIDS.journalCard)).first()
	await expect(card).toBeVisible()
	await expect(card.locator(tid(TESTIDS.journalAccount))).toHaveClass(/other/)
	const switchTo = card.locator(tid(TESTIDS.journalSwitchAccount))
	await expect(switchTo).toBeVisible()
	await expect(switchTo).toContainText("Switch to")
	await expect(card.locator(tid(TESTIDS.journalClaim))).toHaveCount(0)
	expect((await walletCalls(page, run, "plain")).sendTx ?? 0, "nothing was sent under the wrong account").toBe(0)

	await switchTo.click()
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(actor.address.slice(2, 6), { ignoreCase: true })
	await expect(card.locator(tid(TESTIDS.journalSwitchAccount))).toHaveCount(0)
	// The owning account is active now: the other-account chip goes with the switch.
	await expect(card.locator(tid(TESTIDS.journalAccount))).toHaveCount(0)
	// A rediscovered record with no claim hash is not auto-resumed: the claim is the user's click.
	const claim = card.locator(tid(TESTIDS.journalClaim))
	await expect(claim).toBeVisible({ timeout: 60_000 })
	await claim.click()
	await expect(card).toHaveAttribute("data-stage", "done", { timeout: 8 * 60_000 })
	expect((await depositRecords(page)).at(-1)?.claimTxHash, "the claim landed from the journal").toBeTruthy()
	expect((await balanceOf(usdtL2, actor.actor.address, "public")) - before).toBeGreaterThan(0n)
})

test("cell 43 — the switch is refused while the Ethereum leg is waiting on the wallet", async ({ page, sandbox, actor, pool, l1 }) => {
	const b = pool.take()
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const router = sandbox.manifest.bridge?.l1.router ?? ""
	expect(router).not.toBe("")
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	// The router transaction (the deposit itself) never answers; the approval before it goes through.
	// The row is checked only once the held request has actually arrived and parked.
	l1.holdNext("transaction", { to: router as `0x${string}` })
	await confirmReview(page)
	await expect.poll(() => l1.holdsArmed(), { timeout: 120_000 }).toBe(0)
	await expect(page.locator(tid(TESTIDS.stepper))).toBeVisible()

	await page.locator(tid(TESTIDS.accountChip)).first().click()
	const rowB = page.locator(`${tid(TESTIDS.accountMenuRow)}[data-address="${b.address}"]`)
	await expect(rowB).toBeDisabled()
	await expect(page.locator(tid(TESTIDS.accountMenu))).toContainText("Finish the current operation to switch.")
	await page.keyboard.press("Escape")
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(actor.address.slice(2, 6), { ignoreCase: true })
})

test("cell 44 — the gas gate re-reads on a switch: a review opened with credit stands down under an account holding none", async ({
	page,
	sandbox,
	actor,
	pool,
	l1,
}) => {
	const b = pool.take()
	const { usdc } = sandbox.tokens
	await mintPrivateGasNote(actor.s, await privateFpc(actor.s), (await walletCeiling(actor, { isPrivate: false, registers: false })) * 2n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: false })

	await switchAccount(page, b.address)
	await expect(page.locator(tid(TESTIDS.sendReviewStale))).toBeVisible({ timeout: 60_000 })
	const tokenOnly = page.locator(tid(TESTIDS.sendChoiceToken))
	await expect(tokenOnly).toBeDisabled({ timeout: 60_000 })
	const reasonId = await tokenOnly.getAttribute("aria-describedby")
	expect(reasonId, "the disabled card names its reason").toBeTruthy()
	await expect(page.locator(`#${reasonId}`)).toHaveText(/holds no gas the bridge can claim with/)

	await switchAccount(page, actor.address)
	await expect(tokenOnly).toBeEnabled({ timeout: 60_000 })
	await tokenOnly.click()
	await expect(tokenOnly).toHaveAttribute("aria-checked", "true")
	await page.locator(tid(TESTIDS.sendAmountNext)).click()
	await expect(page.locator(tid(TESTIDS.sendStepReview))).toBeVisible()
})

test("cell 45 — a reload remembers a non-first account: no chooser, the chip shows it", async ({ page, actor, pool }) => {
	const b = pool.take()
	void actor
	await page.goto("/")
	await openSend(page)
	await connectAztec(page, { profile: "plain", account: b.address })
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(b.address.slice(2, 6), { ignoreCase: true })

	await page.reload()
	await openSend(page)
	await reconnectedAs(page, "plain", b.address)
})
