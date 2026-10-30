import { EncryptionKey } from "@nulo-sh/wallet-crypto"

/**
 * Recovery-secret encryption for the no-server private bridge. The key is derived from a deterministic
 * L1 signature over a PER-RECORD message (recoveryKeyMessage) — binding the app's origin + chain + portal +
 * bridge + the record's secretHash, so EACH sealed blob has its own key: a leaked signature exposes only that one
 * record, never all of them. Reuses @nulo-sh/wallet-crypto's PBKDF2 + AES-GCM (never roll your
 * own crypto).
 *
 * The sealed blob holds a PRIVATE transfer's claim material, so the UI must warn before exporting it,
 * and a seal MUST prove the wallet signs repeatably before the irreversible L1 deposit — some wallets
 * sign non-deterministically, which would otherwise strand the claim.
 */

/**
 * Which text a key was signed over. `site` names the app's canonical origin and seals every new blob;
 * `legacy` is the text before it, kept only to open what was sealed under it.
 */
export type KeyText = "legacy" | "site"

/** Binds a sealed record to the app's origin, its chain, bridge contracts, and secret hash (per-record key derivation). */
export interface RecoveryBinding {
	/** The build's canonical origin. */
	site: string
	chainId: number
	portal: string
	bridge: string
	secretHashHex: string
}

/**
 * The per-record message the user signs to derive THIS record's recovery key. Its bytes are key material,
 * so neither text may change. The site text stays printable ASCII and never takes EIP-4361's sign-in form.
 */
export function recoveryKeyMessage(b: RecoveryBinding, text: KeyText): string {
	if (text === "legacy") {
		return [
			"Unleashed Bridge recovery key v1 — sign to locally encrypt ONE in-flight private claim secret.",
			"This is not a transaction and costs nothing.",
			`chain=${b.chainId} portal=${b.portal.toLowerCase()} bridge=${b.bridge.toLowerCase()} record=${b.secretHashHex.toLowerCase()}`,
		].join("\n")
	}
	return [
		"Unleashed: unlock one transfer's recovery data",
		"",
		`Sign this only on ${b.site}. The signature locks and unlocks the recovery data of one bridge transfer.`,
		"",
		`Site: ${b.site}`,
		`Chain: ${b.chainId}`,
		`Transfer: ${b.secretHashHex.toLowerCase()}`,
		`Portal: ${b.portal.toLowerCase()}`,
		`Bridge: ${b.bridge.toLowerCase()}`,
		"",
		"Signing is free. It is not a transaction and moves no funds.",
	].join("\n")
}

