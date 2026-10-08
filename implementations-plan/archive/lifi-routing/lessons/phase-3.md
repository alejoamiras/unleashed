# Phase 3: Encodings, schemas, journal, envelope

**Verdict: done.** Everything the core library persists or signs for a cross-chain deposit now exists and is
pinned. The app still reads only what it read before; arc 4 wires the new keys.

## Facts the next phases rely on

- **`DepositWitness` (`l1.ts`)** matches `DepositRouter.hashWitness` byte for byte:
  - typehash `0x1069…5745`, and the shared vector `0xcda2…5d12` from `test/DepositWitness.t.sol`;
  - viem's own `hashStruct` over `DEPOSIT_WITNESS_PERMIT_TYPES` gives the same hash, so what a wallet signs is
    what the router checks;
  - the witness carries `keccak256(swapData)`, so changing one byte of `swapData` changes the hash.
- **`manifest-v2.ts` additive fields** (`depositRouter`, `fuelSwapper`, `fuel`, `legacyRouters`, `routing`) are
  refined:
  - the swapper is refused on chain 1; elsewhere it is present exactly when the router is;
  - a router needs the fuel budgets;
  - the current router is never listed as legacy;
  - routing needs a router;
  - every `destToken` is a manifest token;
  - a source chain is never the destination chain and never repeats.
- **`parseFeeJuiceDeposit(logs, portal)`** reads only the named portal's events. A router or LI.FI transaction
  runs third-party code that can emit a look-alike.
- **Journal storage keys.** Cross-chain records (schema 4) live under `unleashed-bridge:journal:crosschain:v1`,
  with their own quarantine key.
  - `loadJournal` still reads `JOURNAL_KEY` only. `loadCrossChainJournal` reads the new key, and `loadAllRecords`
    reads both.
  - Writes route by schema, and an id lives under one key only.
  - Cross-chain records are validated before every write, so a malformed patch throws instead of vanishing on
    the next round trip.
- **Retention.** `isRetirable` is the only gate for the cap and the prune. A cross-chain record retires only once
  it is deposited (`leafIndex`) and claimed (`completedAt`), with no outcome and no extra deposit.
  - Extra deposits carry no claim marker, so a record with one is kept until the user dismisses it. This is the
    plan's conservative reading. A "claimed" marker would need a new record field, which the plan does not have.
- **Finality.** An outcome without `completedAt` is provisional.
  - `outcomePatch` sets `completedAt` only when the deciding block is at or below `finalized` on the chain that
    decides it: the source chain for `not-sent`, Ethereum for the others.
  - It refuses a block from another chain, and it refuses to touch a final record.
  - Clearing a provisional outcome after a reorg, when the deposit shows up, is discovery's job (Phase 4).
- **Envelope v3.**
  - API: `sealDepositEnvelopeV3`, `openDepositEnvelopeV3`, `envelopeV3MatchesRecord`,
    `sealCrossChainDepositRecord` (the same sign-twice self-test as v2), and
    `resealExactEnvelope(key, v3, deposited)`, which re-seals to an exact v2 without a signature.
  - `crossChainAmountWindow` returns `[minReceived − fuelSlice, maxPull]`.
  - Each version's opener rejects the other.
- **Backups.**
  - `openAnyBridgeBackup` and `validateJournalRecord` accept schema 4.
  - `openBridgeBackup` refuses schema 4, exactly as a pre-schema-4 bundle does. Arc 4's restore must switch to
    `openAnyBridgeBackup`.
  - Every existing journal, backup and v2 envelope byte form is pinned to digests taken from the pre-change code.

## Open for arc 4

- Restore and the dock's `storedJournalIds` read `JOURNAL_KEY` only and must also read the cross-chain key.
- A record with neither a source hash nor a batch id shows `depositing`. If the board draws an uncertain wallet
  reply as bridging, change the label in `deriveCrossChainDepositStage`.

## Attempts

1. `l1.test.ts` failed to typecheck twice: viem's `hashStruct` wants a plain object (`{ ...w }`), and a mutated
   template literal needed an explicit `Hex`.
2. Biome flagged `delete` in the manifest test; the test assigns `undefined` instead.
3. **Gate.** `bun run --cwd packages/bridge-core test -- deposit-router-abi l1 manifest-v2 journal backup
   recovery-crypto fuel`: 15 files, 263 passed. Mutating the retention and finality code makes the matching tests
   fail. `apps/tools` tests: 1,639 passed. G0 passes:
   - contracts: build, `lifi` build, 243 hermetic tests, snapshot, 23 halmos proofs;
   - TypeScript: lint, `typecheck:all`, `test:all`, `lint:actions`, `test:ci-gating`.
