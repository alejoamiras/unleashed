# aztec-rc3 recon

Read-only recon against `origin/main` at `aecf311`, plus the open `lifi-routing` stack (#7–#14) and the
upstream sources named below. Three Sonnet explorers (bump surface, dRPC keys, PrivateFPC) and direct
probes by the lead. No key appears in this file: every dRPC URL is written `…/<KEY>`.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Pin surface, lockfile, patches | UPDATE.md § The pin surface; `aztec-line.test.ts`, `published-packages.test.ts` | adapt: `aztec-line.test.ts` holds one `PIN` for both scopes; labs rc.3 + foundation rc.6 + standards rc.3 needs a per-scope rule |
| Noir line | `compile.sh`, `nargo.sh`, `run-txe-tests.sh`, the six `Nargo.toml` tags, vendored `token_portal_content_hash_lib` | reuse; re-vendor the lib from `aztec-labs-eng/aztec-node` `v6.0.0-rc.3` (`noir-projects/noir-contracts/contracts/libs/token_portal_content_hash_lib`) |
| Generation deploy | `live-intent.ts`, `deploy-generation.ts`, `generation.ts`, the canaries, the `bridge-generation` skill Branch B | reuse as-is; the shape depends on whether `lifi-routing` lands first (below) |
| Reset baseline | the hand-written baseline in `archive/aztec-v6/lessons/` and `NO_RESET_BASELINE` | reuse the procedure; write a new baseline in this plan's `lessons/` |
| Chain cascade | `chain-constants.ts`, `walletChainIdOf`, the test literals listed in § Identities | reuse |
| PrivateFPC pin | `private-fuel.ts`, `private-fpc-canonical.json`, `private-fuel.test.ts` (holds the pin equal to the package's `canonical-deployment.json`), `check-fpc-version.ts` checks 1–3 | reuse; drop check 4's `require-deployed` absence rule and the deploy scripts (§ PrivateFPC) |
| Node URL for scripts | `process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL` in 12 scripts | adapt: make `AZTEC_NODE_URL` required, remove the keyed default |
| Keyed-run templates | `testnet-l1`, `testnet-generation`, `testnet-provision`, `testnet-faucet` `.env.example` (`op://Keyed-Runs/Unleashed-Testnet/<FIELD>`) | adapt: add `AZTEC_NODE_URL` to the run templates that reach the node |
| URL redaction | none: searched `redact`, `maskUrl`, `origin only` in `packages/` and `apps/` | build new: one helper in bridge-core that keeps the origin and drops the path |
| Browser node URL + CSP | `network-targets.ts` (`TESTNET_NODE_SOURCE`, `cspConnectSrc`), `vite.config.ts` `cspFor`, `network-targets.test.ts` | reuse; the CSP follows the constant |
| Preview host rule | `build-integrity.ts` `isPreviewHostOf`, `preview-hosts.ts` | reuse as the allowlist source |

## Bump surface

- **Pins to rc.3**: every `@aztec-labs/*` in `apps/tools`, `packages/bridge-core`, `contracts/bridge/aztec/txe-server`; `@aztec-foundation/aztec-standards` (the only foundation package at rc.3); `@alejoamiras/private-fee-juice`; the `Nargo.toml` tags (aztec-nr and the hub's `token` from `AztecProtocol/aztec-standards`, which pins aztec-nr `v6.0.0-rc.3` itself); `AZTEC_HOME` defaults in the three contract scripts.
- **Pins to rc.6**: `@aztec-foundation/{bb.js,l1-artifacts,noir-acvm_js,noir-noirc_abi}`, the root `patchedDependencies` keys and the two `patches/` file names.
- **Read dynamically, no edit**: `.github/actions/setup-aztec` and `_tools-e2e.yml` read the aztec.js pin; `_bridge-contracts.yml` reads the Nargo tag; `local-network.ts` boots `~/.aztec/versions/<aztec.js pin>`.
- **Re-pinned by the rebuild**: committed `target/*.json`, the class ids in `noir-artifact-classids.test.ts` (hub, Token, Dripper) and every copy of the Token class id (`hub-token.test.ts`, `promotion.test.ts`, `manifest-v2.test.ts`, `send-flow.test.ts`, `script-l2.test.ts`, `deploy-manifest.test.ts`), the derived-address vector in `hub-token.test.ts` and its Noir mirror in `keystone.nr`, `fixtures/sandbox-manifest.json`.
- **Docs**: UPDATE.md "Current line", the skill's `AZTEC_HOME` line, `contracts/bridge/aztec/README.md`, `apps/tools/tests/browser/README.md`.
- **Changelog items with no hit here** (searched every `*.nr` and `Nargo.toml` under `contracts/`, and `apps packages scripts` for TS): `ecdsa_public_key_note`, `contract_instance_registry` and `fee_juice` crates, `aztec::facts`, `OriginBlock`, `Writer`/`advance_offset`, `Serialize` for `Option`, `get_nullifier_status`/`check_nullifier_exists`, `getBlockHashMembershipWitness`. The changelog says the three interface crates moved into `aztec-labs-eng/aztec-nr`; at tag `v6.0.0-rc.3` that repository has no such directories, and they sit in `aztec-node` under `noir-projects/noir-contracts/contracts/`. Moot here.
- **Upstream breaking commits** (`aztec-node` `v6.0.0-rc.1...v6.0.0-rc.3`, 121 commits): `feat!: bump the contract address domain separator to v3` and `feat(txe)!: support immutables hash in TXE deployments`.
- **Near misses to re-check after the rebuild**: `register.nr` `should_fail_with` strings match aztec-nr/TXE error text; `STANDARD_AUTH_REGISTRY_ADDRESS` and the SponsoredFPC address are derived from artifacts at import/run time, so they move with the artifacts without an edit.

## Identities

- Live L1 reads (public Sepolia RPC): registry `0xa0bf…c6ba` (unchanged) → canonical rollup `0xEd1e…089d`, `getVersion()` `3409706519`, `getFeeAssetPortal()` `0x6974…Ce59` (moved), `getFeeAsset()` `0x762c…3c18` (unchanged, so the ETH/FJ pool persists), handler `FEE_ASSET()` equal to it. Upstream `AztecProtocol/networks` `network_config.json` names the same registry and handler. A second independent RPC and the `portal.ROLLUP()`/`UNDERLYING()` back-pointers are still owed for the baseline.
- Wallet chainId `(11155111 ^ 3409706519) >>> 0 = 3415328944`.
- Old-identity literals (`2914217885`, `2904119610`): `chain-constants.ts`, `chain-info.test.ts`, `wallet-chain-id.test.ts`, `build-integrity.test.ts`, `bridge-generation.test.ts`, `private-fpc-canonical.json`, `private-fuel.test.ts`, `live-intent.test.ts` (also the old rollup, portal and registry), `testnet-bridge.json` (written by `promote`), `deploy-journal/testnet-generation.jsonl` (retired per the skill).
- Old L1 literals (portal `0x5bb7…`): `contracts/bridge/evm/.env.example`, `DeployFuelLive.s.sol`, `DeployFuelLive.fork.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`. The `lifi-routing` stack rewrites some of these.
- `live-intent.ts`: `NO_RESET_BASELINE` names `archive/aztec-v6/lessons/intent.json`; `OPERATIONAL_ALLOWLIST` lists older arcs' lessons and must gain this plan's.

## PrivateFPC

- `@alejoamiras/private-fee-juice@6.0.0-rc.3` `canonical-deployment.json`: salt `0x…01` (unchanged), `expectedAddress` `0x2e189d0c28cb86234a17951a94131e19620cda595fa8f9c5c10c24268ceb6db4`. Against rc.1 only the comment, `aztecVersion` and `expectedAddress` changed.
- The artifact has no initializer and no public function of its own (`public_dispatch` is the macro stub); `pay_fee` and `mint_and_pay_fee` are private and call `set_as_fee_payer()`. The README states no deployment is required.
- Rc.3 sources: the init check is injected only when a module has an `#[initializer]` (aztec-nr `macros/internals_functions_generation/external/private.nr`); the PXE falls back to the locally registered instance when `node.getContract` is empty (`pxe` `contract_class_service.ts`); the node reads the fee payer's balance by storage slot (`p2p` `gas_validator.ts`); the docs' `contract_readiness_states.md` lists a private-only contract as "Public Deployment: Skip". The kernel's own checks are inferred, not read.
- Self-imposed here: `check-fpc-version.ts` check 4 (`require-deployed` fails on absence), its callers `fuel-testnet.ts` and `live-intent.ts` promote, `deploy-private-fpc-testnet.ts`, `deploy-canonical-private-fpc.ts`, the sandbox's `ensurePrivateFpc`, AGENTS.md's "waits for this repository's FPC deploy", skill step 6. `fuel-testnet.ts` `registerPrivateFpc` already says no deploy is needed.
- The app derives the instance locally and calls `registerContract` (`useWalletConnection.ts`); no fee path is gated on publication. The sandbox comment "a wallet syncs it from the node" is a wallet-side claim, open with the Nulo wallet's repository.

## dRPC keys

- Testnet key: `testnet-node.ts` (`TESTNET_NODE_URL`), `network-targets.ts` (`TESTNET_NODE_SOURCE`, bundled, and the CSP), `apps/tools/.env.example`, `packages/bridge-core/.env.example`, and three archived records (`primaryRpc` in two intents and one reset baseline) plus one archived lesson.
- Mainnet key: `network-targets.ts` (bundled, unused at runtime: the mainnet build is a placeholder whose CSP blocks node calls), `deploy-config.ts`, `deploy-private-fpc-mainnet.ts`, `fpc-dust-canary-mainnet.ts`.
- The browser talks to the node directly (`NETWORK.nodeUrl` in the send, exit, drip and gas paths, and the boot identity check in `main.ts`); the wallet is never given the URL. Production always uses the committed constant; `VITE_AZTEC_NODE_URL` applies in dev only.
- Persisted or printed: `live-intent.ts build` writes `primaryRpc` (and an optional `secondEndpoint.url`) into the committed intent, and `verify`/`promote` read the node back from it; `rpc()` errors and one hub check embed the URL; `check-fpc-version.ts` and `apps/tools/scripts/deploy.ts` log it. Not persisted: the conductor journal, manifests, receipts, `build.json`.
- CSP: path-exact on purpose (a host-only `lb.drpc.live` would admit every dRPC customer); `network-targets.test.ts` holds the URL and the CSP equal.
- Origins: testnet `https://testnet.app.unleashed.systems`, `https://unleashed-testnet.alejo-amiras.workers.dev`, previews `https://<label>-unleashed-testnet.alejo-amiras.workers.dev` (`isPreviewHostOf`); mainnet `https://app.unleashed.systems`, `https://unleashed-mainnet.alejo-amiras.workers.dev`, no previews.
- The Nulo wallet's repository uses its own testnet key, different from both; neither Unleashed key appears in its main checkout or its eleven worktrees. An old standalone copy of the wallet source on the build host holds the Unleashed mainnet key; disabling that key covers it.

## External packages

- `@nulo-sh/*` are at `0.1.0` with exact rc.1 peers; 0.2.0 is staged in the wallet's repository, not published. The deploy scripts import `@nulo-sh/wallet-crypto` (`deriveNuloAccountKeys`, the L2 deployer and faucet keys) and `@nulo-sh/resolve-asset`.
- `@aztec-foundation/aztec-standards@6.0.0-rc.3` is younger than the 7-day gate at plan time; labs rc.3 and foundation rc.6 are older; `private-fee-juice` rc.3 is younger and becomes a standing exemption (owner's decision).

## Collision: the `lifi-routing` stack

- Delivered and awaiting merge: six arcs plus a close-out, 415 files, based on `9725c08`. It conflicts with `main` only in docs (`AGENTS.md`, `README.md`, the plan indexes, `follow-ups.md`, `lessons.md`).
- It replaces the Uniswap fuel leg (`SwapBridgeRouter`, `UniswapFuelSwap`) with `DepositRouter` + `TestnetFuelSwapper`, and rewrites `generation.ts`, `deploy-generation.ts`, `live-intent.ts`, `testnet-bridge.json`, `network-targets.ts` and the skill. Its testnet deployment was on the network that reset.
