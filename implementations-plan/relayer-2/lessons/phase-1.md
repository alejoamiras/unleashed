# relayer-2 phases 1 and 2: implementation and the fix loop

- Gates on the a1 head: package tests 34/34, typecheck, root lint, `typecheck:all`, the anvil integration suite 6/6
  (it needs `lib/forge-std` and `lib/openzeppelin-contracts` in `contracts/bridge/evm`, then `forge build`), and the
  live window test 1/1 with `RELAYER_LIVE=1`.
- Mutation checks: the old two-hour `ignored` window, the old block-count window and an unraced survey each turn a
  new test red.
- Codex fix loop round 1 (session `01a1890f`, high): two low findings, both comments, both accepted. The run and
  pass comments promised an end before the next cron, but an admitted send is awaited past it (the §1 limit): they
  now say a run starts nothing after its end. Two narrating comments were deleted. No runtime finding; its
  in-memory traces confirmed that an abandoned survey reaches no read and that passes never overlap.
- Same-family review of the a1 diff (Opus, general-purpose), alongside round 1: no medium-or-higher finding; eight
  low or nit. Accepted: a pass starts only at a slot, never right after an overrunning pass (the code had run an
  overdue slot at once, against D10's own wording); a read in flight at the deadline is refused too, so an
  abandoned survey logs nothing more (the stall test now releases an `ignored`-shaped deposit, and dropping the
  refusal turns it red); a run too late for any pass logs `late`; the live test reads two blocks below the head,
  with retries; a worker test for a failed first pass; §1 case 1 widened to a try slow before its first write;
  D5's "no gap" corrected; wording nits. Accepted as a known limit (README 4): a pass whose Sepolia backend lags the
  fill the previous pass landed can try that relay again, gas only. Rejected: a guard for finite deadlines over
  2³¹ − 1 ms, which no caller passes (`Infinity` skips the timer).
- `pkill -f "<pattern>"` in a command whose own text holds the pattern kills that command's shell (exit 144).
