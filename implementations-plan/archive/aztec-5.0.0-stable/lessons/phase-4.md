# Phase 4 ✓ — Noir surface + shift inventory

## Gate result: ✅ green
All 3 contracts compile + transpile + path-scrub clean on the 5.0.0 toolchain (FIRST TRY — no mixed-set errors); `test:all` exit 0 (423 faucet + 128 bridge-core); `lint` 0; builds 0. `verify:deployments` intentionally RED (the drift detector — see the inventory).

## What shipped
- `compile.sh` → `~/.aztec/versions/5.0.0` (toolchain installed; the installer's foundry step aborts if ANY anvil runs on the machine and then SKIPS the npm phase — completed manually: foundry 1.4.1 binaries copied from rc.2, byte-identical per upstream's pin; `npm install @aztec/aztec@5.0.0 @aztec/cli-wallet@5.0.0 @aztec/bb.js@5.0.0 --prefix ~/.aztec/versions/5.0.0`).
- Nargo tags: aztec-nr + `token_portal_content_hash_lib` ×3 → `v5.0.0` (upstream tag SHA `c5db195d…`, recorded at bump time in phase-1 lessons).
- **The last live `@defi-wonderland` reference closed**: `token_minter_proxy`'s `token` dep → `git = "alejoamiras/ecosystem-tooling", tag = "v5.0.0", directory = "packages/aztec-standards/src/token_contract"` (tag SHA `45c0c578…` == the npm provenance commit — the Noir source and the published npm artifacts are the same revision). Compiled clean against aztec-nr v5.0.0 → Inference 5 verified empirically.
- `token_bridge/src/main.nr`: `consume_l1_to_l2_message(content, [secret], …)` at BOTH sites (:98 public claim, :115 private claim) — the only Noir break; everything else grep-clean and compile-confirmed.
- Artifacts recompiled + committed (token_bridge, token_minter_proxy, keystone).
- **Portal-fork pins: NO change needed** — `build-portal-artifact.ts` rebuilt against the 5.0.0 node_modules produced a byte-identical forked portal artifact (solc 0.8.30, initCodeHash `0x788602…`, runtimeCodeHash `0x851a50…`); the rc.2→5.0.0 l1-contracts interfaces our fork imports are unchanged.

## SHIFT INVENTORY (Phase 5's redeploy checklist — drift EXPECTED and TOTAL: the network reset)

| Identity | Old (rc.2 live) | 5.0.0-derived (Phase 5 lands here) |
|---|---|---|
| rollupVersion / wallet chainId | `2787991301` / `2793892258` | **`1821665230` / `1816023401`** (live probe) |
| FeeJuicePortal (L1) | `0xb06ac815…` | **`0xB4A9F8Ea…`** (from the live node; re-verify at pre-flight) |
| dripper | `0x127f76a6…91b40c40` | **`0x08699952…e287a9b8`** (verify:deployments computed) |
| TKA (usdc) | `0x22f86df1…a598b522` | **`0x1c22b375…6d1fedb9`** |
| TKB (eth) | `0x12d13bce…c399f05e` | **`0x1155425b…93001159`** |
| PrivateFPC | `0x0d4b2c28…` (operator salt 0) | **`0x257aa870…efc86e9` at CANONICAL salt `0x…01`** (re-pinned Phase 2; derivation + digest cross-checked; hardened gate GREEN live — address clean-absent, deploy owed) |
| SponsoredFPC (salt 0) | `0x0628377e…3fe1` | **UNCHANGED `0x0628377e…3fe1`** — the 5.0.0 sandbox e2e deployed the same address (universal-deploy determinism), and the accelerator's live testnet instance sits there FUNDED (1000 FJ) — reuse, no deploy |
| bridge / proxy / keystone | manifest metas (rc.2) | fresh candidate-first redeploy (addresses derive from the NEW deployer accounts — the signing-key-root change shifts deployer L2 addresses too, so no meaningful pre-derive; the candidate IS the inventory) |
| L1 fuel router / swap | `0x4c3fcd14…` / `0xAb3a9a9F…` | redeploy (router binds the NEW FeeJuicePortal at construction) |
| L1 AZLO + pools | `0x457f9c…` + pools | fresh AZLO minted by the bridge deploy ⇒ pool re-seed (ETH/FJ pool persists) |

Detector states: `verify:deployments` RED (all three `[DRIFT]`, computed values above) · PrivateFPC tripwire GREEN at the canonical pin (consciously re-pinned Phase 2, both cross-checks; fresh-artifact re-verify green — the fee-payment artifact is npm-sourced, unaffected by our contract recompiles) · hardened `check-fpc-version.ts` GREEN live (exact 5.0.0 agreement, digest match, RPC-error≠absence).

## Gotchas
- The ecosystem-tooling `token` dep's `generic_proxy` path dependency resolves fine in nargo git checkouts (as inferred).
- `aztec compile` was clean this cycle — the rc.2 stack-overflow masking didn't recur; keep the raw `aztec-nargo` + `ulimit` trick in the runbook regardless.

LESSONS_FILE=implementations-plan/archive/aztec-5.0.0-stable/lessons/phase-4.md
