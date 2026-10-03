/** The exit direction of the Send wizard, testid-only. */
import { expect, type Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import { tid } from "./connect"

export interface ExitPlan {
	l1ChainId: number
	erc20: string
	amount: string
	isPrivate: boolean
}

/** Exit direction → token → amount → visibility. Leaves the wizard on the amount step. */
export async function startExit(page: Page, plan: ExitPlan): Promise<void> {
	await page.locator(tid(TESTIDS.sendDirectionExit)).click()
	await page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${plan.l1ChainId}:${plan.erc20.toLowerCase()}"]`).click()
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).toBeVisible()
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).toHaveAttribute("data-direction", "l2-to-l1")
	await page.locator(tid(TESTIDS.sendAmountInput)).fill(plan.amount)
	const toggle = page.locator(tid(TESTIDS.sendPrivateToggle))
	if ((await toggle.getAttribute("aria-checked")) !== String(plan.isPrivate)) await toggle.click()
	await expect(toggle).toHaveAttribute("aria-checked", String(plan.isPrivate))
}

/** Through to the review, which names the burn. */
export async function reviewExit(page: Page, plan: ExitPlan): Promise<void> {
	await startExit(page, plan)
	const next = page.locator(tid(TESTIDS.sendAmountNext))
	await expect(next).toBeEnabled({ timeout: 60_000 })
	await next.click()
	await expect(page.locator(tid(TESTIDS.sendStepReview))).toBeVisible()
	// An exit's review names the burn, never a visibility line (that line is the deposit's).
	await expect(page.locator(tid(TESTIDS.sendReviewBurnNote))).toBeVisible()
}
