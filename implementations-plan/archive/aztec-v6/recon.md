# Recon: aztec-v6

Read against `main`. One batched reuse sweep, plus driver probes of the live nodes, npm and GitHub.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Bump checklist (pins, lockfile, excludes, patches, couplings) | `UPDATE.md` | reuse-as-is; update it to the new scope at the end |
| Classify the bump, Noir surface, drift detectors, new generation | `.claude/skills/bridge-generation/SKILL.md` (Phase 0/1, Branch B steps 1–11) | reuse-as-is; this plan's phases follow it |
| Toolchain resolution for the sandbox | `packages/bridge-core/scripts/sandbox/local-network.ts:240-280` (reads the `@aztec/aztec.js` pin, refuses a partial `~/.aztec/versions/<v>`) | adapt: read `@aztec-labs/aztec.js` |
| CI toolchain resolution | `.github/actions/setup-aztec/action.yml:32`, `_bridge-contracts.yml:284`, `_tools-e2e.yml:43` | adapt: same key rename |
| Noir compile + class-id parity | `contracts/bridge/aztec/scripts/compile.sh` (`--check`), `nargo-5.sh` | adapt: `AZTEC_HOME` → 6.0.0-rc.1; rename the version-named wrapper |
| TXE suite | `contracts/bridge/aztec/txe-server` (frozen lockfile), `scripts/run-txe-tests.sh:77,90,103` | adapt: `@aztec-labs/txe`, new bin path |
| Noir wasm package.json exports patch | `patches/@aztec%2Fnoir-{acvm_js,noirc_abi}@5.2.0.patch` | adapt: still needed (`@aztec-foundation/noir-acvm_js@6.0.0-rc.1` still ships `module` with no `exports`); regenerate under the new names |
| Fee Juice artifact for `Contract.at(addr, artifact)` | `deposit-flow.ts:284-285` and six scripts import `@aztec/noir-contracts.js/FeeJuice` | adapt: move to `@aztec-labs/aztec.js/protocol` (`FeeJuiceContract.withWallet`) or the `@aztec-labs/protocol-contracts` artifact; the package no longer exports FeeJuice |
| SponsoredFPC | `apps/tools/src/contracts/sponsored-fpc.ts`, `scripts/deploy.ts` | reuse: `noir-contracts.js@6.0.0-rc.1` still ships `sponsored_fpc_contract-SponsoredFPC.json`; the address is derived, not pinned |
| L1 Solidity remap | `contracts/bridge/evm/foundry.toml:21-22` → `node_modules/@aztec/l1-artifacts/l1-contracts/src/` | adapt: `@aztec-foundation/l1-artifacts@6.0.0-rc.1` ships `l1-contracts/src` (109 files) |
| Chain identity cascade | `chain-constants.ts`, `wallet-chain-id.ts` and the literal list in SKILL.md Branch B step 1 | reuse |
| New generation deploy | `deploy:generation` conductor + journal, `live-intent.ts` (build/verify/promote), smokes, canaries, `calibrate` | reuse-as-is |
| Faucet redeploy (SIGNAL/NOISE/dripper) | `apps/tools/scripts/deploy.ts` → `deployments.candidate.json` → `promote` | reuse-as-is |
| PrivateFPC gate + deploy | `check-fpc-version.ts`, `deploy-private-fpc-testnet.ts`, `private-fpc-canonical.json` | reuse; the descriptor is re-pinned |
| Drift tripwires | `noir-artifact-classids.test.ts`, `hub-token.test.ts`, `private-fuel.test.ts`, `claim-secret.test.ts` (DOM_SEP literals) | reuse; re-pinned deliberately |
| Wallet peer gate | `scripts/ci-cd/published-packages.test.ts` | adapt: PEERS map to the new scope |
| Keyed runs for deployer keys | `env-exec` (on PATH) → `op-remote` | reuse |
| DelayedPublicMutable 1h floor, `returnTypes`/`decodeFromAbi`, `TxRequest`, `DomainSeparator`, `GasPrice`, removed CLI commands, `ACVM_*`, MultiCallEntrypoint/HandshakeRegistry | none. Searched `git grep -E` for each symbol over the repo, excluding `implementations-plan`, `audit`, `bun.lock`, `*/target/*` and `patches` | N/A: no code change |

## Import surface

- 65 files in `apps/tools`, 59 in `packages/bridge-core` and 1 in `scripts/ci-cd` import `@aztec/*`. Zero TS files under `contracts/` do.
- Pins: `apps/tools/package.json` has 16 `@aztec/*` at 5.2.0; `packages/bridge-core/package.json` has 10; `contracts/bridge/aztec/txe-server/package.json` has `@aztec/txe@5.0.1`.
- Non-TS string references:
  - root `package.json` `patchedDependencies`
  - `apps/tools/vite.config.ts:207` dedupe
  - `apps/tools/tests/browser/test-wallet/vite.config.mts:32-43,88-90`
  - `apps/tools/tests/browser/node-json-imports.mjs:2`
  - `foundry.toml`
  - the CI pin readers
  - `local-network.ts:243`
  - `run-txe-tests.sh`
  - `bunfig.toml`
  - docs: AGENTS.md, UPDATE.md, READMEs, SECURITY.md, SKILL.md
