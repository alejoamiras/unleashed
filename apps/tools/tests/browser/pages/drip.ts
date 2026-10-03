import { expect, type Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import { tid } from "./connect"

export type DripSymbol = "SIGNAL" | "NOISE"

/** One drip to the connected account; resolves when the card reports the landed transaction. */
export async function drip(page: Page, symbol: DripSymbol, visibility: "public" | "private"): Promise<void> {
	await page.locator(tid(TESTIDS.tabDrip)).click()
	const card = page.locator(`${tid(TESTIDS.tokenCard)}[data-symbol="${symbol}"]`)
	await expect(card).toBeVisible()
	await card.locator(tid(visibility === "public" ? TESTIDS.btnDripPublic : TESTIDS.btnDripPrivate)).click()
	await expect(card.locator(tid(TESTIDS.dripStatus))).toHaveAttribute("data-drip-status", "ok", { timeout: 180_000 })
}

/** The card's rendered balances, as text (the chain is the authority; this is the UI's echo). */
export async function balancesShown(page: Page, symbol: DripSymbol): Promise<{ publicText: string; privateText: string }> {
	const card = page.locator(`${tid(TESTIDS.tokenCard)}[data-symbol="${symbol}"]`)
	return {
		publicText: (await card.locator(tid(TESTIDS.balancePublic)).textContent()) ?? "",
		privateText: (await card.locator(tid(TESTIDS.balancePrivate)).textContent()) ?? "",
	}
}
