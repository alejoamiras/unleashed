// @vitest-environment node
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { computeFeeJuiceMessageNullifier, L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import { deriveTokenClaimSecret, mintToPrivateContentHash, mintToPublicContentHash } from "@unleashed/bridge-core"
import { describe, expect, it, vi } from "vitest"
import { hubMessageState, recomputeTokenMessageHash, tokenMessageNullifier, tokenMessageState } from "./message-nullifier"

const PORTAL = "0x8fa7ffaf818b7157823340cbf3e0c5b3f0a5a0c0"
const HUB = `0x00${"1a".repeat(31)}`
const RECIPIENT = `0x00${"2b".repeat(31)}`
const SECRET = `0x00${"3c".repeat(31)}`
const SECRET_HASH = `0x00${"4d".repeat(31)}`

const facts = {
	portal: PORTAL,
	chainId: 31337,
	hub: HUB,
	rollupVersion: 1,
	recipient: RECIPIENT,
	amount: 100_000_000n,
	isPrivate: false,
	secretHashHex: SECRET_HASH,
	leafIndex: "7",
}

describe("recomputeTokenMessageHash — the Inbox message from the record's own facts", () => {
	it("is the L1ToL2Message over (portal, chain, hub, version, content, secret hash, leaf index)", async () => {
		const expected = new L1ToL2Message(
			new L1Actor(EthAddress.fromString(PORTAL), 31337),
			new L2Actor(AztecAddress.fromStringUnsafe(HUB), 1),
			Fr.fromString(await mintToPublicContentHash(AztecAddress.fromStringUnsafe(RECIPIENT).toString(), 100_000_000n)),
			Fr.fromString(SECRET_HASH),
			new Fr(7n),
		).hash()
		expect((await recomputeTokenMessageHash(facts)).equals(expected)).toBe(true)
	})

	it("a private mint's content carries the amount only; the recipient moves the hash only when public", async () => {
		const priv = await recomputeTokenMessageHash({ ...facts, isPrivate: true })
		const privOther = await recomputeTokenMessageHash({ ...facts, isPrivate: true, recipient: `0x00${"5e".repeat(31)}` })
		expect(priv.equals(privOther)).toBe(true)
		const expected = new L1ToL2Message(
			new L1Actor(EthAddress.fromString(PORTAL), 31337),
			new L2Actor(AztecAddress.fromStringUnsafe(HUB), 1),
			Fr.fromString(await mintToPrivateContentHash(100_000_000n)),
			Fr.fromString(SECRET_HASH),
			new Fr(7n),
		).hash()
		expect(priv.equals(expected)).toBe(true)
		const pubOther = await recomputeTokenMessageHash({ ...facts, recipient: `0x00${"5e".repeat(31)}` })
		expect(pubOther.equals(await recomputeTokenMessageHash(facts))).toBe(false)
	})

	it.each([
		["the leaf index", { leafIndex: "8" }],
		["the amount", { amount: 1n }],
		["the portal", { portal: "0x0000000000000000000000000000000000000001" }],
		["the secret hash", { secretHashHex: `0x00${"6f".repeat(31)}` }],
		["the rollup version", { rollupVersion: 2 }],
		["the chain", { chainId: 1 }],
	])("changes with %s", async (_what, over) => {
		const a = await recomputeTokenMessageHash(facts)
		const b = await recomputeTokenMessageHash({ ...facts, ...over })
		expect(a.equals(b)).toBe(false)
	})
})

describe("tokenMessageNullifier — the hub's siloed consumption nullifier", () => {
	it("public: poseidon2([message, secret]) under the message-nullifier separator, siloed by the consumer", async () => {
		const message = await recomputeTokenMessageHash(facts)
		const expected = await siloNullifier(
			AztecAddress.fromStringUnsafe(HUB),
			await computeFeeJuiceMessageNullifier(message, Fr.fromString(SECRET)),
		)
		const got = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: message,
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		expect(got.equals(expected)).toBe(true)
	})

	it("private: the consumed secret is derive_claim_secret(salt, recipient), as claim_private derives it", async () => {
		const message = await recomputeTokenMessageHash({ ...facts, isPrivate: true })
		const derived = await deriveTokenClaimSecret(Fr.fromString(SECRET), AztecAddress.fromStringUnsafe(RECIPIENT))
		const expected = await siloNullifier(AztecAddress.fromStringUnsafe(HUB), await computeFeeJuiceMessageNullifier(message, derived))
		const got = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: message,
			secretHex: SECRET,
			isPrivate: true,
			recipient: RECIPIENT,
		})
		expect(got.equals(expected)).toBe(true)
		// The raw salt is never the consumed secret.
		const raw = await siloNullifier(
			AztecAddress.fromStringUnsafe(HUB),
			await computeFeeJuiceMessageNullifier(message, Fr.fromString(SECRET)),
		)
		expect(got.equals(raw)).toBe(false)
	})

	it("a different secret, message or consumer yields a different nullifier", async () => {
		const message = await recomputeTokenMessageHash(facts)
		const base = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: message,
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		const secret = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: message,
			secretHex: `0x00${"7a".repeat(31)}`,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		const other = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: new Fr(1n),
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		const consumer = await tokenMessageNullifier({
			consumer: RECIPIENT,
			messageHash: message,
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		for (const n of [secret, other, consumer]) expect(base.equals(n)).toBe(false)
	})
})

describe("tokenMessageState — the record's message, checked before it is looked up", () => {
	it("a stored hash that recomputes is looked up: witness present ⇒ nullified, absent ⇒ live", async () => {
		const storedMessageHash = (await recomputeTokenMessageHash(facts)).toString()
		const expected = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: await recomputeTokenMessageHash(facts),
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		const seen: string[] = []
		const nullified = async (n: Fr) => {
			seen.push(n.toString())
			return true
		}
		await expect(tokenMessageState({ facts, storedMessageHash, secretHex: SECRET, nullified })).resolves.toBe("nullified")
		expect(seen).toEqual([expected.toString()])
		await expect(tokenMessageState({ facts, storedMessageHash, secretHex: SECRET, nullified: async () => false })).resolves.toBe("live")
	})

	it("a stored hash that does not recompute from the facts is invalid, and nothing is looked up", async () => {
		const nullified = vi.fn(async () => true)
		const wrong = (await recomputeTokenMessageHash({ ...facts, leafIndex: "8" })).toString()
		await expect(tokenMessageState({ facts, storedMessageHash: wrong, secretHex: SECRET, nullified })).resolves.toBe("invalid")
		await expect(tokenMessageState({ facts, storedMessageHash: "0xnothex", secretHex: SECRET, nullified })).resolves.toBe("invalid")
		expect(nullified).not.toHaveBeenCalled()
	})

	it("reads the TOKEN message's nullifier: a fuel-side consumption answers nothing about the token", async () => {
		const storedMessageHash = (await recomputeTokenMessageHash(facts)).toString()
		const fuelFacts = { ...facts, secretHashHex: `0x00${"7b".repeat(31)}`, leafIndex: "8" }
		const fuelNullifier = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: await recomputeTokenMessageHash(fuelFacts),
			secretHex: SECRET,
			isPrivate: false,
			recipient: RECIPIENT,
		})
		const nullified = async (n: Fr) => n.equals(fuelNullifier)
		await expect(tokenMessageState({ facts, storedMessageHash, secretHex: SECRET, nullified })).resolves.toBe("live")
	})

	it("a failing read or unusable facts are unknown, never a verdict", async () => {
		const storedMessageHash = (await recomputeTokenMessageHash(facts)).toString()
		const throwing = async () => {
			throw new Error("rpc down")
		}
		await expect(tokenMessageState({ facts, storedMessageHash, secretHex: SECRET, nullified: throwing })).resolves.toBe("unknown")
		await expect(
			tokenMessageState({
				facts: { ...facts, portal: "not-an-address" },
				storedMessageHash,
				secretHex: SECRET,
				nullified: async () => true,
			}),
		).resolves.toBe("unknown")
	})
})

