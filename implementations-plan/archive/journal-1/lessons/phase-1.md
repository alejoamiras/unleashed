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
- `e2e:tools`, second run: every cell failed to launch Chromium: `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright` lacks
  the pinned build (already in `lessons.md`); rerun with it unset.
- Third run, on the build before the review fixes: 15 passed; cell 56 failed. Its public token-only ask was stood down
  on the second review with `changed: intent`: an account without Aztec gas has its token-only intent flipped to token
  and gas (`SendWizard.vue:614`), and the gas verdict, re-read on entering the amount step, can land after the review
  froze. Unrelated to this arc; cell 56 now sends token and gas like cells 50–52. The harness's `confirmReview` also
  retries a stood-down review through `goToReview`'s same-chain review test id, so a cross-chain stand-down surfaces
  as a missing `tl-send-step-review`, not as the stand-down.
- Cell 56 proves the spent mark only inside the route's 60 s TTL: past it, the amount step requotes anyway.
- Final head: `test:all` (63 s) and `audit:tools` (67 s) pass; `e2e:tools` on the three specs at retry 0: 16 passed,
  29.2 min on chromium. Cell 56 measured 1.1 min against a 120 s estimate, so the suite is about 28.1 min without it;
  the deposit-crosschain spec alone is 13.9 min with it and 12.8 min without.

## Review

- Codex round 1 (gpt-6.1-sol, high), session `01a18d83-e3e7-7f51-aa6c-d45138c94493`: approve with fixes (the
  failure-chain test passed with the caller's `await` removed; one redundant comment). Opus (`general-purpose`):
  approve with fixes (a refused held id reached the failed send's cleanup through `row.id`; the `blocked` rename test
  wrote through this tab's reload; two comments). All applied and checked against their regressions.
- Codex round 2 (resume): approve. Converged in two rounds.
- Signing: mid-arc the SSH agent socket stopped answering (`ssh-add -l` hung) and a commit blocked in
  `ssh-keygen -Y sign`; the signing key is passphrase-less, so later commits sign from the key file with the agent
  socket unset for that one command.
