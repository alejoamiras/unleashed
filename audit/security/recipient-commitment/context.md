# Focused re-audit — recipient-commitment + Permit2-everywhere (Phase 9)

Scope: the CHANGED SURFACE of the task branch only (52 files, +2964/-485
vs the base branch). This is the plan-mandated Phase 9 re-audit. Not a full bridge re-audit — the earlier
`bridge-redteam` covers the unchanged base; this re-attacks only what moved.

## What changed (the three coupled improvements)

- **(a) bridge-only ERC20 → router `bridge()`** — the direct approve+portal deposit path was DELETED
  from `packages/bridge-core/src/flows.ts` (`runDeposit`/`depositPublic`/`depositPrivate`/`DepositParams`)
  and `apps/faucet/src/composables/useDeposit.ts`. Bridge-only now signs a Permit2 witness and goes
  through the same `SwapBridgeRouter.bridge()` the swap path used.
- **(b) fuel-only → witness-bound Permit2 `bridge()`** — zero new Solidity. The router's `bridge()` is
  pointed at the `FeeJuicePortal` (its `depositToAztecPublic` is ABI-identical to the TokenPortal's).
- **(c) recipient-commitment** — `claim_private` no longer takes a raw bearer secret. It takes a
  per-deposit `claim_salt` and re-derives the consumption secret in-circuit from `(claim_salt, recipient)`.
  Closes red-team F-007; the driver is the new relayer capability.

## The secret-derivation design (independently verified against source)

- `contracts/bridge/aztec/claim_secret/src/lib.nr:26-31` —
  `derive_claim_secret(claim_salt: Field, recipient: AztecAddress) = poseidon2_hash_with_separator([claim_salt, recipient.to_field()], DOM_SEP)`,
  `DOM_SEP = 3140354885` (`lib.nr:24`), pinned literal =
  the poseidon2 byte hash of the claim-secret separator label, as a u32.
- `contracts/bridge/aztec/token_bridge/src/main.nr:113-133` — `claim_private(recipient, amount, claim_salt, message_leaf_index)`:
  `assert(amount > 0)` + `assert(!recipient.is_zero())`, `content_hash = get_mint_to_private_content_hash(amount)`
  (recipient OMITTED — amount only), `secret = derive_claim_secret(claim_salt, recipient)`,
  `consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index)`,
  `mint_to_private(recipient, amount)`.
- TS mirror `packages/bridge-core/src/claim-secret.ts` — same DOM_SEP; keystone-pinned both toolchains.

### Soundness argument (main-agent independent read)

The private L1→L2 message is identified by `(content_hash = H(amount), secret_hash = compute_secret_hash(derive_claim_secret(salt, recipient)), portal, leaf)`.
Recipient is bound ONLY through `secret_hash`, not `content_hash`. `claim_private` re-derives
`secret = derive_claim_secret(salt, recipient_ARG)` from its recipient argument and mints to that SAME
argument (`main.nr:125` derives, `:132` mints — one variable). Therefore:

- **Redirect is impossible.** An attacker calling `claim_private(attacker, amount, salt, leaf)` derives
  `derive_claim_secret(salt, attacker) ≠ derive_claim_secret(salt, original)`, so `compute_secret_hash`
  mismatches the committed `secret_hash` and `consume_l1_to_l2_message` fails. Binding rests on poseidon2
  preimage resistance.
- **A leaked salt is not a bearer credential.** Whoever holds `(salt, recipient, amount, leaf)` can
  only complete the claim TO the originally-bound recipient — the relayer capability, not theft.
- **Cross-consumption is impossible.** `claim_public` consumes `get_mint_to_public_content_hash(to, amount)`
  (a DIFFERENT content hash, includes `to`) with a raw secret; a private message's `content_hash = H(amount)`
  can never match a public consume, and vice-versa. `check-sole-consumer.sh` pins exactly 2 consume sites
  (`main.nr:100` public, `:126` private).

## Verified gate results (Phase 9 gate — all green)

| Layer | Command | Result |
|---|---|---|
| L1 fork (HIGH-3 named-leg) | `SEPOLIA_RPC_URL=<public> forge test --match-contract SwapBridgeRouterPermit2ForkTest` | **12 passed, 0 skipped** incl. `test_fuelOnly_realFeeJuicePortal`, `test_deployedRouter_hasBridgeSelector`, `test_bridge_witnessTamperReverts` |
| L1 fuzz | (Phase 1) `forge test` | 34 passed, 3 fork-skip (RPC-gated), fuzz 256 runs each |
| L2 Noir | `aztec-nargo test` (keystone) | **6/6** incl. `claim_secret_dom_sep_is_pinned`, `claim_secret_vectors_match_ts`, `claim_secret_hash_vectors_match_ts` |
| L2 Noir | `aztec-nargo test` (token_bridge) | compiles, 0 tests (byte-stable artifact) |
| TS unit | `bun run --cwd packages/bridge-core test` | **136 passed** (19 files) |
| Faucet full | `bun run audit:faucet` | exit 0 (typecheck → 426 tests → lint → build OK) |
| Repo | `bun run lint && bun run typecheck:all` | lint exit 0; typecheck passed |

## Residue check (main-agent independent grep)

- **No bearer-secret residue on the private TOKEN path.** Every `Fr.random()` in a claim/deposit path
  is either (i) the salt fed into a recipient-bound derivation (`useDeposit.ts:659` →
  `deriveTokenClaimSecret(secret, recipient)`; `flows.ts:107,323` gated on `isPrivate ? claimSalt : Fr.random`),
  (ii) the PUBLIC-path raw secret (recipient in content hash), (iii) the FUEL leg's FPC-derived secret
  (`useDeposit.ts:637` → `deriveBridgeSecret(salt, claimer)`), or (iv) an authwit nonce (`useWithdraw.ts:220`).
- **Direct path fully deleted.** No live reference to `runDeposit`/`depositPrivate`/`depositPublic`/`DepositParams`
  remains — only comment references in `flows.ts` explaining the removal.
- **Private journal stores no plaintext salt.** `useDeposit.ts:681` `secret: isPrivate ? undefined : secret.toString()`
  — the private salt is not in the plaintext journal `secret` field (sealed in `DepositEnvelopeV2.salt`
  instead; Phase 8 durability test pins the round-trip).

## Known / accepted (carried forward, not new)

- **A-1 on-chain portal-binding is future work** (both bridge-only + fuel-only) — the router takes
  `tokenPortal` as a parameter. Client-side it is manifest-sourced; on-chain hardening (allowlist /
  immutable binding) is documented in `contracts/bridge/evm/README.md` as a value-token hard-blocker.
- **INFO-1** — `MintableERC20` permissionless mint + forced Permit2 allowance: testnet-only, value-token blocker.
- **Private FUEL salt is journal-plaintext, not sealed** (`useDeposit.ts:690-691` `TODO seal salt`) — a
  recovery-durability gap for the fuel leg only (fuel salt → FPC, recipient-bound; not a theft vector).
  Documented in Phase 8 (`recovery-crypto.test.ts` pins that the fuel salt is journal-only).
