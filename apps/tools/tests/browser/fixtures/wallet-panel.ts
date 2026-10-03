/**
 * The SDK mounts the session iframe inside a 420×500 floating panel at z-index 999999, bottom-right
 * — over the wizard's action row. The wallet page needs no clicks, so the panel is parked small in
 * the top-left corner the moment it appears; the frame stays attached and scripted.
 */
import type { BrowserContext } from "@playwright/test"

export async function parkWalletPanel(context: BrowserContext, walletOrigins: string[]): Promise<void> {
	await context.addInitScript((origins: string[]) => {
		const park = (node: Node) => {
			if (!(node instanceof HTMLElement) || node.tagName !== "DIV") return
			const frame = node.querySelector("iframe")
			if (!frame || node.style.position !== "fixed") return
			let origin = ""
			try {
				origin = new URL(frame.src).origin
			} catch {
				return
			}
			if (!origins.includes(origin)) return
			node.style.left = "0px"
			node.style.top = "0px"
			node.style.width = "160px"
			node.style.height = "100px"
			node.style.opacity = "0.4"
			node.dataset.walletParked = "1"
		}
		// Init scripts run before the document has an element, so the Document node is what exists.
		new MutationObserver((records) => {
			for (const r of records) for (const n of r.addedNodes) park(n)
		}).observe(document, { childList: true, subtree: true })
	}, walletOrigins)
}
