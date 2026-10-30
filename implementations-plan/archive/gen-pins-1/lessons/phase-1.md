# Phase 1: the record and the writer

## Bootstrap

- Forge libraries installed with the README's pinned `forge install --no-git` lines, `gen-remappings.ts`, then
  `forge build` with the host's Foundry 1.4.1 (CI pins 1.7.1): `code-pins.test.ts` passes on this build, so the
  runtime bytes do not depend on the Foundry version here (`evm_version`, optimizer and solc are pinned in
  `foundry.toml`).
- `write testnet --first`: every entry's build is `b8c2289` (`origin/main`, the merge base), since no build input moved
  on the branch. The kept hub artifact is byte-identical to the HEAD target. `write mainnet --first`: `evm: {}`, no
  `aztec`.
- `check testnet --rpc <PublicNode Sepolia> --rpc <Tenderly gateway> --node https://aztec-testnet.drpc.org
  --build-out contracts/bridge/evm/out`: intact, solc-shaped, bound; all four L1 runtimes run their pins on both
  RPCs; the hub runs class `0x2132…2abe`; all four EVM entries equal this build and the hub equals the hub target.

## Attempts

- A `refine((n) => n === 32)` infers a type predicate (TS 5.5+) and narrows the span length to the literal `32`, which
  `CodePin` then fails to assign: the predicate's return type is annotated `boolean`.
- `AztecAddress.fromString` does not exist in 6.0.0: `fromStringUnsafe`, as the SDK uses.

## Gate

`bun run lint`, `bun run typecheck:all`, `bun run --cwd packages/sdk test` (466 passed), `bun run --cwd
packages/bridge-core test` (535 passed): green.
