import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
	type RecoveryBinding,
	RecoveryKey,
	crossChainAmountWindow,
	envelopeMatchesRecord,
	envelopeV3MatchesRecord,
	keyTextOf,
	normalizeAmount,
	openDepositEnvelope,
	openDepositEnvelopeV3,
	recoveryKeyMessage,
	resealExactEnvelope,
	sealCrossChainDepositRecord,
	sealDepositEnvelope,
	sealDepositEnvelopeV3,
	sealDepositRecord,
} from "./recovery-crypto"

const SECRET = "0x1234deadbeefcafe"
const SITE = "https://testnet.app.unleashed.systems"

/** A deterministic wallet: its signature is a hash of the exact text, so two texts never share a key. */
const signer =
	(wallet = "a", calls: string[] = []) =>
	async (message: string) => {
		calls.push(message)
		return `0x${createHash("sha256").update(`${wallet}:${message}`).digest("hex")}`
	}

const BINDING: RecoveryBinding = { site: SITE, chainId: 11155111, portal: "0xPortal", bridge: "0xBridge", secretHashHex: "0xabc" }
const siteKey = (wallet = "a") => RecoveryKey.derive(signer(wallet), BINDING, "site")

describe("recovery-crypto", () => {
	it("round-trips a secret (ciphertext, not plaintext)", async () => {
		const key = await siteKey()
		const blob = await key.seal(SECRET)
		expect(blob).not.toContain(SECRET)
		expect(await key.open(blob)).toBe(SECRET)
	})

	it("same signature derives a key that decrypts another instance's blob (re-derivable)", async () => {
		const blob = await (await siteKey()).seal(SECRET)
		expect(await (await siteKey()).open(blob)).toBe(SECRET)
	})

	it("a different signature cannot decrypt the blob", async () => {
		const blob = await (await siteKey("a")).seal(SECRET)
		await expect((await siteKey("b")).open(blob)).rejects.toThrow()
	})

	it("encrypting twice yields different blobs (random IV) but both decrypt", async () => {
		const key = await siteKey()
		const b1 = await key.seal(SECRET)
		const b2 = await key.seal(SECRET)
		expect(b1).not.toBe(b2)
		expect(await key.open(b1)).toBe(SECRET)
		expect(await key.open(b2)).toBe(SECRET)
	})

	it("envelope round-trips an optional private-fuel salt; a non-string salt is rejected", async () => {
		const key = await siteKey()
		const blob = await sealDepositEnvelope(key, {
			secret: SECRET,
			recipient: "0xrecipient",
			amount: "1000",
			sealerL1: "0xsealer",
			leafIndex: "7",
			salt: "0x5a17",
		})
		expect((await openDepositEnvelope(key, blob)).salt).toBe("0x5a17")
		// An envelope WITHOUT a salt still opens (back-compat for token deposits).
		const noSalt = await sealDepositEnvelope(key, { secret: SECRET, recipient: "0xr", amount: "1", sealerL1: "0xs" })
		expect((await openDepositEnvelope(key, noSalt)).salt).toBeUndefined()
		// A blob whose salt is a non-string is refused.
		const bad = await key.seal(JSON.stringify({ v: 2, secret: SECRET, recipient: "0xr", amount: "1", sealerL1: "0xs", salt: 7 }))
		await expect(openDepositEnvelope(key, bad)).rejects.toThrow(/not a v2 envelope/)
	})

	it("recoveryKeyMessage is per-record — a different secretHash yields a different message", () => {
		const mA = recoveryKeyMessage({ ...BINDING, secretHashHex: "0xAAAA" }, "site")
		const mB = recoveryKeyMessage({ ...BINDING, secretHashHex: "0xBBBB" }, "site")
		expect(mA).not.toBe(mB)
		expect(mA).toContain("Transfer: 0xaaaa") // lowercased
	})

	it("pins the site text byte for byte: the recovery key is derived from its signature", () => {
		expect(recoveryKeyMessage({ ...BINDING, secretHashHex: "0xAAAA" }, "site")).toBe(
			"Unleashed: unlock one transfer's recovery data\n" +
				"\n" +
				"Sign this only on https://testnet.app.unleashed.systems. The signature locks and unlocks the recovery data of one bridge transfer.\n" +
				"\n" +
				"Site: https://testnet.app.unleashed.systems\n" +
				"Chain: 11155111\n" +
				"Transfer: 0xaaaa\n" +
				"Portal: 0xportal\n" +
				"Bridge: 0xbridge\n" +
				"\n" +
				"Signing is free. It is not a transaction and moves no funds.",
		)
	})

	it("pins the legacy text byte for byte, whatever the site: material sealed under it still opens", () => {
		expect(recoveryKeyMessage({ ...BINDING, secretHashHex: "0xAAAA" }, "legacy")).toBe(
			"Unleashed Bridge recovery key v1 — sign to locally encrypt ONE in-flight private claim secret.\n" +
				"This is not a transaction and costs nothing.\n" +
				"chain=11155111 portal=0xportal bridge=0xbridge record=0xaaaa",
		)
		expect(recoveryKeyMessage({ ...BINDING, site: "https://app.unleashed.systems" }, "legacy")).toBe(
			recoveryKeyMessage(BINDING, "legacy"),
		)
	})

	it("a key derived for another origin opens nothing this origin sealed", async () => {
		const blob = await (await siteKey()).seal(SECRET)
		const elsewhere = await RecoveryKey.derive(signer(), { ...BINDING, site: "https://unleashed-restore.example" }, "site")
		await expect(elsewhere.open(blob)).rejects.toThrow()
		expect(await (await RecoveryKey.derive(signer(), BINDING, "site")).open(blob)).toBe(SECRET)
	})

	it("a blob opens only under the text its tag names", async () => {
		const site = await siteKey()
		const legacy = await RecoveryKey.derive(signer(), BINDING, "legacy")
		const siteBlob = await site.seal(SECRET)
		const legacyBlob = await legacy.seal(SECRET)
		expect([siteBlob.startsWith("site:"), keyTextOf(siteBlob), keyTextOf(legacyBlob)]).toEqual([true, "site", "legacy"])
		expect(await site.open(siteBlob)).toBe(SECRET)
		expect(await legacy.open(legacyBlob)).toBe(SECRET)
		await expect(legacy.open(siteBlob)).rejects.toThrow(/not sealed under this key's text/)
		await expect(site.open(legacyBlob)).rejects.toThrow(/not sealed under this key's text/)
		expect(keyTextOf(`next:${legacyBlob}`)).toBeNull()
	})

	it("a key is built only by derive, so its label always matches its text", async () => {
		const legacy = await RecoveryKey.derive(signer(), BINDING, "legacy")
		// @ts-expect-error a relabelled object literal is not a RecoveryKey
		const relabelled: RecoveryKey = { text: "site", seal: legacy.seal, open: legacy.open }
		expect(relabelled.text).toBe("site")
	})

	it("normalizes the signature's case — upper/lower-hex signatures derive the same key", async () => {
		const blob = await (await RecoveryKey.derive(async () => `0x${"a".repeat(130)}`, BINDING, "site")).seal(SECRET)
		expect(await (await RecoveryKey.derive(async () => `0x${"A".repeat(130)}`, BINDING, "site")).open(blob)).toBe(SECRET)
	})

	it("deriveTwice reports a wallet whose two signatures differ", async () => {
		let n = 0
		const flaky = async () => `0x${String(n++).padEnd(130, "0")}`
		expect((await RecoveryKey.deriveTwice(flaky, BINDING, "site")).repeatable).toBe(false)
		expect((await RecoveryKey.deriveTwice(signer(), BINDING, "site")).repeatable).toBe(true)
	})
})

const ENVELOPE = {
	secret: "0x1234deadbeefcafe",
	recipient: "0xAzTecRecipient",
	amount: "100000000",
	sealerL1: "0xSealerAddr",
}

describe("v2 deposit envelope", () => {
	it("round-trips with all fields, normalizing the amount", async () => {
		const key = await siteKey()
		const blob = await sealDepositEnvelope(key, { ...ENVELOPE, amount: "0100000000" as never, leafIndex: "42" })
		expect(blob).not.toContain(ENVELOPE.secret)
		const env = await openDepositEnvelope(key, blob)
		expect(env).toMatchObject({ v: 2, ...ENVELOPE, amount: "100000000", leafIndex: "42" })
	})

	it("tampered ciphertext throws (GCM auth)", async () => {
		const key = await siteKey()
		const blob = await sealDepositEnvelope(key, ENVELOPE)
		const i = Math.floor(blob.length / 2)
		const flipped = blob.slice(0, i) + (blob[i] === "A" ? "B" : "A") + blob.slice(i + 1)
		await expect(openDepositEnvelope(key, flipped)).rejects.toThrow()
	})

	it("REJECTS a bare-secret blob — no fallback (the downgrade-attack pin)", async () => {
		const key = await siteKey()
		const bareBlob = await key.seal("0x1234deadbeefcafe")
		await expect(openDepositEnvelope(key, bareBlob)).rejects.toThrow(/not a v2 envelope/i)
	})

	it("REJECTS valid JSON that isn't a v2 envelope shape", async () => {
		const key = await siteKey()
		const blob = await key.seal(JSON.stringify({ v: 1, secret: "0x1" }))
		await expect(openDepositEnvelope(key, blob)).rejects.toThrow(/not a v2 envelope/i)
	})

	it("envelopeMatchesRecord: case-insensitive recipient, normalized amount, leafIndex when both present", () => {
		const env = { v: 2 as const, ...ENVELOPE, leafIndex: "7" }
		expect(envelopeMatchesRecord(env, { recipient: "0xaztecrecipient", amount: "100000000", leafIndex: "7" })).toBe(true)
		expect(envelopeMatchesRecord(env, { recipient: "0xATTACKER", amount: "100000000", leafIndex: "7" })).toBe(false)
		expect(envelopeMatchesRecord(env, { recipient: "0xaztecrecipient", amount: "999", leafIndex: "7" })).toBe(false)
		expect(envelopeMatchesRecord(env, { recipient: "0xaztecrecipient", amount: "100000000", leafIndex: "8" })).toBe(false)
		expect(envelopeMatchesRecord(env, { recipient: "0xaztecrecipient", amount: "100000000" })).toBe(true)
	})

	it("normalizeAmount canonicalizes equivalent encodings", () => {
		expect(normalizeAmount("0100")).toBe("100")
		expect(normalizeAmount(100n)).toBe("100")
	})
})

describe("sealDepositRecord (trust-aware signature economics)", () => {
	it("trusted ⇒ exactly ONE signature over the site text, no self-test; the blob is tagged and opens with the returned key", async () => {
		const calls: string[] = []
		const { blob, key } = await sealDepositRecord({ sign: signer("a", calls), binding: BINDING, envelope: ENVELOPE, trusted: true })
		expect(calls).toEqual([recoveryKeyMessage(BINDING, "site")])
		expect(keyTextOf(blob)).toBe("site")
		expect((await openDepositEnvelope(key, blob)).secret).toBe(ENVELOPE.secret)
	})

	it("untrusted ⇒ exactly TWO signatures (self-test)", async () => {
		const calls: string[] = []
		await sealDepositRecord({ sign: signer("a", calls), binding: BINDING, envelope: ENVELOPE, trusted: false })
		expect(calls).toHaveLength(2)
	})

	it("untrusted + non-deterministic signer ⇒ aborts before any irreversible tx", async () => {
		let n = 0
		const sign = async () => `0x${String(n++).padEnd(130, "0")}`
		await expect(sealDepositRecord({ sign, binding: BINDING, envelope: ENVELOPE, trusted: false })).rejects.toThrow(/self-test/i)
	})

	it("the retained key re-seals a finalized envelope (leafIndex) with ZERO further signatures", async () => {
		const calls: string[] = []
		const { key } = await sealDepositRecord({ sign: signer("a", calls), binding: BINDING, envelope: ENVELOPE, trusted: true })
		const finalized = await sealDepositEnvelope(key, { ...ENVELOPE, leafIndex: "108239872" })
		expect(calls).toHaveLength(1)
		expect((await openDepositEnvelope(key, finalized)).leafIndex).toBe("108239872")
	})
})

describe("recovery-crypto — recipient-committed backup durability", () => {
	const RECIP = `0x${"3".repeat(64)}`
	const SEALER = `0x${"1".repeat(40)}`

	it("the token claim-salt round-trips the sealed envelope (the strand-prevention credential)", async () => {
		// For a recipient-committed PRIVATE token deposit the sealed `secret` field IS the claim_salt
		// (claim_private re-derives the consumption secret from it + the recipient), so it MUST survive
		// the sealed backup — losing it strands the deposit.
		const key = await siteKey()
		const claimSalt = "0x07abc0ffee1234"
		const blob = await sealDepositEnvelope(key, { secret: claimSalt, recipient: RECIP, amount: "100", sealerL1: SEALER })
		expect(blob).not.toContain(claimSalt)
		expect((await openDepositEnvelope(key, blob)).secret).toBe(claimSalt)
	})

	it("direct-fuel private seals BOTH salts; swap-fueled seals only the token secret (documented asymmetry)", async () => {
		const key = await siteKey()
		// Direct private FUEL (useFuel): the fuel bridge-secret salt is the sole recovery input → sealed.
		const withSalt = await openDepositEnvelope(
			key,
			await sealDepositEnvelope(key, { secret: "0xaa", recipient: RECIP, amount: "1", sealerL1: SEALER, salt: "0xf001" }),
		)
		expect(withSalt.salt).toBe("0xf001")
		// Swap-fueled private (useDeposit): only the TOKEN secret is sealed; the FUEL salt lives in the
		// plaintext journal (record.fuel.bridgeSecretSalt), NOT the sealed blob (a known
		// durability asymmetry: a lost localStorage loses the fuel-salt recovery, never the token one).
		const noSalt = await openDepositEnvelope(
			key,
			await sealDepositEnvelope(key, { secret: "0xbb", recipient: RECIP, amount: "1", sealerL1: SEALER }),
		)
		expect(noSalt.salt).toBeUndefined()
	})
})

describe("v3 cross-chain envelope", () => {
	const RECIP = `0x${"3".repeat(64)}`
	// Stargate shape: T = 100, maxPull = T + 1.5 %, a 10-unit fuel slice ⇒ window [90, 101.5].
	const ROUTE = { minReceived: "100000000", maxPull: "101500000" }
	const FUELED = { intent: "token+gas" as const, route: ROUTE, fuel: { amount: "10000000" } }

	it("accepts both ends of [minReceived − fuelSlice, maxPull] and refuses one unit outside either", async () => {
		const window = crossChainAmountWindow(FUELED)
		expect(window).toEqual({ minAmount: "90000000", maxAmount: "101500000" })
		expect(crossChainAmountWindow({ intent: "token", route: ROUTE })).toEqual({ minAmount: "100000000", maxAmount: "101500000" })
		expect(crossChainAmountWindow({ intent: "gas", route: { minReceived: "5", maxPull: "5" }, fuel: { amount: "5" } })).toEqual({
			minAmount: "0",
			maxAmount: "5",
		})
		expect(() => crossChainAmountWindow({ ...FUELED, fuel: { amount: "100000001" } })).toThrow(/exceeds/)
		expect(() => crossChainAmountWindow({ ...FUELED, fuel: undefined })).toThrow(/fuel slice/)
		const key = await siteKey()
		const blob = await sealDepositEnvelopeV3(key, { secret: SECRET, recipient: RECIP, sealerL1: "0xs", ...window })
		const env = await openDepositEnvelopeV3(key, blob)
		// 90: the swap consumed the whole slice; 101.5: it consumed almost none and the rest joined the token leg.
		for (const amount of ["90000000", "101500000"]) {
			expect(envelopeV3MatchesRecord(env, { recipient: RECIP.toUpperCase(), amount })).toBe(true)
		}
		for (const amount of ["89999999", "101500001"]) expect(envelopeV3MatchesRecord(env, { recipient: RECIP, amount })).toBe(false)
		expect(envelopeV3MatchesRecord(env, { recipient: `0x${"4".repeat(64)}`, amount: "95000000" })).toBe(false)
	})

	it("neither version opens as the other", async () => {
		const key = await siteKey()
		const v3 = await sealDepositEnvelopeV3(key, { secret: SECRET, recipient: RECIP, minAmount: "1", maxAmount: "2", sealerL1: "0xs" })
		const v2 = await sealDepositEnvelope(key, { secret: SECRET, recipient: RECIP, amount: "1", sealerL1: "0xs" })
		await expect(openDepositEnvelope(key, v3)).rejects.toThrow(/not a v2 envelope/)
		await expect(openDepositEnvelopeV3(key, v2)).rejects.toThrow(/not a v3 envelope/)
		const inverted = { v: 3, secret: SECRET, recipient: RECIP, minAmount: "2", maxAmount: "1", sealerL1: "0xs" }
		await expect(openDepositEnvelopeV3(key, await key.seal(JSON.stringify(inverted)))).rejects.toThrow(/not a v3 envelope/)
	})

	it("re-seals a matched v3 as an exact v2 under the in-memory key; an unmatched deposit seals nothing", async () => {
		const calls: string[] = []
		const envelope = { secret: SECRET, recipient: RECIP, sealerL1: "0xs", salt: "0x5a17", ...crossChainAmountWindow(FUELED) }
		const { blob, key } = await sealCrossChainDepositRecord({ sign: signer("a", calls), binding: BINDING, envelope, trusted: false })
		expect(calls).toHaveLength(2)
		const v3 = await openDepositEnvelopeV3(key, blob)
		const exact = await resealExactEnvelope(key, v3, { recipient: RECIP, amount: "101090000", leafIndex: "8" })
		expect(calls).toHaveLength(2)
		expect(keyTextOf(exact)).toBe("site")
		const v2 = await openDepositEnvelope(key, exact)
		expect(v2).toEqual({ v: 2, secret: SECRET, recipient: RECIP, amount: "101090000", sealerL1: "0xs", leafIndex: "8", salt: "0x5a17" })
		expect(envelopeMatchesRecord(v2, { recipient: RECIP, amount: "101090000", leafIndex: "8" })).toBe(true)
		await expect(resealExactEnvelope(key, v3, { recipient: RECIP, amount: "101500001" })).rejects.toThrow(/does not match/)
	})

	it("an exact reseal keeps the text of the key that opened the v3", async () => {
		const legacy = await RecoveryKey.derive(signer(), BINDING, "legacy")
		const blob = await sealDepositEnvelopeV3(legacy, {
			secret: SECRET,
			recipient: RECIP,
			minAmount: "1",
			maxAmount: "2",
			sealerL1: "0xs",
		})
		const exact = await resealExactEnvelope(legacy, await openDepositEnvelopeV3(legacy, blob), { recipient: RECIP, amount: "2" })
		expect([keyTextOf(blob), keyTextOf(exact)]).toEqual(["legacy", "legacy"])
		expect((await openDepositEnvelope(await RecoveryKey.derive(signer(), BINDING, "legacy"), exact)).amount).toBe("2")
	})
})
