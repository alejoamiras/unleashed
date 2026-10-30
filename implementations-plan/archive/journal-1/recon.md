# journal-1 recon

Read against `main` at 97e100e, plus PR #88 (`sdk-1-a6-claims`, open, conflicting with main) read through the
GitHub contents API, because #88 rewrites the same journal writers. Two Sonnet explorers (a writer inventory and a
reuse sweep) and the planner's own reads. Paths are repository-relative.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Fresh claim material per quote | `quoteCrossChainRoute` (`apps/tools/src/composables/useCrossChainRoute.ts:339`) draws a fresh `lifiTxId` and fresh secrets (`crossChainSecrets`, :139) on every call | reuse as-is: a requote IS fresh claim material |
| Which answer the amount step offers | `useCrossChainSend` `asked`/`key` gate (`useCrossChainSend.ts:287-306`): `quoted` is the core's answer only while `asked === key` | adapt: reset `asked` when a route is handed to a send |
| Dropping a cached answer | `latestQuote` (`latest-quote.ts`) has `ask`/`fresh`/`dispose` only | no new API needed: the `asked` gate already hides an answer |
| Insert-only journal write | `rekeyRecordWhen` (`packages/bridge-core/src/journal.ts:689`) refuses a destination id any lane holds, in one synchronous span; `upsertRecord` (:517) replaces by id | build new, small: `insertRecord(kv, rec): boolean` beside `upsertRecord`, modelled on `rekeyRecordWhen`'s `locate` check |
| Cross-chain filing | `addCrossChainRecordVerified` (`useBridgeJournal.ts:549`): upsert + read-back; callers `crosschain-deposit-flow.ts:426` and `useBridgeBackup.ts:80` (`track`) | adapt: insert-only, returns whether it filed |
| Restore's duplicate refusal | `useBridgeBackup.ts` `restoreFile` pre-checks `listedRecords` and throws "This bridge is already tracked here — nothing to restore." | reuse that sentence when the insert refuses inside `track` |
| Journal lock | `underJournalLock` (`useBridgeJournal.ts:1024`) private on main; exported by #88 | reuse; on main export it exactly as #88 does |
| Second deposit under one record | `route.extraDeposits` (`journal.ts:233-273`), written only by discovery (`crosschain-discovery.ts` `extrasOf`/`mergeExtras`) from the router's `Deposited` logs | do not reuse: Ethereum-side facts of unexpected extra deposits, no source send, no secrets, no `lifiTxId` |
| Two-tab tests | `memoryJournalLocks()` (`lib/journal-locks.ts:41`), `memKV`, `fromOtherTab` and the held-lock pattern in `useBridgeJournal.test.ts:2000-2060` | reuse as-is |
| Cross-chain send fixtures | `fakeWallet`, `fakeReads`, `sendOf` (`crosschain-deposit-flow.test.ts:49-116`); `quotedRoute` (`apps/tools/src/test/crosschain.ts:117`, real secrets per call) | reuse as-is |
| `useCrossChainSend` harness | `setup()` in `useCrossChainSend.test.ts:55` with a `quoting` ref and `routeDeps` | reuse; `vi.mock` the deposit flow's `sendCrossChain` for the send |

Absence trails: `insertRecord|addIfAbsent|insertOnly|createRecord|refus.*exist` over `packages/bridge-core/src` and
`apps/tools/src` found nothing; `already held|already tracked|already exists` hits only `upsertRecord`'s lane check
and the backup pre-check. No unit or browser test sends one cross-chain ask twice (`two sends|second send|twice|two
records|two cards`); the only two-send browser cell is Ethereum-origin (activity.spec.ts cell 40).

## #65 path (demonstrated by code trace; the issue's probe agrees)

