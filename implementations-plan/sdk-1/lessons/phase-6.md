# Phase 6 (Arc a6)

## The plan amendment

- Recon (two Sonnet explorers): the claim card's states and specs; the journal's schemas, writers, retirement and
  locks. The app engine's verification, rounds and resume rules read directly.
- Codex consult (gpt-6.1-sol, high), four rounds on one session; Opus 5.5 Plan agent beside round 1. Verdicts are in
  the plan's Audit verdicts. What changed the design:
  - The persist adapter needs an identity guard, not only a field CAS: a stale nullifier verdict could otherwise
    complete a record whose message moved.
  - "Unreachable" claims about record states have to be checked against write order: the ladder latches the gas-only
    fuel hash before the engine writes the top-level one, so the fuel-hash-only state is reachable and keeps today's
    receipt reading.
  - A gas-only claim is a carrier-less transaction with no app phase: it cannot revert after its setup, which removed
    an apparent owner ask.
  - Re-entering the app's own claims each receipt round turns them into resumed calls, so the SDK's verification runs
    where today's engine trusted its provenance; bounded only by node health (known limit).
