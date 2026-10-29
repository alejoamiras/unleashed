# Phase 4 lessons

## 4.1 The app's claim lanes on the SDK

- **The comparison came first, and it decided the arc.** Before touching the engine, `runDepositClaimLocked` and its
  helpers were read side by side with `claimToken`/`claimFuel`: seventeen gaps, eight of them visible (fee-stop
  timing, claimed-by-another, leftover gas, a dropped claim found on resume, narration, recovery waits, the attempt
  latch, the trust checks). The plan had assumed the SDK entries could carry the app with an event map.
- **Panel consult (Codex `gpt-6.1-sol` high, Opus 5.5 Plan beside it): both chose C.** Keep the engine, ask the owner
  once (`OWNER-ASKS.md` §10), fix the SDK's own bugs. Opus traced two: a private token + gas record whose token
  another submitter claimed settled with its gas unclaimed (a week later the app prunes it, sealed salt and all), and a
  token + gas record holding only its token leaf never read its gas leaves. Codex found an abort hole for a later port
  (a successful simulate reaches the send with no abort check) and that the gas claim's hash lives in
  `fuel.claimTxHash`, not the top-level field the app's resume reads.
- **Mutation-checked.** Each of the two new `claim.token.test.ts` cases fails with its fix reverted.
