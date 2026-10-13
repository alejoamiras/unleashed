import type { Page } from "@playwright/test"
import { COPY } from "../../src/content.ts"
import { expect, expectClean, test } from "./fixtures.ts"

const FIELD = "#land > canvas.bg"

const sample = (page: Page, selector: string) => page.locator(selector).evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())

/** Two samples far enough apart for a 150 ms field to have stepped at least twice. */
async function moves(page: Page, selector: string): Promise<boolean> {
	const first = await sample(page, selector)
	await page.waitForTimeout(450)
	return first !== (await sample(page, selector))
}

declare global {
	interface Window {
		__frames?: number
	}
}

test("the field draws and moves while running", async ({ page, guard }) => {
	await page.goto("/")
	await expect(page.locator(FIELD)).toHaveAttribute("data-state", "running")
	const painted = await page.locator(FIELD).evaluate((canvas: HTMLCanvasElement) => {
		const data = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height).data
		const [r, g, b] = data
		let others = 0
		for (let i = 0; i < data.length; i += 4) if (data[i] !== r || data[i + 1] !== g || data[i + 2] !== b) others++
		return others
	})
	expect(painted).toBeGreaterThan(0)
	expect(await moves(page, FIELD)).toBe(true)
	await expectClean(guard)
})

test.describe("with reduced motion", () => {
	test.use({ reducedMotion: "reduce" })

	test("shows one still frame until the visitor presses Play", async ({ page, guard }) => {
		await page.goto("/")
		const button = page.getByRole("button", { name: COPY.play })
		await expect(button).toBeVisible()
		await expect(page.locator(FIELD)).toHaveAttribute("data-state", "still")
		expect(await moves(page, FIELD)).toBe(false)
		await button.click()
		await expect(page.locator(FIELD)).toHaveAttribute("data-state", "running")
		expect(await moves(page, FIELD)).toBe(true)
		await expectClean(guard)
	})
})

test("Pause holds every frame, and a reduced-motion change does not undo it", async ({ page }) => {
	await page.goto("/")
	await page.getByRole("button", { name: COPY.pause }).click()
	await expect(page.locator(FIELD)).toHaveAttribute("data-state", "paused")
	expect(await moves(page, FIELD)).toBe(false)
	await page.emulateMedia({ reducedMotion: "reduce" })
	await page.emulateMedia({ reducedMotion: "no-preference" })
	await expect(page.getByRole("button", { name: COPY.play })).toBeVisible()
	expect(await moves(page, FIELD)).toBe(false)
})

test("a hidden tab stops the field", async ({ page }) => {
	await page.goto("/")
	await expect(page.locator(FIELD)).toHaveAttribute("data-state", "running")
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
		document.dispatchEvent(new Event("visibilitychange"))
	})
	await expect(page.locator(FIELD)).toHaveAttribute("data-state", "paused")
})

test("requests no animation frames while paused", async ({ page }) => {
	await page.addInitScript(() => {
		const request = window.requestAnimationFrame.bind(window)
		window.__frames = 0
		window.requestAnimationFrame = (callback) => {
			window.__frames = (window.__frames ?? 0) + 1
			return request(callback)
		}
	})
	await page.goto("/")
	await page.getByRole("button", { name: COPY.pause }).click()
	await page.waitForTimeout(300)
	const before = await page.evaluate(() => window.__frames ?? 0)
	await page.waitForTimeout(1_000)
	expect((await page.evaluate(() => window.__frames ?? 0)) - before).toBeLessThanOrEqual(1)
})

test.describe("at a 1.5× screen", () => {
	test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, reducedMotion: "reduce" })

	test("every cell is exactly 6 device pixels", async ({ page, context }) => {
		await page.goto("/")
		const box = await page.locator(FIELD).evaluate((canvas: HTMLCanvasElement) => ({
			cells: [canvas.width, canvas.height],
			css: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
		}))
		expect(box.css).toEqual([box.cells[0] * 4, box.cells[1] * 4])
		// The right gutter shows only the field: from a cell boundary, every run of one colour is whole cells.
		const png = await page.screenshot({ clip: { x: 376, y: 0, width: 12, height: 600 } })
		const decoder = await context.newPage()
		const runs = await decoder.evaluate(async (base64) => {
			const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
			const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D
			ctx.drawImage(bitmap, 0, 0)
			const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
			const lengths: number[] = []
			const at = (x: number, y: number) => data.slice((y * width + x) * 4, (y * width + x) * 4 + 3).join()
			for (let x = 0; x < width; x++) {
				let run = 1
				for (let y = 1; y < height; y++) {
					if (at(x, y) === at(x, y - 1)) run++
					else {
						lengths.push(run)
						run = 1
					}
				}
			}
			return { lengths, width, height }
		}, png.toString("base64"))
		expect([runs.width, runs.height]).toEqual([18, 900])
		expect(runs.lengths.length).toBeGreaterThan(10)
		expect(runs.lengths.filter((length) => length % 6 !== 0)).toEqual([])
	})
})

test("a canvas that cannot draw leaves the page whole", async ({ page, guard }) => {
	await page.addInitScript(() => {
		HTMLCanvasElement.prototype.getContext = () => null
	})
	await page.goto("/")
	await expect(page.locator(FIELD)).toHaveCount(0)
	for (const screen of await page.locator(".screen").all()) await expect(screen).toBeHidden()
	await page.getByRole("button", { name: COPY.pause }).click()
	await expect(page.getByRole("button", { name: COPY.play })).toBeVisible()
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
	await expectClean(guard)
})
