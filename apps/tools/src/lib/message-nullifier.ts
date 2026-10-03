/**
 * The identity of a hub token deposit's L1→L2 message, recomputed from the record's own facts, and
 * the nullifier the hub emits when it consumes that message. Both mirror the Noir side byte for byte:
 * `compute_l1_to_l2_message_hash` (portal, chain, hub, version, content, secret hash, leaf index) and
 * `compute_l1_to_l2_message_nullifier` (poseidon2 over [message_hash, secret], siloed by the hub) —
 * the scheme `computeFeeJuiceMessageNullifier` implements for any consumer that follows it. The leaf
 * index is an input of the message, never of the nullifier.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { siloNullifier } from "@aztec-labs/stdlib/hash"
import { computeFeeJuiceMessageNullifier, L1Actor, L1ToL2Message, L2Actor } from "@aztec-labs/stdlib/messaging"
import {
	type DepositEnvelopeV2,
	deriveTokenClaimSecret,
	feeJuiceAddress,
	mintToPrivateContentHash,
	mintToPublicContentHash,
	type SendDepositRecord,
} from "@unleashed/bridge-core"

export interface TokenMessageFacts {
	/** The token's portal (the L1 sender) and the L1 chain it sent on. */
	portal: string
	chainId: number
	/** The hub (the L2 recipient and the consuming contract) and the rollup version it lives on. */
	hub: string
	rollupVersion: number
	recipient: string
	amount: bigint
	isPrivate: boolean
	secretHashHex: string
	leafIndex: string
}

/** The message hash the Inbox holds for these facts. A public mint's content binds the recipient; a
 *  private mint's content carries only the amount (the recipient is committed through the secret). */
export async function recomputeTokenMessageHash(f: TokenMessageFacts): Promise<Fr> {
	const content = f.isPrivate
		? await mintToPrivateContentHash(f.amount)
		: await mintToPublicContentHash(AztecAddress.fromStringUnsafe(f.recipient).toString(), f.amount)
	const message = new L1ToL2Message(
		new L1Actor(EthAddress.fromString(f.portal), f.chainId),
		new L2Actor(AztecAddress.fromStringUnsafe(f.hub), f.rollupVersion),
		Fr.fromString(content),
		Fr.fromString(f.secretHashHex),
		Fr.fromString(f.leafIndex),
	)
	return message.hash()
}

/** The siloed nullifier `consumer` inserts when it consumes `messageHash` with `secret`. */
export async function consumedMessageNullifier(consumer: string, messageHash: Fr, secret: Fr): Promise<Fr> {
	const inner = await computeFeeJuiceMessageNullifier(messageHash, secret)
	return siloNullifier(AztecAddress.fromStringUnsafe(consumer), inner)
}

/** The siloed nullifier the hub inserts when it consumes `messageHash`. `secretHex` is the record's
 *  claim value: the raw secret of a public deposit, the claim salt of a private one — the private
 *  consumer derives `derive_claim_secret(salt, recipient)` in-circuit, as `claim_private` does. */
export function tokenMessageNullifier(i: {
	consumer: string
	messageHash: Fr
	secretHex: string
	isPrivate: boolean
	recipient: string
}): Promise<Fr> {
	const secret = i.isPrivate
		? deriveTokenClaimSecret(Fr.fromString(i.secretHex), AztecAddress.fromStringUnsafe(i.recipient))
		: Fr.fromString(i.secretHex)
	return consumedMessageNullifier(i.consumer, i.messageHash, secret)
}

/** The nullifier the Fee Juice contract inserts when it claims a public fuel message: the message
 *  key the `BridgeWithFuel` event carried, consumed with the fuel's plaintext secret. */
export function feeJuiceMessageNullifier(fuel: { messageHash: string; secret: string }): Promise<Fr> {
	return consumedMessageNullifier(feeJuiceAddress, Fr.fromString(fuel.messageHash), Fr.fromString(fuel.secret))
}

export type TokenMessageState = "nullified" | "live" | "invalid" | "unknown"

/** Where a hub token deposit's message stands, from the record's own facts: `invalid` when the
 *  stored hash is not the message those facts describe (a proven wrong identity — never looked up),
 *  `nullified`/`live` by the consumer's nullifier, `unknown` when the evidence cannot be produced. */
export async function tokenMessageState(i: {
	facts: TokenMessageFacts
	storedMessageHash: string
	secretHex: string
	nullified: (nullifier: Fr) => Promise<boolean>
}): Promise<TokenMessageState> {
	let message: Fr
	try {
		message = await recomputeTokenMessageHash(i.facts)
	} catch {
		return "unknown"
	}
	let stored: Fr
	try {
		stored = Fr.fromString(i.storedMessageHash)
	} catch {
		return "invalid"
	}
	if (!message.equals(stored)) return "invalid"
	try {
		const nullifier = await tokenMessageNullifier({
			consumer: i.facts.hub,
			messageHash: message,
			secretHex: i.secretHex,
			isPrivate: i.facts.isPrivate,
			recipient: i.facts.recipient,
		})
		return (await i.nullified(nullifier)) ? "nullified" : "live"
	} catch {
		return "unknown"
	}
}

/** A hub token deposit record's message state, from the record's own facts and read at the journal's
 *  settlement floor. A private record's amount and recipient come from the OPENED envelope (the
 *  sealed truth), never the display fields; the hub is the record's `bridge`, the rollup version the
 *  active target's. Unusable facts are `unknown`. */
export function hubMessageState(
	rec: SendDepositRecord,
	material: { secretHex: string; envelope?: DepositEnvelopeV2 },
	identity: { rollupVersion: number },
	nullified: (nullifier: Fr) => Promise<boolean>,
): Promise<TokenMessageState> {
	if (!rec.messageHash || !rec.leafIndex) return Promise.resolve("unknown")
	const truth = material.envelope ?? rec
	let amount: bigint
	try {
		amount = BigInt(truth.amount)
	} catch {
		return Promise.resolve("unknown")
	}
	return tokenMessageState({
		facts: {
			portal: rec.portal,
			chainId: rec.chainId,
			hub: rec.bridge,
			rollupVersion: identity.rollupVersion,
			recipient: truth.recipient,
			amount,
			isPrivate: rec.isPrivate,
			secretHashHex: rec.secretHashHex,
			leafIndex: rec.leafIndex,
		},
		storedMessageHash: rec.messageHash,
		secretHex: material.secretHex,
		nullified,
	})
}
