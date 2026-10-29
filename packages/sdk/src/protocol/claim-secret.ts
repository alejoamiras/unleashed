/**
 * Recipient-committed private-claim secret derivation — the TS mirror of the Noir
 * `claim_secret_lib::derive_claim_secret` (contracts/bridge/aztec/claim_secret/src/lib.nr).
 *
 * A PRIVATE token bridge deposits on L1 with `secretHash = computeSecretHash(deriveTokenClaimSecret(salt,
 * recipient))`; on L2 `claim_private(recipient, amount, salt, leaf)` re-derives the same secret from the
 * recipient ARGUMENT and consumes the message. A claim naming a different recipient derives a different
 * secret whose hash can't match — so a relayer holding (salt, recipient, amount, leaf) can submit the
 * claim FOR the user but can never redirect the funds. Security comes from there being no raw-secret
 * consumption path anywhere (sole-consumer invariant), NOT from the secret staying private — the relayer
 * necessarily learns it.
 *
 * The derivation MUST byte-match the Noir side; the keystone (claim-secret.test.ts here + keystone/src/main.nr)
 * pins both toolchains against fixed vectors so an `@aztec` crypto change can never silently strand a deposit.
 */
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"

/**
 * Domain separator: `poseidon2_hash_bytes("unleashed_dom_sep__token_bridge_private_claim_secret") as u32`.
 * Mirrors the Noir `DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET`. PINNED as a literal (NOT computed at
 * load): a poseidon call at module-load time crashes non-node consumers (the tools app's jsdom test env
 * throws before Barretenberg is initialized) — same constraint as `private-fuel.ts`. The keystone test
 * re-derives this in node and asserts equality; that is the drift tripwire. Distinct from the FPC fuel
 * separator (3952304070) and the protocol secret-hash separator (4199652938) — cross-protocol reuse hygiene.
 */
export const DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET = 2317478496

/**
 * The claim secret a private token-bridge deposit binds to: `poseidon2([salt, recipient], DOM_SEP)`.
 * `claim_private` reconstructs it from its `recipient` argument, so a RANDOM secret would strand the
 * deposit — the flow MUST inject this for private token deposits (public deposits keep `Fr.random()`,
 * since `claim_public`'s content hash already binds the recipient).
 *
 * PRIVACY INVARIANT — `salt` MUST be a full-entropy random field (`Fr.random()`), NEVER a deterministic
 * or low-entropy value. The private deposit's `secret_hash = computeSecretHash(deriveTokenClaimSecret(
 * salt, recipient))` is written to L1 IN THE CLEAR and the amount is public, so an observer who guesses
 * a small `salt` space can brute-force `(salt, recipient)` and DE-ANONYMIZE the recipient BEFORE the
 * claim — no salt leak required. `Fr.random()` (~254 bits) makes this infeasible; a "deterministic /
 * recoverable salt" convenience refactor would silently break recipient-privacy for EVERY private
 * deposit. This is distinct from the salt-LEAK → linkage risk (see the README). Pinned by
 * `claim-secret.test.ts` ("two private deposits to the same recipient yield different secret hashes").
 */
export const deriveTokenClaimSecret = (salt: Fr, recipient: AztecAddress): Fr =>
	poseidon2HashWithSeparator([salt, recipient], DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET)

/** The `secretHash` for the L1 `depositToAztecPrivate` call — `computeSecretHash` of the derived secret. */
export const tokenClaimSecretHash = (salt: Fr, recipient: AztecAddress): Promise<Fr> =>
	computeSecretHash(deriveTokenClaimSecret(salt, recipient))
