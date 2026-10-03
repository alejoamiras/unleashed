import { ref } from "vue"

/**
 * Tools theme switcher — Dark / Light / System. The raw choice is persisted
 * to localStorage and read back BEFORE first paint by public/theme-boot.js (no flash-of-dark). "system"
 * tracks the OS via prefers-color-scheme. The stored value is allowlist-validated on read (untrusted).
 */

export const THEME_KEY = "unleashed:theme"
export const THEME_MODES = ["dark", "light", "system"] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export function isThemeMode(value: unknown): value is ThemeMode {
	return value === "dark" || value === "light" || value === "system"
}

export function prefersDark(): boolean {
	return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches)
}

/** Resolve a mode to the concrete theme the `theme` attribute carries. */
export function resolveTheme(mode: ThemeMode): "dark" | "light" {
	if (mode === "system") return prefersDark() ? "dark" : "light"
	return mode
}

/** Read + allowlist-validate the persisted choice; junk / missing → "system". */
export function readStoredTheme(): ThemeMode {
	try {
		const stored = localStorage.getItem(THEME_KEY)
		return isThemeMode(stored) ? stored : "system"
	} catch {
		return "system"
	}
}

function applyTheme(mode: ThemeMode): void {
	if (typeof document !== "undefined") document.documentElement.setAttribute("theme", resolveTheme(mode))
}

// Module-level singleton: one document, one theme. Initialised from the persisted choice.
const mode = ref<ThemeMode>(readStoredTheme())

let systemListenerBound = false
function bindSystemListener(): void {
	if (systemListenerBound || typeof window === "undefined" || !window.matchMedia) return
	systemListenerBound = true
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (mode.value === "system") applyTheme("system")
	})
}

export function useTheme() {
	bindSystemListener()
	applyTheme(mode.value) // re-affirm the attribute the boot script set pre-paint

	function setTheme(next: ThemeMode): void {
		mode.value = next
		try {
			localStorage.setItem(THEME_KEY, next)
		} catch {
			// best-effort persistence; the in-memory mode still drives this session
		}
		applyTheme(next)
	}

	function cycleTheme(): void {
		setTheme(THEME_MODES[(THEME_MODES.indexOf(mode.value) + 1) % THEME_MODES.length])
	}

	return { mode, setTheme, cycleTheme }
}
