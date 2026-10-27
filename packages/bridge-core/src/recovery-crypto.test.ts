import { describe, expect, it } from "vitest"
import {
	crossChainAmountWindow,
	envelopeMatchesRecord,
	envelopeV3MatchesRecord,
	normalizeAmount,
	openDepositEnvelope,
	openDepositEnvelopeV3,
	openDepositRecord,
	openRecordSecret,
	openSecret,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
	resealExactEnvelope,
	sealCrossChainDepositRecord,
	sealDepositEnvelope,
	sealDepositEnvelopeV3,
	sealDepositRecord,
	sealRecordSecret,
	sealSecret,
} from "./recovery-crypto"

const SIG_A = `0x${"a".repeat(130)}`
const SIG_B = `0x${"b".repeat(130)}`
const SECRET = "0x1234deadbeefcafe"

describe("recovery-crypto", () => {
	it("round-trips a secret (ciphertext, not plaintext)", async () => {
		const key = await recoveryKeyFromSignature(SIG_A)
		const blob = await sealSecret(key, SECRET)
		expect(blob).not.toContain(SECRET)
		expect(await openSecret(key, blob)).toBe(SECRET)
	})

	it("same signature derives a key that decrypts another instance's blob (re-derivable)", async () => {
		const k1 = await recoveryKeyFromSignature(SIG_A)
		const k2 = await recoveryKeyFromSignature(SIG_A)
		const blob = await sealSecret(k1, SECRET)
		expect(await openSecret(k2, blob)).toBe(SECRET)
	})

	it("a different signature cannot decrypt the blob", async () => {
		const k1 = await recoveryKeyFromSignature(SIG_A)
		const k2 = await recoveryKeyFromSignature(SIG_B)
		const blob = await sealSecret(k1, SECRET)
		await expect(openSecret(k2, blob)).rejects.toThrow()
	})

	it("encrypting twice yields different blobs (random IV) but both decrypt", async () => {
		const key = await recoveryKeyFromSignature(SIG_A)
		const b1 = await sealSecret(key, SECRET)
		const b2 = await sealSecret(key, SECRET)
		expect(b1).not.toBe(b2)
		expect(await openSecret(key, b1)).toBe(SECRET)
		expect(await openSecret(key, b2)).toBe(SECRET)
	})

	it("envelope round-trips an optional private-fuel salt; a non-string salt is rejected", async () => {
		const key = await recoveryKeyFromSignature(SIG_A)
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
		const bad = await sealSecret(key, JSON.stringify({ v: 2, secret: SECRET, recipient: "0xr", amount: "1", sealerL1: "0xs", salt: 7 }))
		await expect(openDepositEnvelope(key, bad)).rejects.toThrow(/not a v2 envelope/)
	})

	it("recoveryKeyMessage is per-record — a different secretHash yields a different message", () => {
		const base = { chainId: 11155111, portal: "0xPortal", bridge: "0xBridge" }
		const mA = recoveryKeyMessage({ ...base, secretHashHex: "0xAAAA" })
		const mB = recoveryKeyMessage({ ...base, secretHashHex: "0xBBBB" })
		expect(mA).not.toBe(mB)
		expect(mA).toContain("chain=11155111")
		expect(mA).toContain("record=0xaaaa") // lowercased
	})

	it("pins the signed message byte for byte: the recovery key is derived from its signature", () => {
		expect(recoveryKeyMessage({ chainId: 11155111, portal: "0xPortal", bridge: "0xBridge", secretHashHex: "0xAAAA" })).toBe(
			"Unleashed Bridge recovery key v1 — sign to locally encrypt ONE in-flight private claim secret.\n" +
				"This is not a transaction and costs nothing.\n" +
				"chain=11155111 portal=0xportal bridge=0xbridge record=0xaaaa",
		)
	})

	it("recoveryKeyFromSignature normalizes case — upper/lower-hex sig derive the same key", async () => {
		const kLower = await recoveryKeyFromSignature(`0x${"a".repeat(130)}`)
		const kUpper = await recoveryKeyFromSignature(`0x${"A".repeat(130)}`)
		const blob = await sealSecret(kLower, SECRET)
		expect(await openSecret(kUpper, blob)).toBe(SECRET)
	})

	const BINDING = { chainId: 11155111, portal: "0xPortal", bridge: "0xBridge", secretHashHex: "0xabc" }

	it("sealRecordSecret round-trips with a deterministic signer", async () => {
		const sign = async () => `0x${"a".repeat(130)}`
		const blob = await sealRecordSecret(sign, BINDING, SECRET)
		expect(blob).not.toContain(SECRET)
		expect(await openRecordSecret(sign, BINDING, blob)).toBe(SECRET)
	})

	it("sealRecordSecret aborts on a non-deterministic signer (recovery self-test)", async () => {
		let n = 0
		const sign = async () => `0x${String(n++).padEnd(130, "0")}`
		await expect(sealRecordSecret(sign, BINDING, SECRET)).rejects.toThrow(/self-test/i)
	})
})

