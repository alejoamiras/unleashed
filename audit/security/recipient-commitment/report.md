# Focused re-audit report — recipient-commitment + Permit2-everywhere

**Scope:** the changed surface of the task branch
(see `context.md`) · **Method:** three independent adversarial auditors — Codex (xhigh) + two Claude
subagents (crypto/circuit lens, client/cutover lens) — plus the main agent's own read + the full-stack
gate re-run. Findings below are triaged fix-or-accept; every FIX landed with a test.

## Verdict

**SHIP-FOR-TESTNET · DO-NOT-SHIP-FOR-VALUE.** All three auditors independently found **no Critical**;
the recipient-commitment circuit is cryptographically sound (redirect-impossible, cross-consume-
impossible, degenerate-recipient-guarded — all verified against rc.2 protocol source). The client is
consistently fail-closed and the deleted bearer path leaves zero residue. Codex returned a nominal
"DO-NOT-SHIP" resting on two items that are (1) the **locked A-1 decision** (generic `tokenPortal` — on-
chain portal-binding deferred as documented future work) and (2) a **non-theft, documented** private-
fuel plaintext item (the crypto/client lens correctly rates it Low, not High). Both are already recorded
as **value-token hard-blockers** (Phase 8, `contracts/bridge/evm/README.md`). Nothing new blocks the
testnet-scoped work. Three concrete offline bugs surfaced and were FIXED this phase.

## Auditor convergence

| Property | Codex | Crypto lens | Client lens | Main agent |
|---|---|---|---|---|
| Recipient-commitment redirect-proof | ✅ holds | ✅ holds (protocol-enforced) | ✅ holds | ✅ holds |
| Cross-consume (public↔private) impossible | ✅ | ✅ (content-hash differs) | — | ✅ |
| Deleted bearer path residue | — | — | ✅ CLEARED | ✅ CLEARED |
| L9 salt-v2 downgrade fail-closed | — | — | ✅ fail-CLOSED | ✅ |
| Cutover/recovery durability | — | — | ✅ holds (v2-only unseal) | ✅ (Phase 8 pin) |
| DS distinct from FPC/SECRET_HASH | ✅ | ✅ (grep-verified) | — | ✅ (keystone) |

## Findings — triage

| ID | Sev (auditor) | Title | Disposition |
|---|---|---|---|
| **M2** | Med (crypto) | `check-sole-consumer.sh` bypassable by a multi-line `claim_private` signature (proven live) | **FIXED** + self-test |
| **CX-L1** | Low (codex) | `fuel-testnet.ts` private leg calls `runSwapBridge` without `tokenClaimSalt` (fails closed at F2) | **FIXED** (typecheck) |
| **CL-L1** | Low (client) | Misleading `TODO seal salt` comment (`useDeposit.ts:690`) — fuel salt IS in the whole-record backup | **FIXED** (comment) |
| **H1** | High (crypto) | Noir keystone + `check-sole-consumer.sh` run in NO CI (only the TS mirror runs) | **ACCEPT/defer** → F-003, separate CI plan |
| **CX-H1** | High (codex) | Generic `tokenPortal` = pre-signature phishing surface (both paths) | **ACCEPT** → locked A-1; value-token hard-blocker |
| **CX-H2 / CL-L1b** | High (codex) / Low (client) | Private FUEL secret+salt plaintext-journaled | **ACCEPT** → claimer-committed (non-theft); Phase 8 documented |
| **CX-M1** | Med (codex) | Token+fuel fuel-salt not in `sealedEnvelope` (only whole-record backup) | **ACCEPT** → non-theft; recoverable via backup; follow-up noted |
| **CX-M2 / I1** | Med (codex) / Info (crypto) | No `uint128` bound on L1 amounts → `amount ≥ 2^128` strands (fail-safe) | **ACCEPT** → faucet caps via `maxWholePerTx`; L1 `require` = future |
| **L1** | Low (crypto) | `claim_salt` uniqueness not enforced in derivation (amount not in secret) | **ACCEPT** → happy path uses `Fr.random()`/deposit; no redirect |
| **I2** | Info (crypto) | DS fragility: token vs FPC secret distinguished only by the 32-bit DS | **ACCEPT** → keystone-pinned both toolchains (once H1's CI lands) |
| **INFO-2** | Info (client) | Token claim amount computed, not read from `BridgeWithFuel` event | **ACCEPT** → exact for standard token; strand-not-theft |
| **INFO-3** | Info (client) | `AztecAddress.fromStringUnsafe` for the derivation recipient | **ACCEPT** → canonical round-trip; latent only for non-canonical input |
| **INFO-4** | Info (client) | `leafIndex` tamper uncaught in the pre-finalize seal window | **ACCEPT** → self-DoS only; leaf is chain-recoverable |

## What was FIXED this phase (each with a test)

1. **M2 — sole-consumer tripwire made robust** (`contracts/bridge/aztec/scripts/check-sole-consumer.sh`).
   The old guard's raw-secret regex was line-oriented (`[^)]*` can't cross newlines) so it never matched
   the real multi-line `claim_private(` signature, and its `derive_claim_secret` check matched the bare
   import. The crypto auditor PROVED this by running the real script against a crafted multi-line bearer
   regression → it exited 0. **Fix:** analyse a newline-flattened copy; assert the `claim_private`
   parameter list carries `claim_salt` and contains no `secret` substring (catches `raw_secret` too);
   assert `derive_claim_secret(` is CALLED inside the `claim_private` body (a `(` after the name — not the
   import) alongside its consume. **Test:** a new `--self-test` mode builds the exact multi-line bearer
   regression the old guard accepted plus two more shapes (import-only-no-call, 3-consumers) and asserts
   the guard rejects all three while upholding the real source. `check-sole-consumer.sh --self-test` → green.
