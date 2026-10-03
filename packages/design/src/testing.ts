/**
 * Test-only entry (`@unleashed/design/testing`), not runtime API: the theme guards, so a consuming
 * package runs the same undefined-token and contrast checks over its own components, and the
 * pointer gesture a `Dialog` scrim needs before it cancels.
 */

export * from "./theme-vars"
export * from "./theme-contrast"

/** A pointer press and release on `overlay` itself, then the click: a bare `click()` is not a
 *  backdrop click to `Dialog`. */
export function clickScrim(overlay: Element): void {
	overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }))
	overlay.dispatchEvent(new Event("pointerup", { bubbles: true }))
	overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}
