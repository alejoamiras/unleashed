import { readFileSync } from "node:fs"
import { type Channel, pageHeaders } from "../../security-headers.ts"
import { LEGAL_PAGES } from "../../src/legal-pages.ts"
import { expect, expectClean, test } from "./fixtures.ts"

const { channel } = JSON.parse(readFileSync(new URL("../../dist/build.json", import.meta.url), "utf8")) as { channel: Channel }

for (const legal of LEGAL_PAGES) {
	test(`serves ${legal.path} with the page headers, whole and clean at 320 px`, async ({ page, guard }) => {
		await page.setViewportSize({ width: 320, height: 900 })
		const response = await page.goto(legal.path)
		expect(response?.status()).toBe(200)
		const headers = response?.headers() ?? {}
		for (const [name, value] of Object.entries(pageHeaders(channel))) expect(headers[name.toLowerCase()], name).toBe(value)
		expect(headers["cache-control"] ?? "").not.toContain("immutable")
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(legal.doc.title)
		await expect(page.locator("main h2")).toHaveCount(legal.doc.sections.length)
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
		expect(overflow).toBeLessThanOrEqual(0)
		await expectClean(guard)
	})
}

test("the landing's footer reaches each legal page, and each page leads home", async ({ page }) => {
	await page.goto("/")
	for (const legal of LEGAL_PAGES) {
		await page.locator("footer").getByRole("link", { name: legal.doc.title }).click()
		await expect(page.locator("main")).toHaveAttribute("data-legal-doc", legal.doc.id)
		expect(new URL(page.url()).pathname).toBe(legal.path)
		await page.locator("nav").getByRole("link", { name: "Unleashed" }).click()
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
		expect(new URL(page.url()).pathname).toBe("/")
	}
})
