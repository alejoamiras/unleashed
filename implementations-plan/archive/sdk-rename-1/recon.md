# sdk-rename-1 recon

Base: `main` at 90e3e8f. One Sonnet explorer (scope couplings) plus the parent's own greps and trial runs; every
trial edit was reverted (`git checkout -- .`, tree clean after).

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Find every name occurrence | `git grep -l "@unleashed/sdk" -- ':!implementations-plan'`: 209 files, 395 lines, 402 occurrences | reuse-as-is |
| Regenerate the root lockfile | `bun install` (lockfile v2; the workspace entry is `@unleashed/sdk@workspace:packages/sdk`) | reuse-as-is |
| Prove the tarball | `bun run --cwd packages/sdk pack:check`; it derives the tarball name from `bun pm pack` (`pack-check.ts:89`) | reuse-as-is |
| Select every workspace in `typecheck:all` / `test:all` | root `package.json:21-22` `--filter '@unleashed/*'`, pinned by `scripts/ci-cd/workspaces.test.ts` | adapt: the glob must cover both scopes |
| Workspace-dependency graph for the CI gates | `scripts/ci-cd/behavior-gating.test.ts:18-23` `startsWith("@unleashed/")` | adapt: select by the `workspace:` protocol |
| Design layering floor | `biome.json:120,148,180` `"group": ["@unleashed/*"]`, pinned by `packages/design/src/boundary.test.ts:62,96` | adapt: add `@unleashed-systems/*` |
| Path to the unpacked SDK in the consumer | `pack-check.ts:164` `join(scratch, "node_modules", "@unleashed", "sdk")` | adapt: the literal is split, a text replace misses it |

No new code is needed: no `build new` row.

## Where the name appears (209 files)

`apps/tools` 89 (src, tests, `scripts/deploy.ts`, `scripts/verify-deployments.ts`, `vite.config.test.ts`,
`package.json`), `packages/bridge-core` 101 (src, scripts, tests, README, `package.json`), `packages/sdk` 8
(`package.json`, README, three examples, `scripts/pack-check.ts:205`, `test/consumer/{bunfig.toml,consumer.ts}`),
`packages/testnet-relayer` 6, `scripts/ci-cd` 2 (`field-randomness.test.ts` comment, `workspaces.test.ts`),
`.github/workflows/publish-sdk.yml` (comment line 3), `AGENTS.md:208`, `bun.lock` (lines 56, 96, 132, 158, 755).

## Brief claims checked

- **Holds:** about 209 files; the version stays 0.1.0; `stage.ts` copies `workspace.name` (`stage.ts:238`) and
  hard-codes no name; the tarball becomes `unleashed-systems-sdk-0.1.0.tgz` with no script edit (`publish-sdk.yml`
  globs `*.tgz`).
- **Does not hold:** the consumer fixture's `package.json` and `bun.lock` do not name the SDK (the fixture is
  `unleashed-sdk-consumer`; the tarball "never enters this lockfile", `bunfig.toml:3-4`); only its `bunfig.toml`
  comment and `consumer.ts` change. `scripts/ci-cd/publish-sdk.test.ts` names neither the package nor the tarball.
  `packages/bridge-core/scripts/layout-identity.test.ts` names neither.
