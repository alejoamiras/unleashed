/** The Aztec connect flow, testid-only. Which panel drives it depends on the tab (bridge or drip). */
import { expect, type Frame, type Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import type { RunEnv } from "../env"
import type { TestWalletProfile } from "../test-wallet/profile"

export const tid = (t: string) => `[data-testid="${t}"]`

/** The id the test wallet announces itself under — profile-keyed, so the picker row is unambiguous. */
export const walletIdOf = (profile: TestWalletProfile) => `test-wallet-${profile}`

export interface ConnectOptions {
	profile: TestWalletProfile
	/** Which panel's connect button to press; the bridge one lives on the Send tab. */
	panel?: "bridge" | "drip"
	/** The actor to select when the grant lists several; defaults to the first row. */
	account?: string
	/** The chooser must NOT appear (a one-account grant, a remembered account): it is a failure, never answered. */
	refuseChooser?: boolean
}

/** Connect tools to a test-wallet profile: picker → emoji verification → grant → account choice. */
export async function connectAztec(page: Page, o: ConnectOptions): Promise<void> {
	const panel = o.panel ?? "bridge"
	const ids =
		panel === "bridge"
			? { connect: TESTIDS.bridgeL2Connect, status: TESTIDS.bridgeL2Status }
			: { connect: TESTIDS.btnConnect, status: TESTIDS.status }
	const row = page.locator(`${tid(TESTIDS.walletPickerRow)}[data-wallet-id="${walletIdOf(o.profile)}"]`)
	await openPickerWith(page, ids.connect, row)
	// The picker ignores a row click for 500 ms after its rows change; an accepted click closes it.
	await expect(async () => {
		await row.locator(tid(TESTIDS.walletPickerConnect)).click({ timeout: 2_000 })
		await expect(row).toBeHidden({ timeout: 1_000 })
	}).toPass({ timeout: 20_000 })
	await expect(page.locator(tid(TESTIDS.verificationModal))).toBeVisible()
	// Focus lands a tick after the dialog renders, so poll rather than read once.
	await expect
		.poll(() =>
			page.evaluate((id) => !!document.activeElement?.closest(`[data-testid="${id}"] [role=dialog]`), TESTIDS.verificationModal),
		)
		.toBe(true)
	await page.locator(tid(TESTIDS.btnVerifyConfirm)).click()
	await chooseAccountIfAsked(page, o)
	await expect(page.locator(tid(ids.status))).toHaveAttribute("data-status", "connected", { timeout: 120_000 })
}

/**
 * Open the picker until it lists the wanted wallet. Discovery probes every listed wallet URL in
 * parallel with a 10 s budget each; every profile has its own origin because the probe tells
 * frames apart by origin alone. The reopen is the safety net for a frame that missed its budget.
 */
async function openPickerWith(page: Page, connect: string, row: ReturnType<Page["locator"]>): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		await page.locator(tid(connect)).first().click()
		try {
			await expect(row).toBeVisible({ timeout: 15_000 })
			return
		} catch (e) {
			if (attempt >= 2) throw e
			await page.locator(tid(TESTIDS.walletPickerCancel)).click()
			await expect(page.locator(tid(TESTIDS.walletPicker))).toBeHidden()
		}
	}
}

/**
 * Drive whatever state the Aztec connection is in to `connected` — a page that reloaded with a
 * remembered wallet: the reconnect may already sit at the emoji check, may still be idle (then
 * Connect skips the picker and goes straight to that check), or may have erred. Every stop on
 * the way (picker row, emoji check, account choice) is answered as it appears.
 */
export async function driveToConnected(page: Page, o: ConnectOptions): Promise<void> {
	const status = page.locator(tid(TESTIDS.bridgeL2Status))
	const stops = connectionStops(page, o.profile)
	const started = Date.now()
	let state: string | null = null
	while (Date.now() < started + 180_000) {
		state = await status.getAttribute("data-status")
		if (state === "connected") return
		await answerStop(page, o, stops, state)
		await page.waitForTimeout(500)
	}
	throw new Error(`the Aztec connection never reached connected (last state: ${state})`)
}

/**
 * The reload-side reconnect of a wallet that REMEMBERS its account: every stop but the chooser is
 * answered, and the chooser appearing is the failure this helper exists to catch (`driveToConnected`
 * would answer it and hide a lost selection). Ends on the chip showing `address`.
 */
export async function reconnectedAs(page: Page, profile: TestWalletProfile, address: string): Promise<void> {
	await driveToConnected(page, { profile, refuseChooser: true })
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(address.slice(2, 6), { ignoreCase: true })
}

type Locator = ReturnType<Page["locator"]>
interface ConnectionStops {
	connect: Locator
	row: Locator
	modal: Locator
	confirm: Locator
	accounts: Locator
}

function connectionStops(page: Page, profile: TestWalletProfile): ConnectionStops {
	return {
		connect: page.locator(tid(TESTIDS.bridgeL2Connect)).first(),
		row: page.locator(`${tid(TESTIDS.walletPickerRow)}[data-wallet-id="${walletIdOf(profile)}"]`),
		modal: page.locator(tid(TESTIDS.verificationModal)),
		confirm: page.locator(tid(TESTIDS.btnVerifyConfirm)),
		accounts: page.locator(tid(TESTIDS.accountChoice)),
	}
}

