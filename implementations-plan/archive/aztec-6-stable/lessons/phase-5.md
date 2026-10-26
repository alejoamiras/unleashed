# Phase 5: chain cascade, L1 constants, the baseline wiring

## Identity

`TESTNET_ROLLUP_VERSION` is 679261766, so the testnet wallet chain id is
`(11155111 ^ 679261766) >>> 0 = 685146337`. Moved with it: `chain-info.test.ts`, `wallet-chain-id.test.ts`,
the six `build-integrity.test.ts` fixtures, the `testnet-bridge.json` row of `bridge-generation.test.ts`,
the `live-intent.test.ts` node fixture (rollup `0x1f43…efba`, portal `0xe59a…f505`, nodeVersion 6.0.0; the
upper-case rollup spelling keeps the "case aside" check meaningful), the FPC descriptor's network pins and
`private-fuel.test.ts`'s rollupVersion assertion.

The build-integrity check runs when the app loads, not at build, so both builds pass while the shipped
`testnet-bridge.json` still names the rc.3 chain. A preview built before promotion refuses to load. That
is the intended fail-closed state, and the promotion in Phase 9 ends it.

## L1 constants

`FEE_JUICE_PORTAL` moved to `0xE59aCBA462a0324B1d619a7A1b219419f156f505` (checksummed with viem's
`getAddress`) in `DeployFuelLive.s.sol`, both fork suites and `.env.example`. The fee asset, the handler,
the registry, Permit2 and the pool manager did not move.

`DeployFuelLive.fork.t.sol` also pins `LIVE_TOKEN_PORTAL = 0x9c41…11Ea`, an AZLO portal from before the
factory generations, which the rc.3 bump also kept. It is an opt-in fork fixture (it skips without
`SEPOLIA_RPC_URL`, and CI runs `--no-match-contract Fork`), so it stays.

## The baseline wiring

`NO_RESET_BASELINE` points at `implementations-plan/aztec-6-stable/lessons/reset-baseline.json`, committed
with the plan, and that lessons directory joins `OPERATIONAL_ALLOWLIST`. `isAllowlistedPath` still
excludes the baseline itself, so changing it after an intent is built is source drift.

## The retired scope

6.0.0 resolves nothing under `@aztec/*` (Phase 2, D20), so `aztec-line.test.ts` no longer exempts
`@aztec/viem`: any `@aztec/*` package in either lockfile is a stray. Without that, a fork that came back
through a transitive dependency would pass silently. `UPDATE.md` says the same and documents the stock
`viem` pin.

## createPortal (A8 a)

`ensurePortal` sends `createPortal` with `sendGasLimit(estimate)`, the helper `runSend` uses (now exported
from `send-flow.ts`), and throws `createPortal(<erc20>) REVERTED (<tx>)` on a receipt whose status is not
`success`. Before, a revert surfaced as "landed but the factory has no registration". The new
`generation.test.ts` case fails against the old `ensurePortal` (the revert reads as the registration
error) and passes on the fix; it also pins the gas limit, 375000 for a 300000 estimate.
`MIN_FUEL_FJ` stays at 29.773 FJ; the deferral is recorded in `follow-ups.md`, which now lists only
the remaining Inbox writer and the lag-tolerant readback.

## Docs

`UPDATE.md` (current line, foundation numbering, the stock viem pin, toolchain path), the runbook's
toolchain path, `contracts/bridge/aztec/README.md` and `apps/tools/tests/browser/README.md`. The 6.0.0
aztec.js option schema still names the fee cap `maxFeePerGas` (`dest/wallet/wallet.d.ts`), so only the
browser README's version changed. Two rc.3 mentions remain on purpose: UPDATE.md's Nulo line until
Phase 7, and `testnet-bridge.json` until promotion.

## Gate

| Command | Exit | Note |
|---|---|---|
| `bun run lint` | 0 | |
| `bun run typecheck:all` | 0 | |
| `bun run test:all` | 1 | every failure an open ledger case (below) |
| `bun run test:ci-gating` | 1 | only `published-packages.test.ts` (Phase 7); run because `aztec-line.test.ts` changed |
| `build:testnet`, `verify:build-target testnet` | 0, 0 | |
| `build:mainnet`, `verify:build-target mainnet` | 0, 0 | |
| `forge build` (1.7.1) | 0 | the Solidity fixtures changed |
| the identity search | 0 | only `apps/tools/public/testnet-bridge.json` (lines 5, 15, 109), after the journal's retirement |

Open ledger cases failing, by name:

- `manifest-v2.fixture.test.ts`; `bridge-generation.test.ts` › the sandbox generation (two cases); four
  `useTokenSelection` cases (Phase 6, the fixture).
- `deployments-records.test.ts` › "passes the live file" and its three tamper cases (Phase 6, the faucet
  record).
- `bridge-generation.test.ts` › the shipped manifests › `testnet-bridge.json` (promotion). From this phase
  it also fails on the chain: the row expects 685146337.
- `published-packages.test.ts` (Phase 7).

The network-pin case of `private-fuel.test.ts` closed. `AddressesView.test.ts` passed in the full run.

The identity search runs through zsh here: `rg` is not on a plain `bash -c` PATH on this host, so the
gate helper's first attempt exited 127 and proved nothing.

Commits: the change set, then the journal's retirement on its own (`chore(bridge-core): retire the rc.3
testnet deploy journal`).
