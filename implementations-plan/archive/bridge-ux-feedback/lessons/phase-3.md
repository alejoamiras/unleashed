# P3 — stacked dual balances + gates (lessons)

## P3 COMPLETE
- The Aztec panel now stacks BOTH balances (`Public: X` / `Private: Y`) with `data-active` + highlight following the toggle — visibility never depends on it (the arbitrated F5 (a) design, unanimous across all three reviewers). The Ethereum side keeps its single line; the flip keeps the stacked pair on whichever side is Aztec.
- `bridgeBalanceL2` testid retired for `bridgeBalanceL2Public`/`bridgeBalanceL2Private`; validation still binds to the ACTIVE balance only (`l2Balance` per toggle, untouched).
- Tests reworked: both-visible-without-toggling pin, active-flips pin, stacked-pair-follows-the-flip pin. Suite 190 ✓, smoke 9 ✓, build ✓.
- Gates: `bun run audit:faucet` exit=0 · `bun run audit:vue` exit=0 (both in the transcript).

LESSONS_FILE=implementations-plan/archive/bridge-ux-feedback/lessons/phase-3.md

## post-impl closed
/code-review max --fix: 1 fix (stale soft notes) committed separately. Codex post-impl: reject (cross-tab stale runners) → fixed (existence+idempotency guards on completion writes, post-send bail, copy align, toast pin, 2 cross-tab pins) → verdict flip: **approve**. Suites: faucet 196 ✓ · smoke 9 ✓ · gates audit:faucet/audit:vue exit 0.

LESSONS_FILE=implementations-plan/archive/bridge-ux-feedback/lessons/phase-3.md
