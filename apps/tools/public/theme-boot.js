/*
 * Pre-paint theme boot. A classic (render-blocking) external script in <head> that sets <html theme>
 * before first paint so the app never flashes the wrong theme. localStorage["unleashed:theme"] is the
 * persisted choice (written by useTheme); "system" / missing / junk resolves to the OS preference.
 * Keep the key + allowed values in sync with src/composables/useTheme.ts.
 */
function bootTheme() {
	let choice = null
	try {
		choice = localStorage.getItem("unleashed:theme")
	} catch {
		// localStorage may be unavailable (privacy mode); fall through to the OS preference.
	}
	if (choice !== "dark" && choice !== "light" && choice !== "system") choice = "system"
	let resolved = choice
	if (choice === "system") {
		resolved = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light"
	}
	document.documentElement.setAttribute("theme", resolved)
}

try {
	bootTheme()
} catch {
	// Never block first paint on the theme hint.
}
