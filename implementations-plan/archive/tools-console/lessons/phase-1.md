# Phase 1 — policy, feed, shell/dock state, toast owner, small fixes

No visible change; everything the later phases lean on.

## What landed

- `lib/record-policy.ts` — `recordState(record, rt, wallet)` and `accountOf`, extracted verbatim from the card's computeds. The card wraps it in one `computed` and keeps its UI state (discard arm timer, fuel-recovering flag, the reconcile watcher). `BridgeJournalCard.test.ts` is byte-identical to the base and green: the extraction preserved behaviour.
- `lib/activity.ts` — `classify` in the card's precedence (`completedAt` first, then `busy`, then the gates), `groupRecords`, `needsYouCount`, `phaseWord`, `routeWords`, `visibilityWords`, `rowStrings` (symbol through `safeDisplay`), `ageWords` (the card now uses it too).
- `composables/useActivityFeed.ts` over `visibleRecords` + runtime + wallet refs + `useNow`, all read inside the computed.
- `composables/useShell.ts`, `useDockState.ts` (preference + journal-pruned seen set, storage re-read per call), `useCompletionToasts.ts` (the watcher moved out of `BridgeJournal`; `AppShell` calls it once; the `toasts` prop is gone).
- Small fixes: `userMessage` in `lib/errors.ts` unwraps viem's `details`/`shortMessage`; `useTokenSelection.select` uses it; the card renders `blocked` through a new `safeSentence` (same strip, 240-char cap) and the symbol through `safeDisplay`; the stale `visibleRecords` comment rewritten.

## Findings while doing it

- `safeDisplay` caps at 32 characters — right for a symbol, wrong for a sentence. The engine's own blocked reasons are ~70 characters, so the first card test run truncated them. `safeSentence` (240) shares the strip and differs only in the cap.
- The "8 lint errors" after the first run were biome *format* diagnostics on my new test files, not rule violations; `biome check --write apps/tools/src` cleared them. The 31 warnings and 5 infos remaining are pre-existing. `bun run lint` exits 0.
- Running vitest through `bunx vitest --config apps/tools/vitest.config.ts` from the repo root fails to find the setup file; the package script (`bun run --cwd apps/tools test -- <files>`) is the way.
- `classify` and the toast watcher both landed at cognitive 16 on the first cut; a one-function split each brought them under the 15 budget without a suppression.

## Gate

`bun run lint` exit 0 · `bun run --cwd apps/tools typecheck` exit 0 · `bun run --cwd apps/tools test` 92 files / 1202 tests passed · `bun run --cwd apps/tools test:e2e` 2 files / 21 passed · `git diff --quiet <rev> -- <nine frozen step files>` exit 0 · `git diff --quiet <rev> -- apps/tools/src/components/BridgeJournalCard.test.ts` exit 0 · parity pin in `lib/activity.test.ts` green.
