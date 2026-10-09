import { readFileSync } from "node:fs"
import { type Channel, IMMUTABLE, pageHeaders } from "../../security-headers.ts"
import { expect, expectClean, LIVE, test } from "./fixtures.ts"

/** The build this run is checked against: the local dist/, which a live run builds at the deployed commit. */
const DIST = new URL("../../dist/", import.meta.url)
const reference = {
	html: readFileSync(new URL("index.html", DIST), "utf8"),
	build: JSON.parse(readFileSync(new URL("build.json", DIST), "utf8")) as { buildId: string; channel: Channel },
	hashed: readFileSync(new URL("_headers", DIST), "utf8")
		.split("\n")
		.filter((line) => line.startsWith("/assets/")),
}

test("loads clean: no CSP violation, no request to another origin, no console error", async ({ page, guard }) => {
	await page.goto("/")
	await page.mouse.wheel(0, 4_000)
	await page.waitForTimeout(1_000)
	await expectClean(guard)
})

test("any unknown path, a page or a file, gets the landing with the page headers and no long cache", async ({ page, request }) => {
	const navigation = await page.goto("/nope")
	expect(navigation?.status()).toBe(200)
	expect(navigation?.headers()["content-security-policy"]).toBe(pageHeaders(reference.build.channel)["Content-Security-Policy"])
	await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
	const file = await request.get("/assets/nope.js")
	expect(file.status()).toBe(200)
	expect(file.headers()["content-type"]).toContain("text/html")
	expect(file.headers()["content-security-policy"]).toBe(pageHeaders(reference.build.channel)["Content-Security-Policy"])
	expect(file.headers()["cache-control"] ?? "").not.toContain("immutable")
})

test("sends every page header, and a year's cache on hashed files only", async ({ request }) => {
	const page = await request.get("/")
	const headers = page.headers()
	for (const [name, value] of Object.entries(pageHeaders(reference.build.channel))) expect(headers[name.toLowerCase()], name).toBe(value)
	expect(headers["cache-control"] ?? "").not.toContain("immutable")
	expect(reference.hashed.length).toBeGreaterThan(0)
	for (const path of reference.hashed) expect((await request.get(path)).headers()["cache-control"], path).toContain(IMMUTABLE)
})

test.describe("live host", () => {
	test.skip(!LIVE, "needs LANDING_URL")

	test("serves exactly the reference build, untouched", async ({ page, request }) => {
		const served = await (await request.get("/")).text()
		expect(served).toContain(`<meta name="unleashed-build" content="${reference.build.buildId}">`)
		expect(served).toBe(reference.html)
		const injected: string[] = []
		page.on("request", (r) => {
			if (new URL(r.url()).pathname.startsWith("/cdn-cgi/")) injected.push(r.url())
		})
		await page.goto("/")
		await page.waitForTimeout(2_000)
		expect(injected).toEqual([])
	})
})
