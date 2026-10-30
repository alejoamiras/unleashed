# journal-2 phase 0: planning consults

## Recon

- One Sonnet Explore agent: writer inventory, nesting, test prior art, init order, test environment. Its claim that
  `attestSendTokenBlocks` has no production caller was wrong (`useSend.ts:451`); every other claim held.
- Two issue claims did not hold: the fee-ladder `merge` is unreachable in the app, and the prune runs in
  `AppShell`'s setup before any lock adapter is wired, so a call-site wrap at init alone stays unlocked.

## Audit round 1

- Codex (gpt-6.1-sol, high), fresh session `01a18e0c-c20a-7220-9bbb-95ab51e0f0b0`; the host's sandbox opt-in ran it
  as approve-for-me with the read-only host note. Verdict: **reject**, two findings:
  - Moving `quarantineInvalid` into the deferred, caught span lets a later write drop an invalid entry after a failed
    quarantine; today the throw fails `AppShell`'s setup first. Verified (`App.vue` loads `AppShell` with
    `defineAsyncComponent`). Settled: the quarantine stays synchronous; its unlocked rewrite is a closed known limit.
  - The tests pinned serialization, not the fresh-copy completion guard, the foreground capture or the first-tick
    session mark. Accepted; holds are armed after init so the prune's request is never counted.
  - Smaller: `useHubExit.test.ts` runs under the node environment; capture one `now` for hide and prune.
- Resumed pass on the settlement: **approve**; the known limit must describe an unverified interleaving of supported
  conditions.
- Lesson: deferring a startup step into a lock span also defers, and can swallow, its failure; check what today's
  synchronous throw was preventing before catching it.

## Final fresh pass

- Codex (gpt-6.1-sol, high), new session `01a18e12-c0be-7661-999d-f11268572620`: **conditional approve**. Condition:
  a failed prune must keep its rows hidden; restoring them "as `discard` does" would show an expired card that today
  never shows. Verified and applied, with a throwing-storage test. Resumed verify pass: **approve**.
- Lesson: when a deferred step borrows another path's failure handling, check that handling's visible result against
  what the old synchronous step showed on the same failure.
