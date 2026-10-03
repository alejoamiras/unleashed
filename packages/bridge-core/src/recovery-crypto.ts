import { EncryptionKey } from "@alejoamiras/nulo-wallet-crypto"

export type { EncryptionKey } from "@alejoamiras/nulo-wallet-crypto"

/**
 * Recovery-secret encryption for the no-server private bridge. The key is derived from a deterministic
 * L1 signature over a PER-RECORD message (recoveryKeyMessage) — binding chain + portal + bridge + the
 * record's secretHash, so EACH sealed blob has its own key: a leaked signature exposes only that one
 * record, never all of them. Reuses @alejoamiras/nulo-wallet-crypto's PBKDF2 + AES-GCM (never roll your
 * own crypto).
 *
 * The sealed blob is a BEARER credential for PRIVATE transfers (the L2 claim chooses the recipient),
 * so the UI must warn before exporting it, and the caller MUST round-trip self-test the seal before
 * the irreversible L1 deposit — some wallets sign non-deterministically, which would otherwise strand
 * the claim.
 */

/** Binds a sealed record to its chain, bridge contracts, and secret hash (per-record key derivation). */
export interface RecoveryBinding {
	chainId: number
	portal: string
	bridge: string
	secretHashHex: string
}

/** The per-record, domain-separated message the user signs to derive THIS record's recovery key. */
export function recoveryKeyMessage(b: RecoveryBinding): string {
	return [
		"Unleashed Bridge recovery key v1 — sign to locally encrypt ONE in-flight private claim secret.",
		"This is not a transaction and costs nothing.",
		`chain=${b.chainId} portal=${b.portal.toLowerCase()} bridge=${b.bridge.toLowerCase()} record=${b.secretHashHex.toLowerCase()}`,
	].join("\n")
}

function toBase64(bytes: Uint8Array): string {
	let s = ""
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
	return btoa(s)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
	const s = atob(b64)
	const out = new Uint8Array(s.length)
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
	return out
}

/** Derive a record's recovery key from the user's signature over recoveryKeyMessage(...). Normalizes
 *  the signature encoding (trimmed lowercase) so trivial encoding differences don't change the key. */
export function recoveryKeyFromSignature(signatureHex: string): Promise<EncryptionKey> {
	return EncryptionKey.fromPassword(signatureHex.trim().toLowerCase())
}

/** Encrypt a claim/exit secret into the opaque base64 blob held in recovery records. */
export async function sealSecret(key: EncryptionKey, secretHex: string): Promise<string> {
	const enc = new TextEncoder().encode(secretHex)
	const bytes = new Uint8Array(enc.length)
	bytes.set(enc)
	return toBase64(await key.encrypt(bytes))
}

/** Decrypt a blob produced by `sealSecret` back into the secret. */
export async function openSecret(key: EncryptionKey, blob: string): Promise<string> {
	return new TextDecoder().decode(await key.decrypt(fromBase64(blob)))
}

/**
 * Seal a record's secret end-to-end: derive THIS record's key from the per-record signature, seal,
 * then SELF-TEST the round trip (re-sign + open). A wallet that signs non-deterministically fails the
 * self-test and throws HERE — before the irreversible L1 deposit — rather than stranding the claim.
 */
export async function sealRecordSecret(
	sign: (message: string) => Promise<string>,
	binding: RecoveryBinding,
	secretHex: string,
): Promise<string> {
	const message = recoveryKeyMessage(binding)
	const blob = await sealSecret(await recoveryKeyFromSignature(await sign(message)), secretHex)
	const reopened = await openSecret(await recoveryKeyFromSignature(await sign(message)), blob).catch(() => null)
	if (reopened !== secretHex) {
		throw new Error(
			"Recovery self-test failed: this wallet signs non-deterministically, so a private claim could not be recovered. Aborting before the deposit.",
		)
	}
	return blob
}

/** Re-derive THIS record's key from the per-record signature and open its sealed blob. */
export async function openRecordSecret(
	sign: (message: string) => Promise<string>,
	binding: RecoveryBinding,
	blob: string,
): Promise<string> {
	return openSecret(await recoveryKeyFromSignature(await sign(recoveryKeyMessage(binding))), blob)
}

/**
 * The v2 deposit envelope: the private claim credential AND its authoritative metadata, sealed
 * together so GCM's auth tag covers all of it — browser storage cannot redirect a claim by editing
 * plaintext fields. For a recipient-committed private TOKEN deposit `secret` is the `claim_salt`, a
 * strand-prevention + linkage-privacy credential (NOT bearer): re-deriving the consumption secret
 * requires the bound recipient, so a leaked salt claims only to that recipient. `sealerL1` lives
 * inside because it gates trust revocation. This is the ONLY accepted blob shape: a decrypt that
 * doesn't parse as v2 is rejected outright (no bare-secret fallback — that absence is what closes the
 * downgrade attack).
 */
