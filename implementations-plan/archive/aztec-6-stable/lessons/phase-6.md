# Phase 6: the local rehearsal

## The smoke failed twice at the fragmented credit step

Both first runs stopped at the same step with the same numbers:

```
✗ (d) private gas → two more notes, none covering a ceiling — a change of 235331315680000 at the ceiling 27444447400000 leaves no two-note window
```

Every step before it passed: the public, private and relayed claims, token+gas, gas-only, the one-note
PrivateFPC credit, the public exit, and the private exit paid from one note.

The first note is sized at 1.4 ceilings (281583844080000 FJ-wei, so a ceiling of about 2.01e14). The exit
that spent it kept a ceiling of 4.63e13, and the next ceiling read 2.74e13. The change therefore covered
8.6 ceilings, and no pair of new notes could sit under one ceiling beside it.

## Cause: the sandbox's L1 base fee free-falls, and 6.0.0's mana min fee follows it

A poller beside the second run read anvil's latest block and the node's `node_getCurrentMinFees` and
`node_getPredictedMinFees` every 15 s:

| L1 block | L1 base fee (wei) | L2 fee per gas (current) |
|---|---|---|
| 0 | 1,000,000,000 | node not up |
| 18 | 158,692,203 | 869,281,200,000 |
| 42 | 7,405,427 | 22,758,100,000 |
| 56 | 1,170,091 | 3,854,800,000 |
| 69 | 209,197 | 700,700,000 |
| 83 | 32,790 | 93,300,000 |
| 102 | 2,652 | 21,500,000 |

The sandbox's anvil auto-mines one block per transaction, every block is far under its gas target, and
EIP-1559 lowers the base fee 12.5 % a block from anvil's default 1 gwei. The node prices the next block
with the rollup's `getManaMinFeeAt`, read at the archiver's L1 sync point (`fee_provider.js` in
`@aztec-labs/sequencer-client` 6.0.0), so the L2 fee falls in steps behind the L1 fee: about 40,000-fold
over the first five minutes, the window in which the smoke sizes its credit notes. The rc.3 smoke passed
the same step with the same anvil arguments (anvil 1.4.1 then, 1.8.5 now); this run did not establish
which 6.0.0 change made the L1 term dominate.

## Fix: start anvil at the EIP-1559 fixed point

`spawnAnvil` passes `--block-base-fee-per-gas 7`. At 7 wei an under-target block's decrease,
`7 · (target − used) / target / 8`, rounds to zero, so the base fee cannot fall from block 0. An
over-target block can still raise it; this gives a stable start, not a fixed fee. No assertion moved:
the smoke still sizes, selects and re-checks its notes exactly as before, against fees that now behave
like a settled network's. The browser and integration suites boot the same module, so they get the same
fees.

## Gate

| Command | Result |
|---|---|
| `bun run --cwd packages/bridge-core deploy:sandbox --smoke` (third run, with the flag) | exit 0, every step, `✅ sandbox deploy + smoke OK (15.4m)`; the L2 fee held at 10,200,000 per gas for the whole run; the last step reports the PrivateFPC unpublished |
| `bun run e2e:tools`, `.vite` cleared first | exit 0, `73 passed (1.4h)`, wall-clock 5220 s at load average 140–264 on 188 cores (rc.3: `70 passed (1.2h)`, 4465 s, on a quieter machine) |
| `bun run --cwd packages/bridge-core test:integration` | exit 0, 6 files, 35 passed, 1653 s |
| `bun run lint`, `bun run typecheck:all` | exit 0 |
| `bun run test:all` | only `testnet-bridge.json is a valid v2 manifest for its own chain` fails (promotion, Phase 11) |
| `bun run test:ci-gating` | only `published-packages.test.ts` fails (Phase 7) |
| `verify:deployments`, `build:testnet` + `verify:build-target testnet`, `build:mainnet` + `verify:build-target mainnet`, `build:landing` | exit 0 |

The copies closed the faucet-record case and the fixture-derived cases. Each run reaped its own process
group; no anvil, node or vite of this run survived it.

The browser log carries 72 `private FJ balance read failed (fail-closed → null)` lines, now worded
`Cannot sync contract <PrivateFPC>: its instance is not registered nor published`. They are the no-fuel
gate's balance probe running before the connect-time registration lands, the fail-closed path two
archived plans already recorded under 5.x's wording (`No artifact registered`); the specs that depend on
the read passed.
