/** How long the page waits for a face before it carries on in the fallback. */
export const FONT_WAIT_MS = 1500

export const FACES = {
	pixel: '400 1em "Sixtyfour Convergence"',
	mono: '500 10px "Atkinson Hyperlegible Mono"',
	body: '700 10px "Atkinson Hyperlegible Next"',
} as const

/**
 * Resolves once every face has loaded, or after `ms`, whichever is first. Never rejects: a face that
 * fails to load only means the fallback is drawn.
 */
export function fontsLoaded(faces: readonly string[], text: string, ms = FONT_WAIT_MS): Promise<void> {
	const fonts = typeof document === "undefined" ? undefined : document.fonts
	if (!fonts) return Promise.resolve()
	const loads = Promise.all(faces.map((face) => fonts.load(face, text))).then(
		() => undefined,
		() => undefined,
	)
	const timeout = new Promise<void>((done) => setTimeout(done, ms))
	return Promise.race([loads, timeout])
}
