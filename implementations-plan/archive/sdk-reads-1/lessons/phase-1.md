# Phase 1: both fixes and the app on the SDK read

- The first bad-checksum fixture lowercased the address's last character, a digit, so it stayed valid and the test
  could not go red for the right reason. Flipping a letter's case (`A579` → `a579`) makes viem's `isAddress` refuse it.
- The new worktree had no `contracts/bridge/evm/lib`; installed the README's pins with `--no-git`. The README's cleanup
  also deletes upstream `.env` files by name; that part was skipped, as this run may not search for `.env` files.
- Codex round 1: `findings: 0`, two optional suggestions adopted (reorg wording, a -32603 refusal row). Opus review
  beside it: one Low (a cyclic `cause` hangs the walk), adopted with the repo's own depth-8 bound. Round 2: `findings: 0`.
- vitest's `it.each` with arrays has no positional `%4$s`: order the row so the interpolated values come first.