2. **CX-L1 — fuel-testnet private leg** (`packages/bridge-core/scripts/fuel-testnet.ts`). Injected a
   per-deposit `tokenClaimSalt` for the private variant; `runSwapBridge` derives the L1-committed secret
   from `(salt, recipient)` and echoes the salt back as `tokenSecretHex`, which the existing
   `claim_private(from, …, tokenSecret, …)` re-derives from. Without it the F2 fail-closed guard threw
   before signing. **Test:** `bun run --cwd packages/bridge-core typecheck` (the script now typechecks
   against the required-`tokenClaimSalt` params; live run is Phase 7).
3. **CL-L1 — misleading comment** (`apps/faucet/src/composables/useDeposit.ts`). Rewrote the stale
   `TODO seal salt` note to state the accurate invariant: the fuel secret is claimer-committed
   (`PrivateFPC.mint_and_pay_fee` re-derives from `msg_sender`), plaintext is a privacy-linkage not a
   theft path, and recovery rides the whole-record backup seal — `sealedEnvelope` deliberately carries
   only the recipient-committed token salt. **Test:** covered by the Phase 8 durability pin
   (`recovery-crypto.test.ts`) that asserts the fuel salt is journal/backup-only, not in the envelope.

Also landed the Phase 3 **relayer deliverable** (`packages/bridge-core/scripts/relay-claim-testnet.ts`
+ the unit-tested pure core `src/relay-claim.ts`, 13 tests) — see `findings/relayer-review.md`.

## Accepted / deferred — rationale

- **CX-H1 (generic `tokenPortal`)** — this is the locked **A-1** decision (user ratified zero-Solidity
  reuse + deferred on-chain portal-binding). The client sources `tokenPortal` only from the bundled
  manifest, never user/URL input (client lens confirmed), so the phishing surface requires a hostile
  frontend reusing the router — out of scope for the official faucet. Documented as a value-token hard-
  blocker for BOTH paths (`contracts/bridge/evm/README.md`). Not re-litigated.
- **CX-H2/CX-M1 (private-fuel plaintext + unsealed fuel salt)** — non-theft: the fuel secret is
  claimer-committed. The crypto/client lens rates it Low; Codex's "front-run/consume" High is overstated
  (the FPC re-derives from `msg_sender`, so a plaintext read cannot consume). Recovery works via the
  whole-record backup. Phase 8 already documented + pinned the fuel salt as journal/backup-only by
  design. **Follow-up (not this plan):** seal the fuel salt in `DepositEnvelopeV2` for parity.
- **CX-M2/I1 (uint128 bound)** — fail-SAFE (strand, not theft), depositor-inflicted, and unreachable via
  the faucet (deposits are capped by the token's `maxWholePerTx`). An L1 `require(amount <= 2^128-1)` is
  future hardening but a Solidity change the zero-new-Solidity decision excludes from this plan.
- **H1 (no CI)** — this is red-team **F-003** (contract tests + keystone not CI-enforced). CI was a
  Phase-0 decision to split into a **separate follow-up plan**. Recorded; the tripwire + keystone are the
  artifacts that plan will wire. Until then they're run manually in the Phase 1/2/9 gates.
- **L1/I2/INFO-2/3/4** — all non-theft, happy-path-safe, latent-only. Recorded for the follow-up.

## Gate — full-stack re-run (Phase 9 gate)

| Layer | Command | Result |
|---|---|---|
| L1 fork (HIGH-3) | `SEPOLIA_RPC_URL=<public> forge test --match-contract SwapBridgeRouterPermit2ForkTest` | 12 PASS, 0 skipped |
| L2 Noir | `aztec-nargo test` (keystone) | 6/6 |
| A2 tripwire | `check-sole-consumer.sh` + `--self-test` | real upheld; 3 regressions rejected |
| TS unit | `bun run --cwd packages/bridge-core test` | 149 pass (20 files; +13 relay-claim) |
| Faucet full | `bun run audit:faucet` | exit 0 |
| Repo | `bun run lint && bun run typecheck:all` | lint 0; typecheck passed |
