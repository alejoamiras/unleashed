# send-copy-1 phase 1: arc a1 implementation and review

## Gates

- P1 green: lint, typecheck:all, test:tools.
- P2: lint, typecheck:all and test:e2e green. In test:all, tools' untouched `bridge-generation.test.ts` timed out at
  5 s three times under host load (load average about 140 on this host). It passes alone and in the full test:tools
  run, so it counts as the host.
- The worktree's gitignored forge `out/` predated `FuelOnlyGate`, so the SDK's code-pins test failed with ENOENT.
  `forge build` in `contracts/bridge/evm` fixed it.
- A mutation check proved the wizard's held-check test: with the post-check review guard removed, both cases fail.
  A first draft of that test had silently built a private review, which takes the gas re-read path rather than the
  fast path. Asserting the plan the check received caught it.

## Codex fix loop, round 1 (gpt-6.1-sol, high)

- One material finding, **demonstrated**. A receipt requested while the bridge check reads is deferred by the
  `preflighting` hold. Dropping the hold queues the wizard's request watcher, and that watcher runs before the
  awaiting caller resumes. `bridgeChecked` tested the review in the same tick it dropped the hold, so the guard
  passed. The watcher then replaced the review, and the confirm sent the old review anyway.
- A regression reproduced the finding: the receipt opened and `send` still ran.
- Fix: the hold moved into an awaited `heldCheck`, and the review is tested after it resolves. This is the same
  shape `preflightReads` already has. A normal-send control was added.

## Same-family leg (Opus, beside round 1)

- No material findings. Its nits were applied in a follow-up commit:
  - `DepositPlan.pauseCheck` is gone, since nothing passed `false` after this arc;
  - the `preflight` docblock now names the bridge check;
  - the wrong-chain sentence now says only the session's first check compares chains;
  - a `useSend` test was renamed to claim only the mapping it proves.
- Left as is: a refusal sentence persists through Back then Next, as every `sendFlow` error already does. Clearing it
  changes when existing errors disappear, which is a visible change for the owner.

## Codex fix loop, round 2

- Verified both fixes, including the Vue-scheduler reproduction for a pass and a refusal. **NO MATERIAL FINDINGS**:
  converged in 2 rounds.
