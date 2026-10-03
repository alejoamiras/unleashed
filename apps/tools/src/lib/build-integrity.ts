import { MANIFEST_CHAIN } from "@/contracts/bridge-generation"
import { type ToolsTarget, resolveToolsTarget } from "./network-targets"

export interface ManifestChainIdentity {
	l1ChainId?: number
	walletChainId?: number
}

/** `<label>-<workersDevHost>`, one DNS label in front: where Cloudflare serves a Worker's preview aliases and versions. */
function isPreviewHostOf(hostname: string, workersDevHost: string): boolean {
	const suffix = `-${workersDevHost}`
	return hostname.endsWith(suffix) && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(hostname.slice(0, -suffix.length))
}

/**
 * The pure integrity check — returns a human error string, or `null` when the build is coherent. Kept
 * side-effect-free (no module state, no `window`) so it's exhaustively unit-testable.
 *
 * Two of the five fail-closed layers live here:
 *  - Layer 5 (hostname↔target): a build served at the wrong host is internally consistent (it passes
 *    the chain layers) but must NOT run. PROD-only — dev/preview/e2e legitimately run on localhost.
 *  - Layer 2 sync half (target↔manifest): the bundled manifest MUST self-declare its chain and match
 *    the build target, else a wrong-manifest build shipped. (The async manifest↔node half is
 *    `assertNodeChainMatches`, run after the node handshake.)
 */
export function checkBuildIntegrity(
	target: Pick<ToolsTarget, "key" | "l1ChainId" | "walletChainId" | "host" | "workersDevHost" | "acceptsPreviewHosts">,
	manifest: ManifestChainIdentity,
	opts: { hostname: string; isProd: boolean },
): string | null {
	// The target's two production hosts, exactly. A preview is a PROD build too, served at a host
	// of the Worker's own; only a target that opts in (testnet) runs there.
	const { hostname } = opts
	const hostOk =
		hostname === target.host ||
		hostname === target.workersDevHost ||
		(target.acceptsPreviewHosts === true && target.workersDevHost !== undefined && isPreviewHostOf(hostname, target.workersDevHost))
	if (opts.isProd && !hostOk) {
		return `hostname ${opts.hostname} is not a ${target.key} target host such as ${target.host} (mis-hosted build)`
	}
	if (manifest.l1ChainId === undefined || manifest.walletChainId === undefined) {
		return "bundled manifest is missing l1ChainId/walletChainId — cannot verify chain identity"
	}
	if (manifest.walletChainId !== target.walletChainId || manifest.l1ChainId !== target.l1ChainId) {
		return (
			`bundled manifest chain (l1=${manifest.l1ChainId}, wallet=${manifest.walletChainId}) != ` +
			`${target.key} target (l1=${target.l1ChainId}, wallet=${target.walletChainId})`
		)
	}
	return null
}

/** Fail-closed gate called before mount — throws (app refuses to render) on any mismatch. */
export function assertBuildIntegrity(hostname: string = typeof window !== "undefined" ? window.location.hostname : ""): void {
	const err = checkBuildIntegrity(resolveToolsTarget(), MANIFEST_CHAIN, { hostname, isProd: import.meta.env.PROD })
	if (err) throw new Error(`build integrity check failed — refusing to load: ${err}`)
}

/** Layer 2 async half — call after the node handshake with the node's derived wallet chain id. */
export function assertNodeChainMatches(nodeWalletChainId: number): void {
	const target = resolveToolsTarget()
	if (nodeWalletChainId !== target.walletChainId) {
		throw new Error(
			`build integrity check failed — live node chain ${nodeWalletChainId} != ${target.key} target ${target.walletChainId}`,
		)
	}
}
