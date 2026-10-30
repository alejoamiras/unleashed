# journal-2 phase 1: arc a1

## Implementation

- Merged `origin/main` (#113, #114) first; no conflict with this arc's sites.
- `isPrunable` in bridge-core; the engine's default deps carry `webJournalLocks()`; the two wiring lines are gone.
- The prune hides its rows through `discarding` and skips the lock request when nothing is expired, so a test
  without expired rows sees no startup request.
- Each new test was checked against its regression by reverting the code it covers (scratch script, restored with
  `git checkout`): every lock wrap, the stale `blocked` selection, the stale completion guard, the completion
  bookkeeping after the await, the exit marks after the await, a synchronous prune, a failed prune that unhides, the
  missing default adapter and the SDK's un-awaited `onSent`. Every one failed its test.
- The first `onSent` revert passed: the other tab's hold was requested, but its span had not loaded the lane when
  the unlocked write ran, so the hold read the write. `hold` now resolves once the lane is loaded and every arm
  awaits it. Lesson: a lost-write test must let the other tab's load happen before the write under test.
