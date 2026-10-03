/** The Send tab, testid-only: the L1 chip, the deposit wizard, the stepper and the receipt. */
import { expect, type Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import { tid } from "./connect"

export type Intent = "token" | "token+gas" | "gas"

export interface DepositPlan {
	l1ChainId: number
	erc20: string
	/** Decimal string as a user types it. */
	amount: string
	intent: Intent
	isPrivate: boolean
	/** The token is not in the list: paste its address, add it, and let the add select it. */
	viaLookup?: boolean
}

/** Paste an address into the search, wait for the lookup to read it, add it — which selects it. */
export async function pasteToken(page: Page, erc20: string): Promise<void> {
	await page.locator(tid(TESTIDS.sendTokenSearch)).fill(erc20)
	const lookup = page.locator(tid(TESTIDS.sendTokenLookup))
	await expect(lookup).toHaveAttribute("data-status", "found", { timeout: 30_000 })
	await lookup.locator(tid(TESTIDS.sendLookupAdd)).click()
}

/** From the receipt back to the token step, with the list as the last send left it. */
export async function newSend(page: Page): Promise<void> {
	await page.locator(tid(TESTIDS.receiptNewBridge)).click()
	await expect(page.locator(tid(TESTIDS.sendStepToken))).toBeVisible()
}

export async function openSend(page: Page): Promise<void> {
	await page.locator(tid(TESTIDS.tabSend)).click()
	await expect(page.locator(tid(TESTIDS.sendView))).toBeVisible()
}

export async function connectL1(page: Page): Promise<void> {
	await page.locator(tid(TESTIDS.l1Connect)).click()
	await expect(page.locator(tid(TESTIDS.l1Status))).toHaveAttribute("data-connected", "true")
}

/** Deposit direction → token → amount typed. Leaves the wizard on the amount step, choice untouched. */
export async function startDeposit(page: Page, plan: Pick<DepositPlan, "l1ChainId" | "erc20" | "amount" | "viaLookup">): Promise<void> {
	await page.locator(tid(TESTIDS.sendDirectionDeposit)).click()
	if (plan.viaLookup) await pasteToken(page, plan.erc20)
	else await page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${plan.l1ChainId}:${plan.erc20.toLowerCase()}"]`).click()
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).toBeVisible()
	await page.locator(tid(TESTIDS.sendAmountInput)).fill(plan.amount)
}

/** The wizard opens private; a public send flips the toggle. */
export async function setVisibility(page: Page, isPrivate: boolean): Promise<void> {
	const toggle = page.locator(tid(TESTIDS.sendPrivateToggle))
	if ((await toggle.getAttribute("aria-checked")) !== String(isPrivate)) await toggle.click()
	await expect(toggle).toHaveAttribute("aria-checked", String(isPrivate))
}

/** Token → amount → choice → visibility → review. Leaves the wizard on the review step. */
export async function reviewDeposit(page: Page, plan: DepositPlan): Promise<void> {
	await startDeposit(page, plan)
	const choice = { token: TESTIDS.sendChoiceToken, "token+gas": TESTIDS.sendChoiceTokenGas, gas: TESTIDS.sendChoiceGas }[plan.intent]
	const card = page.locator(tid(choice))
	await expect(card).toBeEnabled({ timeout: 30_000 })
	await card.click()
	await expect(card).toHaveAttribute("aria-checked", "true")
	await setVisibility(page, plan.isPrivate)
	await goToReview(page)
	await expect(page.locator(tid(TESTIDS.sendReviewVisibility))).toHaveAttribute("data-visibility", plan.isPrivate ? "private" : "public")
}

/**
 * CONTINUE, once the step has stopped quoting: a route quote landing under a review stands it down,
 * and a found route prints nothing of its own, so the step's loading flag is the wait — read only
 * after CONTINUE lights up. It lights up once the token has resolved, and resolving is what asks
 * for the quote, so "not loading" before that point is not "quoted". Every deposit stand-down asks
 * for the quote again, so a re-entered review waits the same way; an exit never quotes.
 */
