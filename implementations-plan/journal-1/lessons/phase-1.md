# journal-1 phase 1: arc a1

## Implementation

- `insertRecord` in bridge-core, behind both verified adds; the spent mark in `useCrossChainSend`; call-site
  `underJournalLock` on both send flows, the private seal and the restore's `track`. `useCrossChainSend` crossed the
  80-line function budget; the private-slice predicate moved to a module function (`pricedFor`).
- `useSend()`'s wiring passes `locks: webJournalLocks()`, which is `undefined` under node, so a test that injects
  `memoryJournalLocks()` must connect it after calling `useSend()`.
- `JournalLocks.journal(fn)` types a span returning a promise as `Promise<Promise<…>>`; a test holder that keeps the
  lock across an await is typed `Promise<unknown>`.
- Each new unit test was checked against its regression by reverting the code it covers: the unlocked `srcTxHash`
  write, the marks outside the filing span, the un-awaited not-sent patch, `upsertRecord` in place of
  `insertRecord`, the unlocked `persistSend`, and dropping `blocked` from the rename. Every one failed its test.

## Gates

- On 9aae2a5: `journal.test.ts` (34) pass; the five app suites (197) pass; lint pass; `typecheck:all` pass; `test:all`
  pass (71 s); `audit:tools` pass (83 s).
- `e2e:tools`, first run: the sandbox died while booting: `contracts/bridge/evm/lib` was missing in this worktree.
  Installed the pinned libs as `.github/actions/setup-forge/action.yml` does (`forge install --no-git`) and removed the
  upstream agent-instruction files; the `.env` cleanup line was not run, since this lane may not search for `.env`
  files.
