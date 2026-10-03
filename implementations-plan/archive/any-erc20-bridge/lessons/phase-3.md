# Phase 3 — Hub + register lib + keystones + CI parity

Arc 2, stacked on the task branch.

## What shipped

- The spike's Aztec side, brought onto the arc branch verbatim (the spike itself never merges): `contracts/bridge/aztec/token_bridge_hub/` (full API — `constructor`, `set_exits_paused`, `register_token` / `register_and_claim_public`, the publish-free `bind_token` / `bind_and_claim_public` harness entrypoints, `_bind` (private-phase consume, D36), `_register`, `claim_public`, `claim_private` (F-007 sole consumer), `exit_to_l1_public/private`, `token_for` / `portal_for`, the `word_to_str` / `derive_token` library methods), its committed transpiled artifact, `txe-manifest.txt` (6 named tests), `src/test/{utils,register,keystone}.nr`; `register_hash/` lib; the keystone crate's two register vectors; `scripts/{nargo-5.sh,run-txe-tests.sh}`; `txe-server/{package.json,bun.lock}` (D24); `packages/bridge-core/src/hub-token.ts` (+ test).
- `scripts/compile.sh`: crate list gains `token_bridge_hub`; **`--check`** rebuilds each crate with the pinned `aztec compile` and requires the fresh artifact's DERIVED class id to equal the committed one (via the new `packages/bridge-core/scripts/noir-class-id.ts`), restoring the committed bytes either way. Verified load-bearing: a one-character mutation of `claim_public` reds it (`0x1d3c…` → `0x185b…`).
- `packages/bridge-core/src/artifacts.ts` exports `tokenBridgeHubArtifact`; `noir-artifact-classids.test.ts` pins the hub's class id (`0x1d3c…` at P3; `0x05cd…` after the arc-2 loop's contract fixes, see phase-4) (the Token pin `0x0225da0f…` was already there).
- `_bridge-contracts.yml`: the `noir` job also runs the hub's oracle-free keystone tests (`aztec-nargo test --force keystone` in the hub crate — D35); new **`hub-parity`** job (setup-bun → `bun install` → `setup-aztec@5.0.1` → `compile.sh --check token_bridge_hub`). actionlint clean.

## Deviations / notes

- **D39's "toolchain mini-project" is unnecessary**: the existing `setup-aztec` action (version read from the crate's `Nargo.toml`) installs `~/.aztec/versions/5.0.1` with the `aztec` CLI and `bb` — exactly what `compile.sh` uses — so the parity job reuses it instead of a second pinned install.
- `aztec compile` has its own skip logic: it rebuilds only when a source is newer than the OLDEST `target/*.json`, and `target/` also holds ignored files (the TXE runner stages `token_contract-Token.json` and leaves a `.bak`). `--check` therefore moves every JSON aside, compiles, compares only the git-tracked artifacts, and moves everything back. (`aztec compile --force` does NOT bypass the wrapper's check — the flag reaches nargo only after the wrapper has decided to skip.)
- The class id, not byte-identity, is the parity criterion: the artifact's debug `file_map` carries machine paths (scrubbed) and the JSON could legitimately differ in non-binding fields; the class id is what a deploy binds.
- The hub crate's plain tests are selected by name (`keystone`) so `aztec-nargo test` in that crate does not sweep in the TXE suite.
- **Verdict B's harness is NOT "hub code unchanged" (D17)**: the publish-free `bind_*` entrypoints are part of the deployed contract. Made inert on a real network in the arc-2 loop (harness-only consumption secret) — recorded in phase-4.

## Gate

- fast ✓ (`lint` 0 errors, `typecheck:all` clean, actionlint clean)
- forge ✓ / halmos ✓ (unchanged since the arc-1 gate: 146 hermetic, 13 proofs by name)
- keystone ✓ 10/10 (`aztec-nargo test --force` in `keystone/`) · hub keystone ✓ 2/2 (`derive_token` vector + oversized word)
- txe ✓ `run-txe-tests.sh --crate token_bridge_hub` — 6/6 named tests, manifest satisfied, exit 0
- core ✓ 298 passed / 1 skipped (incl. the hub class-id pin + `hub-token`)
- `compile.sh --check` ✓ all four crates (proxy `0x0768…`, bridge `0x2cb5…`, hub `0x1d3c…`, keystone = library); tree clean afterwards
