# Phase 1 — the nullifier helper, the dep, the two engine branches, the two locks

Arc 1 (the task branch). Gate: `bun run --cwd apps/tools test -- src/lib/message-nullifier src/composables/useBridgeJournal`
(2 files, 125 tests) + `src/lib` (25 files, 424) green; `bun run --cwd packages/bridge-core test -- src/journal` (28) green;
`bun run --cwd apps/tools typecheck` exit 0; `bun run lint` exit 0;
the whole tools unit suite (100 files, 1327) green.

## What landed

- `apps/tools/src/lib/message-nullifier.ts`: `recomputeTokenMessageHash` (the seven Inbox inputs),
  `tokenMessageNullifier` (`computeFeeJuiceMessageNullifier` siloed by the hub; the private secret is
  `deriveTokenClaimSecret(salt, recipient)`), and `tokenMessageState` (recompute → compare to the stored
  hash → `invalid` without a lookup; else the witness read ⇒ `nullified`/`live`; any throw ⇒ `unknown`).
- `packages/bridge-core`: `claimedByOther?: boolean` on deposit records (backup validator accepts it),
  `rekeyRecordWhen` (guarded re-key, refuses an occupied destination) — arc 3 uses it.
- `apps/tools/src/lib/journal-locks.ts`: `webJournalLocks` (Web Locks; the record lock branches on the
  `null` lock object `ifAvailable` hands over under contention) and `memoryJournalLocks` (the unit fake).
- Engine (`useBridgeJournal.ts`): `messageNullified` + `locks` deps; `resolveClaimStart` runs the
  probe BEFORE `buildClaimHandles`; `awaitConsumable` is tri-state through `classifyConsumable`;
  `isMsgConsumed` matches the public-context wording; `recordMessageConsumed` reads the nullifier for
  hub token sends and keeps the claim-build probe for everything else; `completeClaimedByOther` writes
  `{ claimedByOther, completedAt? }` through `patchRecordWhen` under the journal lock with a
  snapshot + `gen` guard; a `claimedByOther` record resumes only to complete once its fuel settles.
- `fuel-claim-state` / `record-policy` / `fuel-recovery`: `claimedByOther` counts as a finished token
  leg for the public standalone gas offer, hides CLAIM, is exposed to the card (`RecordState.claimedByOther`),
  and the standalone gas claim hands the completion back to the engine.
- `useSend.ts` wires `hubMessageNullified` (envelope facts for a private record, `resolveToolsTarget().rollupVersion`,
  `getNullifierMembershipWitness("checkpointed", n)`) and the locks; `useHubExit.ts` wires the locks.

## Lessons

- **bb.js poseidon under jsdom throws `std::bad_cast`.** The tools vitest config is jsdom; bb.js's sync
  poseidon binding rejects jsdom-realm typed arrays. Every test that hashes with poseidon carries
  `// @vitest-environment node` (the existing `deposit-flow.test.ts` already did). Plain `bun run` of
  the same code is fine, which is what made it look like a version mismatch at first.
- **Test field constants must be below the BN254 modulus.** `0x3c…` / `0x4d…` repeated to 32 bytes
  exceed it (`Fr.fromString` throws "greater or equal to field modulus"); prefix a zero byte.
- **A resumed claim-build probe re-runs per poll.** Test (h)'s first draft counted `claim` calls with
  `smartClaimFake` (simulate succeeds ⇒ "still claimable" ⇒ 45 polls per round ⇒ 137 builds). The pin
  now uses a probe whose simulate throws the consumed wording, so the record completes as today.
- **`runDepositClaimLocked` sat at the cognitive ceiling.** The probe and the tri-state added ~6 points;
  the pre-build stretch (`resolveClaimStart`) and the consumability outcome (`settleConsumability`) were
  split out rather than suppressed.

## Decisions (none needed a consult)

- The held-elsewhere outcome is logged, not surfaced on the card: it is the same "already in flight"
  case as today's process-local duplicate, and the two-tab browser cell (activity 40) races two
  DIFFERENT records, so no cell changes.
- A private `claimedByOther` record's fuel decision is `"none"` (not `private-settled`, which would
  claim its Fee Juice paid for a completing tx that never happened, and not `private-unknown`, whose
  card copy says the gas state is unknown — it is known: sealed and unspent). Phase 2's card line says so.
- The dep signature carries the whole `SendDepositRecord` plus the resolved material; the identity
  (hub, rollup version) is resolved in `useSend.ts`, not stored, per the plan's "recomputed, never trusted".
