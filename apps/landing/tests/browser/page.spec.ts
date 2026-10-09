import { COPY, EXPERIMENTS } from "../../src/content.ts"
import { expect, expectClean, test } from "./fixtures.ts"

const DARK_BG = "rgb(11, 11, 13)"
const LIGHT_BG = "rgb(244, 241, 232)"

test("renders every row and link as the content file says", async ({ page, guard }) => {
	await page.goto("/")
	await expect(page.getByRole("heading", { level: 1 })).toHaveText(COPY.heading)
	const rows = page.locator(".idx > li")
	await expect(rows).toHaveCount(EXPERIMENTS.length)
	for (const [i, experiment] of EXPERIMENTS.entries()) {
		const row = rows.nth(i)
		await expect(row.locator("strong")).toHaveText(experiment.name)
		if (experiment.href) await expect(row.locator("a")).toHaveAttribute("href", experiment.href)
		else await expect(row.locator("a")).toHaveCount(0)
	}
	await expectClean(guard)
})

for (const width of [320, 360, 390, 1440, 1920]) {
	test(`fits ${width} px: no sideways scroll, no tag over a name`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 })
		await page.goto("/")
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
		expect(overflow).toBeLessThanOrEqual(0)
		// The text's own extent, not the grid cell's: the board's overlap was a name overflowing its column.
		const overlapping = await page.$$eval(
			".idx > li",
			(rows) =>
				rows.filter((row) => {
					const range = document.createRange()
					range.selectNodeContents(row.querySelector("strong") as Element)
					const name = range.getBoundingClientRect()
					const tags = (row.querySelector(".tags") as Element).getBoundingClientRect()
					return tags.left < name.right && tags.right > name.left && tags.top < name.bottom && tags.bottom > name.top
				}).length,
		)
		expect(overlapping).toBe(0)
	})
}

test("Tab reaches every link and control in order, each with a focus ring", async ({ page }) => {
	await page.goto("/")
	const expected = await page.$$eval("a[href], button", (els) =>
		els.filter((el) => el.checkVisibility()).map((el) => `${el.tagName} ${el.getAttribute("href") ?? ""} ${el.textContent?.trim()}`),
	)
	expect(expected.length).toBeGreaterThan(EXPERIMENTS.length)
	for (const want of expected) {
		await page.keyboard.press("Tab")
		const focused = await page.evaluate(() => {
			const el = document.activeElement as Element
			const style = getComputedStyle(el)
			return {
				id: `${el.tagName} ${el.getAttribute("href") ?? ""} ${el.textContent?.trim()}`,
				ring: style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
			}
		})
		expect(focused.id).toBe(want)
		expect(focused.ring, want).toBe(true)
	}
})

for (const [scheme, background] of [
	["dark", DARK_BG],
	["light", LIGHT_BG],
] as const) {
	test(`follows the ${scheme} system theme`, async ({ page, guard }) => {
		await page.emulateMedia({ colorScheme: scheme })
		await page.goto("/")
		await expect(page.locator("html")).toHaveAttribute("theme", scheme)
		await expect(page.locator("body")).toHaveCSS("background-color", background)
		await expectClean(guard)
	})
}

test.describe("without JavaScript", () => {
	test.use({ javaScriptEnabled: false })

	test("shows all text and links in dark, with no screens and no Pause button", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "light" })
		await page.goto("/")
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(COPY.heading)
		await expect(page.locator(".idx > li")).toHaveCount(EXPERIMENTS.length)
		await expect(page.locator(".wm-hero")).toBeVisible()
		await expect(page.locator("body")).toHaveCSS("background-color", DARK_BG)
		await expect(page.locator("[data-motion]")).toBeHidden()
		for (const screen of await page.locator(".screen").all()) await expect(screen).toBeHidden()
	})
})

test("the text and the wordmark still appear when every font fails", async ({ page }) => {
	await page.route("**/*.woff2", (route) => route.abort())
	await page.goto("/")
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
	await expect(page.locator(".wm-hero")).toBeVisible({ timeout: 2_500 })
})
