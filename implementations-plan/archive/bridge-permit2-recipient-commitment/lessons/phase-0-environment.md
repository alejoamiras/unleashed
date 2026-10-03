# Phase 0 — environment readiness (first build)

Toolchain audited + installed before Phase 1. All three toolchains verified end-to-end against the existing suites (a clean baseline before any change).

## What was found / done

| Tool | State found | Action |
|---|---|---|
| Bun 1.3.14, node 24, git, actionlint, shellcheck | present | — |
| root `node_modules`, local biome | present (`bun install` already run) | — |
| **Foundry** (forge/cast/anvil/chisel 1.7.1) | installed in `~/.foundry/bin` but **not on PATH** | put `~/.foundry/bin` on PATH |
| **Foundry libs** (`contracts/bridge/evm/lib/`, gitignored) | MISSING | `forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts Uniswap/v4-core@v4.0.0` — v4-core pinned to `v4.0.0`/`e50237c4` (MUST, per evm README) |
| **Aztec toolchain 5.0.0-rc.2** (aztec, aztec-nargo, aztec-bb, aztec-pxe, aztec-txe, aztec-anvil) | only the `aztec-up` bootstrap present; not installed | `aztec-up install 5.0.0-rc.2` → `~/.aztec/versions/5.0.0-rc.2/` |
| Docker 29.6.1 | daemon reachable | not needed for these gates (v5 sandbox is native), but available |

## Verified baselines (before any change)

- Foundry: `cd contracts/bridge/evm && forge test` → **29 passed, 0 failed, 3 skipped** (32). The 3 skips are the `SEPOLIA_RPC_URL`-gated fork legs auto-skipping — this is the live demonstration of final-audit HIGH-3: `forge test` exits 0 with the load-bearing fork proof absent, so Phase 1/6/9 gates MUST assert the NAMED fork legs PASSED, not bare exit 0.
- Noir: `bash contracts/bridge/aztec/scripts/compile.sh` transpiled all 3 contracts + generated VKs (incl. `claim_private`); recompiled artifacts are **byte-identical** to the committed ones (deterministic toolchain). `cd contracts/bridge/aztec/keystone && aztec-nargo test` → **3/3 pass**.
- TS: `bun run --cwd packages/bridge-core test` → **129/129 pass** (18 files).

## Exact env each toolchain needs (non-obvious — reuse in every phase)

- **Foundry**: `~/.foundry/bin` on PATH. Standalone from the aztec-bundled `aztec-forge`.
- **Noir/aztec-nargo**: the rc.2 toolchain, NOT the default. `compile.sh` sets it:
  ```
  AZTEC_HOME="$HOME/.aztec/versions/5.0.0-rc.2"
  export PATH="$AZTEC_HOME/bin:$AZTEC_HOME/node_modules/.bin:$PATH"
  ```
  Plain `nargo`/default aztec toolchain FAILS (`#[aztec]` macros don't expand — see the aztec README). Always compile via `compile.sh` (it also path-scrubs the artifacts) and test via `aztec-nargo test` under that PATH.
- **bb** (Barretenberg): `~/.bb/5.0.0-nightly.20260624/` VK cache, auto-populated by the aztec toolchain.

## STILL NEEDED FROM THE USER (secrets — NOT created by the agent)

`packages/bridge-core/.env` and `contracts/bridge/evm/.env` are ABSENT. The fork-test and live-deploy phases need (from `.env.example`):
- `SEPOLIA_RPC_URL` — **required for Phase 1's real fork proof** (without it the fork legs silently skip and the gate is vacuous — HIGH-3) and Phase 5/6 fork rehearsals.
- `PRIVATE_KEY` (funded Sepolia) — Phase 6 live deploy + Phase 7 canaries.
- `ETHERSCAN_API_KEY` (optional, verification), `AZTEC_NODE_URL` (defaults to public testnet RPC).
- `REGISTRY_ADDRESS` / `FEE_JUICE_ADDRESS` / `FEE_JUICE_PORTAL` / `FEE_ASSET_HANDLER` — live addresses for the deploy scripts (from `.env.example` / the current `testnet-bridge.json`).

Phases 1–5 (contract code, Noir, TS, faucet, fuzz, sandbox) run WITHOUT these — only the fork legs and live deploy need them. A `/goal` run can complete Phases 1–5 + the local sandbox (Phase 4) fully offline; it must STOP at the fork-test assertion and the live-deploy/promotion (already gated on explicit go).
