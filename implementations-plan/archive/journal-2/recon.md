# journal-2 recon

Base: `main` at 1b3b202 (#107 merged). One Sonnet Explore agent (writer inventory, nesting, test prior art, init
order, test environment); every claim below was re-read against the tree by the planner.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| A write span under the cross-tab lock | `underJournalLock` (`useBridgeJournal.ts:1028`) | reuse-as-is |
| Guarded patch computed from the fresh copy | `updateRecordWhen` (`useBridgeJournal.ts:508`, bridge-core `patchRecordWhen`) | reuse-as-is |
| Hide a row whose removal waits for the lock | `discarding` + `reload()`'s filter (`useBridgeJournal.ts:268, 314-319`), used by `discard` | reuse (the startup prune joins it) |
| The prune's predicate | inline in bridge-core `pruneCompleted` (`journal.ts:733-740`) | adapt: export it as `isPrunable` so the hide and the prune share one predicate |
| The browser lock adapter | `webJournalLocks()` (`lib/journal-locks.ts:25`), wired only in `ensureSendJournalDeps` / `ensureHubExitDeps` | adapt: the engine's default deps carry it |
| Lost-write test shape | `crosschain-deposit-flow.test.ts:328-370`, `useSend.test.ts:791-835` (counting wrapper over `memoryJournalLocks()`, another tab's held load → write) | adapt: one shared helper in `composables/test/` |
| A `navigator.locks` fake | `fakeLockManager` in `lib/journal-locks.test.ts:7-27` (file-local) | not needed: a one-line `request` stub suffices for the default-wiring test |

## Writer inventory (production code, unlocked on main)

- `useHubExit.ts:498` `openExitRecord` → `addRecord` (upsert), then `markSessionLive`, `setRecordStep`; called
  through `authorizeExit`'s synchronous `open()` (`:459-473`).
- `useHubExit.ts:268` `onSent` → `updateRecord({ consumeTxHash })`; the SDK's `consumeWithdrawal` calls `onSent`
  synchronously and does not await it (`packages/sdk/src/execution/flows.ts:39, 79`). `@unleashed/sdk/internal`
  is workspace-only, never published (`packages/sdk/src/internal.ts:1`).
- `useBridgeJournal.ts:738` `blockTokenRecords` (from `attestSendTokenBlocks`, called by
  `useSend.ts:451` `pinAttestedJournalTokens`; the explorer's "no non-test caller" was wrong).
- `useBridgeJournal.ts:758` `checkTokenBlock` (claim guard `:1185`, consume `:1886`).
- `useBridgeJournal.ts:1057` `completeWithdraw` (`:1744`, `:1897`); it reads this tab's lagging copy for its
  `completedAt` check.
- `useBridgeJournal.ts:1747, 1894, 1899`: the consume hash and its two clears.
- `useBridgeJournal.ts:426-428` `initJournal`: `quarantineInvalid` and `pruneCompleted`, both whole-lane rewrites
  (each writes only when it moves or drops a row). The issue names only the prune.

## Claims that did not hold

- **The fee-ladder store's `merge` is unreachable.** `journalStore` (`deposit-flow.ts:49-58`) is used only by the
  app's `patchFuel` (`:68`), which calls `mergeWhen` only (`fee-env.ts:74`); its one caller is
  `reconcileFuelConsumed`, already inside `underJournalLock` (`fuel-recovery.ts:44-48`). The SDK's only
  `records.merge` (`deposit-recovery.ts:59`) runs on the claim run's own store, which writes through the locked
  `persistClaimDelta` (`useBridgeJournal.ts:1428`). Searched `FeeLadderStore|patchFuelOn|\.merge\(|mergeWhen|records.merge`
  over `apps/tools/src` and `packages/sdk/src`. Wrapping `journalStore` would nest a request inside
  `reconcileFuelConsumed`'s span and break `mergeWhen`'s synchronous boolean.
- **The prune runs before any lock adapter exists.** `AppShell.vue:37-38` (`useCompletionToasts`,
  `useActivityFeed`) call `useBridgeJournal()` → `initJournal()` in the shell's setup; `SendWizard.vue:186-187`
  (`useSend`, `useHubExit`) wire `locks` later in the same mount. A call-site `underJournalLock` at init reads
  `deps.locks` as undefined and degrades to an unlocked deferred call.

## Nesting

No unlocked writer is reached from inside a journal-lock body. Every body on main is synchronous and calls only
engine wrappers and in-memory marks. The consume path runs under the record lock (`withRecordLock`, `:908`), and
`attachAndConsume` awaits its rekey span before the consume (`:605-614`): the order is record → journal.

## Test environment

`apps/tools/vitest.config.ts`: jsdom; `src/test/setup.ts` defines no `navigator.locks`, so `webJournalLocks()` is
undefined under test and tests inject `memoryJournalLocks()`. `initJournal`'s prune and quarantine have no app-level
test (bridge-core `journal.test.ts` covers the primitives).

## Collisions

PR #113 (claim-keep-1) edits `useBridgeJournal.ts` in the claim region (`:1325-1662`, `:1904-1924`) and two doc
comments in bridge-core `journal.ts` (`isRetirable`, `pruneCompleted`). This lane edits `pruneCompleted`'s body
line and the engine's exit and init sites: merge `origin/main` before the PR.
