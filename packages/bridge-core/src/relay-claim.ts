/**
 * Relayer-claim primitives — the PURE, unit-testable half of `scripts/relay-claim-testnet.ts`.
 *
 * A relayer finishes a user's PRIVATE token deposit by submitting `claim_private` FOR them.
 * Recipient-commitment (`claim_secret_lib`) means a claim naming a different recipient derives a
 * different consumption secret and can't consume the message — so a third party can safely run this
 * and can NEVER redirect the funds. What the relayer CAN do is grief (not submit) or leak: it
 * necessarily learns the `salt`, and the salt reveals the recipient↔amount↔leaf linkage. So the salt
 * is a linkage-privacy credential, NOT a bearer credential — this module NEVER logs it, and its error
 * messages never echo it.
 *
 * Everything here is node-free + deterministic so it can be tested without an Aztec node (the live
 * wiring — wallet, sponsored FPC, `submitPrivateClaim` — lives in the script).
 */
import { Fr } from "@aztec-labs/aztec.js/fields"

/** The off-chain hand-off a user gives a relayer to finish their private deposit. */
export interface RelayClaimDescriptor {
	/** L2 bridge address (hex). */
	bridge: string
	/** L2 recipient — the BOUND recipient; a relayer cannot change it. */
	recipient: string
	amount: bigint
	/** The per-deposit `claim_salt`. SENSITIVE (reveals linkage) — never log. */
	salt: Fr
	/** The L1→L2 message leaf index the claim consumes. */
	leafIndex: bigint
}

const HEX_FIELD = /^0x[0-9a-fA-F]{1,64}$/
const isHexField = (s: unknown): s is string => typeof s === "string" && HEX_FIELD.test(s)

function toBigInt(v: unknown, field: string): bigint {
	if (typeof v === "bigint") return v
	if (typeof v === "number" && Number.isInteger(v)) return BigInt(v)
	if (typeof v === "string" && /^[0-9]+$/.test(v)) return BigInt(v)
	throw new Error(`relay descriptor: \`${field}\` must be a non-negative integer`)
}

/**
 * Parse + validate a relayer claim descriptor from untrusted JSON (a file the user hands over).
 * Fail-closed on any missing/malformed field — a bad descriptor must never reach a live send. The
 * thrown message NEVER contains the salt value (only the fact that it was malformed).
 */
export function parseClaimDescriptor(raw: unknown): RelayClaimDescriptor {
	if (typeof raw !== "object" || raw === null) throw new Error("relay descriptor: not a JSON object")
	const o = raw as Record<string, unknown>
	if (!isHexField(o.bridge)) throw new Error("relay descriptor: missing/invalid `bridge` (hex address)")
	if (!isHexField(o.recipient)) throw new Error("relay descriptor: missing/invalid `recipient` (hex address)")
	if (!isHexField(o.salt)) throw new Error("relay descriptor: missing/invalid `salt` (hex field element)")
	const amount = toBigInt(o.amount, "amount")
	if (amount <= 0n) throw new Error("relay descriptor: `amount` must be greater than zero")
	const leafIndex = toBigInt(o.leafIndex, "leafIndex")
	return { bridge: o.bridge, recipient: o.recipient, amount, salt: Fr.fromString(o.salt), leafIndex }
}

/**
 * Load the relayer's dedicated L2 account secret from the environment. Fail-closed if absent, unparseable,
 * or zero — a relayer must run under its OWN key, never a shared/user key. The return is an `Fr`; the raw
 * string is never returned, logged, or included in any thrown message (so a stack trace can't leak it).
 */
export function requireRelayerSecret(env: Record<string, string | undefined>): Fr {
	const raw = env.RELAYER_L2_SECRET_KEY
	if (!raw) {
		throw new Error("RELAYER_L2_SECRET_KEY is required (the relayer's dedicated L2 account secret) — refusing to run")
	}
	let secret: Fr
	try {
		secret = Fr.fromString(raw)
	} catch {
		throw new Error("RELAYER_L2_SECRET_KEY is not a valid field element")
	}
	if (secret.isZero()) throw new Error("RELAYER_L2_SECRET_KEY is zero — refusing to run")
	return secret
}

/**
 * A log-safe view of a descriptor. The salt is a linkage credential — but so are the recipient, amount,
 * and leaf index TOGETHER (they reconstruct the deposit↔recipient↔amount link the salt is meant to hide),
 * so ALL of them are redacted, not just the salt. Only the bridge address (a public contract shared by
 * every deposit) is kept, for operational sanity. Prefer logging tx hashes + attempt/result over
 * descriptor contents. (Redacting the salt alone still leaked the protected linkage.)
 */
export function redactDescriptorForLog(d: RelayClaimDescriptor): Record<string, string> {
	return {
		bridge: d.bridge,
		recipient: "<redacted>",
		amount: "<redacted>",
		leafIndex: "<redacted>",
		salt: "<redacted>",
	}
}