/** One look at the screen, one answer. A click under a modal that opened between the look and the
 *  click would wait out the whole action timeout, so every click here is short and the next look
 *  decides again. */
async function answerStop(page: Page, o: ConnectOptions, s: ConnectionStops, state: string | null): Promise<void> {
	const tap = (target: Locator) => target.click({ timeout: 5_000 }).catch(() => undefined)
	if (await s.confirm.isVisible()) return tap(s.confirm)
	// The emoji check owns the screen; its confirm button is what the next look will find.
	if (await s.modal.isVisible()) return
	if (await s.accounts.isVisible()) {
		if (o.refuseChooser) throw new Error("the account chooser appeared on a connection that should not have asked")
		return chooseAccount(page, o.account).catch(() => undefined)
	}
	if (await s.row.isVisible()) return tap(s.row.locator(tid(TESTIDS.walletPickerConnect)))
	if (state === "choosing") return rescanIfMissing(page, s.row).catch(() => undefined)
	// `verifying` is an active connection's own state: Connect is never pressed under it.
	if (state === "idle" || state === "error") await tap(s.connect)
}

/** In the picker with the wanted row absent: give the scan its budget, then cancel so the next
 *  Connect scans again (see `openPickerWith`). */
async function rescanIfMissing(page: Page, row: ReturnType<Page["locator"]>): Promise<void> {
	const seen = await row.waitFor({ state: "visible", timeout: 15_000 }).then(
		() => true,
		() => false,
	)
	if (!seen) await page.locator(tid(TESTIDS.walletPickerCancel)).click()
}

/** With more than one granted account and none remembered, the choose-account modal pauses the flow. */
async function chooseAccountIfAsked(page: Page, o: Pick<ConnectOptions, "account" | "refuseChooser">): Promise<void> {
	const modal = page.locator(tid(TESTIDS.accountChoice))
	const status = page.locator(`[data-status="connected"]`)
	await Promise.race([
		modal.waitFor({ state: "visible", timeout: 120_000 }),
		status.first().waitFor({ state: "attached", timeout: 120_000 }),
	])
	if (!(await modal.isVisible())) return
	if (o.refuseChooser) throw new Error("the account chooser appeared on a connection that should not have asked")
	await chooseAccount(page, o.account)
}

async function chooseAccount(page: Page, account?: string): Promise<void> {
	const modal = page.locator(tid(TESTIDS.accountChoice))
	const row = account
		? modal.locator(`${tid(TESTIDS.accountChoiceRow)}[data-address="${account}"]`)
		: modal.locator(tid(TESTIDS.accountChoiceRow)).first()
	await row.click()
	await modal.locator(tid(TESTIDS.accountChoiceContinue)).click()
}

/** The SESSION frame of a connected profile — the one whose `window.__unleashedTestWallet` drives the
 *  wallet the page talks to (the discovery frames are separate documents). */
export function walletFrame(page: Page, run: Pick<RunEnv, "testWalletOrigins">, profile: TestWalletProfile): Frame {
	const origin = run.testWalletOrigins[profile]
	const frames = page.frames().filter((f) => originOf(f.url()) === origin && f.url().includes(`profile=${profile}`))
	const frame = frames.at(-1)
	if (!frame) throw new Error(`no session frame for the ${profile} wallet`)
	return frame
}

function originOf(url: string): string {
	try {
		return new URL(url).origin
	} catch {
		return ""
	}
}

/** What the connected wallet was asked, by method — `sendTx`, `createAuthWit` — since its frame loaded. */
export function walletCalls(
	page: Page,
	run: Pick<RunEnv, "testWalletOrigins">,
	profile: TestWalletProfile,
): Promise<Record<string, number>> {
	return walletFrame(page, run, profile).evaluate(() => window.__unleashedTestWallet!.calls())
}

/** Every address the grant carried, as the switcher menu lists them. */
export async function grantedAccounts(page: Page): Promise<string[]> {
	// The chip is a toggle: only open the menu when it is not already up.
	if (!(await page.locator(tid(TESTIDS.accountMenu)).isVisible())) await page.locator(tid(TESTIDS.accountChip)).first().click()
	const rows = page.locator(tid(TESTIDS.accountMenuRow))
	await expect(rows.first()).toBeVisible()
	const addresses = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.address ?? ""))
	await page.keyboard.press("Escape")
	return addresses
}

/** Select an actor in the account switcher (the chip's menu). */
export async function switchAccount(page: Page, address: string): Promise<void> {
	await page.locator(tid(TESTIDS.accountChip)).first().click()
	await page.locator(`${tid(TESTIDS.accountMenuRow)}[data-address="${address}"]`).click()
	await expect(page.locator(tid(TESTIDS.accountChip)).first()).toContainText(address.slice(2, 6), { ignoreCase: true })
}