export interface DepositEnvelopeV2 {
	v: 2
	secret: string
	recipient: string
	/** Base units, canonical decimal string (normalized at seal time). */
	amount: string
	sealerL1: string
	leafIndex?: string
	/** PRIVATE fuel only — the per-deposit bridge-secret salt. For a direct private Fuel bridge the salt
	 *  is the SOLE recovery input: the claim secret is `deriveBridgeSecret(salt, claimer)`, so a lost salt
	 *  strands the Fee Juice. Sealed here (not just the plaintext journal copy) so a backup can recover it. */
	salt?: string
}

/** Normalize an amount to its canonical decimal form so seal-time and verify-time agree. */
export function normalizeAmount(amount: string | bigint): string {
	return BigInt(amount).toString()
}

export async function sealDepositEnvelope(key: EncryptionKey, env: Omit<DepositEnvelopeV2, "v">): Promise<string> {
	const payload: DepositEnvelopeV2 = { ...env, v: 2, amount: normalizeAmount(env.amount) }
	return sealSecret(key, JSON.stringify(payload))
}

/** Decrypt + validate a v2 envelope. Throws on GCM failure AND on any non-v2 plaintext shape. */
export async function openDepositEnvelope(key: EncryptionKey, blob: string): Promise<DepositEnvelopeV2> {
	const plaintext = await openSecret(key, blob)
	let parsed: unknown
	try {
		parsed = JSON.parse(plaintext)
	} catch {
		throw new Error("Sealed blob is not a v2 envelope — refusing to use it.")
	}
	const env = parsed as DepositEnvelopeV2
	if (
		env?.v !== 2 ||
		typeof env.secret !== "string" ||
		typeof env.recipient !== "string" ||
		typeof env.amount !== "string" ||
		typeof env.sealerL1 !== "string" ||
		(env.salt !== undefined && typeof env.salt !== "string")
	) {
		throw new Error("Sealed blob is not a v2 envelope — refusing to use it.")
	}
	return env
}

/** Compare an unsealed envelope against a record's display fields (the tamper check). */
export function envelopeMatchesRecord(env: DepositEnvelopeV2, record: { recipient: string; amount: string; leafIndex?: string }): boolean {
	if (env.recipient.toLowerCase() !== record.recipient.toLowerCase()) return false
	if (normalizeAmount(env.amount) !== normalizeAmount(record.amount)) return false
	if (env.leafIndex !== undefined && record.leafIndex !== undefined && env.leafIndex !== record.leafIndex) return false
	return true
}

/**
 * Trust-aware end-to-end seal for a private deposit. Returns the blob AND the in-memory key so
 * the caller can re-seal the finalized envelope (leafIndex) after the deposit receipt with ZERO
 * additional signatures — the key must never be persisted.
 *
 * `trusted: true` (seal-trust cache hit) ⇒ exactly ONE signature, no self-test.
 * `trusted: false` ⇒ the two-signature self-test; throws before any irreversible tx on a
 * non-deterministic wallet.
 */
export async function sealDepositRecord(opts: {
	sign: (message: string) => Promise<string>
	binding: RecoveryBinding
	envelope: Omit<DepositEnvelopeV2, "v">
	trusted: boolean
}): Promise<{ blob: string; key: EncryptionKey }> {
	const message = recoveryKeyMessage(opts.binding)
	const key = await recoveryKeyFromSignature(await opts.sign(message))
	const blob = await sealDepositEnvelope(key, opts.envelope)
	if (!opts.trusted) {
		const retestKey = await recoveryKeyFromSignature(await opts.sign(message))
		const reopened = await openDepositEnvelope(retestKey, blob).catch(() => null)
		if (!reopened || reopened.secret !== opts.envelope.secret) {
			throw new Error(
				"Recovery self-test failed: this wallet signs non-deterministically, so a private claim could not be recovered. Aborting before the deposit.",
			)
		}
	}
	return { blob, key }
}

/** Re-derive the per-record key (one signature) and open the v2 envelope. */
export async function openDepositRecord(
	sign: (message: string) => Promise<string>,
	binding: RecoveryBinding,
	blob: string,
): Promise<{ envelope: DepositEnvelopeV2; key: EncryptionKey }> {
	const key = await recoveryKeyFromSignature(await sign(recoveryKeyMessage(binding)))
	return { envelope: await openDepositEnvelope(key, blob), key }
}
