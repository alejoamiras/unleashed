# gas-floor-1 phase 1: arc a1

- Tests first: the route case and the send case both failed on `main`'s `gasFailure` (`unavailable` where
  `below-floor` belongs), reproducing ask28. Mutation control after the fix: restoring the old body fails both again.
- The send case's first wait (`route` null) passed before the re-quote landed, because `latestQuote.ask` clears the
  answer at once. Waiting on the new `gasError` is the landing signal.
- Sandbox boot in a new worktree: the canonical clone's `contracts/bridge/evm/lib` lacks `lifi-contracts`; the
  README's pinned `forge install --no-git lifi-contracts=…` fills it. The first boot also logged an Aztec "Address
  already in use" next to that missing-library error; the second boot, with the library, was clean.
- Browser gate (retry 0): `deposit-crosschain` 6 passed (cell 55 41.6 s), `deposit-token-gas` 7 passed; 19.9 min.
- Screenshot tour: the Ethereum stepper passes Authorize and Deposit + fuel within a second in the sandbox, so its
  pending "Crossing ~1 min" needs a held transaction (`l1.holdNext("transaction")`) to stay on screen.
- `audit:tools` on the merged head hit one 5 s timeout in `bridge-generation.test.ts` (untouched) at load average 148,
  with a sandbox booting beside it; the file passed alone (10/10), and `test:all` had passed it minutes earlier.
- Codex fix loop: r1 CLEAN (one comment nit), r2 CLEAN on the fix diff. Opus review: three findings, adopted or sent
  to the owner (plan § Audit verdicts).
