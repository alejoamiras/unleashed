/*
 * Pre-paint boot, classic and render-blocking. `theme` follows the OS, as the page has no theme
 * control; `js` tells the CSS that scripts run, which gates the wordmark on its font.
 */
try {
	const root = document.documentElement
	root.setAttribute("theme", window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
	root.classList.add("js")
} catch {
	// Never block first paint: without a theme attribute the dark tokens apply.
}
