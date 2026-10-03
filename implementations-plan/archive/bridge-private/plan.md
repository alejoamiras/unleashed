## Outcome

Archived. Seeds retired.

# Bridge — private L1↔L2 flows

Branch: the task branch, off the merged public bridge.
Goal: add the PRIVATE deposit + withdraw paths to the faucet bridge, testnet-validated, faucet quality. Reuse the proven public infra (the `claim_*.simulate()` sync-gate, the in-flight dedup, the persisted recovery, the proven-epoch wait); add only the private contract calls, the bearer-secret seal, and the public/private toggles.

## Why private differs (load-bearing facts)
- Private deposit content hash = `get_mint_to_private_content_hash(amount)` — **amount only, no recipient** (`packages/bridge-aztec/token_bridge/src/main.nr:114`). So the claim secret is a **bearer credential**: whoever holds `secret` + `leafIndex` can `claim_private` to their own address.
- Therefore the private claim secret MUST be sealed at rest (`packages/bridge-core/src/recovery-crypto.ts`: `recoveryKeyFromSignature` → `sealSecret` / `openSecret`), and the UI must warn before any export. Never log it.
- Private balance is `balance_of_private` (a `#[external("utility")]` — read via `executeUtility`, not `.simulate()`).
- The combined manifest already scopes `claim_private` / `exit_to_l1_private` / `burn_private` (sim + tx) — verify in PV4.

## Phases (status = source of truth)
- **PV1 — private deposit** ✅ CODE-COMPLETE (NEEDS MANUAL TEST — see `lessons/phase-1.md`) — `useDeposit` `isPrivate` mode: L1 `depositToAztecPrivate(amount, secretHash)` (no recipient) → seal-before-mint → `claim_private` → `balance_of_private` confirm; `DepositCard` public/private toggle + bearer warning shipped. All 6 codex findings addressed.
- **PV2 — private withdraw** ✅ CODE-COMPLETE (NEEDS MANUAL TEST — see `lessons/phase-2.md`) — `useWithdraw` `isPrivate` mode: OFF-CHAIN `createAuthWit(burn_private)` → `exit_to_l1_private` (ONE tx, witness attached); reuses `consumeExit` unchanged; no bearer secret; `WithdrawCard` toggle + test. codex `019eac9c`.
- **PV3 — seal + bearer warning** ✅ (for deposit) — per-record key + sig-normalize + `sealRecordSecret`/`openRecordSecret` self-test; key-first plaintext minimization; `DepositCard` bearer warning shipped. (PV2 withdraw reuses these primitives if it needs a seal.)
- **PV4 — scopes + tests** ✅ — manifest scopes verified (`capabilities.ts`: `claim_private`/`exit_to_l1_private`/`burn_private` sim+tx, `balance_of_private` utilities, `canCreateAuthWit: true`); DepositCard + WithdrawCard toggle component tests; lint + typecheck + 142 tests + faucet build all green.
- **PV5 — gates** 🔄 — codex post-impl audit DONE (`019eacad`): 1 CRITICAL FIXED + pinned (block a 2nd deposit while one is pending — overwrite would strand the bearer blob); 2 HIGH + 1 MEDIUM SURFACED as shared-recovery hardening decisions (localStorage-tamper recipient auth; balance-heuristic completion; chain/account persist — see `lessons/phase-5.md`); logging MEDIUM deferred per the user. Remaining (USER): `/code-review max --fix`, the 2 manual testnet tests, and a decision on the surfaced hardening.

## Security & adversarial
- Bearer secret: sealed at rest; UI warns before export; never logged (the public-flow resume-log leak is already fixed on the base branch).
- Deterministic-signature reliance for the seal key (RFC-6979). Non-deterministic wallets → unrecoverable seal → stranded private claim on refresh. Surface a clear failure; consider a fallback. (codex this in PV3.)
- Recipient-commitment alternative (bind recipient into the content hash, hidden on L1) is structurally stronger but a **contract change** (bridge-aztec + re-deploy + re-audit) — deferred; sealing is the MVP path.

## Manual-test handoff (the loop can't prove these headless)
Private deposit/withdraw need real Aztec + Rabby signatures and a private-note claim. The loop implements + unit/integration-tests each path, then STOPS that thread with a `NEEDS MANUAL TEST: <action + expected>` note — never fakes a pass.
