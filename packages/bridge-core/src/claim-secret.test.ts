import { poseidon2HashBytes } from "@aztec-labs/foundation/crypto/sync"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it } from "vitest"

import { DOM_SEP__FPC_BRIDGE_SECRET } from "./private-fuel"
import { DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET, deriveTokenClaimSecret, tokenClaimSecretHash } from "./claim-secret"

/**
 * KEYSTONE — the second irreversible-loss gate (recipient-committed private claims). These vectors are
 * the single source of truth that the TS `deriveTokenClaimSecret` byte-matches the Noir
 * `claim_secret_lib::derive_claim_secret` (asserted against the SAME literals in
 * contracts/bridge/aztec/keystone/src/main.nr). A change to `@aztec`'s poseidon, the domain string, or
 * the field ordering breaks one of these — the intended tripwire, since a drift strands every private
 * deposit made against the derivation.
 */
describe("claim-secret keystone", () => {
	// The protocol secret-hash separator computeSecretHash uses (DOM_SEP__SECRET_HASH) — our DS must differ.
	const SECRET_HASH_SEP = 4199652938

	it("DOM_SEP literal equals the runtime poseidon derivation + differs from the FPC/secret-hash separators", () => {
		expect(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET).toBe(2317478496)
		const derived = Number(
			poseidon2HashBytes(Buffer.from("unleashed_dom_sep__token_bridge_private_claim_secret")).toBigInt() & 0xffff_ffffn,
		)
		expect(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET).toBe(derived)
		// Cross-protocol-secret-reuse tripwire: distinct from the private-fuel derivation and the outer hash.
		expect(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET).not.toBe(DOM_SEP__FPC_BRIDGE_SECRET)
		expect(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET).not.toBe(SECRET_HASH_SEP)
	})

	// Fixed (salt, recipient) → (secret, secretHash) vectors, byte-identical to the Noir keystone.
	const vectors: { salt: Fr; recipient: AztecAddress; secret: string; secretHash: string }[] = [
		{
			salt: Fr.zero(),
			recipient: AztecAddress.ZERO,
			secret: "0x1f17a9afc746bb16b48b40e27204959589a14c8da06e6562f1f730e71ba56571",
			secretHash: "0x21dda6113edeb23b9b0267ed92219f361a88095de9c7f47d80c208b3858f42fd",
		},
		{
			salt: new Fr(1n),
			recipient: AztecAddress.fromBigIntUnsafe(2n),
			secret: "0x0e1c1bc4c90f0e15e3c4d18ad4ab43c07f8ff9c230d24a5295b41a32ae9fd397",
			secretHash: "0x1ce9b36531e066f21da630794455329ccf900519a6873e7c9b710b245979ecdc",
		},
		{
			salt: new Fr(0x1234567890abcdefn),
			recipient: AztecAddress.fromBigIntUnsafe(0xdeadbeefn),
			secret: "0x1bf3b96e42ed3d8ce072727e05ea920b23adf8a9effde855584a6a26d9f4eb37",
			secretHash: "0x16b3c095d59a7813e217f2d377b94def432072bf495fae1ef2c15d6ac714b61c",
		},
	]

	it.each(vectors)("derives the pinned secret + secretHash for (salt=$salt)", async ({ salt, recipient, secret, secretHash }) => {
		expect(deriveTokenClaimSecret(salt, recipient).toString()).toBe(secret)
		expect((await tokenClaimSecretHash(salt, recipient)).toString()).toBe(secretHash)
	})
})

/**
 * PRIVACY INVARIANT tripwire: the private deposit's
 * `secret_hash` is L1-public and the amount is public, so recipient-privacy rests ENTIRELY on the salt
 * being full-entropy-random. These pin that (a) the salt genuinely varies the secret_hash — so two
 * random-salt deposits to the SAME recipient are unlinkable — and (b) the entropy MUST come from the
 * salt, since the derivation is otherwise deterministic in (salt, recipient). A future "deterministic /
 * recoverable salt" refactor (which would let an observer brute-force the recipient pre-claim) turns
 * the first test red.
 */
describe("claim-secret privacy invariant (salt entropy)", () => {
	const recipient = AztecAddress.fromBigIntUnsafe(0xc0ffeen)

	it("two DIFFERENT salts → DIFFERENT secretHash for the same recipient (unlinkable with a random salt)", async () => {
		const a = await tokenClaimSecretHash(Fr.random(), recipient)
		const b = await tokenClaimSecretHash(Fr.random(), recipient)
		expect(a.toString()).not.toBe(b.toString())
	})

	it("derivation is deterministic in (salt, recipient) — so entropy MUST come from the salt", async () => {
		const salt = Fr.random()
		const a = await tokenClaimSecretHash(salt, recipient)
		const b = await tokenClaimSecretHash(salt, recipient)
		expect(a.toString()).toBe(b.toString())
	})
})
