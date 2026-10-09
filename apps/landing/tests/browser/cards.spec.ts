import type { Page } from "@playwright/test"
import { COPY, EXPERIMENTS } from "../../src/content.ts"
import { expect, expectClean, test } from "./fixtures.ts"

const ENGINES = EXPERIMENTS.flatMap((e) => (e.engine ? [e.engine] : []))
const screenOf = (id: string) => `canvas[data-engine="${id}"]`

const sample = (page: Page, selector: string) => page.locator(selector).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())

async function moves(page: Page, selector: string): Promise<boolean> {
	const first = await sample(page, selector)
	await page.waitForTimeout(500)
	return first !== (await sample(page, selector))
}

/** Pixels that differ from the corner, which is the screen's own panel fill. */
const drawn = (page: Page, selector: string) =>
	page.locator(selector).evaluate((canvas: HTMLCanvasElement) => {
		const data = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height).data
		let count = 0
		for (let i = 0; i < data.length; i += 4) if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) count++
		return count
	})

test.use({ viewport: { width: 1440, height: 2000 } })

test("every screen draws and moves while running", async ({ page, guard }) => {
	expect(ENGINES.length).toBeGreaterThan(0)
	await page.goto("/")
	for (const id of ENGINES) {
		await expect(page.locator(screenOf(id))).toHaveAttribute("data-state", "running")
		expect(await drawn(page, screenOf(id)), id).toBeGreaterThan(0)
		// Polled, not sampled twice: the Tuner holds still for up to 13 steps of 120 ms at random.
		const first = await sample(page, screenOf(id))
		await expect.poll(() => sample(page, screenOf(id)), { message: id, timeout: 4_000 }).not.toBe(first)
	}
	await expectClean(guard)
})

test("Pause holds every screen", async ({ page }) => {
	await page.goto("/")
	await page.getByRole("button", { name: COPY.pause }).click()
	for (const id of ENGINES) {
		await expect(page.locator(screenOf(id))).toHaveAttribute("data-state", "paused")
		expect(await moves(page, screenOf(id)), id).toBe(false)
	}
})

test.describe("with reduced motion", () => {
	test.use({ reducedMotion: "reduce" })

	test("every screen shows a drawn still frame", async ({ page }) => {
		await page.goto("/")
		for (const id of ENGINES) {
			await expect(page.locator(screenOf(id))).toHaveAttribute("data-state", "still")
			expect(await drawn(page, screenOf(id)), id).toBeGreaterThan(0)
			expect(await moves(page, screenOf(id)), id).toBe(false)
		}
	})
})

test.describe("in a short window", () => {
	test.use({ viewport: { width: 1440, height: 600 } })

	test("a screen off screen stops, and starts when scrolled to", async ({ page }) => {
		await page.goto("/")
		const last = page.locator(screenOf(ENGINES[ENGINES.length - 1]))
		await expect(last).toHaveAttribute("data-state", "paused")
		await last.scrollIntoViewIfNeeded()
		await expect(last).toHaveAttribute("data-state", "running")
		await page.evaluate(() => window.scrollTo(0, 0))
		await expect(last).toHaveAttribute("data-state", "paused")
	})
})

test("a row inverts on hover and keeps its screen's own fill", async ({ page }) => {
	await page.goto("/")
	const row = page.locator(".idx a").first()
	const fill = (selector: string) =>
		row.evaluate(
			(el, s) =>
				getComputedStyle(s ? (el.querySelector(s) as Element) : el)
					.getPropertyValue("--ul-fill")
					.trim(),
			selector,
		)
	const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ul-ink").trim())
	const panel = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ul-panel").trim())
	await row.hover()
	expect(await fill("")).toBe(ink)
	expect(await fill(".screen")).toBe(panel)
	await expect(row.locator("canvas")).toHaveAttribute("data-state", "running")
})

test("a screen that fails on a resize or a redraw is retired, and the rest keep drawing", async ({ page }) => {
	const uncaught: string[] = []
	page.on("pageerror", (error) => uncaught.push(error.message))
	await page.goto("/")
	await page.getByRole("button", { name: COPY.pause }).click()
	const breakFill = (id: string) =>
		page.locator(screenOf(id)).evaluate((canvas: HTMLCanvasElement) => {
			const ctx = canvas.getContext("2d") as CanvasRenderingContext2D
			ctx.fillRect = () => {
				throw new Error("injected")
			}
		})
	const screen = (id: string) => page.locator(".screen").filter({ has: page.locator(screenOf(id)) })
	const [resized, redrawn, ...rest] = ENGINES
	await breakFill(resized)
	await page.setViewportSize({ width: 600, height: 2000 })
	await expect(screen(resized)).toBeHidden()
	await breakFill(redrawn)
	await page.emulateMedia({ colorScheme: "dark" })
	await expect(screen(redrawn)).toBeHidden()
	expect(rest.length).toBeGreaterThan(0)
	for (const id of rest) await expect(screen(id)).toBeVisible()
	expect(uncaught).toEqual([])
})
