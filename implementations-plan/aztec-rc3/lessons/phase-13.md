# Phase 13 — docs and the final gates

The runbook gained three rc.3 lessons: the read-after-receipt lag and its recovery, a plain `claim_public` in the
calibration matrix, and never overlapping a local forge build with a keyed strict verify. `UPDATE.md` names the
per-manifest declaration check. `follow-ups.md` merged the two `MIN_FUEL_FJ` entries, now with the measured
ceilings, and widened the `ensurePortal` entry to every Inbox writer and the lagging readbacks.

## The final cross-arc pass

Codex `gpt-6.1-sol`, high, fresh session, over PR B's net diff at `1d3bd11`: "No material findings at `1d3bd11` —
moderate confidence overall; three low findings." All three were applied:

1. `aztec-line.test.ts` merged the dependency sections, so an exact peer could hide a range in `dependencies`.
   Each section is now checked on its own.
2. The runbook's retry note said every step reads before it writes. Only the factory and portals do; the note now
   points at § Recovery after a partial landing for the rest.
3. A comment restated `sendGasLimit`. It was deleted.

What holds, in its words: "Both promotions' manifest and faucet hashes match their intents and receipts;
recalibration changes only the two budget fields." "All app bridge sends reach `runSend`; viem preserves explicit
gas."

## Local gates after the gas fix

- Lint, typecheck, every unit test and the CI-gating tests pass, with no expected red left.
- The sandbox smoke passed all steps (`✅ sandbox deploy + smoke OK (10.0m)`), including `runSend`'s deposits and
  fueled sends under the new gas limit.
- The send-related browser specs (`deposit-token`, `deposit-token-gas`, `deposit-gas-only`, `l1-wallet`), the
  app's wallet path, whose test wallet forwards `gas` to `sendTransaction`: `26 passed (26.9m)`.