describe("hubMessageState — a record's facts, the sealed copy's for a private one", () => {
	const rec = {
		schema: 3,
		id: SECRET_HASH,
		direction: "deposit",
		isPrivate: true,
		intent: "token",
		amount: "999", // the display copy; the envelope is the truth
		recipient: `0x00${"5e".repeat(31)}`,
		secretHashHex: SECRET_HASH,
		leafIndex: "7",
		chainId: 31337,
		portal: PORTAL,
		bridge: HUB,
	} as unknown as Parameters<typeof hubMessageState>[0]
	const envelope = { v: 2, secret: SECRET, recipient: RECIPIENT, amount: "100000000", sealerL1: PORTAL, leafIndex: "7" } as Parameters<
		typeof hubMessageState
	>[1]["envelope"]

	it("recomputes the private message from the envelope's amount and recipient, and asks for its nullifier", async () => {
		const message = await recomputeTokenMessageHash({ ...facts, isPrivate: true })
		const expected = await tokenMessageNullifier({
			consumer: HUB,
			messageHash: message,
			secretHex: SECRET,
			isPrivate: true,
			recipient: RECIPIENT,
		})
		const seen: string[] = []
		const state = await hubMessageState(
			{ ...rec, messageHash: message.toString() },
			{ secretHex: SECRET, envelope },
			{ rollupVersion: 1 },
			async (n) => {
				seen.push(n.toString())
				return true
			},
		)
		expect(state).toBe("nullified")
		expect(seen).toEqual([expected.toString()])
	})

	it("a record without its message hash or leaf index is unknown", async () => {
		const nullified = vi.fn(async () => true)
		await expect(
			hubMessageState({ ...rec, leafIndex: undefined }, { secretHex: SECRET, envelope }, { rollupVersion: 1 }, nullified),
		).resolves.toBe("unknown")
		await expect(hubMessageState(rec, { secretHex: SECRET, envelope }, { rollupVersion: 1 }, nullified)).resolves.toBe("unknown")
		expect(nullified).not.toHaveBeenCalled()
	})
})
