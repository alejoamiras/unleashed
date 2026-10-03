/**
 * Normalize errors from wallet-sdk, simulation, and tx submission into
 * UI categories with their canonical toast copy.
 *
 * Categories (ordered most-specific first):
 *   user-rejected · capability-rejected · no-wallet · network · tx-reverted
 *   no-fee-asset · account-uninitialized · contract-not-registered · chain-desync · unknown
 */

export type ErrorCategory =
	| "user-rejected"
	| "capability-rejected"
	| "no-wallet"
	| "network"
	| "tx-reverted"
	| "no-fee-asset"
	| "account-uninitialized"
	| "contract-not-registered"
	| "chain-desync"
	| "unknown"

export interface NormalizedError {
	readonly category: ErrorCategory
	readonly message: string
	readonly raw: unknown
}

const TOAST_COPY: Record<ErrorCategory, string> = {
	"user-rejected": "Rejected in wallet.",
	"capability-rejected": "You denied the permissions. Click Approve to try again.",
	"no-wallet": "No Aztec wallet found. Install one and reload.",
	network: "Alpha-testnet is not responding. Try again.",
	"tx-reverted": "Drip transaction reverted — view tx.",
	"no-fee-asset": "No fee route available. Wait or report.",
	"account-uninitialized": "Selected account isn't deployed on alpha-testnet. Send any tx from your wallet first.",
	"contract-not-registered": "Couldn't register the app's contracts with your wallet. Reconnect.",
	"chain-desync": "Your wallet's view of the network was behind. Try again.",
	unknown: "Something went wrong. Try again.",
}

/** The two Nulo wallet-error codes this dApp acts on, mapped to their categories. The wallet's
 *  structured envelope is authoritative — a text classifier would misread these as `network` or
 *  `unknown`. Any other code (or none) falls through to the substring rules. */
// A Map, not a plain object: `walletErrorCode` is attacker-controlled text, and an object lookup on
// `"toString"`/`"constructor"`/`"__proto__"` would resolve an inherited property and be mistaken for
// a real category. Map.get returns undefined for any non-key.
const ENVELOPE_CATEGORY = new Map<string, ErrorCategory>([
	["PXE_STALE_ANCHOR", "chain-desync"],
	["CONTRACT_NOT_REGISTERED", "contract-not-registered"],
])

function tryJsonParse(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

/** The Nulo `walletErrorCode` carried in a thrown error's message, or undefined. Two transports
 *  encode it differently and both are decoded, never deeper: an extension transport wraps the envelope
 *  OBJECT once (`new Error(JSON.stringify(envelope))`), while the wallet-sdk iframe transport
 *  reduces the throw to its message STRING and JSON-encodes that again — so the first parse can
 *  yield a string that must be parsed once more. */
export function walletErrorCodeOf(err: unknown): string | undefined {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : undefined
	if (message === undefined) return undefined
	let parsed = tryJsonParse(message)
	if (typeof parsed === "string") parsed = tryJsonParse(parsed)
	if (!parsed || typeof parsed !== "object") return undefined
	const data = (parsed as { data?: unknown }).data
	const code = (data as { walletErrorCode?: unknown } | undefined)?.walletErrorCode
	return typeof code === "string" ? code : undefined
}

/** True for the wallet's "capability denied by user" wording, which must beat the generic
 *  user-rejection match below (extracted so `normalizeError` stays a flat dispatch). */
function isCapabilityRejection(lc: string): boolean {
	return lc.includes("capability") && (lc.includes("denied") || lc.includes("rejected"))
}

/** The sentence a user can act on. A viem error wraps the underlying cause in prose and a version
 *  line ("An unknown RPC error occurred. Details: … Version: viem@…"); the cause is what to show. */
export function userMessage(err: unknown, fallback = "Something went wrong. Try again."): string {
	if (err && typeof err === "object") {
		const { details, shortMessage } = err as { details?: unknown; shortMessage?: unknown }
		if (typeof details === "string" && details.trim() !== "") return details.trim()
		if (typeof shortMessage === "string" && shortMessage.trim() !== "") return shortMessage.trim()
	}
	if (err instanceof Error && err.message.trim() !== "") return err.message
	return fallback
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: accepted at score 21 — ordered overlapping message predicates are the error-classification precedence policy
export function normalizeError(err: unknown): NormalizedError {
	// The wallet's structured envelope wins over any text heuristic: the two codes it documents as
	// dApp-actionable map straight to their categories; everything else falls through.
	const code = walletErrorCodeOf(err)
	const enveloped = code ? ENVELOPE_CATEGORY.get(code) : undefined
	if (enveloped) return { category: enveloped, message: TOAST_COPY[enveloped], raw: err }

	const msg = err instanceof Error ? err.message : String(err)
	const lc = msg.toLowerCase()

	// Capability rejections are checked BEFORE generic user-rejection because
	// the wallet phrases the capability-denied error as "Capability denied by
	// user" - without this ordering the generic match wins and the UI shows
	// the wrong toast / hides the retry path.
	if (isCapabilityRejection(lc)) {
		return {
			category: "capability-rejected",
			message: TOAST_COPY["capability-rejected"],
			raw: err,
		}
	}
	// EIP-1193 user rejection
	if (typeof err === "object" && err !== null && "code" in err && err.code === 4001) {
		return { category: "user-rejected", message: TOAST_COPY["user-rejected"], raw: err }
	}
	if (lc.includes("user rejected") || lc.includes("user cancelled") || lc.includes("user canceled") || lc.includes("denied by user")) {
		return { category: "user-rejected", message: TOAST_COPY["user-rejected"], raw: err }
	}
	if (lc.includes("no wallet") || lc.includes("wallet not found") || lc.includes("no provider")) {
		return { category: "no-wallet", message: TOAST_COPY["no-wallet"], raw: err }
	}
	if (lc.includes("existing nullifier") || lc.includes("not initialized") || lc.includes("not deployed")) {
		return {
			category: "account-uninitialized",
			message: TOAST_COPY["account-uninitialized"],
			raw: err,
		}
	}
	if (lc.includes("fee") && (lc.includes("sponsored") || lc.includes("payment"))) {
		return { category: "no-fee-asset", message: TOAST_COPY["no-fee-asset"], raw: err }
	}
	if (lc.includes("revert") || lc.includes("reverted")) {
		return { category: "tx-reverted", message: TOAST_COPY["tx-reverted"], raw: err }
	}
	if (lc.includes("unknown contract") || lc.includes("not registered")) {
		return {
			category: "contract-not-registered",
			message: TOAST_COPY["contract-not-registered"],
			raw: err,
		}
	}
	if (lc.includes("fetch") || lc.includes("network") || lc.includes("timeout") || lc.includes("econnrefused")) {
		return { category: "network", message: TOAST_COPY.network, raw: err }
	}
	return { category: "unknown", message: TOAST_COPY.unknown, raw: err }
}
