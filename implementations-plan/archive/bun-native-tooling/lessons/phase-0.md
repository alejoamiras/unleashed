# Phase 0 — Primitive + tests + dry-run baselines — lessons

## Delivered

`packages/bridge-core/scripts/run.ts` (`run`, `RunError`, `resolveBin`, `git`) + `run.test.ts` (14 cases, real subprocesses, the engine running the test is the scripted child). Nothing else in the tree changed.

Design notes worth keeping:
- A synchronous `spawnSync` throw is real on both engines: `spawnSync("git", ["--version", "SECRET" + NUL + "X"])` raises `ERR_INVALID_ARG_VALUE` — "The argument 'args[1]' must be a string without null bytes. Received 'SECRET\x00X'" — on Node 24.18.0 AND Bun 1.4.0. `run()` catches it and reports the fixed reason `invalid argument` (`code: "EINVAL_ARG"`), retaining nothing from the thrown error.
- `maxBuffer` overflow surfaces as `res.error.code === "ENOBUFS"` on both engines (pinned by the test), with the child killed by `killSignal`.
- The sentinel tests inspect four surfaces (`message`, `stack`, `util.inspect`, `JSON.stringify`) for three failure classes (non-zero exit, ENOENT, NUL-bearing argument).
- Biome (lint + format) clean on both files; `tsc -p tsconfig.scripts.json` clean.

## Dry-run baselines (unmodified base-branch scripts, key-free; forge from `~/.foundry/bin`)

`bun run --cwd packages/bridge-core verify:l1 --dry-run` (testnet, default config), exit 0:
```
✓ TestUsdc @ 0x032E4F5f21d74AE177b96BeD98E472FFA9D62448: standard-json builds (1 sources, solc settings from foundry.toml)
✓ <forked-portal> @ 0xe0fd81b5ddb13bbb64243d018a6e9c3dfae8d21f: standard-json builds (89 sources, solc settings from foundry.toml)
✓ SwapBridgeRouter @ 0x78365a471dfce304f25d0382cdbd65b2b7935820: standard-json builds (4 sources, solc settings from foundry.toml)
✓ UniswapFuelSwap @ 0x9c3cf20639a1a1f3fec1db8e6fa3199910db6dba: standard-json builds (1 sources, solc settings from foundry.toml)
```
`… verify:l1 --config apps/faucet/public/mainnet-bridge.json --dry-run` (mainnet), exit 0:
```
— token @ 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 is circle-proxy (reused official USDC): source-verify skipped; identity pinned at deploy
✓ <forked-portal> @ 0x3c32f16f5893c9699b4131a235604d8f5c6dfab6: standard-json builds (89 sources, solc settings from foundry.toml)
✓ SwapBridgeRouter @ 0x2eb3435f5f47414fd10655d43199ecdcb0707559: standard-json builds (4 sources, solc settings from foundry.toml)
✓ UniswapFuelSwap @ 0xfe001417c1060c908d157baecda0b6a076e87d8c: standard-json builds (1 sources, solc settings from foundry.toml)
```

## Validation gate (as written in plan.md) — PASSED

| Command | Result |
|---|---|
| `bun run --cwd packages/bridge-core typecheck` | exit 0 (no diagnostics) |
| `bun run --cwd packages/bridge-core test` (the base branch's runner: `vitest run`, Node by shebang) | 28 files passed, 1 skipped; 237 tests passed, 4 skipped |
| `bun run --cwd packages/bridge-core vitest run scripts/run.test.ts` (Node, explicit) | 14/14 |
| `bun run --cwd packages/bridge-core --bun vitest run scripts/run.test.ts` (Bun, explicit) | 14/14 |
| `bun run lint` | 0 errors (the 33 warnings / 11 infos are pre-existing repo-wide; `biome check` on the two new files: clean) |

LESSONS_FILE=implementations-plan/archive/bun-native-tooling/lessons/phase-0.md