- **Does not hold:** "change only name and specifier lines". The `@unleashed/` scope is also a workspace marker in
  four places (the reuse map's `adapt` rows). Measured on a trial rename: with the filter unchanged,
  `bun run --filter '@unleashed/*' typecheck` runs six workspaces and skips `@unleashed-systems/sdk`;
  `workspaces.test.ts` then fails. `behavior-gating.test.ts` would silently drop the SDK from every gate's
  dependency closure. The Biome floor would stop banning a design import of the SDK.
- **Does not hold:** "no reformatting". Biome's 140-column limit rewraps 10 import statements the longer name
  pushes over it: `apps/tools/src/composables/{test/fake-claim-sdk.ts,useCrossChainRoute.ts}`,
  `apps/tools/tests/e2e/send-smoke.test.ts`, `packages/bridge-core/scripts/{generation.ts,script-l2.ts,
  script-send.test.ts,smoke-existing-testnet.ts}`, `packages/bridge-core/src/{across-fill-bundle.test.ts,
  across-v4.ts,stargate.test.ts}`. `bun run lint` fails without the rewrap.

## Glob semantics (trial, manifest name changed alone, then reverted)

`bun run --filter '@unleashed*/*'` and `--filter '@unleashed{,-systems}/*'` both select all seven workspaces;
`Bun.Glob` agrees on both (`@unleashed-systems/sdk` true, `@unleashed/tools` true, `unleashed` false). The
explorer's claim that no single glob matches both scopes is wrong.

## pack:check baseline (trunk)

The report as printed, runtime version lines last. After the rename, every line but the first must match, and the
first must read `unleashed-systems-sdk-0.1.0.tgz, 178 files`:

```
pack:check: unleashed-sdk-0.1.0.tgz, 178 files
  exports . ./fuel ./bridge ./protocol ./networks
  peers @aztec-foundation/aztec-standards@6.0.0 @aztec-foundation/l1-artifacts@6.0.0 @aztec-labs/aztec.js@6.0.0 @aztec-labs/constants@6.0.0 @aztec-labs/ethereum@6.0.0 @aztec-labs/foundation@6.0.0 @aztec-labs/stdlib@6.0.0 @alejoamiras/private-fee-juice@6.0.0 viem@^2.57.1
  dependencies zod@4.4.3
  assets/mainnet-bridge.json sha256 5f57857f2fc1234cbd1edea075b7645ed6ab54b94ec9d7a85fb00d9a4a4a3d8b = apps/tools/public/mainnet-bridge.json
  assets/testnet-bridge.json sha256 e68bbb13391cebe0d549af07dbb1eba383687d3d79b964bbdfc1570d22961e31 = apps/tools/public/testnet-bridge.json
  assets/token-bridge-hub.json sha256 c733b654c399f10fde81f649063a1af0f001036227377d1f93432d6add07bf43 = contracts/bridge/aztec/token_bridge_hub/target/token_bridge_hub_contract-TokenBridgeHub.json
  assets/generations/mainnet/record.json sha256 c3f168594322bff88706a19b9779dc5de35000fa592d53ae7bb2e1bc91b45d4b = contracts/bridge/generations/mainnet/record.json
  assets/generations/testnet/record.json sha256 9186a23bf889a3810d1c55342d8e4747533e24e8749421aa889347067316ebd7 = contracts/bridge/generations/testnet/record.json
  assets/generations/testnet/token-bridge-hub.json sha256 d7e3be3c0b51718cddb0a28e9a9a7e163d5d88c7f120b3daecc013532bfe328a = contracts/bridge/generations/testnet/aztec/TokenBridgeHub.json
  typechecked under tsconfig.nodenext.json, tsconfig.bundler.json
  node 24.22.1: 5 entries imported, hub TokenBridgeHub
  bun 1.4.2: 5 entries imported, hub TokenBridgeHub
pack:check: ok
```

## Kept as is (not the package's name)

`pack-check.ts:78` cache directory `unleashed-sdk-pack-check`; the fixture name `unleashed-sdk-consumer`;
`contracts/bridge/aztec/txe-server` (`@unleashed/txe-server`, not a root workspace); the six `@unleashed/*`
siblings; everything under `implementations-plan/` (the brief's boundary: `follow-ups.md:53`,
`mainnet-1/plan.md:322` and the archive keep the old name).

## Open work and collisions

No open or closed issue on the rename or the scope (`gh issue list --state all --search "sdk rename OR
unleashed-systems OR npm scope"`); no closed `known-limit` on it. PR #121 (`worktree-claim-fee-1`) shares 14 files
with this rename, three of them among the rewrapped ten (`send-smoke.test.ts`, `generation.ts`,
`smoke-existing-testnet.ts`). It merges after this lane and must re-run the rename on its own new imports; its
typecheck fails loudly until it does, because `@unleashed/sdk` no longer resolves.
