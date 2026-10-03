/**
 * Cell 34b: the community token list is untrusted input. The egress fence answers this worker's
 * list from the hostile fixture (`tokenList: "hostile"` — a worker option, hence its own file):
 * malformed entries are dropped one by one, an entry with no contract behind its address fails
 * closed on selection, a duplicate symbol at another address is never merged into the manifest's
 * token, and a 32-character symbol never paints over its row's balance.
 */
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { connectL1, openSend } from "../pages/send"

test.use({ family: "tokens-hostile", cells: 1, l1Index: 2, tokenList: "hostile" })

const L1 = 31337

test("cell 34b — a hostile community list: malformed entries never become tiles, a no-contract entry fails closed on selection, a duplicate symbol stays its own address", async ({
	page,
	sandbox,
	actor,
}) => {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.sendDirectionDeposit)).click()

	// The community list arrives after the manifest's tiles; its surviving entry marks it merged.
	await expect(page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:0x1111111111111111111111111111111111111111"]`)).toBeVisible({
		timeout: 60_000,
	})
	const keys = await page.locator(tid(TESTIDS.sendTokenTile)).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key ?? ""))
	// `decimals: 300` and a non-address are dropped entry by entry.
	expect(keys).not.toEqual(expect.arrayContaining([`${L1}:0x4444444444444444444444444444444444444444`]))
	expect(keys.some((k) => k.includes("not-an-address"))).toBe(false)
	// The fake "USDC" at another address is its own tile, never folded into the manifest's USDC.
	const usdc = sandbox.tokens.usdc.erc20.toLowerCase()
	expect(keys).toEqual(expect.arrayContaining([`${L1}:${usdc}`, `${L1}:0x6666666666666666666666666666666666666666`]))
	expect(keys.filter((k) => k === `${L1}:${usdc}`)).toHaveLength(1)
	// Brand colours follow committed identity, never the symbol: the look-alike stays grey.
	const tile = (address: string) => page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:${address}"]`)
	await expect(tile(usdc).locator(tid(TESTIDS.sendTokenLogo))).toBeVisible()
	await expect(tile("0x6666666666666666666666666666666666666666").locator(tid(TESTIDS.sendTokenMonogram))).toBeVisible()
	await expect(tile("0x6666666666666666666666666666666666666666").locator(tid(TESTIDS.sendTokenLogo))).toHaveCount(0)

	// A 32-character symbol at phone width stays in its own column: it never paints over the balance.
	const viewport = page.viewportSize()
	await page.setViewportSize({ width: 390, height: 900 })
	const wide = tile("0x7777777777777777777777777777777777777777")
	await wide.scrollIntoViewIfNeeded()
	await expect(wide.locator(tid(TESTIDS.sendTokenSymbol))).toHaveText("W".repeat(32))
	await expect(wide.locator(tid(TESTIDS.sendTokenBalance))).toBeVisible({ timeout: 60_000 })
	const [symbolBox, balanceBox] = await Promise.all([
		wide.locator(tid(TESTIDS.sendTokenSymbol)).boundingBox(),
		wide.locator(tid(TESTIDS.sendTokenBalance)).boundingBox(),
	])
	if (!symbolBox || !balanceBox) throw new Error("the wide-symbol tile rendered no symbol or no balance box")
	expect(symbolBox.x + symbolBox.width).toBeLessThanOrEqual(balanceBox.x)
	if (viewport) await page.setViewportSize(viewport)

	// A syntactically valid address with no contract behind it: selecting it reads the chain and
	// fails closed — no amount step, no route, nothing to send.
	await page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:0x5555555555555555555555555555555555555555"]`).click()
	await expect(page.locator(tid(TESTIDS.sendSelectionError))).toBeVisible({ timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).toHaveCount(0)
})
