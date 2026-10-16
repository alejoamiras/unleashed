import { test as base, expect, type Page } from "@playwright/test"

/** Set when the run checks a live host instead of the local dist/. */
export const LIVE = Boolean(process.env.LANDING_URL)

export function origin(): string {
	const value = process.env.LANDING_ORIGIN
	if (!value) throw new Error("LANDING_ORIGIN is unset: global-setup.ts did not run")
	return value
}

/** What a page did that a clean load never does. */
export interface Guard {
	readonly consoleErrors: string[]
	readonly offOrigin: string[]
	cspViolations(): Promise<string[]>
}

declare global {
	interface Window {
		__cspViolations?: string[]
	}
}

async function guardPage(page: Page): Promise<Guard> {
	const consoleErrors: string[] = []
	const offOrigin: string[] = []
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text())
	})
	page.on("pageerror", (error) => consoleErrors.push(error.message))
	page.on("request", (request) => {
		const url = new URL(request.url())
		if (url.protocol.startsWith("http") && url.origin !== origin()) offOrigin.push(request.url())
	})
	// Before any page script, so a violation during parse is caught too.
	await page.addInitScript(() => {
		window.__cspViolations = []
		document.addEventListener("securitypolicyviolation", (event) => {
			window.__cspViolations?.push(`${event.effectiveDirective} ${event.blockedURI}`)
		})
	})
	return { consoleErrors, offOrigin, cspViolations: () => page.evaluate(() => window.__cspViolations ?? []) }
}

export const test = base.extend<{ guard: Guard }>({
	// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
	baseURL: async ({}, use) => use(origin()),
	guard: async ({ page }, use) => use(await guardPage(page)),
})

/** A clean page: no CSP violation, no request to another origin, no console error. */
export async function expectClean(guard: Guard): Promise<void> {
	expect(await guard.cspViolations(), "CSP violations").toEqual([])
	expect(guard.offOrigin, "requests to another origin").toEqual([])
	expect(guard.consoleErrors, "console errors").toEqual([])
}

export { expect }
