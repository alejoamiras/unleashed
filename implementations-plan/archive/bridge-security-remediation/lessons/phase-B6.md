# Phase B6 — cutover (PROMOTE the validated candidate)

Ran on the user's explicit "go". Per the user's earlier decision ("one deploy, hold for promote;
first clean deploy wins"), B6 was a PROMOTE of the B-canary candidate, NOT a fresh redeploy — the
candidate that passed both smokes + F-001-on-chain IS the cutover generation.

## Sequence (all green)
1. **Snapshot** — a pre-cutover copy + git (rollback = `git checkout`).
2. **Promote** — `cp testnet-bridge.candidate.json → testnet-bridge.json`. Live portal
   `0x9c41…` (old canonical) → `0xf2f1…0fa0` (forked-v1).
3. **Post-promote gate** — faucet `test` 335/335 (the reader rebuilds from the new manifest) + `build`
   green. (Biome wanted the manifest's short arrays inline — reformatted before commit.)
4. **No stale refs** — grep confirms nothing references the old portal `0x9c41…`.
5. **Live deposit→claim** — covered by B-canary's smokes on the identical candidate (not re-run).
6. **Commit + push + PR** — the cutover manifest (candidate/journal gitignored) + the plan +
   lessons + redteam audit, indexed. Pushed the task branch; **PR → the base branch**.

## Notes
- Commits are unsigned. The base branch merges via UI **squash**, which GitHub web-flow signs →
  satisfies `required_signatures`. The individual unsigned commits are squashed away. No backfill needed.
- Disclosure: F-001 is now safe to disclose (the live faucet uses the guarded portal; the old portal is
  abandoned + low-value testnet).

## Remaining
- The PR: CI (`Quality / Status`) + review + **UI squash-merge** (the user).
- **B7** — `/harden security` re-pass over the new surface (the forked portal, single-minter proxy,
  12-field router, migration scripts); confirm F-001/F-002/F-004/F-006 closed + no new high/critical.
- Deferred: **F-003** contract CI (user decision); **F-008** accepted-latent.

GOAL MET: PR A merged (F-005/F-007) + B1–B5 + B-canary + B6 all ✓ with gates reported per phase.