export async function goToReview(page: Page): Promise<void> {
	const next = page.locator(tid(TESTIDS.sendAmountNext))
	await expect(next).toBeEnabled({ timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).not.toHaveAttribute("data-route-loading", "true", { timeout: 60_000 })
	await next.click()
	await expect(page.locator(tid(TESTIDS.sendStepReview))).toBeVisible()
}

type Pressed = "left" | "stale" | "refused" | "pending"

/** Where a pressed confirm has got to. A refusal is the review's error beside a Confirm that is live
 *  again: an error left by an earlier attempt sits beside a held button until this one settles. */
async function pressedOutcome(page: Page): Promise<Pressed> {
	const left = page.locator(`${tid(TESTIDS.stepper)}, ${tid(TESTIDS.receipt)}, ${tid(TESTIDS.sendGrantPending)}`)
	if (await left.first().isVisible()) return "left"
	if (await page.locator(tid(TESTIDS.sendReviewStale)).isVisible()) return "stale"
	if (!(await page.locator(tid(TESTIDS.sendReviewError)).isVisible())) return "pending"
	return (await page.locator(`${tid(TESTIDS.sendReviewConfirm)}:enabled`).isVisible()) ? "refused" : "pending"
}

async function settledPress(page: Page): Promise<Pressed> {
	let pressed = "pending" as Pressed
	await expect
		.poll(
			async () => {
				pressed = await pressedOutcome(page)
				return pressed
			},
			{ timeout: 120_000 },
		)
		.not.toBe("pending")
	if (pressed === "refused") {
		throw new Error(`the review refused the confirm: ${(await page.locator(tid(TESTIDS.sendReviewError)).textContent())?.trim()}`)
	}
	return pressed
}

/**
 * Confirm the review; the grant (if any) is auto-approved by the test wallet. A read that lands
 * after the review opened (held gas, a re-priced fee) stands the review down with a reason on the
 * amount step — exactly what a user would answer by reviewing again, so the helper does the same,
 * a bounded number of times. A read still in flight from the last confirm can stand the re-opened
 * review down before its button is even pressed, so the wait for that button is also a wait for
 * the notice. A confirm the review refuses fails at once, with the review's own reason.
 */
export async function confirmReview(page: Page): Promise<void> {
	const stale = page.locator(tid(TESTIDS.sendReviewStale))
	for (let attempt = 0; attempt < 4; attempt++) {
		await expect(
			page
				.locator(`${tid(TESTIDS.sendReviewConfirm)}:enabled`)
				.or(stale)
				.first(),
		).toBeVisible({ timeout: 60_000 })
		if (!(await stale.isVisible())) {
			await page.locator(tid(TESTIDS.sendReviewConfirm)).click()
			if ((await settledPress(page)) === "left") return
		}
		console.log(`[send] review stood down: ${(await stale.textContent())?.trim()}`)
		await goToReview(page)
	}
	throw new Error("the review was stood down four times in a row")
}

export interface Receipt {
	hero: string
	gas: string | null
	/** The From row's value ("Ethereum · 0x71C4…3A9F"); null when the receipt shows none. */
	from: string | null
	/** Everything the receipt says, for wording that must never appear on it. */
	text: string
}

/** Waits out the whole bridge — L1 signatures, the deposit, the L2 sync, the claim — for the receipt. */
export async function waitForReceipt(page: Page, timeout = 8 * 60_000): Promise<Receipt> {
	const receipt = page.locator(tid(TESTIDS.receipt))
	await expect(receipt).toBeVisible({ timeout })
	// A token send's hero is the token row; a gas-only bridge's hero IS the Fee Juice row.
	const hero = receipt.locator(`${tid(TESTIDS.sendReceiptToken)}, ${tid(TESTIDS.receiptFuel)}`).first()
	const gas = receipt.locator(tid(TESTIDS.sendReceiptGas))
	const from = receipt.locator(tid(TESTIDS.sendReceiptFrom))
	return {
		hero: (await hero.textContent()) ?? "",
		gas: (await gas.count()) > 0 ? await gas.first().textContent() : null,
		from: (await from.count()) > 0 ? await from.first().textContent() : null,
		text: (await receipt.textContent()) ?? "",
	}
}

/** The stepper's phases as `key → state`, for asserting which path a send took. */
export async function stepperPhases(page: Page): Promise<Record<string, string>> {
	const phases = page.locator(`${tid(TESTIDS.stepperPhase)}, ${tid(TESTIDS.sendStepperRegister)}`)
	const entries = await phases.evaluateAll((els) =>
		els.map((e) => [(e as HTMLElement).dataset.phase ?? "", (e as HTMLElement).dataset.state ?? ""]),
	)
	return Object.fromEntries(entries)
}