const BINDING = { chainId: 11155111, portal: "0xPortal", bridge: "0xBridge", secretHashHex: "0xabc" }

const ENVELOPE = {
	secret: "0x1234deadbeefcafe",
	recipient: "0xAzTecRecipient",
	amount: "100000000",
	sealerL1: "0xSealerAddr",
}

describe("v2 deposit envelope", () => {
	it("round-trips with all fields, normalizing the amount", async () => {
		const key = await recoveryKeyFromSignature(`0x${"a".repeat(130)}`)
		const blob = await sealDepositEnvelope(key, { ...ENVELOPE, amount: "0100000000" as never, leafIndex: "42" })
		expect(blob).not.toContain(ENVELOPE.secret)
		const env = await openDepositEnvelope(key, blob)
		expect(env).toMatchObject({ v: 2, ...ENVELOPE, amount: "100000000", leafIndex: "42" })
	})

	it("tampered ciphertext throws (GCM auth)", async () => {
		const key = await recoveryKeyFromSignature(`0x${"a".repeat(130)}`)
		const blob = await sealDepositEnvelope(key, ENVELOPE)
		const i = Math.floor(blob.length / 2)
		const flipped = blob.slice(0, i) + (blob[i] === "A" ? "B" : "A") + blob.slice(i + 1)
		await expect(openDepositEnvelope(key, flipped)).rejects.toThrow()
	})

	it("REJECTS a bare-secret blob — no fallback (the downgrade-attack pin)", async () => {
		const key = await recoveryKeyFromSignature(`0x${"a".repeat(130)}`)
		const bareBlob = await sealSecret(key, "0x1234deadbeefcafe")
		await expect(openDepositEnvelope(key, bareBlob)).rejects.toThrow(/not a v2 envelope/i)
	})

	it("REJECTS valid JSON that isn't a v2 envelope shape", async () => {
		const key = await recoveryKeyFromSignature(`0x${"a".repeat(130)}`)
		const blob = await sealSecret(key, JSON.stringify({ v: 1, secret: "0x1" }))
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
	const detSign = (calls: { n: number }) => async () => {
		calls.n++
		return `0x${"a".repeat(130)}`
	}

	it("trusted ⇒ exactly ONE signature, no self-test; blob opens with the returned key", async () => {
		const calls = { n: 0 }
		const { blob, key } = await sealDepositRecord({ sign: detSign(calls), binding: BINDING, envelope: ENVELOPE, trusted: true })
		expect(calls.n).toBe(1)
		expect((await openDepositEnvelope(key, blob)).secret).toBe(ENVELOPE.secret)
	})

	it("untrusted ⇒ exactly TWO signatures (self-test)", async () => {
		const calls = { n: 0 }
		await sealDepositRecord({ sign: detSign(calls), binding: BINDING, envelope: ENVELOPE, trusted: false })
		expect(calls.n).toBe(2)
	})

	it("untrusted + non-deterministic signer ⇒ aborts before any irreversible tx", async () => {
		let n = 0
		const sign = async () => `0x${String(n++).padEnd(130, "0")}`
		await expect(sealDepositRecord({ sign, binding: BINDING, envelope: ENVELOPE, trusted: false })).rejects.toThrow(/self-test/i)
	})

	it("the retained key re-seals a finalized envelope (leafIndex) with ZERO further signatures", async () => {
		const calls = { n: 0 }
		const { key } = await sealDepositRecord({ sign: detSign(calls), binding: BINDING, envelope: ENVELOPE, trusted: true })
		const finalized = await sealDepositEnvelope(key, { ...ENVELOPE, leafIndex: "108239872" })
		expect(calls.n).toBe(1)
		expect((await openDepositEnvelope(key, finalized)).leafIndex).toBe("108239872")
	})

	it("openDepositRecord re-derives the key with one signature and returns envelope + key", async () => {
		const calls = { n: 0 }
		const sign = detSign(calls)
		const { blob } = await sealDepositRecord({ sign, binding: BINDING, envelope: ENVELOPE, trusted: true })
		const { envelope, key } = await openDepositRecord(sign, BINDING, blob)
		expect(calls.n).toBe(2)
		expect(envelope.recipient).toBe(ENVELOPE.recipient)
		expect((await openDepositEnvelope(key, blob)).secret).toBe(ENVELOPE.secret)
	})
})

describe("recovery-crypto — recipient-committed backup durability", () => {
	const RECIP = `0x${"3".repeat(64)}`
	const SEALER = `0x${"1".repeat(40)}`

	it("the token claim-salt round-trips the sealed envelope (the strand-prevention credential)", async () => {
		// For a recipient-committed PRIVATE token deposit the sealed `secret` field IS the claim_salt
		// (claim_private re-derives the consumption secret from it + the recipient), so it MUST survive
		// the sealed backup — losing it strands the deposit.
		const key = await recoveryKeyFromSignature(SIG_A)
		const claimSalt = "0x07abc0ffee1234"
		const blob = await sealDepositEnvelope(key, { secret: claimSalt, recipient: RECIP, amount: "100", sealerL1: SEALER })
		expect(blob).not.toContain(claimSalt)
		expect((await openDepositEnvelope(key, blob)).secret).toBe(claimSalt)
	})

	it("direct-fuel private seals BOTH salts; swap-fueled seals only the token secret (documented asymmetry)", async () => {
		const key = await recoveryKeyFromSignature(SIG_A)
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
		const key = await recoveryKeyFromSignature(SIG_A)
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
		const key = await recoveryKeyFromSignature(SIG_A)
		const v3 = await sealDepositEnvelopeV3(key, { secret: SECRET, recipient: RECIP, minAmount: "1", maxAmount: "2", sealerL1: "0xs" })
		const v2 = await sealDepositEnvelope(key, { secret: SECRET, recipient: RECIP, amount: "1", sealerL1: "0xs" })
		await expect(openDepositEnvelope(key, v3)).rejects.toThrow(/not a v2 envelope/)
		await expect(openDepositEnvelopeV3(key, v2)).rejects.toThrow(/not a v3 envelope/)
		const inverted = { v: 3, secret: SECRET, recipient: RECIP, minAmount: "2", maxAmount: "1", sealerL1: "0xs" }
		await expect(openDepositEnvelopeV3(key, await sealSecret(key, JSON.stringify(inverted)))).rejects.toThrow(/not a v3 envelope/)
	})

	it("re-seals a matched v3 as an exact v2 under the in-memory key; an unmatched deposit seals nothing", async () => {
		let signatures = 0
		const sign = async () => {
			signatures++
			return SIG_A
		}
		const envelope = { secret: SECRET, recipient: RECIP, sealerL1: "0xs", salt: "0x5a17", ...crossChainAmountWindow(FUELED) }
		const { blob, key } = await sealCrossChainDepositRecord({ sign, binding: BINDING, envelope, trusted: false })
		expect(signatures).toBe(2)
		const v3 = await openDepositEnvelopeV3(key, blob)
		const exact = await resealExactEnvelope(key, v3, { recipient: RECIP, amount: "101090000", leafIndex: "8" })
		expect(signatures).toBe(2)
		const v2 = await openDepositEnvelope(key, exact)
		expect(v2).toEqual({ v: 2, secret: SECRET, recipient: RECIP, amount: "101090000", sealerL1: "0xs", leafIndex: "8", salt: "0x5a17" })
		expect(envelopeMatchesRecord(v2, { recipient: RECIP, amount: "101090000", leafIndex: "8" })).toBe(true)
		await expect(resealExactEnvelope(key, v3, { recipient: RECIP, amount: "101500001" })).rejects.toThrow(/does not match/)
	})
})
