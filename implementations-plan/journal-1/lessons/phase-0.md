# journal-1 phase 0: planning consults

## Recon

- Two Sonnet Explore agents: a journal writer inventory and a reuse sweep. Both returned; findings are in `recon.md`.
- The writer inventory read `main`, where #80's list of already-locked writers does not hold. PR #88's files, read
  through the contents API, show that list holds there. Lesson: an issue written against an open PR's tree reads as
  false on main; check the PR before calling a claim wrong.

## Audit round 1

- Codex (gpt-6.1-sol, high), fresh session `01a18a38-3655-7291-ab1a-eea5a13e853d`. The host's sandbox opt-in ran
  it as approve-for-me with the read-only host note. Verdict: **reject**, five blocking findings:
  - S1 (plausible): another tab's two-click Discard of the landed record stands the wizard down to the same frozen
    review; within the 60 s TTL a second confirm files the freed id with the same secrets. Verified: the card shows
    Discard on an unfinished deposit once it has a leaf (`BridgeJournalCard.vue:498-506`, `crosschain-activity.ts:48`).
  - S2 (demonstrated): the cross-chain restore's insert stays unlocked and writes the whole lane. Accepted.
  - S3 (demonstrated): the locked rekey builds its replacement from a copy read before the span; a discard in
    another tab is overtaken. Accepted in part (see plan D3).
  - S4 (omission): the failure bookkeeping is synchronous; awaited writes need an async chain. Accepted.
  - The plan's "no visible change" and "no e2e" are wrong as stated: D1 re-prices on screen; AGENTS.md requires
    `bun run e2e:tools` for bridge flows. Accepted.
  - F6 is false after #88 (its `discard` hides a row before the locked removal). Accepted; restated.
- Opus Plan critique (opus, Plan agent): **conditional approve**. Verified and accepted: the filing span must also
  mark the record session-live, or the wizard's pre-flush watcher sees the row before the mark and the stepper does
  not take over (`SendWizard.vue:1170-1175`); resetting `asked` at send time drops `amountReady` and changes the step
  strip (`SendWizard.vue:621-627`), so D1 became a lazy spent mark; the held-id test must pin the TTL; the held-id
  throw must stay before the `try`; lock `track` and insert both families; one open issue for the remaining writers.
  Disagreed with Codex on a new browser cell (not needed); the plan keeps cell 56 (the brief asks for two cards).
- Lesson: wrapping a synchronous write in an awaited lock moves every in-memory step after it past a microtask
  boundary, and Vue's pre-flush watchers run there. Keep in-memory marks a watcher keys on inside the same span.

## Final fresh pass

- Codex (gpt-6.1-sol, high), new session `01a18a48-645e-7db3-93f0-d995c7d371ca`: **conditional approve**. Conditions,
  each verified and applied: D1's lazy mark read "no route" as spent (`null === null`), so it now needs
  `spent !== null`; cell 56 could not press New send while bridging (only Run in background reaches `onNewSend`);
  the restore race's "already tracked" refusal would be a new visible outcome, so the restore keeps the stored record
  and succeeds as today.
- Resumed verify pass, same session: **approve**; one wording fix (a concurrent restore may use another backup of
  the same bridge).
- Lesson: a lazy identity mark compared against a value that can be null matches every null; guard the mark first.
