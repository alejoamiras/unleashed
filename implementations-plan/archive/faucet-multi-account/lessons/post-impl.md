# Lessons — post-implementation (code-review + codex audit loop)

## Outcome
`/code-review max --fix`: 1 finding applied (immediate pre-select) — which itself introduced a TDZ crash the suite's unhandled-rejection detection caught (immediate watchers run synchronously during setup; declarations must precede them). Codex post-impl: **reject → approve** across two rounds; final state 576/576 tests, typecheck 0, lint 0.

## The two post-impl HIGHs were real phase-work misses

1. **Wrong-account journal actions**: the phase-2 "verify the journal guard" step found the PRIVATE-claim mismatch guard and declared the item satisfied — but public claims and the standalone gas claim had no guard at all, so a card action could act for account A while the chip showed B. Lesson: when a plan item says "re-scope/guard X", verifying that A guard exists is not verifying that THE invariant holds — enumerate the action surface (public/private/auto-resume/standalone) before citing prior art as coverage.
2. **Escaped operation spans**: the D-19 sweep grepped RPC call sites but reasoned at the WRAPPER level — `claimFuelStandalone` (a direct export bypassing the wrapped entry points) and a detached `void sendStandaloneFjClaim(...)` (outlives its parent span) both escaped. Lesson: for span invariants, sweep for DETACHED promises (`void fn(...)`) and direct exports separately from the happy-path call graph.

## Other keepers

- **Fail-closed guards**: `if (known && mismatch)` silently allows the unknown case; codex flagged it, and `if (!known || mismatch)` is strictly safer wherever the action can simply be retried after connecting properly.
- **`isValid()` needs the Barretenberg WASM** — it works under `bun -e` but throws `std::bad_cast` in the jsdom vitest env. Curve-validity evidence therefore lives in an out-of-band probe pinned in a comment; the suite asserts only what its runtime can compute. Probe result: 0x…02/0x…05 ARE curve-valid, 0x…03/0x…04/0x…06/0x…07 are NOT — fixture choice matters when the test's claim is "provably invalid".
- **Never pipe a gate command into `tail` inside a `&&` chain** — the pipeline exit code is tail's, and a red suite can slide a commit through. Capture to a file, `echo $?`, then read the file.
- The audit-fix commit shipped with a commitlint WARNING (footer-leading-blank) — warnings don't block; fine.

## Codex loop stats (whole plan)
Plan-time: reject → reject → conditional-approve (3 rounds, 31 ledger entries D-1..D-31). Post-impl: reject → approve (2 rounds, D-32..D-41). One codex misread successfully rebutted with evidence (D-15); one of my fixtures successfully rebutted by codex with evidence (D-35). The loop worked in both directions.