1. A cross-chain review is signed: `runCrossChain` → `xc.send(quoted, route)` → `journalAndSend` files the record
   under `routeRecordId(route.secrets)` (the token leg's claim hash) and signs.
2. The user starts another send (`onNewSend`, or RUN IN BACKGROUND, which calls it): `resetAmount()`, step 0. Picking
   the same row and typing the same amount rebuilds the same `key`.
3. `useCrossChainSend`'s watcher requotes only when `key !== asked`; `asked` was never reset, so `quoted` is the
   first answer again while it is under `ROUTE_TTL_MS` (60 s): same secrets, same `lifiTxId`, same tx bytes.
4. The second confirm files a record with the same id: `upsertRecord` replaces the first. The first send's
   `srcTxHash`, `srcScanFromBlock`, `approveTxHash` and outcome are gone, and both source deposits carry one secret
   hash. Discovery would list the other deposit as an `extraDeposits` entry of the surviving record at best.

The Ethereum-origin send is not affected: the SDK draws fresh secrets inside every `depositL1`, a public row starts
under `makeProvisionalDepositId()`, and the private id is that fresh claim hash.

## #80 path and the writer inventory

On `main`, `underJournalLock` guards four claim-internal writes only (`useBridgeJournal.ts:627, 1346, 1649, 1703`).
The issue's list of already-locked writers (discovery's patch and reseal, the consumed flag, `discard`) does not
hold on `main`; it holds on #88's branch, which wraps discovery (`crosschain-watch.ts:87, 117`), the fuel
`consumed` reconcile (`fuel-recovery.ts:44`), the claim's `patchRecordDelta` (:1426), the reseals (:844, :895) and
makes `discard` take the lock itself. The issue describes the post-#88 tree.

Send-flow writers that stay unlocked after #88:

| Lane | Write | Site (main) |
|---|---|---|
| Ethereum-origin | open the row | `useSend.ts:718` `addRecordVerified` |
| Ethereum-origin | the SDK's persisted facts | `useSend.ts:696` `updateRecord(factsOf(rowOf(...)))`, computed from the reactive copy |
| Ethereum-origin | name a public row at the signature | `useSend.ts:762` `rekeyJournalRecord` |
| Ethereum-origin | the frozen token block | `useSend.ts:906` `updateRecord({ token })` |
| Ethereum-origin | the private seal | `deposit-flow.ts:257` `updateRecord({ sealedEnvelope, sealerL1 })` |
| Cross-chain | file the record | `crosschain-deposit-flow.ts:426` `addCrossChainRecordVerified` |
| Cross-chain | the seal | `crosschain-deposit-flow.ts:252` |
| Cross-chain | `srcTxHash`, `srcBatchId` | `crosschain-deposit-flow.ts:295, 320, 331` |
| Cross-chain | `approveTxHash` | `crosschain-deposit-flow.ts:357` |
| Cross-chain | `not-sent` outcome | `crosschain-deposit-flow.ts:375` |

`useSend.ts:383` (`registerTxHash` in `hubClaimSeams`) is the claim's and #88 deletes it. Other unlocked writers
outside both send flows: `useHubExit.ts:268, 497`, the backup import (`useBridgeBackup.ts:76, 80`), the fee-ladder
store (`deposit-flow.ts:100-108`), and engine-internal `patchRecord` calls.

Lock facts: every `underJournalLock` body is a synchronous span; the lock is not re-entrant; the only nesting is
record lock → journal lock (`attachAndConsume`, the claim's guarded writes); no path takes the journal lock and then
a record lock (`deps.locks.record` is `ifAvailable` and never waits). `webJournalLocks()` is wired from `useSend.ts:207`
and `useHubExit.ts:309`; the wizard instantiates `useSend`, so the cross-chain send runs with the same `deps.locks`.

## Collisions

- PR #88 rewrites `useSend.ts`, `useBridgeJournal.ts`, `deposit-flow.ts` and `crosschain-watch.ts`. This lane builds
  on it (lane brief: merge main after it lands).
- send-copy-2 changes send-flow strings in `SendWizard.vue`; this lane changes no string.
- Closed known limits searched (`journal OR lock OR route OR record`): none covers either path.
