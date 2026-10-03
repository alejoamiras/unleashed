import { createApp } from "vue"
import App from "./App.vue"
import "@unleashed/design/base.css"
import "./app.css"
import { assertBuildIntegrity, assertNodeChainMatches } from "./lib/build-integrity"
import { httpsUpgradeUrl } from "./lib/https-upgrade"
import { IS_MAINNET, NETWORK } from "./lib/network"

// Fail-closed BEFORE mount: if the build target, its bundled manifest, or the serving hostname
// disagree, refuse to render (a wrong-chain build must never reach a transaction). Show the reason
// instead of a blank page, and still surface it in the console.
const die = (e: unknown): never => {
	const message = e instanceof Error ? e.message : String(e)
	const el = document.getElementById("app")
	if (el) el.textContent = message
	throw e
}

function mount(): void {
	try {
		assertBuildIntegrity()
		createApp(App).mount("#app")
	} catch (e) {
		die(e)
	}
}

// Layer-2 async half — the LIVE node must derive the same wallet chain id the build targets. Runs
// right after mount (completes in seconds, long before any wallet connect + deposit); a mismatch in
// PROD kills the app the same way the sync assertion does — a stale/wrong committed node URL must
// never carry a real deposit's claim polling to the wrong chain. Dev only warns (local nodes vary).
// The mainnet build serves a static placeholder with no node behind it (and a CSP that blocks the
// call), so probing there could only ever fail — skip it rather than kill the page on a dead fetch.
async function checkNodeChain(): Promise<void> {
	if (IS_MAINNET) return
	try {
		const res = await fetch(NETWORK.nodeUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] }),
		})
		const info = (await res.json()).result as { l1ChainId: number; rollupVersion: number } | undefined
		if (!info) return // transient RPC malfunction — the wallet handshake still enforces chain identity
		assertNodeChainMatches((info.l1ChainId ^ info.rollupVersion) >>> 0)
	} catch (e) {
		if (import.meta.env.PROD && e instanceof Error && e.message.includes("build integrity")) die(e)
		else console.warn("node chain identity check skipped/failed:", e)
	}
}

// PROD only: a dev server on a LAN address has no HTTPS to move to.
const httpsUrl = import.meta.env.PROD ? httpsUpgradeUrl(window.location.href, window.isSecureContext) : null
if (httpsUrl) {
	window.location.replace(httpsUrl)
} else {
	mount()
	void checkNodeChain()
}
