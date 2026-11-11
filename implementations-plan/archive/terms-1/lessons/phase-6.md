# Phase 6: the owner's answers

## Merge of main

`origin/main` had moved 11 commits (sdk-1, mainnet-1's first arcs, the testnet relayer). Conflicts:
the CI path filters, `AGENTS.md`'s read list, `scripts/ci-cd/workspaces.test.ts` (both sides added
workspaces: kept all), `apps/tools/package.json` (main sorted the `@unleashed/*` block; `legal` joined
it) and `bun.lock` (main's lockfile, then `bun install` added only the `legal` workspace and its two
links; the 7-day gate no longer blocks the Aztec 6.0.0 pins). The auto-merge also doubled
`allowImportingTsExtensions` in `apps/tools/tsconfig.json`, which main had added too; main's line kept.

## Re-trace against the merged tree

| Claim | Merged code | Holds |
|---|---|---|
| The mainnet app is a holding page that calls nothing | `App.vue` unchanged; `MAINNET_TARGET.cspConnectSrc` still `'self' data: blob:` | yes |
| Pause stops new deposits | mainnet's fuel route puts `FuelOnlyGate` in the router's factory slot: `setDepositsPaused`, `onlyOwner`, renounce disabled (`FuelOnlyGate.sol`); the router still checks `depositsPaused()` on every entry | yes |
| Sweep reaches only balances held outside a call | `DepositRouter.sweep` unchanged | yes |
| The PrivateFPC has no owner | the mainnet descriptor now pins the installed artifact (`packages/sdk/src/protocol/private-fpc-canonical-mainnet.json`, sha256 `bc1e27b0…`): `balance_of`, `mint`, `mint_and_pay_fee`, `pay_fee`, an only-self helper, `offchain_receive`, `sync_state`, `public_dispatch`; no admin function | yes, now verified for mainnet |
| A private gas record keeps its secret and salt readable, next to a sealed copy | `useSend.ts:712` → `send-record.ts:36-42`; every private send seals (`useSend.ts:717-719`) | yes |
| Pruning at start; lists trimmed toward 100 by completed records, unfinished ones never removed; each quarantine capped at 100 | `useBridgeJournal.ts:70`, `journal.ts:53,434` | yes |

Two imprecisions left as they are, because the owner approved the text as shown and neither is false:
the Terms say a token is swapped "into Fee Juice … unless it already is Fee Juice", while on Ethereum
the fee asset is AZTEC, which the portal turns into Fee Juice; and the Policy's list of service kinds
has no same-chain swap quote (main's gas pricing asks li.quest with the token, the amount and the
router's address, not the user's). The Policy promises to name every provider before the app calls it,
and the provider pin fails until it does, so the list is updated with the first mainnet origin
(mainnet-1's M4). mainnet-1's arc a3 (Drip on mainnet) also contradicts the Terms' "it will offer one
thing", so that arc changes §3 too.

## A11

Both documents dated 29 October 2026, the UTC date of the final revision, in the same commit as the
landing guard's refusal of an owner's blank (`dist-checks.ts`) and a package test that every
`updated` is a date.

## Gates

lint, `typecheck:all`, `test:all` (tools 1681, sdk 434, bridge-core 525, landing 87, design 242,
testnet-relayer 25, legal 4), `test:ci-gating`, `lint:actions`, `audit:tools`, both tools builds with
`verify:build-target` (legal links absent on testnet, present on mainnet), the landing build and
guard, the landing browser smoke (30 passed, the live case skipped). `e2e:tools` stays CI's, as in P5.

## Code fix loop (Codex gpt-6.1-sol, high)

**Round 1** (fresh session, on the merge and the P6 delta): no material finding. Fixed: this file's
retention wording; a trust note on the exported `link()` (it escapes only `href`); a narrating comment
on `render` in `vite.config.ts`. Kept: the guard's header (it states the import constraint that keeps
the guard auditable), the legal stylesheet's one-line header, and the placeholder's `/** Services */`
section labels (the repo's Vue convention).
