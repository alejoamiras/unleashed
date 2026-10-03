# Phase 1 — Network recon + L1↔L2 interop spike

**Status:** ✅ **P1 DONE** — contracts compile (bridge-evm + both bridge-aztec, rc.2 nargo) · keystone cross-chain hash proven · **recon GO** (ran read-only vs the public testnet RPC — net 4.2.0-compatible, FeeAssetHandler wired). Recon gate CLEARED → P2+ unblocked.

## Toolchain (critical finding — would bite anyone)
- Noir contracts pin aztec-nr `v4.2.0-aztecnr-rc.2`. The machine's default aztec toolchain (`~/.aztec/current` → `4.2.0`) bundles `nargo 1.0.0-beta.19`, which **mismatches** rc.2 → ~1299 errors (`cannot find self`, `Could not resolve 'at'`) because the `#[aztec]` macros don't expand.
- **FIX:** compile with the rc.2 toolchain's nargo: `~/.aztec/versions/4.2.0-aztecnr-rc.2/bin/nargo` (= `nargo 1.0.0-beta.18`). `token_minter_proxy` then compiles clean (exit 0, artifact produced). The matching version was already installed under `~/.aztec/versions/`.
- **Implication:** `bridge-aztec` (and CI) must pin the rc.2 nargo, not the default. Documented in the package README.

## bridge-evm (Foundry) — done
- Scaffold compiles (`forge build` green). Reusable `UniswapFuelSwap` + interfaces verbatim. Libs vendored from the reference (gitignored). `@aztec/` remaps to the installed `@aztec/l1-artifacts` 4.2.0 L1 sources (no aztec-contracts submodule) — version-matched by construction.

## Done (live-net-independent)
- ✅ `token_minter_proxy` compiles (rc.2 nargo).
- ✅ `token_bridge` attestation stripped + compiles (rc.2 nargo); schnorr dep + TXE test module removed.
- ✅ bridge-evm `UniswapFuelSwap` + interfaces compile (`forge build`).

- ✅ **Keystone content-hash equality test (cross-chain proof).** Foundry (`bridge-evm/test/ContentHash.t.sol`) pins the 3 canonical L1 hashes (mint_to_public/private, withdraw) for fixed vectors; the Noir `keystone` crate asserts `token_portal_content_hash_lib` produces the SAME 3 values. `forge test` 3 pass + `nargo test` 3 pass (rc.2). The one cross-chain boundary the TXE can't test is now pinned in both toolchains — a selector/arg-order drift fails both sides. (Note: the R2 canonical-portal decision already makes the L1 hashes canonical-by-lineage; this keystone is the explicit regression pin.)

## P1 recon: ✅ DONE — GO (gate cleared)
Ran read-only against `https://rpc.testnet.aztec-labs.com` + Sepolia public RPC. **The recon needs NO key** — `getNodeInfo()` + the FeeAssetHandler reads are all read-only (the Sepolia key is only for mint/deploy). Result: **GO** — net 4.2.0-compatible (rollupVersion `4127419662`); FeeAssetHandler wired (`FEE_ASSET() == feeJuice 0x762c…`, `mintAmount` 1000 FJ, `mint()` permissionless). Full snapshot + all L1 addresses: `research/recon-testnet.md`.

**P2+ recon gate CLEARED.** Authoring (P2 contracts, bridge-core, frontend + their mock/unit tests) is unblocked. Remaining **operator-gated** steps: actual on-chain **deploys** (Sepolia deployer key), the **P0.5 browser/MetaMask spike**, and **`e2e:agent`** (network sandbox).

## BLOCKED (needs operator infra — the plan's stop-the-line gate)
- Live-net recon go/no-go: `getNodeInfo()` for FeeJuicePortal underlying + `FeeAssetHandler` wiring + `mintAmount` + rollup version. Needs `VITE_AZTEC_NODE_URL` + network egress + a Sepolia key. **Cannot run in CI/sandbox** — must be run on operator infra before P2 deploy-shaping.