/** Prefixes every blob a site key seals; `:` is outside the base64 alphabet, so no legacy blob carries it. */
const SITE_TAG = "site:"
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** The text whose key opens `blob`, read before any signature is asked for; null for a marker this build does not know. */
export function keyTextOf(blob: string): KeyText | null {
	if (blob.startsWith(SITE_TAG)) return "site"
	return BASE64.test(blob) ? "legacy" : null
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

/** Trivial encoding differences (case, whitespace) must not change the key. */
const normalizeSignature = (signatureHex: string): string => signatureHex.trim().toLowerCase()

/**
 * A record's recovery key, labelled with the text it was signed over. Nominal (private constructor and
 * field): only `derive`/`deriveTwice` build one, so a label can never disagree with its key, and a blob it seals is
 * tagged with that label.
 */
export class RecoveryKey {
	readonly #key: EncryptionKey

	private constructor(
		readonly text: KeyText,
		key: EncryptionKey,
	) {
		this.#key = key
		Object.freeze(this) // `readonly` is compile-time only; a relabelled key would seal under a text it was not signed over.
	}

	/** One signature over the binding's `text`. */
	static async derive<T extends KeyText>(
		sign: (message: string) => Promise<string>,
		binding: RecoveryBinding,
		text: T,
	): Promise<RecoveryKey & { readonly text: T }> {
		const signature = await sign(recoveryKeyMessage(binding, text))
		return new RecoveryKey(text, await EncryptionKey.fromPassword(normalizeSignature(signature))) as RecoveryKey & { readonly text: T }
	}

	/** Two signatures over the same text; `repeatable` is false when they differ, i.e. the wallet could never
	 *  re-derive this key and anything sealed under it would be unrecoverable. */
	static async deriveTwice<T extends KeyText>(
		sign: (message: string) => Promise<string>,
		binding: RecoveryBinding,
		text: T,
	): Promise<{ key: RecoveryKey & { readonly text: T }; repeatable: boolean }> {
		const message = recoveryKeyMessage(binding, text)
		const first = normalizeSignature(await sign(message))
		const repeatable = normalizeSignature(await sign(message)) === first
		return { key: new RecoveryKey(text, await EncryptionKey.fromPassword(first)) as RecoveryKey & { readonly text: T }, repeatable }
	}

	async seal(plaintext: string): Promise<string> {
		const enc = new TextEncoder().encode(plaintext)
		const bytes = new Uint8Array(enc.length)
		bytes.set(enc)
		const blob = toBase64(await this.#key.encrypt(bytes))
		return this.text === "site" ? SITE_TAG + blob : blob
	}

	/** Throws on a blob tagged for the other text, before decrypting, and on any GCM failure. */
	async open(blob: string): Promise<string> {
		if (keyTextOf(blob) !== this.text) throw new Error("This blob was not sealed under this key's text.")
		const body = this.text === "site" ? blob.slice(SITE_TAG.length) : blob
		return new TextDecoder().decode(await this.#key.decrypt(fromBase64(body)))
	}
}

/** A key every new blob, file and retained in-memory key is sealed under. */
export type SiteKey = RecoveryKey & { readonly text: "site" }

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

export async function sealDepositEnvelope(key: RecoveryKey, env: Omit<DepositEnvelopeV2, "v">): Promise<string> {
	const payload: DepositEnvelopeV2 = { ...env, v: 2, amount: normalizeAmount(env.amount) }
	return key.seal(JSON.stringify(payload))
}

/** Decrypt + validate a v2 envelope. Throws on GCM failure AND on any non-v2 plaintext shape. */
export async function openDepositEnvelope(key: RecoveryKey, blob: string): Promise<DepositEnvelopeV2> {
	const plaintext = await key.open(blob)
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
export function sealDepositRecord(opts: {
	sign: (message: string) => Promise<string>
	binding: RecoveryBinding
	envelope: Omit<DepositEnvelopeV2, "v">
	trusted: boolean
}): Promise<{ blob: string; key: SiteKey }> {
	return sealWithSelfTest(opts, (key) => sealDepositEnvelope(key, opts.envelope))
}

/** The seal half both envelope versions share: a site key from one signature when trusted, else from the
 *  sign-twice self-test, which refuses a wallet whose two signatures differ. */
async function sealWithSelfTest(
	opts: { sign: (message: string) => Promise<string>; binding: RecoveryBinding; trusted: boolean },
	seal: (key: SiteKey) => Promise<string>,
): Promise<{ blob: string; key: SiteKey }> {
	const { key, repeatable } = opts.trusted
		? { key: await RecoveryKey.derive(opts.sign, opts.binding, "site"), repeatable: true }
		: await RecoveryKey.deriveTwice(opts.sign, opts.binding, "site")
	if (!repeatable) {
		throw new Error(
			"Recovery self-test failed: this wallet signs non-deterministically, so a private claim could not be recovered. Aborting before the deposit.",
		)
	}
	return { blob: await seal(key), key }
}

/**
 * The v3 deposit envelope, sealed while a cross-chain private deposit is bridging: the amount that
 * will land is known only as a window until the `Deposited` event names it. Same primitives and
 * per-record key as v2; `v` keeps each version's opener from accepting the other. Once the key is in
 * memory and the event is read, `resealExactEnvelope` replaces it with an exact v2.
 */
export interface DepositEnvelopeV3 {
	v: 3
	secret: string
	recipient: string
	/** Base units, canonical decimal strings, `minAmount ≤ maxAmount`. */
	minAmount: string
	maxAmount: string
	sealerL1: string
	salt?: string
}

const DECIMAL = /^\d+$/

const isWindow = (minAmount: unknown, maxAmount: unknown): boolean =>
	typeof minAmount === "string" &&
	typeof maxAmount === "string" &&
	DECIMAL.test(minAmount) &&
	DECIMAL.test(maxAmount) &&
	BigInt(minAmount) <= BigInt(maxAmount)

function assertWindow(minAmount: string, maxAmount: string): void {
	if (!isWindow(minAmount, maxAmount)) throw new Error("A v3 envelope needs a decimal window with minAmount ≤ maxAmount.")
}

/**
 * The amount window a cross-chain deposit's token leg can land in: `[minReceived − fuelSlice,
 * maxPull]`. The fuel slice is the token-unit `fuel.amount` (zero for a token-only intent). The upper
 * bound is `maxPull`, never `maxPull − fuelSlice`: on the caller path the swap may consume almost
 * none of the slice and the rest joins the token leg. Throws when the slice exceeds `minReceived` or
 * a fueled intent carries no fuel block.
 */
export function crossChainAmountWindow(rec: {
	intent: "token" | "token+gas" | "gas"
	route: { minReceived: string; maxPull: string }
	fuel?: { amount: string }
}): { minAmount: string; maxAmount: string } {
	const fuel = rec.intent === "token" ? { amount: "0" } : rec.fuel
	if (!fuel) throw new Error("A fueled cross-chain intent needs its fuel slice.")
	const floor = BigInt(rec.route.minReceived) - BigInt(fuel.amount)
	if (floor < 0n) throw new Error("The fuel slice exceeds the route's minimum received amount.")
	const window = { minAmount: floor.toString(), maxAmount: normalizeAmount(rec.route.maxPull) }
	assertWindow(window.minAmount, window.maxAmount)
	return window
}

export async function sealDepositEnvelopeV3(key: RecoveryKey, env: Omit<DepositEnvelopeV3, "v">): Promise<string> {
	const payload: DepositEnvelopeV3 = {
		...env,
		v: 3,
		minAmount: normalizeAmount(env.minAmount),
		maxAmount: normalizeAmount(env.maxAmount),
	}
	assertWindow(payload.minAmount, payload.maxAmount)
	return key.seal(JSON.stringify(payload))
}

/** Decrypt + validate a v3 envelope. Throws on GCM failure AND on any non-v3 plaintext shape. */
export async function openDepositEnvelopeV3(key: RecoveryKey, blob: string): Promise<DepositEnvelopeV3> {
	const plaintext = await key.open(blob)
	let parsed: unknown
	try {
		parsed = JSON.parse(plaintext)
	} catch {
		throw new Error("Sealed blob is not a v3 envelope — refusing to use it.")
	}
	const env = parsed as Partial<DepositEnvelopeV3> | null
	if (
		env?.v !== 3 ||
		typeof env.secret !== "string" ||
		typeof env.recipient !== "string" ||
		!isWindow(env.minAmount, env.maxAmount) ||
		typeof env.sealerL1 !== "string" ||
		(env.salt !== undefined && typeof env.salt !== "string")
	) {
		throw new Error("Sealed blob is not a v3 envelope — refusing to use it.")
	}
	return env as DepositEnvelopeV3
}

/** The v3 tamper check: recipient equal and `minAmount ≤ amount ≤ maxAmount`, where `amount` must
 *  come from the authenticated `Deposited` event, never from storage. */
export function envelopeV3MatchesRecord(env: DepositEnvelopeV3, record: { recipient: string; amount: string }): boolean {
	if (env.recipient.toLowerCase() !== record.recipient.toLowerCase()) return false
	if (!DECIMAL.test(record.amount)) return false
	const amount = BigInt(record.amount)
	return BigInt(env.minAmount) <= amount && amount <= BigInt(env.maxAmount)
}

/**
 * Turn a matched v3 envelope into an ordinary exact v2 under the same in-memory key (no signature).
 * `deposited` is the event-derived amount and leaf; the sealed recipient, secret, sealer and salt
 * carry over. Throws, sealing nothing, when the deposit falls outside the v3 window or names
 * another recipient.
 */
export async function resealExactEnvelope(
	key: RecoveryKey,
	env: DepositEnvelopeV3,
	deposited: { recipient: string; amount: string; leafIndex?: string },
): Promise<string> {
	if (!envelopeV3MatchesRecord(env, deposited)) {
		throw new Error("The deposit does not match its sealed v3 envelope — refusing to re-seal.")
	}
	return sealDepositEnvelope(key, {
		secret: env.secret,
		recipient: env.recipient,
		amount: deposited.amount,
		sealerL1: env.sealerL1,
		leafIndex: deposited.leafIndex,
		salt: env.salt,
	})
}

/** `sealDepositRecord` for a v3 envelope: same signature economics and self-test. */
export function sealCrossChainDepositRecord(opts: {
	sign: (message: string) => Promise<string>
	binding: RecoveryBinding
	envelope: Omit<DepositEnvelopeV3, "v">
	trusted: boolean
}): Promise<{ blob: string; key: SiteKey }> {
	return sealWithSelfTest(opts, (key) => sealDepositEnvelopeV3(key, opts.envelope))
}
