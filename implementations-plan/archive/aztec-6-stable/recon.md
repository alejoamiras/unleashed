# Recon: aztec-6-stable

Base: `origin/main` at `b1a52e6` (#24). Read-only sweep by one Explore agent (Sonnet), completed by the lead
after the agent's shell was cut off by the worktree hook. Evidence from outside the repository is in `plan.md`
§ Assumptions. The archived `aztec-rc3` plan is the worked example this bump replays; it is evidence, not a task
list.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Line guard (one version per scope) | `scripts/ci-cd/aztec-line.test.ts`: labs from the bridge-core aztec.js pin, foundation from the lockfile's aztec.js entry, standards from its pin, every manifest and both lockfiles, patch keys and files. No literal | reuse-as-is |
| Wallet-package peers | `scripts/ci-cd/published-packages.test.ts`: `@nulo-sh/wallet-crypto` peers `accounts`+`foundation`, `wallet-sdk-schema-patch` peers `aztec.js`+`stdlib`, each at the dependent's exact pin | reuse-as-is; red until the Nulo packages exist on 6.0.0 |
| Derivation vector | `packages/bridge-core/scripts/deployer-keys.test.ts`: the wallet repository's reference vectors for `deriveNuloAccountKeys` | reuse-as-is; re-run on the new `@nulo-sh/wallet-crypto` |
| CI toolchain readers | `.github/actions/setup-aztec` (aztec.js pin from `apps/tools/package.json`, or `version`); `_bridge-contracts.yml` reads the `aztec-nr` tag from `Nargo.toml` by `sed`; `_tools-e2e.yml` reads the bridge-core pin | reuse-as-is |
| Local toolchain readers | `compile.sh`, `nargo.sh`, `run-txe-tests.sh` default `AZTEC_HOME` to a literal; `local-network.ts` reads the bridge-core pin and refuses a partial toolchain; `live-intent.ts` `castBin()` has a stale `versions/5.0.0` candidate | adapt: three literals and the cast candidate |
| Reset baseline and intent tooling | `live-intent.ts` (`build`/`verify`/`promote`, `NO_RESET_BASELINE`, `OPERATIONAL_ALLOWLIST`, `PLAN_PINNED_L1_SIGNERS`, `CAPS` 2.0 ETH); `assertNoResetPins` byte-pins identity and five L1 addresses against the baseline read from `HEAD`; the rc.3 `lessons/reset-baseline.json` is the shape | adapt: new baseline file, re-point the constant, allowlist the new `lessons/` |
| Generation conductor | `packages/bridge-core/scripts/deploy-generation.ts` (`deploy`, `pre-create`, `calibrate`; journal `deploy-journal/testnet-generation.jsonl` stamped with identity; `SKIP_POOL_SEED`; `MIN_FUEL_FJ` 29.773 FJ source constant) and `generation.ts` (token class id from the installed standards artifact, factory predicted from the pending nonce) | reuse-as-is; retire the rc.3 journal first |
| Promotion | `src/promotion.ts` `assertZeroSeed` refuses any identity, factory or hub move; a reset deletes the live manifest in its own commit, then `promote` takes the first-promotion path | reuse-as-is (runbook step 8) |
| Faucet deploy | `apps/tools/scripts/deploy.ts` (`deploy:testnet`, idempotent, universal deploys with fixed salts; `deployments.candidate.json`) and `verify:deployments` | reuse-as-is; the record moves (separator V3 moved it at rc.3, bytecode moves it now) |
| Sandbox rehearsal | `deploy:sandbox --smoke` boots `aztec start --local-network` from `~/.aztec/versions/<pin>` with the toolchain's own `internal-bin/forge`; writes `sandbox-deploy/deployments.json` | reuse-as-is |
| Browser and integration suites | `bun run e2e:tools` (parallel-safe, six CI shards on the `e2e:tools` label or the tools paths); `test:integration` | reuse-as-is |
| PrivateFPC gate | `private-fuel.ts` (`PRIVATE_FPC_ADDRESS`, `PRIVATE_FPC_SALT`), `private-fpc-canonical.json`, `private-fuel.test.ts` (re-derives the address from the installed artifact at salt `0x…01`, deployer zero; compares the package's `canonical-deployment.json`), `scripts/check-fpc-version.ts` (one behaviour) | adapt: address, digest, version, compat entry, network pins |
| Identity constants | `apps/tools/src/lib/chain-constants.ts` (`TESTNET_ROLLUP_VERSION`), tests `chain-info.test.ts`, `wallet-chain-id.test.ts`, `build-integrity.test.ts`, `bridge-generation.test.ts`; `live-intent.test.ts` fixtures; the manifest's `walletChainId` is written by the conductor | adapt: literals |
| L1 fork fixtures | `DeployFuelLive.s.sol`, `DeployFuelLive.fork.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`, `SeedTokenPool.s.sol`, `contracts/bridge/evm/.env.example` | adapt: only `FEE_JUICE_PORTAL` moved |
| Record withholding at boot | `packages/bridge-core/src/journal.ts` and `apps/tools/src/composables/useBridgeJournal.ts`: records re-validate against the live factory's frozen registration; stored data is keyed by wallet chain id (`promotion.ts`) | reuse-as-is: no code change on a reset |
| Vendored content-hash lib | `contracts/bridge/aztec/token_portal_content_hash_lib/src/lib.nr`: upstream bytes at `v6.0.0` hash to the header's `5e20eaf6…`, unchanged since rc.3 | adapt: header only (tag, commit) |
| Re-vendor or tag-rewrite automation | none | build nothing: six `Nargo.toml` edits and one header; `_bridge-contracts.yml` parses the tag |
| Docs that record the line | `UPDATE.md` (current line, pin surface, toolchain path), the `bridge-generation` skill (toolchain path, rc examples), `contracts/bridge/aztec/README.md`, `apps/tools/tests/browser/README.md`, `follow-ups.md`; `AGENTS.md`, `SECURITY.md`, `apps/tools/README.md` hold no rc literal | adapt |

## Literal inventory (tracked files, outside `implementations-plan/archive` and lockfiles)

- `6.0.0-rc.3`: `UPDATE.md` (8), `apps/tools/package.json` (17 with the foundation rows), `packages/bridge-core/package.json` (12),
  root `package.json` `patchedDependencies` and the two `patches/*@6.0.0-rc.6.patch` files, `txe-server/package.json`,
  six `Nargo.toml` tags, the vendored lib header, `keystone.nr:11` (comment), `contracts/bridge/aztec/README.md` (3),
  `compile.sh` (4), `nargo.sh` (2), `run-txe-tests.sh`, `testnet-bridge.json:116`, `chain-constants.ts:21` (comment),
  `tests/browser/README.md:67`, `private-fpc-canonical.json` (5), `private-fuel.test.ts:153`,
  `noir-artifact-classids.test.ts` (4), `hub-token.test.ts` (comments), `script-l2.test.ts:24` (comment),
  `live-intent.test.ts:14`, the skill (line 75), `follow-ups.md:31`, the committed `target/*.json`.
- `3409706519` / `3415328944`: `chain-constants.ts:22`, `chain-info.test.ts`, `wallet-chain-id.test.ts`,
  `private-fpc-canonical.json:12`, `live-intent.test.ts:16`, `deploy-journal/testnet-generation.jsonl:1`,
  `testnet-bridge.json:5`, `bridge-generation.test.ts:96`, `build-integrity.test.ts` (6).
- rc.3 portal `0x6974…ce59`: the three Solidity fixtures, `.env.example`, `testnet-bridge.json` (2), `live-intent.test.ts`,
  the journal. The rollup `0xed1e…089d`: `live-intent.test.ts` (2). Registry, fee asset and handler did not move.
- CI foundry pin `1.7.1`: `_bridge-contracts.yml` (2), `_tools-e2e.yml`; the 6.0.0 toolchain ships 1.8.5 in `internal-bin`.

## Wallet-package coupling

- `deriveNuloAccountKeys` (`@nulo-sh/wallet-crypto`): `script-l2.ts` (the conductor's L2 deployer),
  `sandbox/l2.ts`, `apps/tools/scripts/deploy.ts` (the faucet deployer), the drip and relay canaries, the mainnet
  FPC scripts, the browser suite's test wallet. `EncryptionKey`: `src/backup.ts`, `src/recovery-crypto.ts`.
- `resolvePackageAsset` (`@nulo-sh/resolve-asset`, no peers): `generation.ts`, `script-l2.ts`, `check-fpc-version.ts`,
  `gen-remappings.ts`, `apps/tools/vite.config.ts`, the test wallet's Vite config.
- `@nulo-sh/wallet-sdk-schema-patch`: `apps/tools` only.

So the deploy conductor, the faucet deploy and the sandbox rehearsal all derive keys through `wallet-crypto`. A
`wallet-crypto` whose peers pin rc.3 links against the workspace's 6.0.0 `@aztec-labs/foundation` under Bun's
isolated linker with `warn: incorrect peer dependency`, one `Fr` class in the tree (plan F13, the scratch probe);
`published-packages.test.ts` is the one test that refuses the mismatch. The Nulo packages on 6.0.0 are a
prerequisite for the PR, and `deployer-keys.test.ts` pins the derived keys either way.

## Collision risks

- Other worktrees under `.claude/worktrees/` (the `lifi-routing` stack, `forge-cache`) stay untouched. Repo-wide
  searches exclude them.
- `aztec-up install` re-points `~/.aztec/current`, which other sessions use. It was restored to `6.0.0-rc.3`
  after installing `6.0.0`; every script here pins its own toolchain path.
- A keyed `verify-l1 --strict` rebuilds `contracts/bridge/evm/out`; no local forge build or sandbox overlaps it.
- `env-exec` refuses untracked files and a commit voids a pending request: commit between requests only.
- The rc.3 journal carries the old identity; the conductor refuses it. Retire it in its own commit before `build`.

## Search trails for absences

- No hand-written source uses the APIs the 6.0.0 changelog breaks (`OriginBlock`, `record_retractable_fact`,
  `advance_offset`, `check_nullifier_exists`, `getBlockHashMembershipWitness`, `ecdsa_public_key_note`, the
  protocol interface crates): `grep -rnE` over `contracts packages apps scripts` (`.nr`, `.ts`, `.toml`), no hit.
- No re-vendor or tag-rewrite script: `git grep -i 'vendor'` hits docs and headers only.
- No open issue or known limit: `gh issue list --state open` and `--label known-limit` are empty.
- No `TODO` on 6.0.0 in source: `git grep -iE '6\.0\.0 final|6\.0\.0 stable|TODO.*6\.0'` hits archived plans and
  `follow-ups.md:31` only.
- `AGENTS.md`, `SECURITY.md`, root `README.md`, `apps/tools/README.md`: no `6.0.0-rc.3`, `rc.6` or `v6.0.0-rc` hit.
