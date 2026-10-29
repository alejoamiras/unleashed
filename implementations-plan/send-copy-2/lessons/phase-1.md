# send-copy-2 phase 1: arc a1 implementation and review

## Gates

- P1's unit gate: lint, typecheck:all, test:all (tools 127 files, 1705 tests), `apps/tools` test:e2e (30) and
  audit:tools exit 0.
- The worktree lacked the gitignored `contracts/bridge/evm/lib`. The README's pinned `forge install` lines were
  run with `--no-git`, and its cleanup `find` lines then ran.
- Browser gate at retry 0, with `PLAYWRIGHT_BROWSERS_PATH` unset: deposit-crosschain, l1-wallet and recovery,
  14 passed in 18.8 min. Cell 53 took 1.5 min. On the same kept sandbox, main's cell 53 against this build took
  1.4 min.
- Mutation checks on the wizard tests:
  - removing the `enterReview` reset fails two tests;
  - removing the snapshot guard after `xc.send` fails one;
  - ignoring the check's answer fails one;
  - clearing an exit's decline fails one;
  - removing `reviewStands` from the cross-chain check failed nothing at first. It fails both cases since the
    round-1 fix.
- Test-harness gotchas:
  - the `ReviewStep` stub must declare a prop (`paused`) for `props()` to show it;
  - the permission screen remounts the review, so re-find the component after a deposit's confirm.

## Codex fix loop

- Round 1 (gpt-6.1-sol, high): **no material findings**.
  - Nit taken: cell 53 could reach a confirm with lapsed terms. A `liveTerms` helper now waits for Sign or
    Rebuild, rebuilds lapsed terms, and waits for an enabled Sign.
  - Nit taken: `crossChainChecked`'s docblock restated its body, and `clearSendErrors`' opening line narrated.
- Opus `general-purpose`, beside round 1: two low findings, both fixed.
  - The held cross-chain check test passed without its guard. With a token ask, the later gas re-read's own guard
    masked the removal. Fix: a gas-only ask, and a newer review opened before the check returns.
  - The no-reader fail-open path did not log, against D2. Fix: it logs `{ code: "no-reader" }`.
  - Not taken: `goToReview` waits for the Ethereum review's testid, so a stood-down cross-chain review cannot retry
    in `confirmReview`. This predates the diff.
- Round 2, verifying 9e34306: **no material findings**. Converged in 2 rounds.
- Round 3, the last allowed, verifying b9dc86d (P10-01 B folded after round 2) and the merge of origin/main:
  **no material findings**. Codex judged the mapping separate from the Ethereum send's on purpose: there,
  `wrong-chain` describes the wallet's transport, but here the reader is the build's pinned one, so a "switch your
  wallet" sentence would misdiagnose it. A missing reader causes no new false refusal, because `sendOn` already
  needs the same reader.
