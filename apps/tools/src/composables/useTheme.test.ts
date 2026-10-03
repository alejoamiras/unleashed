import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { isThemeMode, readStoredTheme, resolveTheme, THEME_KEY, useTheme } from "./useTheme"

function mockMatchMedia(matches: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches,
		media: query,
		addEventListener() {},
		removeEventListener() {},
	}))
}

beforeEach(() => {
	localStorage.clear()
	document.documentElement.removeAttribute("theme")
	vi.unstubAllGlobals()
})

describe("useTheme helpers", () => {
	test("isThemeMode allowlists exactly dark/light/system", () => {
		expect(isThemeMode("dark")).toBe(true)
		expect(isThemeMode("light")).toBe(true)
		expect(isThemeMode("system")).toBe(true)
		expect(isThemeMode("neon")).toBe(false)
		expect(isThemeMode(null)).toBe(false)
		expect(isThemeMode(42)).toBe(false)
	})

	test("resolveTheme maps explicit modes + resolves system via prefers-color-scheme", () => {
		expect(resolveTheme("dark")).toBe("dark")
		expect(resolveTheme("light")).toBe("light")
		mockMatchMedia(true)
		expect(resolveTheme("system")).toBe("dark")
		mockMatchMedia(false)
		expect(resolveTheme("system")).toBe("light")
	})

	test("readStoredTheme returns a valid stored value, else system (rejects untrusted junk)", () => {
		expect(readStoredTheme()).toBe("system")
		localStorage.setItem(THEME_KEY, "light")
		expect(readStoredTheme()).toBe("light")
		localStorage.setItem(THEME_KEY, "'); DROP TABLE themes;--")
		expect(readStoredTheme()).toBe("system")
	})
})

describe("useTheme composable", () => {
	test("setTheme persists the choice + sets the <html theme> attribute", () => {
		mockMatchMedia(false)
		const { setTheme } = useTheme()
		setTheme("light")
		expect(localStorage.getItem(THEME_KEY)).toBe("light")
		expect(document.documentElement.getAttribute("theme")).toBe("light")
		setTheme("dark")
		expect(document.documentElement.getAttribute("theme")).toBe("dark")
	})

	test("setTheme('system') resolves the attribute via the OS preference", () => {
		mockMatchMedia(true)
		const { setTheme } = useTheme()
		setTheme("system")
		expect(localStorage.getItem(THEME_KEY)).toBe("system")
		expect(document.documentElement.getAttribute("theme")).toBe("dark")
	})

	test("cycleTheme advances dark -> light -> system -> dark", () => {
		mockMatchMedia(false)
		const { mode, setTheme, cycleTheme } = useTheme()
		setTheme("dark")
		cycleTheme()
		expect(mode.value).toBe("light")
		cycleTheme()
		expect(mode.value).toBe("system")
		cycleTheme()
		expect(mode.value).toBe("dark")
	})
})

// theme-boot.js is a classic script that runs before the bundle, so it cannot import the key.
test("the pre-paint boot script reads the key useTheme writes", () => {
	const boot = readFileSync(join(__dirname, "..", "..", "public", "theme-boot.js"), "utf8")
	expect(boot).toContain(`localStorage.getItem("${THEME_KEY}")`)
})