- Every `@aztec/*` package in use exists at `@aztec-labs/*@6.0.0-rc.1`: accounts, aztec.js, constants, ethereum, foundation, noir-contracts.js, protocol-contracts, pxe, standard-contracts, stdlib, wallet-sdk, wallets, kv-store, sqlite3mc-wasm, txe.
- `bb.js`, `noir-acvm_js`, `noir-noirc_abi` and `l1-artifacts` are at `@aztec-foundation/*@6.0.0-rc.1`.
- `@aztec-labs/aztec.js@6.0.0-rc.1` depends on `viem: npm:@aztec/viem@2.38.3`; bridge-core pins 2.38.2.

## Noir surface

- The four crates pin `aztec` from `AztecProtocol/aztec-packages` v5.0.1 (`noir-projects/aztec-nr/aztec`). The hub adds `compressed_string` (same repo), `token_portal_content_hash_lib` (monorepo `noir-contracts/contracts/libs/`) and `token` from `AztecProtocol/aztec-standards` v5.0.1.
- v6 homes, verified via `gh api`:
  - `aztec-labs-eng/aztec-nr` tag `v6.0.0-rc.1` has `aztec/` and `compressed-string/`.
  - `AztecProtocol/aztec-standards` tag `v6.0.0-rc.1` exists, and its `token_contract` depends on `aztec-labs-eng/aztec-nr` `v6.0.0-rc.1`.
  - `token_portal_content_hash_lib` now lives in `aztec-labs-eng/aztec-node` at tag `v6.0.0-rc.1`, `noir-projects/noir-contracts/contracts/libs/token_portal_content_hash_lib` (`lib.nr`, 2971 B).
  - Its `aztec` dep is a path into aztec-node's own copy of aztec-nr, so as a git dep it would pull a second `aztec` crate.
- No `DelayedPublicMutable` anywhere. The hub uses `PublicImmutable`, `PublicMutable` and `Map`.
- Committed artifacts that must be recompiled, since v6 rejects unnamed `outputs.globals`: `keystone/target/keystone.json` and `token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json`.
- Pinned DOM_SEP literals with poseidon tripwires:
  - `claim-secret.ts:29`
  - `private-fuel.ts:27`
  - Noir `claim_secret/src/lib.nr`, `keystone/src/main.nr`. Keystone also uses aztec-nr's public `DOM_SEP__SECRET_HASH`, which is not among the seven made crate-internal.

## Live state

| Node | nodeVersion | rollupVersion | FeeJuicePortal |
|---|---|---|---|
| `lb.drpc.live/aztec-testnet/<key>` (given by the owner) | 6.0.0-rc.1 | 2914217885 | `0x5bb7…2d7f` |
| `v5.testnet.rpc.aztec-labs.com` (current pin) | 5.0.0 | 1821665230 | `0xb4a9…37a3` |
| `lb.drpc.live/aztec-mainnet/<key>` | 5.2.0 | 4248422647 | n/a |

- No `aztec-labs.com` v6 host answers: `v6.testnet.rpc`, `rpc.testnet` and `testnet.rpc` were all probed.
- The rollupVersion moved, so this is a network reset and Branch B is mandatory.

## Toolchain and publications

- `~/.aztec/versions/6.0.0-rc.1` is incomplete: empty `bin/`, no `node_modules`. It needs `aztec-up install 6.0.0-rc.1` before the sandbox or `compile.sh` can run.
- npm:
  - `@aztec-labs/aztec.js@6.0.0-rc.1` is published.
  - `@aztec-foundation/aztec-standards@6.0.0-rc.1` was published inside the release-age window at the time, so it is under the 7-day gate.
  - `@alejoamiras/private-fee-juice` has only 5.0.1 (peers `@aztec/*` 5.0.1).
  - `@alejoamiras/nulo-wallet-crypto`, `@alejoamiras/nulo-resolve-asset` and `@alejoamiras/nulo-wallet-sdk-schema-patch` have only 0.1.0 (peers `@aztec/*` 5.2.0).

## Dedup and collision risks

- A held package that peers the old scope (private-fee-juice 5.0.1, the wallet packages 0.1.0) installs a second `@aztec/*` generation beside `@aztec-labs/*`. SKILL.md gotcha "One `@aztec` generation per bundle": `getVKIndex` uses `instanceof`, so two copies abort. Held packages are tolerable only as interim, uncommitted state.
- `private-fpc-canonical-mainnet.json` pins a 5.x FPC artifact digest. Once the installed artifact is v6, any test comparing the mainnet descriptor to the installed artifact goes red. This is not yet read; verify in phase 1.
