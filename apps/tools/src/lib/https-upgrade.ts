/**
 * The `https:` URL an insecure HTTP load should move to, else `null`. Insecure means no
 * `crypto.randomUUID` (wallet discovery throws) and ignored COOP/COEP (bb.js loses isolation).
 * Trustworthy HTTP such as loopback stays: the browser suite runs a production build there.
 */
export function httpsUpgradeUrl(href: string, isSecureContext: boolean): string | null {
	const url = new URL(href)
	if (isSecureContext || url.protocol !== "http:") return null
	url.protocol = "https:"
	return url.href
}
