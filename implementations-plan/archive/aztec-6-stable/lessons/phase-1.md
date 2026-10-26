# Phase 1: preconditions and the reset evidence

Evidence gathered during planning, recorded here so the reset baseline never depends on the node.

## Identity reads (F4)

`cast` from the 6.0.0 toolchain (`~/.aztec/versions/6.0.0/internal-bin/cast`), through two public Sepolia
RPCs, no key. Both answered identically.

| Read | `ethereum-sepolia-rpc.publicnode.com` | `1rpc.io/sepolia` |
|---|---|---|
| `chain-id` | 11155111 | 11155111 |
| registry `0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba` `getCanonicalRollup()` | `0x1f435a7F2dA358caF887A470FAeEE7d5D5f4eFBA` | same |
| registry `getRollup(679261766)` | `0x1f435a7F2dA358caF887A470FAeEE7d5D5f4eFBA` | same |
| rollup `getVersion()` | 679261766 | 679261766 |
| rollup `getFeeAssetPortal()` | `0xE59aCBA462a0324B1d619a7A1b219419f156f505` | same |
| rollup `getFeeAsset()` | `0x762C132040fdA6183066Fa3B14d985ee55aA3C18` | same |
| portal `ROLLUP()` | the rollup above | same |
| portal `UNDERLYING()` | the fee asset above | same |
| handler `0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9` `FEE_ASSET()` | the fee asset above | same |
| signer `0x7F42…6a9a` balance | 2.903569588521244400 ETH | same |

The fee asset, the handler and the registry did not move from the rc.3 generation; the rollup and its
FeeJuicePortal did (rc.3: rollupVersion 3409706519, portal `0x6974…Ce59`). Wallet chain id
`(11155111 ^ 679261766) >>> 0 = 685146337`.

## Upstream network config (F5)

`AztecProtocol/networks` `network_config.json`, `testnet`: `l1ChainId` 11155111, `registryAddress`
`0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba`, `feeAssetHandlerAddress`
`0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9`. Same registry and handler as the L1 reads.

## Keyless node (F6)

`https://aztec-testnet.drpc.org` `node_getNodeInfo`: nodeVersion `6.0.0`, l1ChainId 11155111,
rollupVersion 679261766, the L1 addresses above, block 574 at planning time.

## Toolchain (F9)

`aztec-up install 6.0.0` into `~/.aztec/versions/6.0.0` (nine log lines: version manifest, node, nargo,
foundry, native tools, npm packages, commands, `Installed and activated version 6.0.0`). `internal-bin`
forge is 1.8.5. `aztec-up use 6.0.0-rc.3` restored `~/.aztec/current` afterwards for the other
sessions on this host; every script here reaches 6.0.0 through its `AZTEC_HOME` default (Phase 3).

## Worktree setup

`bun install --frozen-lockfile` on the worktree base (`main` at b1a52e6). Forge's `lib/` and `out/`
were copied from the canonical clone's `contracts/bridge/evm`, without `cache/`; the copied
`lib/v4-core/.env` was deleted (a gitignored file with no business in a fresh worktree).

## `bun audit` baseline on the worktree base

Exit 1: **80 vulnerabilities (37 high, 35 moderate, 8 low)**. Advisory groups, by top-level package:

`@fastify/busboy@2.1.1`, `@opentelemetry/core@1.30.1`, `@opentelemetry/propagator-jaeger@1.30.1`,
`@vitest/mocker@4.1.10`, `@vue/server-renderer@3.5.41`, `axios@1.19.0`, `brace-expansion@2.1.4`,
`elliptic@6.6.1`, `fast-copy@4.0.4`, `fast-uri@3.1.5`, `follow-redirects@1.16.0`, `js-yaml@4.3.1`,
`pbkdf2@3.1.6`, `qs@6.15.3`, `sharp@0.35.2`, `source-map-js@1.2.1`, `systeminformation@5.23.8`,
`undici@5.29.0`, `uuid@9.0.1`, `vite@8.2.1`, `vitest@4.1.10`, `ws@8.18.3`.

The Phase 2 gate compares its `bun audit` against this list: a new group is a finding, a group that
drops out is a gain. Only `vite` and `vitest` are direct dependencies of a workspace (build and test
tooling); every other group is transitive.

## Gate

On the plan commit, from the worktree root:

| Command | Exit | Note |
|---|---|---|
| `bun install --frozen-lockfile` | 0 | |
| `bun run lint` | 0 | |
| `bun run typecheck:all` | 0 | |
| `bun run test:all` | 0 | design 242, bridge-core 489 (1 skipped), landing 76, tools 1681 |

No expected-red case is open yet. Phase 1 green.
