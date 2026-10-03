---
plan: tools-recovery
tier: mid
driver: claude-code
eli5_mode: artifact
code_review: off
codex_effort: high
recon_budget: 2 agents (batched reuse sweep + journal mapper), default
status: approved (the owner set the /goal seed); the approval condition held — fresh codex pass #5 on v8: approve (3 low editorial items, folded); implementing
---

## Outcome

Archived. Seeds retired.

# tools-recovery — the three stuck-record recoveries, identity-bound

The tools dApp keeps a bridge journal of every deposit and exit. An earlier readiness plan
pinned three rows the journal cannot finish today:

1. **Consumed**: a claim another submitter made first (a relayer, another tab). Today the record ends
   in an error ("already nullified") although the tokens arrived.
2. **Hash-less deposit**: the Ethereum wallet never answered the router transaction (or the page died
   before the hash was written). Today the row says "never confirmed on Ethereum" and offers only
   Discard, even when the deposit landed.
3. **Hash-less exit**: the wallet sent the burn but the page never learned the transaction id. Today
   the row says "The exit was interrupted" and offers only Discard, even though the funds are in the
   Outbox waiting to be finished.

Each fix ADDS a chain-proven fact to the record (done-by-another, `depositTxHash`, `exitTxHash`) and
then runs today's paths. None re-sends anything. Every decision fails closed: no fact is written from
an ambiguous match, and no prompt is ever raised except on the user's CLAIM/FINISH click.

## Owner answers (Phase 0)

- **Scope**: all three fixes, as three arcs of one stack.
- **Unseal rule**: the private deposit's secret is unsealed (one L1 signature) only on a CLAIM click —
  never in the background. A reloaded private record that was claimed elsewhere therefore finishes on
  the user's click, not on its own.
- **Gates**: unit tests per phase; each fix flips its pinned cell (24b → done, 26d → reconciled,
  31b → attached) inside its phase gate; the full tools suite in two local shards at each arc boundary;
  `test:all` + lint + `lint:actions` at the end. CI's six shards remain the last gate.
- **Bar**: production. `code_review: off`; codex at `high`; no `/harden` scheduled now — the bridge's
  pre-release `/harden security` pass covers the journal's recovery surface later.

## Scope

**In**
- A. `claimedByOther`: the token message is recomputed from the record's own facts and its nullifier
  read from the node; a nullified message finishes the deposit as done with a persisted fact — hub
  token sends only (public, and private on the CLAIM click that unseals the secret).
- B. Deposit reconcile: a hash-less hub token send finds its router transaction on L1 by its own
  secret hash inside a chain-time window, verified on calldata (entrypoint, token, portal, amounts,
  secret hashes, recipients, privacy) and on a canonical, successful receipt; exactly one match writes
  `depositTxHash`; the existing leg recovery then runs.
- C. Exit attach: a hash-less exit recomputes its L2→L1 message hash and scans the L2 blocks since
  the record's creation for the one transaction that emitted it; exactly one unclaimed match writes
  `exitTxHash`/`exitBlock` (re-keying the record as a live exit does); the existing consume tail runs.
- Card copy and action gating for the three shapes; the three cells flipped; unit tests for every
  helper and engine branch, including the ambiguity refusals.

**Out**
- Resubmitting anything from a record (the journal's standing rule).
- Background scans on reload: B and C run on the user's click only (a read, but a deliberate one —
  and `resumeActionFor` keeps skipping mid-flight shapes).
- A private-deposit variant of cell 24b in the browser (the relayer cannot claim a private deposit
  without the claim salt — the harness never has it): the private path is proven in unit tests
  against the derived secret.
- Fixing the readiness warts (`confirmReview` stand-downs, the SDK probe patch) — separate work.
- A standalone spend of PRIVATE fuel whose token was claimed by someone else (follow-up
  `private-fuel-standalone`): the record is kept open with its sealed material instead.
- Any change to the wallet or its packages.

## Architecture & Implementation

### Shape

Three pure "find the fact" helpers, three optional engine deps, one new branch per shape in the
journal engine, one new persisted fact, and the affordances that let a click reach the branch.

```
apps/tools/src/lib/message-nullifier.ts      A: nullifier from (messageHash, secret[, recipient])   [new, pure]
apps/tools/src/composables/deposit-reconcile.ts  B: L1 window + log scan + calldata match           [new]
apps/tools/src/composables/exit-attach.ts        C: L2→L1 hash recompute + block scan               [new]
apps/tools/src/composables/useBridgeJournal.ts   3 deps + the cross-tab record lock, 3 branches, claimedByOther [modified]
apps/tools/src/composables/useSend.ts            wires A + B deps (node + L1 public client)          [modified]
apps/tools/src/composables/useHubExit.ts         wires C dep (node)                                  [modified]
apps/tools/src/lib/record-policy.ts              CLAIM for a hash-less send, FINISH for a hash-less exit [modified]
apps/tools/src/components/BridgeJournalCard.vue  copy for the three shapes + done-by-another        [modified]
packages/bridge-core/src/journal.ts              claimedByOther?: boolean; rekeyRecordWhen (sync guard) [modified, additive]
apps/tools/tests/browser/{specs,fixtures}        cells 24b/26d/31b flipped; L1 fixture swallowNext   [modified]
```

### A — consumed → done, on the message's own nullifier

- **Scope**: hub token claims only (`claimsThroughHub(rec)`: a send record with intent `token` or
  `token+gas`, `useBridgeJournal.ts:860`). Gas-only sends and schema-1/2 records keep today's
  behaviour (their consumer is the Fee Juice contract / the legacy bridge — `useSend.ts:166-167,470-471`
  set `bridge` per intent — and their secret schemes differ; the dep answers `null` for them).
- **The message is recomputed, never trusted** (`message-nullifier.ts`): from validated record facts —
  `sender = L1Actor(rec.portal, rec.chainId)`, `recipient = L2Actor(rec.bridge, rollupVersion)` (the active target's, `resolveToolsTarget()`),
  `content = mintToPublicContentHash(rec.recipient, amount)` or `mintToPrivateContentHash(amount)`
  (`content-hash.ts:49-54`, the hub's `main.nr:243,264`), `secretHash = rec.secretHashHex`,
  `index = rec.leafIndex` — `new L1ToL2Message(...).hash()` (stdlib `l1_to_l2_message.d.ts:24-36`;
  aztec-nr `messaging.nr:15-27` uses exactly these seven inputs). The recomputed hash must equal
  `rec.messageHash`; a mismatch is a `"tampered"`-class refusal, never a lookup. For a private record
  the amount/recipient come from the OPENED envelope (the sealed truth), not the display fields.
- **Nullifier**: `siloNullifier(rec.bridge, computeFeeJuiceMessageNullifier(messageHash, secret))` with
  `secret` = the public secret, or `deriveTokenClaimSecret(salt, recipient)` for a private record
  (`main.nr:265-271`, `claim-secret.ts:46-47`). The formula is aztec-nr's
  `compute_l1_to_l2_message_nullifier` (`hash.nr:51-53`): poseidon2 over `[message_hash, secret]`
  with `DOM_SEP__MESSAGE_NULLIFIER`; siloed by the consuming contract (kernel-siloed in private,
  `private_context.nr:395`; AVM-siloed in public, `public_context.nr:257`). The leaf index is an input
  of the message hash, not of the nullifier.
- **Dep** `messageNullified?(rec: SendDepositRecord, material: { secretHex; envelope? }): Promise<"nullified" | "live" | "invalid" | "unknown">`
  — the engine passes the material it already resolved (public: `publicClaimSecretOf`; private: the
  `secretCache` entry — the dep is wired outside the module and cannot read the cache). A recompute
  mismatch is **`"invalid"`** (proven wrong identity: the engine STOPS with `attention: "tampered"` and
  the sealed-values note, in the fresh AND the resumed path — never a completion); missing material /
  `messageHash` / `leafIndex` or an RPC throw is `"unknown"` (unavailable evidence: today's behaviour);
  `node.getNullifierMembershipWitness("checkpointed", n)` present ⇒ `"nullified"`, absent ⇒ `"live"`.
  **`checkpointed`, not `latest`**: `latest` is the proposed tip (`block_parameter.d.ts:8`) and the
  journal's own settlement floor is checkpointed inclusion (`claim-receipt.ts:9-13`); a "done" read
  from a proposed block that later drops would be permanent, and the 7-day prune (`journal.ts:403`)
  would then remove the record — for a private deposit, its only sealed secret. Reading at
  `checkpointed` keeps today's floor; a proposed-only nullifier reads `"live"` and the claim proceeds
  (the simulate then reports it as consumed and the read is retried on the next click).
- **Engine, the read comes before any fee construction**: (1) `probeClaimedElsewhere(rec, material)`
  runs right after the material resolves and BEFORE `buildClaimHandles`: `"nullified"` ⇒
  `completeClaimedByOther(id)` (persist `claimedByOther: true`, `completeDeposit`) — no fee ladder, no
  simulate; `"invalid"` ⇒ stop (`tampered`); `"live"`/`"unknown"` ⇒ continue as today. (2)
  `awaitConsumable` returns a tri-state `"ready" | "claimed-elsewhere" | "timeout"`: a consumed-shaped
  simulate error (both wordings — `isMsgConsumed` gains `L1-to-L2 message is already nullified`,
  `public_context.nr:259`) re-asks the dep; `"nullified"` ⇒ claimed elsewhere; `"invalid"` ⇒ stop;
  otherwise today's error. (3) `recordMessageConsumed` (the probe after a success receipt on a resumed
  claim) dispatches: hub token sends read the nullifier (`"nullified"` ⇒ done, `"live"` ⇒ keep polling,
  `"invalid"` ⇒ stop, `"unknown"` ⇒ today's completion); every other shape keeps today's claim-build
  probe unchanged (`handleSuccessReceipt` `:1293-1310` semantics preserved for gas-only and legacy).
  Extracted helpers: `classifyConsumable`, `probeClaimedElsewhere`, `completeClaimedByOther`, the
  probe dispatcher — the runner functions gain one call each. `record-policy.ts` /
  `fuel-claim-state.ts` learn `claimedByOther` (the card's fuel affordance and its shape rules), and
  the fuel-recovery path completes a `claimedByOther` record once its fuel settles.
- **Completion is guarded and fuel-aware**: `completeClaimedByOther(id, verified)` writes
  `{ claimedByOther: true, completedAt }` TOGETHER through `patchRecordWhen` under the journal lock,
  with the same snapshot guard B/C use (identity fields, no `claimTxHash`, not completed, the
  runner's `gen` unchanged) — `completeDeposit` (`useBridgeJournal.ts:707`) checks existence, not
  identity, and another tab can replace a same-id record while the nullifier read awaits. **The
  token's nullifier says nothing about the fuel**: a relayer can claim the token with its own fees and
  leave the record's fuel unclaimed; `fuel-claim-state.ts:323` would read a completed private record
  as `private-settled` and the prune (`journal.ts:403`) would remove its sealed material. So, by shape:
  - token-only (`intent: "token"`) ⇒ done at once;
  - `token+gas`, fuel already settled (`fuel.consumed` or `fuel.standaloneClaimed`) ⇒ done;
  - `token+gas` PUBLIC, fuel unsettled ⇒ persist `claimedByOther: true` WITHOUT `completedAt`; the
    existing public standalone fuel recovery takes over: `decideStandaloneFuelRecovery`
    (`fuel-claim-state.ts:316-326`) returns `"none"` while `completedAt` is unset, so it gains a
    `claimedByOther` input treated as a finished token leg, and `claimFuelStandalone`
    (`fuel-recovery.ts:88-117`, public ladder, `sendStandaloneFjClaim`) runs unchanged; the engine
    completes the record (guarded) once `fuel.standaloneClaimed` lands. Card: "Your tokens were claimed
    by another submitter. Your gas is still yours to claim — press CLAIM YOUR GAS.";
  - `token+gas` PRIVATE, fuel unsettled ⇒ persist `claimedByOther: true` WITHOUT `completedAt` and
    STOP: private fuel is spent only as the fee of this account's own hub claim through the
    PrivateFPC (`resolvePrivateFuelFee` → `privateFpcFee`, `deposit-flow.ts:401-440`); there is no
    standalone private fuel spend today (`claimFuelStandalone` refuses private records,
    `fuel-recovery.ts:99`), and building one is a new fee surface, not this plan's. The record stays
    open with its sealed material (never pruned — no `completedAt`), the fuel affordance stays hidden,
    and the card says: "Your tokens were claimed by another submitter. Your private gas is still
    sealed in this record — keep it. Claiming private gas on its own is not available yet."
    Filed as the follow-up `private-fuel-standalone`.
- **Fact + copy**: `claimedByOther?: boolean` on deposit records (additive, like `consumedByOther`;
  no migration — loaders never gate on it). Card (token-only, or fuel settled): "Claimed by another
  submitter — your tokens arrived." Stage stays derived.
- **Prompts**: A adds none. The unseal stays where it is (the CLAIM click's
  `resolvePrivateClaimMaterial`); a non-interactive run with no cached secret makes the dep answer
  `null` and the record keeps today's note. (The pre-existing same-session resume — `resumeActionFor`
  only auto-continues what THIS page session started — is the journal's stated exception and is not
  widened.)

### B — reconcile a hash-less deposit from L1

- **Scope**: hub token send records (`claimsThroughHub`), `schema === 3`, no `depositTxHash`. Gas-only
  and legacy records keep today's Discard-only shape (`record-policy` gates the affordance on
  `schema === 3` and a token block, so no CLAIM appears that would always fail).
- **Helper** (`deposit-reconcile.ts`): `findDepositTx(rec, l1, gen, opts)` over a narrow client
  (`getBlock`, `getLogs`, `getTransaction`, `getTransactionReceipt`):
  1. **Window by chain time**: `createdAt/1000 − slack` (delegated: 10 min) → the first L1 block with
     `timestamp ≥ that` by binary search over `getBlock({ blockNumber })`; `toBlock` = latest. The window
     is capped (delegated: 50 000 blocks) and chunked for RPCs that cap `getLogs` ranges; a hit cap,
     missing history or a failed RPC read is **`"incomplete"`**, never `"none"`.
  2. **Candidates**: ONE event per call (viem drops `args` when `events` is used — `getLogs.js:35`):
     `getLogs({ address: gen.router, event: Bridge, fromBlock, toBlock })` for `intent === "token"`,
     `BridgeWithFuel` for `token+gas`. No recipient filter: a private token deposit publishes a ZERO
     recipient (`send-flow.ts:150-154`). Post-filter on the DECODED event args — `Bridge.secretHash`,
     or `BridgeWithFuel.tokenSecretHash` + `fuelSecretHash` (`router-abi.ts:55-66`) — against
     `rec.secretHashHex` and `rec.fuel.secretHashHex`; both event shapes pinned in the unit tests.
  3. **Verify calldata** for each survivor: `getTransaction(hash)` → `decodeFunctionData(SWAP_BRIDGE_ROUTER_ABI, input)`;
     require `tx.to === router`, the entrypoint by intent (`sendEntrypoint`, `send-flow.ts:112-116`),
     `bridgeToken === rec.token.erc20`, `tokenPortal === rec.portal`, `isPrivate === rec.isPrivate`,
     the recipient(s) as the send wrote them (`witnessRecipient`, `:150-154`: zero for private), the
     amounts as the send wrote them (`bridge`: `amount === rec.amount`; `bridgeWithFuel`:
     `totalAmount === rec.amount + rec.fuel.amount`, `fuelAmount === rec.fuel.amount`,
     `minFuelOutput === rec.fuel.minOutput`), and the secret hash(es) again from calldata.
  4. **Canonical check**: `getTransactionReceipt(hash)` must be `success` and its `blockHash` must
     match `getBlock(receipt.blockNumber).hash` at the time of the write (a reorged tx is `"incomplete"`).
  4b. **The chain is pinned around the scan**: the L1 client delegates every read to the injected
     provider (`useL1Wallet.ts:29`), so a wallet chain switch mid-scan would answer from another chain.
     `assertL1Chain` (`useSend.ts:105-112`) runs before the window search and again before the
     result is returned; a mismatch at either point — or a `chainChanged` observed in between — is
     `"incomplete"` and nothing is written. Regression: a chain switch between the log scan and the
     receipt check ⇒ `"incomplete"`, no `depositTxHash`.
  5. **Result**: exactly one verified tx → `{ txHash }`; none → `"none"`; two or more → `"ambiguous"`
     (a wallet that replayed the router tx made two valid deposits with one secret — both need manual
     handling; the leaf index makes their messages distinct, `messaging.nr:19-27`).
- **Dep** `findDepositTx?(rec) → Promise<{ txHash } | "none" | "ambiguous" | "incomplete">`, wired in
  `useSend.ts` with the app's viem public client and `SEND_GENERATION`.
- **Engine**: `recoverLegIfNeeded`'s early bail becomes one call, `reconcileDepositLeg(rec, id)`:
  narrate "looking for the deposit on Ethereum"; on `{ txHash }` write it with
  `patchRecordWhen(id, (live) => sameSnapshot(live, verified) && !live.depositTxHash && !live.completedAt, { depositTxHash })`
  — `sameSnapshot` compares the identity fields the match was verified against (recipient, amount,
  token block, secret hashes, privacy, `createdAt`) so a record another tab rewrote meanwhile is never
  patched — and continue into
  `attemptLegRecovery` on the re-read record (its receipt-log read then recovers the leaves as today);
  `"none"` → `attention: "error"`, "No deposit for this record was found on Ethereum since it was
  started. If you never confirmed it in your wallet, discard this record."; `"ambiguous"` →
  `attention: "unknown-outcome"`, "More than one matching deposit was found — not guessing. Keep this
  record and export its recovery file; it can be finished by hand."; `"incomplete"` → `attention: "error"`,
  "Ethereum could not be searched far enough back — try again later."
- **Affordance**: `record-policy.ts` `depositLegRecoverable` = `depositing` && (`depositTxHash` ||
  (`schema === 3` && a token block)); the button stays CLAIM. Card copy for the hash-less shape: "The
  deposit was never confirmed here. Press CLAIM to look for it on Ethereum; discard if you never sent it."

### C — attach a hash-less exit by its recomputed commitment

- **Scope**: send exit records (`isSendRecord`, `stage === "exiting"`, no `exitTxHash`).
- **Helper** (`exit-attach.ts`): `findExitTx(rec, node, taken, opts)` over a narrow node interface
  (`getNodeInfo`, `getBlockNumber`, `getBlocks`, `getTxEffect`):
  1. **Message hash**: `computeL2ToL1MessageHash({ l2Sender: rec.bridge, l1Recipient: rec.token.portal, content: withdrawContentHash(rec.recipientL1, amount, ZERO_L1), rollupVersion, chainId })`
     — `rollupVersion`/`l1ChainId` from the active target (`resolveToolsTarget()`, which carries the
     sandbox's identity on `local`), asserted equal to the record's `chainId` and to `getNodeInfo()`.
  2. **Window**: L2 blocks with `timestamp ≥ createdAt/1000 − slack`, located by binary search over
     block timestamps, read with `getBlocks(from, limit, { includeTransactions: true })` (bodies are
     off by default — `block_response.d.ts:13-21`); capped; pruned or unreadable history ⇒ `"incomplete"`.
  3. **Scan**: a tx is a candidate only if `l2ToL1Msgs[0] === hash` — index zero, because every reader
     of the exit (`consumeWithdrawal` `flows.ts:222`, `expectedWitness` `useHubExit.ts:189`,
     `consumedElsewhere`) takes index zero; a match elsewhere in the tx is not this app's exit shape.
  4. **Attribution**: drop candidates whose hash is in `taken` (every `exitTxHash` and every record id
     the journal holds — an identical earlier exit this browser recorded). Exactly one left →
     `{ exitTxHash, exitBlock }`; none → `"none"`; more → `"ambiguous"`. Uniqueness inside the window is
     the best evidence available, not provenance: an identical exit from another device, or an earlier
     identical exit that was discarded, is indistinguishable. Accepted because the message pays
     `rec.recipientL1` whatever produced it (see Security) — one of the explicit approval decisions.
- **Dep** `findExitTx?(rec, taken: ReadonlySet<string>) → Promise<{ exitTxHash; exitBlock } | "none" | "ambiguous" | "incomplete">`,
  wired in `useHubExit.ts` with the node client.
- **Engine**: the dead `!rec.exitTxHash` branch in `runWithdrawConsumeLocked` becomes one call,
  `attachExit(rec, id)` — the whole attach + consume happens inside it, under the handoff above
  (no outer re-entry): on a match it re-verifies
  (`getTxEffect(exitTxHash).data.l2ToL1Msgs[0] === hash`), then re-keys through a NEW synchronous
  primitive `rekeyRecordWhen(kv, oldId, guard, next)` in `journal.ts`: one synchronous load → guard →
  write — the guard requires the live source to equal the verified snapshot (identity fields, no
  `exitTxHash`, no `consumeTxHash`, no `completedAt`) AND no record with id `exitTxHash` to exist
  (`rekeyRecord` would overwrite it, `journal.ts:389-393`). Synchronous execution excludes interleaving
  inside ONE tab only; across tabs the exclusion is the **record lock below**: the attach holds the
  old id's lock, acquires `exitTxHash`'s lock before the guard and re-key, and runs the consume body
  inside it (the handoff below).
- **Two same-origin locks, both injectable** (dep `locks?: { journal<T>(fn: () => T): Promise<T>; record<T>(id, fn: () => Promise<T>): Promise<T | "held-elsewhere"> }`;
  production = the Web Locks API, unit fakes = an in-memory lock table the "two tabs" of a test
  share; introduced in **arc 1** as the shared prerequisite for the writes the three arcs add):
  1. **Journal mutation lock** `unleashed-bridge:journal` — the storage unit is the WHOLE journal array
     (`journal.ts` `write`, `:351`), so the NEW guarded writes this plan adds (A's `claimedByOther`
     completion in arc 1, the reconcile's `depositTxHash` write in arc 2, the attach's
     `rekeyRecordWhen` in arc 3) run inside one short exclusive lock
     (`navigator.locks.request(name, fn)`, waiting; the body is the synchronous load → guard →
     write). The journal's EXISTING synchronous writes (`addRecordVerified`, `persistPreTx`, the
     send-flow hooks that `send-flow.ts:240,298,304` invoke without awaiting, discard, import,
     pruning) are NOT wrapped: acquisition is asynchronous (Web Locks § `request`) and those callers
     depend on synchronous persistence — wrapping them would let a send proceed before its recovery
     material is durable. Their cross-tab best-effort semantics are unchanged by this plan and are
     recorded as a follow-up (`journal cross-tab writes`).
  2. **Record run lock** `unleashed-bridge:record:<id>` — `withRecordLock(id, fn)` keeps its process-local
     `inFlight` and adds `navigator.locks.request(name, { ifAvailable: true }, (lock) => lock ? fn() : "held-elsewhere")`
     — the callback is invoked with `null` under contention (Web Locks § LockManager), so the adapter
     branches on the lock object; "held elsewhere" reports today's "already in flight" message. The
     adapter's null-lock branch has its own unit test against a fake `navigator.locks`.
  Without a lock API: the record lock falls back to `inFlight` (today), the reconcile write falls back
  to the guarded synchronous write (today's best effort), and the attach fails closed ("another tab
  may be finishing this exit — try again in a moment").
- **One executable handoff** (locks are not reentrant): `attachExit` finds the candidate `H`, then
  acquires the record lock for `H` FIRST (held elsewhere → the note above); inside it, under the
  journal lock, the guard re-checks the source snapshot and that no record with id `H` exists, then
  re-keys; still inside `H`'s lock it runs the canonical consume body (`runWithdrawConsumeLocked(H)`)
  without re-acquiring, inside its OWN error boundary: a throw after the re-key is reported against
  `H` (`surfaceRunFailure(H, e)`) and the old id's runtime is dropped — the outer
  `runWithdrawConsume(oldId)` catch (`useBridgeJournal.ts:1337`) never sees a record that no longer
  exists; `attachExit` returns `{ rekeyedTo: H }` only for the caller's bookkeeping, and NO second
  consume is invoked. The live exit uses
  the same helper — `useHubExit.ts:512-520` re-keys OUTSIDE any record lock today — so a live exit
  and a concurrent attach of the same hash contend on `H` and exactly one runs. Regressions: two
  in-memory tabs both loaded before either wrote ⇒ one re-key, one consume, one "held elsewhere";
  a live exit vs an attach of the same hash ⇒ one runner; canonical runtime cleanup on the old id.
- **Scan budget**: `findDepositTx`/`findExitTx` take `{ deadlineMs, maxReads, maxCandidates }`
  (delegated defaults, e.g. 45 s / 200 reads / 8 candidates); a deadline or budget hit is
  `"incomplete"`; the engine tags each search with its `gen` and drops a result that lands after the
  runner moved on (no write, no re-key). The L1 client has no transport deadline
  (`useL1Wallet.ts:29`), so the helper races every read against the deadline.
- **Chain identity** comes from the active target (`resolveToolsTarget()` — the `local` target's
  rollup version and chain id are `define`d from the sandbox artifacts, `network-targets.ts:11,64`),
  never from `chain-constants` alone; a mismatch with `getNodeInfo()` is `"incomplete"`.
- **Affordance**: `record-policy.ts` gains `exitAttachable = withdraw && stage === "exiting" && schema === 3 && actionable && !busy`,
  and `showFinish` includes it; the label stays FINISH. `resumeActionFor` keeps skipping hash-less
  exits (click-driven). Card copy: "The exit was interrupted. Press FINISH to look for it on Aztec;
  discard if your wallet never sent it."
- After attach, the existing tail handles "someone already finished it on L1" (`consumedElsewhere` →
  `consumedByOther`), now guaranteed to read the same index-zero message the attach verified.

### Data & control flow (critical paths)

```
A  CLAIM click → runDepositClaim(interactive) → resolvePrivateClaimMaterial (unseal on click)
     → probeClaimedElsewhere: recompute message hash == rec.messageHash → nullifier → witness?
     → nullified ⇒ [journal lock: guarded claimedByOther (+ completedAt only if token-only / fuel settled)]
        public fuel unsettled ⇒ CLAIM YOUR GAS (existing) ⇒ completion on standaloneClaimed
        private fuel unsettled ⇒ record kept open, sealed material retained (follow-up)
     | invalid ⇒ tampered  | live/unknown ⇒ buildClaimHandles → gates
     → awaitConsumable: "already nullified" ⇒ re-ask ⇒ claimed-elsewhere | ready | timeout | error (as today)

B  CLAIM click → runDepositClaimLocked → recoverLegIfNeeded: no depositTxHash → reconcileDepositLeg
     → deps.findDepositTx(rec): window → getLogs(router, event) → secret-hash post-filter
     → getTransaction → decode → match calldata → receipt success + canonical block
     → one ⇒ patchRecordWhen(no hash yet, {depositTxHash}) → attemptLegRecovery (existing) → claim (existing)

C  FINISH click → runWithdrawConsumeLocked (record lock oldId): no exitTxHash → attachExit
     → deps.findExitTx(rec, taken): message hash → block window → l2ToL1Msgs[0] scan → one unclaimed H
     → locks.record(H): [locks.journal: guard (snapshot, no H record) → rekeyRecordWhen]
        → runWithdrawConsumeLocked(H) inside H's lock, own error boundary → exitConsume (existing) → done / consumedByOther
```

### Interfaces (new)

```ts
// useBridgeJournal.ts — JournalEngineDeps additions
messageNullified?: (rec: SendDepositRecord, material: { secretHex: string; envelope?: DepositEnvelopeV2 }) => Promise<"nullified" | "live" | "invalid" | "unknown">
findDepositTx?: (rec: SendDepositRecord) => Promise<{ txHash: string } | "none" | "ambiguous" | "incomplete">
findExitTx?: (rec: SendWithdrawRecord, taken: ReadonlySet<string>) => Promise<{ exitTxHash: string; exitBlock: number } | "none" | "ambiguous" | "incomplete">

// journal.ts (bridge-core) — additive fact + one synchronous guarded re-key
DepositJournalRecord.claimedByOther?: boolean
rekeyRecordWhen(kv: KV, oldId: string, guard: (live: BridgeJournalRecord, all: BridgeJournalRecord[]) => boolean, next: BridgeJournalRecord): boolean

// useBridgeJournal.ts — the two locks (production: navigator.locks; tests: an in-memory lock table)
locks?: { journal<T>(fn: () => T): Promise<T>; record<T>(id: string, fn: () => Promise<T>): Promise<T | "held-elsewhere"> }

// lib/message-nullifier.ts (pure)
recomputeTokenMessageHash(i: { portal; chainId; hub; rollupVersion; recipient; amount; isPrivate; secretHashHex; leafIndex }): Promise<Fr>
tokenMessageNullifier(i: { consumer: string; messageHash: Fr; secretHex: string; isPrivate: boolean; recipient: string }): Promise<Fr>
```

### Algorithms / non-obvious mechanics

- **Block window by timestamp** (B and C): binary search `lo=0..hi=latest` on `getBlock(n).timestamp`
  for the first block ≥ `createdAt/1000 − slack`; O(log n) RPC reads; the scan cap bounds the
  worst case. Anvil/local networks mine sparsely; the search handles gaps by comparing timestamps only.
- **Ambiguity** (B): two router txs with identical calldata (same secret hash) ARE two valid deposits
  (the leaf index is part of each message hash, `messaging.nr:19-27`) claimable with one secret; the
  record can only ever be one of them — refuse as ambiguous, both need manual handling. (C): identical
  exits (same portal/recipient/amount) produce identical message hashes; the `taken` set removes exits
  this journal already owns; anything still plural is refused.
- **Search completeness** is its own outcome: a cap, pruned history or a failed read never reads as
  "nothing was sent".
- **Conditional writes**: all three writes happen after awaits; each re-reads the live record and
  applies only if the fact is still absent (`patchRecordWhen`) or, for the re-key, if the provisional
  record is still present and hash-less.
- **Gen bookkeeping**: the new branches run inside the existing `withRecordLock` + `bumpGen` owners;
  no new lanes.

### Trade-offs & alternatives not taken

- **Paste-a-hash instead of scanning** (competing outline below): cheaper, no window logic, but the
  user rarely has a hash, and the cells could only prove the verification, not the recovery.
- **Background reconciliation on reload**: rejected — the journal's prompt-free/session-scoped resume
  rules (`resumeActionFor`) exist so a reload never starts chain work the user did not ask for; a
  click is the consent for a scan as it is for an unseal.
- **Reusing the fee-bearing claim build as the consumed proof**: the wart codex found in
  the earlier readiness plan (a consumed FUEL message reads as token consumed); rejected for the nullifier read.
- **Putting the helpers in `packages/bridge-core`**: they depend on viem/node clients the app already
  owns and on journal record shapes; kept in `apps/tools` with unit tests over fakes. `journal.ts`'s
  additive field, its `assertDepositFacts` check (`backup.ts:107`: `isOptionalBoolean(d.claimedByOther)`)
  and the synchronous `rekeyRecordWhen` are the bridge-core changes.

## Competing outline — "verify what the user pastes"

A stays as above (nothing to paste). B and C become input fields on the card: "Paste the transaction
hash" → the existing verifiers run: for a deposit `recoverDepositLeg` (receipt logs must decode to this
record's leaves — note `readSendReceiptLeaves` checks event structure only, `send-flow.ts:365-371`,
so the calldata check on (router, token, amounts, secret hashes, recipients) is the identity verifier) for an exit `expectedWitness` + a tx-effects check that the
recomputed message hash is in that tx. Pros: no block windows, no scans, no ambiguity logic, ~40%
of the code. Cons: users of a bridge UI do not have Aztec tx hashes at hand (the wallet that swallowed
the reply is the one that has it); the cells can only exercise the verifier with a hash the fixture
extracts; two identical exits are still ambiguous to the user. Verdict deferred to the audits; the
draft prefers the scan, and keeps the paste as a possible later fallback UI (out of scope here).

## Security & Adversarial Considerations

- **Threat model**: the journal (localStorage) and imported recovery files are attacker-influenced
  input; the L1 RPC and the Aztec node can be slow, stale, pruned or lying; a relayer, another tab or
  another device is a legitimate competing claimer/finisher; a re-org can orphan a just-found tx.
- **Trusted-node boundary (explicit decision)**: the app already decides every stage, claim and finish
  from `NODE_URL`'s answers (receipts, checkpoints, tx effects); A adds one more read of the same node,
  at `checkpointed` — the floor today's completion keys on, never the proposed tip.
  A node fabricating a nullifier witness could mark a claimable deposit done — the same node could
  already misreport a receipt as success. This plan keeps that boundary and does not add a second
  source; it is surfaced at the approval gate as a decision, not silently assumed.
- **A cannot mint "done" from journal data**: the message hash is recomputed from the record's facts
  (portal, chain, hub, version, recipient/amount from the envelope for private, secret hash, leaf
  index) and must equal the stored one; the nullifier is a function of that hash and the claim secret.
  A hostile record pairing another consumed message's hash and secret with different displayed facts
  fails the recompute; a record that carries a consumed message's true facts and secret was that
  deposit's bearer already. Gas-only and legacy records never reach the read (`null`). A consumed FUEL
  message cannot read as a consumed TOKEN message: the read is per message hash.
- **B cannot attach a foreign deposit**: the match binds the record's own secret hash(es) in the event
  and again in calldata, plus entrypoint, token, portal, recipients, all amounts (including
  `minFuelOutput`) and privacy; a copied public secret hash on another token or amount fails the
  calldata check. Knowing public calldata does not yield the secret; a record that copies every field
  of a public deposit including its secret is that deposit's bearer. The write happens only after a
  successful receipt on a canonical block; a re-orged tx reads as `"incomplete"`.
- **C cannot redirect funds**: the L2→L1 message commits to `rec.recipientL1` (caller `ZERO_L1`); a
  foreign exit with the same content pays the same recipient. Only index-zero matches count (the shape
  every reader of the exit assumes). **Attribution (explicit decision)**: two hash-less records, an
  identical exit discarded earlier, or an identical exit from another device cannot be told apart from
  chain data; `taken` removes what this journal owns, anything still plural is refused, and a single
  survivor is attached because the destination is the same either way. The residual is bookkeeping (a
  real exit left untracked while a twin is attached), not loss.
- **Write safety across tabs — scoped, not blanket**: the journal is one localStorage array
  rewritten whole on every mutation and localStorage has no mutex. This plan's NEW writes (the
  reconcile's hash, the attach's re-key, A's completion) run under a same-origin Web Lock and a
  snapshot guard, and a per-record run lock (correct `ifAvailable` adapter) keeps two tabs from
  running the same record's claim/consume; the attach's re-key and consume run under the
  destination's lock in one sequence. Web Locks coordinate cooperating callers only: the journal's
  EXISTING unlocked whole-array writers (the send flow's own persistence, discard, import, pruning)
  can still overwrite a guarded write or restore a provisional source in a lost-update race — a
  pre-existing property this plan neither widens nor fixes (follow-up `journal cross-tab writes`).
  Without a lock API the attach fails closed.
- **Ambiguity never tells the user to discard**: an ambiguous result is positive evidence that a
  deposit or exit exists; the copy says keep the record — and, for deposits, export its recovery file (discarding a
  private deposit destroys its only secret — `BridgeJournalCard.vue:394`).
- **Bounded scans**: a total deadline and read/candidate budgets return `"incomplete"`; a result
  arriving after the runner moved on is dropped (never written), so a hung RPC cannot pin a lock or
  latch a stale fact.
- **Proven-wrong identity stops**: a stored `messageHash` that does not recompute from the record's
  facts is `"invalid"`, surfaced as `tampered` in both the fresh and the resumed path — never
  completed on the "unknown" branch.
- **No new prompts**: the only signature in any path stays the existing unseal on CLAIM; the
  same-session auto-resume that may raise a grant prompt (`resumeActionFor`) is pre-existing and not
  widened; the new branches have no prompting call and a unit test pins the non-interactive `null`.
- **Least privilege / supply chain**: no new dependencies; stdlib helpers already installed (7-day
  min-age unchanged); no CI/token changes.
- **Logging**: secrets and nullifiers never reach `log(...)`; ids, stages, hashes and block numbers only.
- **DoS / latency**: scans are bounded (block caps, chunked `getLogs`, one `getTransaction` per
  post-filtered candidate, batched `getBlocks`); a runaway RPC surfaces as `"incomplete"` with its own
  copy, never a hang.
- **Input validation**: every chain value is parsed through the existing hex/address validators
  before comparison; filters use the router address and the ABI event, never free text.

## Assumptions

**Facts (verified)**
1. Nullifier formula: aztec-nr v5.0.1 `hash.nr:51-53` and `private_context.nr:890-910`
   (`consume_l1_to_l2_message` → `process_l1_to_l2_message`, `messaging.nr:15-32`); public consumption
   asserts `"L1-to-L2 message is already nullified"` (`public_context.nr:259`); TS
   `computeFeeJuiceMessageNullifier` (`stdlib/messaging/l1_to_l2_message.js:74-79`) is the same
   poseidon2 with `DomainSeparator.MESSAGE_NULLIFIER = 3754509616`; `siloNullifier` at
   `stdlib/hash/hash.d.ts:46`; `getNullifierMembershipWitness` at `interfaces/aztec-node.d.ts:64`.
2. The message hash's seven inputs (`messaging.nr:19-27`): portal, chain id, consumer, version,
   content, secret hash, leaf index; TS `L1ToL2Message(sender: L1Actor, recipient: L2Actor, content,
   secretHash, index).hash()` (`l1_to_l2_message.d.ts:24-41`); contents `mintToPublicContentHash` /
   `mintToPrivateContentHash` (`content-hash.ts:49-54`, `main.nr:243,264`).
3. The hub consumes `[secret]` (`main.nr:244`) and, for private, `derive_claim_secret(claim_salt, recipient)`
   (`main.nr:264-271`), mirrored by `deriveTokenClaimSecret` (`claim-secret.ts:46-47`); the value the app
   hands the hub is the salt (`hub-l2.ts:218`, `deposit-flow.ts:350`; `useSend.ts:877-879`).
4. Today's consumed path: `awaitConsumable` rethrows (`useBridgeJournal.ts:1118`) → `surfaceRunFailure`
   (`:769-774`); `recordMessageConsumed` (`:1313-1329`) rebuilds the claim via `buildClaimHandles`;
   `isMsgConsumed` (`:63-64`) matches `No non-nullified L1 to L2 message found|message has already been nullified`
   and MISSES the public wording; `claimsThroughHub` at `:860`; `resumeActionFor` `:1440-1453`.
5. Router events omit token/portal (`SwapBridgeRouter.sol:84-97`); calldata carries them
   (`router-abi.ts:6-122`); the send publishes a ZERO recipient for private token deposits
   (`send-flow.ts:150-154`), `totalAmount = p.amount` with the journal's `amount = total − fuel`
   (`send-flow.ts:180`, `SendWizard.vue:890`), entrypoints per intent (`send-flow.ts:112-116`);
   `readSendReceiptLeaves` checks event structure only (`send-flow.ts:365-371`). Production precedent
   for `getTransaction` + `decodeFunctionData`: `useHubExit.ts:264-286`.
6. viem 2.55 drops `args` when `events` is passed (`getLogs.js:35`).
7. `recoverLegIfNeeded` bails without a hash (`useBridgeJournal.ts:937-940`); `record-policy.ts:92-94`
   hides CLAIM for that shape; the copy lives at `BridgeJournalCard.vue:172`; `recoverDepositLeg`
   refuses non-send records (`deposit-flow.ts:286`).
8. `computeL2ToL1MessageHash` (`stdlib/hash/hash.d.ts:121`) + `withdrawContentHash`
   (`content-hash.ts:58-61`, mirrors `main.nr:290,307`); the exit's caller is `ZERO_L1`
   (`useHubExit.ts:382-389`); every reader takes `l2ToL1Msgs[0]` (`flows.ts:222`, `useHubExit.ts:189`);
   `IndexedTxEffect.data.l2ToL1Msgs` (`tx_effect.d.ts:38`); `getBlocks(from, limit)`
   (`aztec-node.d.ts:186-189`); `NodeInfo.rollupVersion`/`l1ChainId` (`node-info.d.ts:17-19`).
9. A hash-less exit is `exiting`, FINISH hidden (`record-policy.ts:95`), the `unknown-outcome` branch
   at `useBridgeJournal.ts:1404-1410` is unreachable from the UI; a live exit is re-keyed to its hash
   then re-run under the new id (`useHubExit.ts:512-520`); `rekeyRecord` drops any record whose id
   equals the new id (`journal.ts:389-393`); `withRecordLock` keys `inFlight` by id (`useBridgeJournal.ts:625-642`).
10. Conditional-write primitive: `patchRecordWhen` (`journal.ts:373-386`), used at
    `useBridgeJournal.ts:1214-1234` and `:1242-1281`.
11. Deps wiring and fakes: `JournalEngineDeps` (`:138-219`), `ensureSendJournalDeps` (`useSend.ts:228-254`),
    `ensureHubExitDeps` (`useHubExit.ts:289-308`), `baseDeps`/`smartClaimFake`
    (`useBridgeJournal.test.ts:123-155`).
12. The pinned cells: 24b `recovery.spec.ts:117-172`, 26d `l1-wallet.spec.ts:14-59`, 31b
    `exits.spec.ts:123-172`; the L1 fixture's `holdNext` parks BEFORE sending
    (`fixtures/l1-wallet.ts:131-137`, `:165-178`); the test wallet's `swallowNext` runs the call and
    never answers (`test-wallet/main.ts:83-89`).
13. Real commands: `bun run --cwd apps/tools test`, `bun run --cwd packages/bridge-core test`,
    `bun run --cwd apps/tools typecheck`, `bun run e2e:tools -- [--shard=i/n | specs/<file>]` (retry 0
    by default: `UNLEASHED_E2E_RETRIES`), `bun run test:all`, `bun run lint`, `bun run lint:actions`.

**Inferences (unverified — the audits should attack)**
- The hub's siloed nullifier equals `siloNullifier(rec.bridge, poseidon2([messageHash, secret], MESSAGE_NULLIFIER))`
  in both the private and the public claim (fable verified the two contexts; cell 24b — a relayer's
  public claim, then the page's CLAIM → done — is the end-to-end proof at retry 0; a unit vector pins
  the formula).
- `getNullifierMembershipWitness("checkpointed", …)` answers on the sandbox node through the app's node
  client (no PXE).
- viem `getLogs` with one `event` over the window sizes involved returns in one call on anvil;
  public testnet RPCs cap ranges (~10k blocks) — the helper chunks.
- `getBlocks(from, limit)` returns bodies with tx effects for a same-day window on the local
  network and on testnet nodes that keep history; a pruned node answers `"incomplete"`.
- Re-keying then re-running under the new id preserves the live path's card/foreground behaviour
  (`rekeyJournalRecord` carries runtime, session-live and the foreground id; the live exit does the
  same at `useHubExit.ts:512-520`).
- The L1 fixture's `swallowNext("transaction", { to })` can broadcast through viem while parking the
  page's promise (the transaction is sent, the page never hears back) — the twin of the L2 wallet's
  `swallowNext`; it is what makes 26d's flip a real reconcile.

**Asks** — two decisions the approval gate settles explicitly (both recommended "accept"; neither
proves finality or provenance). Consequences stated plainly: a false "done" from a lying node or an
honest checkpoint re-org is followed, after 7 days, by the prune of the record — for a private
deposit that is its only sealed secret, i.e. a possible loss, at exactly today's floor and
probability; the exit residual (a twin finished, the intended one untracked) is bookkeeping.
- **Trusted node / finality**: A reads the nullifier at `checkpointed` from the app's existing node —
  the same settlement floor today's receipt completion uses — with no second source. A `latest`
  (proposed) read was rejected: a done from a block that later drops would be permanent and the
  7-day prune would remove a private deposit's only sealed secret. The residual (an honest
  checkpoint re-org, a lying node) equals today's.
- **Exit attribution**: a single surviving candidate is attached even though an identical exit from
  another device or a discarded twin is indistinguishable; the funds pay the same `recipientL1`.

Delegated to the implementer (logged codex consults): the window slack and caps; whether
"ambiguous" copy names the count; where the L1 `swallowNext` fixture lives.

## Phases

Three arcs, one per fix, stacked. Unit tests are inline with each change.

### Arc 1 — consumed → done (the task branch)

#### Phase 1: The nullifier helper, the dep, the two engine branches ✓ (lessons/phase-1.md)
- `apps/tools/src/lib/message-nullifier.ts` + test (public and private vectors; the private vector
  derives the secret; a wrong secret yields a different nullifier).
- `journal.ts`: `claimedByOther?: boolean` (+ the loader's schema test if one enumerates fields).
- `useBridgeJournal.ts`: `messageNullified` dep; `probeClaimedElsewhere` before `buildClaimHandles`;
  `classifyConsumable` factored out of `awaitConsumable` (tri-state); `isMsgConsumed` gains the public
  wording; `recordMessageConsumed` reads the nullifier; `completeClaimedByOther`. Tests: (a) public
  claim, witness present ⇒ done with the fact, no fee build, no `claimTxHash`, `sendTx` never called;
  (b) private record, secret cached ⇒ the derived secret's nullifier, done; (c) witness absent ⇒ the
  claim proceeds as today; (d) the simulate throws either consumed wording, witness present ⇒ done;
  witness absent ⇒ error as today; (e) the new probe with no material ⇒ `"unknown"`, it calls nothing that could prompt (asserted on the
  dep fake), and the record keeps today's note; (f) a token+gas record whose FUEL message is nullified but the TOKEN message is not ⇒
  not done (the readiness wart, pinned); (g) a record whose stored `messageHash` does not recompute
  from its facts ⇒ `"invalid"` ⇒ `tampered`, no lookup, no completion — fresh and resumed; (h) gas-only
  and schema-2 records never reach the nullifier probe and keep today's claim-build probe (their
  `handleSuccessReceipt` outcomes unchanged); (i) the resumed hub claim with a success receipt uses the
  nullifier, not the claim build (`smartClaimFake` re-pinned: `"live"` keeps polling); (j) the record is
  replaced by another tab while the read awaits ⇒ no completion; (k) token+gas PUBLIC: TOKEN
  nullified, FUEL live ⇒ `claimedByOther` without `completedAt`, CLAIM YOUR GAS offered, then the
  standalone claim's `standaloneClaimed` ⇒ guarded completion (with a reload between the steps);
  (k′) token+gas PRIVATE: TOKEN nullified, FUEL live ⇒ `claimedByOther` without `completedAt`, no fuel
  affordance, the sealed envelope retained, never pruned; (l) token+gas with settled fuel ⇒ done.
- `useSend.ts`: wire the dep (node client + hub address, the active target's identity).
- **The two locks** (shared prerequisite, separable from A so reverting A keeps B/C): `locks` dep +
  the Web Locks adapter (`ifAvailable` null-branch tested against a fake `navigator.locks`), the
  journal mutation lock primitive (used by A's completion here, arc 2's write and arc 3's re-key —
  existing synchronous writes untouched), the record run lock inside `withRecordLock`; the in-memory fake;
  regressions: two in-memory tabs running the same record ⇒ one runs, one "held elsewhere"; a held
  journal lock delays a guarded write until release and the guard re-reads after it; no lock API ⇒
  today's behaviour for everything but the attach.
- **Validation gate**: `bun run --cwd apps/tools test -- src/lib/message-nullifier src/composables/useBridgeJournal`
  green; `bun run --cwd packages/bridge-core test -- src/journal` green; `bun run --cwd apps/tools typecheck`
  exit 0; `bun run lint` exit 0. Layers: lint · unit.

#### Phase 2: Card copy + cell 24b flipped ✓ (recovery.spec 4/4, lessons/phase-2.md)
- `BridgeJournalCard.vue`: the three done-by-another lines (token-only / public fuel to claim /
  private fuel kept); `record-policy` + `fuel-claim-state` were extended in Phase 1.
- `recovery.spec.ts` 24b: title and assertions → after the relayer's claim, the reloaded record's
  CLAIM click ends `data-stage="done"`, `claimedByOther: true` in storage, `sendTx` count 0, credited
  exactly once; a `journalStep`/copy assertion for the done-by-another line.
- **Validation gate**: Phase 1 commands; `bun run e2e:tools -- specs/recovery.spec.ts` (own sandbox,
  retry 0) all cells green. Layers: lint · unit · e2e.
- **Arc boundary**: `bun run e2e:tools -- --shard=1/2` ∥ `--shard=2/2` (own sandboxes, retry 0) both
  exit 0; then the codex loop on the arc-1 diff; then `gh stack add` for arc 2.

### Arc 2 — reconcile a hash-less deposit

#### Phase 3: The L1 finder ✓ (lessons/phase-3.md)
- `deposit-reconcile.ts`: `findDepositTx` over a narrow client interface (the fake encodes viem's real
  signatures: one `event` per `getLogs`, `getTransaction`, `getTransactionReceipt`, `getBlock`); tests:
  window search over sparse timestamps; a chain switch mid-scan ⇒ `"incomplete"`; a matching `bridge` tx; a `bridgeWithFuel` tx for a token+gas
  record (`totalAmount = amount + fuel`, `minFuelOutput`); a PRIVATE deposit (zero event recipient) found
  by its secret hash; a copied secret hash on another token or amount rejected at calldata; two
  matches ⇒ `"ambiguous"`; none ⇒ `"none"`; the cap, a failed read, a never-settling read (the
  deadline), an excessive candidate count, or a non-canonical receipt ⇒ `"incomplete"`.
- **Validation gate**: `bun run --cwd apps/tools test -- src/composables/deposit-reconcile` green;
  typecheck; lint. Layers: lint · unit.

#### Phase 4: Engine branch, affordance, copy, cell 26d flipped ✓ (26d/26e green, lessons/phase-4.md)
- `useBridgeJournal.ts`: `findDepositTx` dep; `reconcileDepositLeg` from `recoverLegIfNeeded`;
  tests: found ⇒ hash written once (`patchRecordWhen`), then leg recovered and the claim proceeds;
  a record discarded meanwhile ⇒ no write; a hash written by another tab meanwhile ⇒ no overwrite;
  a record whose identity fields changed meanwhile ⇒ no write;
  none / ambiguous / incomplete ⇒ their notes; a gas-only or schema-2 record ⇒ today's bail.
- `useSend.ts`: wire with the viem public client + `SEND_GENERATION`. `record-policy.ts`:
  `depositLegRecoverable` for hash-less `schema === 3` token records only (+ tests for both sides).
  Card copy.
- `fixtures/l1-wallet.ts`: `swallowNext("transaction", { to })` — the request is BROADCAST through
  viem and the page's promise parks (today's `takeHold` parks before sending); `holdsArmed` covers
  it; `calls`/`signatures` count it.
- `l1-wallet.spec.ts`: 26d → the router tx swallowed → reload → CLAIM finds it → claim lands → done;
  a 26e keeps today's Discard-only shape for a tx that was truly never sent (hold, no swallow):
  CLAIM → "not found" note → Discard.
- **Validation gate**: Phase 3 commands + `src/composables/useBridgeJournal src/lib/record-policy`;
  `bun run e2e:tools -- specs/l1-wallet.spec.ts` green at retry 0. Layers: lint · unit · e2e.
- **Arc boundary**: the two shards; codex loop on the arc-2 diff; `gh stack add` for arc 3.

### Arc 3 — attach a hash-less exit

#### Phase 5: The L2 finder ✓ (lessons/phase-5.md)
- `exit-attach.ts`: `findExitTx` over a narrow node interface (`getNodeInfo`, `getBlockNumber`,
  `getBlocks`, `getTxEffect`); tests with a fake node: the recomputed hash equals a vector from
  `withdrawContentHash` + `computeL2ToL1MessageHash`; one index-zero match ⇒ `{ exitTxHash, exitBlock }`;
  a match at index 1 ignored; a taken hash excluded; two ⇒ `"ambiguous"`; none; the cap / a pruned
  block / the deadline ⇒ `"incomplete"`; a chain-id/version mismatch with the active target ⇒
  `"incomplete"`.
- **Validation gate**: `bun run --cwd apps/tools test -- src/composables/exit-attach`;
  `bun run --cwd packages/bridge-core test -- src/journal` (`rekeyRecordWhen`); typecheck; lint.

#### Phase 6: Engine branch, affordance, copy, cell 31b flipped ✓ (the arc-3 and cross-arc loops done, 31b/31c green, final gates green, lessons/phase-6.md)
- `useBridgeJournal.ts`: `findExitTx` dep; `attachExit` replaces the dead `unknown-outcome` branch and
  runs the handoff (destination lock → guarded re-key → consume body inside, own error boundary; no
  outer re-entry); the live exit's re-key + consume (`useHubExit.ts:512-520`) goes through the same
  helper; tests: attached ⇒ the consume runs under `H`'s lock ⇒ done, the old id holds no runtime/busy
  state; a throw after the re-key is reported against `H` and the old id's runtime is cleaned; a second
  FINISH click during the consume is refused by `H`'s lock; a live exit vs an attach of the same hash ⇒
  one runner; attached but already finished on L1 ⇒
  `consumedByOther`; none/ambiguous/incomplete notes; a record discarded meanwhile ⇒ no re-key; a
  record whose identity fields changed meanwhile ⇒ no re-key; a record whose id equals the found hash
  already exists ⇒ refused (`journal.ts` `rekeyRecordWhen` tests cover the guard and the destination
  check); the re-verify of the tx effect failing ⇒ `"incomplete"`; **two tabs** (two runners over one
  shared KV and one in-memory lock table, both loaded before either wrote) ⇒ exactly one re-key, one
  consume runner, the other reports "held elsewhere"; no lock API ⇒ the attach fails closed with its
  note while a plain consume still runs.
- `useHubExit.ts`: wire with the node client. `record-policy.ts`: `exitAttachable` → FINISH shown
  (+ test). Card copy.
- `exits.spec.ts`: 31b → the swallowed private exit → reload → FINISH → attached → consume → done;
  credit charged once; no second burn; `exitTxHash` in storage equals the burn the wallet reported
  (`walletCalls`/`submitted`). **31c (two tabs)**: the same swallowed exit, two pages in ONE browser
  context (two wallet profiles, one journal); tab 1 presses FINISH with its L1 portal transaction
  parked by the L1 fixture (`holdNext("transaction", { to: portal })`, so the attach has re-keyed and
  the consume holds `H`'s lock); tab 2 presses FINISH while parked ⇒ its card shows "another tab is
  finishing"; the fixture releases the hold (`release()` — the L1 twin of the test wallet's) ⇒ tab 1
  finishes; exactly one `eth_sendTransaction` to the portal across both pages — the browser-level
  proof of the cross-tab lock that same-thread fakes cannot give.
- **Validation gate**: Phase 5 commands + the journal/policy tests; `bun run e2e:tools -- specs/exits.spec.ts`
  green at retry 0; then the FULL tools suite in two shards (retry 0); `bun run test:all` exit 0;
  `bun run lint && bun run lint:actions` exit 0. Layers: lint · unit · e2e.
- **Arc boundary**: codex loop on the arc-3 diff; then the cross-arc pass; then Delivery.

## Post-implementation (self-contained; executed by the implementing session)

`code_review: off` — `/code-review` is NOT run at any point.

For each arc, at its boundary (phases green, before `gh stack add` of the next arc):
1. **Codex audit** (`/codex high`, read-only): the
   arc's diff (`git diff <base>...<arc-branch>`), this plan + the decision ledger, the arc map ("arc N
   of 3; later arcs add …"), the adversarial/security ask (what could go wrong, what an attacker
   targets, what is trusted that should not be), and the two rules below verbatim.
2. **Iterative fix loop**: verify each finding against the repo, apply the accepted fixes, commit on
   the arc branch, log the round (consult + verdict) in `lessons/phase-N.md`, then RESUME the same
   session with the fix diff. Repeat until a round reports no new material
   findings. Still material after 3 rounds → stop and surface to the owner (log it; the owner decides
   whether to run on).
3. After all three arcs: one FRESH codex session over the stack's net diff from the base branch,
   asking for cross-arc issues (seams, duplication, drift from this plan) — same loop.
4. **Delivery** (below) — the first time any PR is opened.

Rules, verbatim in every codex prompt:
- No over-engineering: "Report bugs and small, targeted improvements only. Do not propose speculative
  abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes
  each real problem. If code works and is clear, leave it alone."
- Comment quality: "Audit the comments for value per character. Flag any comment that narrates what
  the code visibly does, restates its line, references implementation plans / phases / reviews, or
  spends a paragraph where a sentence works — and flag places where a non-obvious invariant or
  constraint deserves a comment it doesn't have. Comments are permanent context every future reader,
  human or LLM, pays to re-read: they must be few, dense, and exact."

Standing constraints for the implementing session: no wallet-sdk patches; no change
to the wallet; never `pkill -f anvil`; the tools suite runs on its own sandbox; commitlint
(≤100-char header, lower-case subject); trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`;
PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; hard limits:
never merge, publish, rewrite shared history, or add a resubmission path to any record.

## Delivery

Three stacked PRs via `gh stack` (installed):

| Arc | Branch | Phases | Stacks on | code_review |
|---|---|---|---|---|
| 1 consumed → done | the task branch | 1–2 | the base branch | off |
| 2 deposit reconcile | the arc-2 branch | 3–4 | arc 1 | off |
| 3 exit attach | the arc-3 branch | 5–6 | arc 2 | off |

- `gh stack init` on the task branch over the base branch at the arc-1 boundary; `gh stack add <branch>` at
  each later boundary; PRs only after the cross-arc pass: `gh stack submit --auto`, then `gh pr ready`
  each (submit creates drafts), `gh pr edit` bodies, `gh pr checks --watch`. After any sync/rebase the
  affected arcs' local gates re-run on the new SHA. Merging is the owner's (`gh stack merge`), unless
  the owner instructs otherwise in the session.
- PR titles (≤ 93 chars, conventional): `feat(tools): a claim another submitter made finishes as done, proven by the message nullifier`
  / `feat(tools): reconcile a hash-less deposit from its router transaction` /
  `feat(tools): attach a hash-less exit by its recomputed l2→l1 message`.
- Close-out: `implementations-plan/index.md` row → merged; the readiness rows
  → fixed.

## Autonomy

Decision points the implementer settles with a logged codex consult (no owner wait): window slack and
caps; the exact copy of the three notes; whether the L1 `swallowNext` fixture belongs in
`fixtures/l1-wallet.ts` or a sibling. Surface to the owner and hold: any change to the prompt rule, any
new persisted field beyond `claimedByOther`, any resubmission path, a third codex round still material.

## Audit verdicts

| Leg | Round | Verdict | Triage |
|---|---|---|---|
| codex (Astra, high) | 1 on v1 | **reject** — 14 findings (5 High security, 2 Facts, 3 Inferences, 1 Ask, 3 Implementation) | 12 adopted, 1 rejected as pre-existing by design, 1 partly |
| fable (Plan subagent) | 1 on v1 | **conditional approve** — S1 silo/secret by record shape, S2 `getLogs` args, I1 re-key outside the old-id lock, fact corrections | all four conditions adopted |
| codex | 2 on v2 | **reject** — 6 findings (cross-tab guards, invalid vs unknown identity, `getBlocks` bodies, `tokenSecretHash`, the probe dispatch for excluded shapes, the scoped prompt test + ledger wording) | all six adopted |
| codex | 3 on v3 | **reject** — 1 finding: the synchronous re-key guard still permits concurrent attachment across tabs | adopted: Web Lock record runner — the three-round stop |
| codex (fresh session #1) | final on v4 + ledger | **reject** — 7 findings, all on v4's lock design and its copy: the journal array is the storage unit (journal-wide lock), the `ifAvailable` adapter, the non-reentrant handoff (+ the live re-key path), scan deadlines, "discard" in ambiguous copy, the local target's rollup version, lock scheduling in arc 1 | all seven adopted |
| codex (fresh session #2) | final on v5 + ledger | **reject** — 6 findings: async journal lock vs synchronous persistence callers; `latest` = proposed vs the checkpointed settlement floor (a strandable private deposit); stale Phase 6 / diagram / interface; the error boundary after re-key; C's export copy on provisional ids; the two-tab cell's contention window | all six adopted |
| codex (fresh session #3) | final on v6 + ledger | **reject** — 5 findings: A's completion lacks the snapshot guard; a token nullifier does not prove private-fuel settlement (strandable); stale blanket lock claims; the trusted-node consequence understated; stale ledger rows | all five adopted in v7; NOT re-audited — surfaced at the gate |
| codex (fresh session #4) | final on v7 (the approval condition) | **reject** — 3 findings: the private-fuel recovery route does not exist (public-only ladder); B's scan must pin the L1 chain; phase text drift | all three adopted in v8 |
| codex (fresh session #5) | final on v8 (the approval condition) | **approve** — 3 low items: `assertDepositFacts` for the new flag, one stale `latest`, editorial alignment | folded |
| codex (fresh session) | final on the consolidated plan + ledger | _pending_ | |

### Decision ledger

| Decision | Chosen | Rejected / alternatives | Why |
|---|---|---|---|
| B/C discovery | scan the chain from the record's own facts | paste-a-hash UI (competing outline); codex's hybrid "scan + verified-hash fallback" | users of a bridge UI rarely hold the hash; the cells prove the recovery only with the scan; the paste fallback stays a possible later UI (out of scope) — fable agrees, codex prefers the hybrid (recorded as the one open disagreement) |
| A's identity | recompute the message hash from record facts and require equality with the stored one | trust `rec.messageHash` (v1) | a hostile record could pair a foreign consumed message with different display facts (codex #1) |
| A's scope | hub token sends only; gas-only/legacy answer `null` | "all deposits" (v1) | their consumer and secret schemes differ (fable S1); fail closed |
| A's probe order | nullifier read BEFORE the fee build; the simulate error is the second chance | after the simulate only (v1) | fee construction can stop earlier and the public wording was missed (codex #9) |
| B's candidate filter | router + one event, post-filter on the secret hash | `aztecRecipient` arg (v1) | private deposits publish a zero recipient; viem drops `args` with `events` (codex #6/#8, fable S2) |
| Search outcomes | `none` / `ambiguous` / `incomplete` | `none` for caps and failures (v1) | "search incomplete" must never read as "nothing was sent" (codex #10) |
| C's match position | index zero only | anywhere in `l2ToL1Msgs` (v1) | every reader of the exit takes index zero (codex #2) |
| C's attribution | refuse anything plural; attach a single survivor; residual accepted | treat window uniqueness as provenance (v1 wording) | identical exits are indistinguishable; the destination is the same (codex #3, fable S3) → explicit approval decision |
| Attach + lock | `attachExit` returns `{ rekeyedTo }`; re-run under the new id | continue under the old id (v1) | `inFlight` and runtime keyed by the dead id; the live exit already re-keys then re-runs (codex #4, fable I1) |
| Trusted node | keep the app's existing single-node boundary; surface as a decision | a second source / finality wait | no second source exists in the app; a lying node already controls every stage (codex #11) |
| Prompt rule on automatic resume | leave as is (pre-existing) | gate `ensureTokenGrant`/`resolvePrivateClaimMaterial` on `interactive` everywhere (codex #5) | `resumeActionFor` auto-continues what this page session started AND prompt-free receipt waits (rediscovered records with a `claimTxHash`); on the latter `claimGuards` may still raise a grant prompt before `resumeSentClaim`'s gate — a pre-existing wart the journal owns, out of this plan's scope and recorded for a follow-up; the new branches add no prompt (the probe is asserted prompt-free on its fake) |

| Cross-tab exclusion (codex round 3 = the three-round stop; refined by fresh passes #1–#3) | two same-origin Web Locks, injectable, introduced in arc 1: a journal lock around the plan's NEW guarded writes only, and a per-record run lock with a correct `ifAvailable` adapter; one internal attach handoff (acquire the destination's lock first, re-key, run the consume body inside it with its own error boundary — no outer re-entry; the live exit uses the same helper); attach fails closed without a lock API; existing unlocked writers remain a stated residual | process-local `inFlight` + synchronous guards (v3); a record-only lock with a re-acquiring handoff (v4); locking every mutation (v5) | two tabs pass a synchronous guard (round 3); a record lock does not protect the whole-array write and a re-acquiring handoff skips itself (fresh #1); async acquisition breaks synchronous persistence callers (fresh #2); Web Locks cannot exclude non-cooperating writers (fresh #3) |
| Ambiguous-result copy | deposits: keep the record and export its recovery file; exits: keep the record — provisional ids have no recovery file — and finish with the burn id from the wallet | "check your wallet activity, then discard" (v1–v4); "export" for exits (v5) | ambiguity is positive evidence; discarding a private deposit destroys its only secret; provisional exits cannot export (fresh #1, #2) |
| A's completion | guarded `{ claimedByOther, completedAt }` write on the verified snapshot; token+gas with unsettled PUBLIC fuel routes to the existing public standalone recovery and completes when it settles; with unsettled PRIVATE fuel the record stays open with its sealed material (follow-up `private-fuel-standalone`) | complete on existence (v1–v6); route private fuel to a standalone claim (v7) | a same-id replacement during the read could be completed; a relayer's token claim leaves fuel unclaimed and the prune would strand it (fresh #3); no private standalone spend exists and one is a new fee surface (fresh #4) |
| Journal lock scope | only the plan's NEW guarded writes run under the journal lock; existing synchronous writes untouched (follow-up `journal cross-tab writes`) | wrap every mutation (v5) | acquisition is async; `addRecordVerified`/`persistPreTx`/the un-awaited send-flow hooks depend on synchronous persistence (fresh pass #2) |
| Nullifier read block | `checkpointed` | `latest` (v1–v5) | `latest` is the proposed tip; a done from a dropped block is permanent and the prune removes the sealed secret (fresh pass #2) |
| Scan bounds | a total deadline + read/candidate budgets → `"incomplete"`; late results dropped by the runner's `gen` | block caps only (v1–v4) | the L1 client has no transport deadline; a hung read could pin a lock or latch a stale fact (fresh pass #1) |

**Still disputed**: codex's hybrid (scan + verified-hash fallback) vs the plan's scan-only. Fresh
pass #1 now agrees: ship scan-only, the fallback can follow. **Three-round stop**: round 3 still
produced one material finding (cross-tab exclusion); it was folded, and the first fresh final pass
then found seven defects in THAT fold (v5), a second fresh pass six more (v6), and a third five more
(v7: A's completion guard and the private-fuel gap, honest lock wording, the trusted-node consequence).
Every finding was verified and folded. The owner approved on the condition that a fresh pass
returns `approve` first: pass #4 on v7 found three more (folded as v8); pass #5 on v8 returned
**`approve`** with three low editorial items (folded). Phase 1 started on that verdict.

## Seeds

_(finalized — approved as drafted; the /goal seed below is the one the owner set)_

```
/goal All 6 phases marked ✓ in implementations-plan/archive/tools-recovery/plan.md (the per-phase headers — not the chat, not the task list), each ✓ backed by its phase's validation gate as written in plan.md reported passing in the transcript (each local suite run quoted with its retry-0 tally and the SHA it ran on); for each phase the agent has printed `LESSONS_FILE=implementations-plan/archive/tools-recovery/lessons/phase-N.md`; `/code-review` was NOT run (code_review: off); the codex fix loop converged for each of the three arcs at its boundary AND for the final cross-arc pass, each convergence evidenced by a resumed codex pass reporting no new material findings, quoted in the transcript; the three-PR stack exists on GitHub, created only after all loops converged (`gh stack view` output in the transcript), each PR's checks watched to a settled PASSING state with the result quoted, and after any sync or rebase the affected arcs' local gates re-run on the new SHA before the re-watch; `bun run test:all` and `bun run lint && bun run lint:actions` both report exit 0 in the transcript on the final SHA; implementations-plan/index.md's tools-recovery row reads "stack open"; every decision point was settled by a logged codex consult or surfaced per plan.md § Autonomy. Merging is the owner's and is not part of this goal.
```

```
/loop 15m Drive implementations-plan/archive/tools-recovery forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/archive/tools-recovery/plan.md and lessons/ (authoritative — not the chat); native task list empty? rebuild it from plan.md, one task per remaining step; `git status`, `git log --oneline -5`; if PRs exist, `gh stack view` and `gh pr checks <n>` (no --watch).
2. Waiting on CI is fine — confirm it progresses; use the wait to prep the next phase. Local suites: the tools suite on its own sandbox (`bun run e2e:tools -- …`), retry 0; shard the arc-boundary runs (`--shard=1/2` ∥ `--shard=2/2`); never `pkill -f anvil`.
3. No task in hand? Take the next pending phase from plan.md. After each meaningful edit run `bun run lint` and `bun run --cwd apps/tools test -- <touched files>`; commit (conventional, ≤100-char lower-case header, the Co-Authored-By trailer) → push (`gh stack push` once the stack exists).
4. Stuck or at a decision you'd bring to me? Call `/codex high` with full context, settle it, act, log consult + verdict in lessons/phase-N.md. Hard limits stay hard: never merge, publish, rewrite shared history, add a resubmission path, change the prompt rule.
5. Same step failed 5 times? Stop retrying; reassess with codex, then continue on the agreed path.
6. Phase green = its validation gate in plan.md passes: run it, paste the tally + SHA, mark ✓ in plan.md, write lessons/phase-N.md, print `LESSONS_FILE=implementations-plan/archive/tools-recovery/lessons/phase-N.md`. Arc boundary? codex loop on the arc diff (no /code-review) until a round yields nothing material (3 rounds still material → surface), THEN `gh stack add <next-arc-branch>`.
7. All 6 phases ✓? Final cross-arc codex pass (fresh session, net diff), then Delivery per plan.md: `gh stack submit --auto`, `gh pr ready` ×3, bodies, `gh pr checks --watch`; then the wrap-up report (what shipped, every contentious decision with ELI5 context, open items). Surface and stop. Merging is mine.
Keep the native task list current; plan.md stays the source of truth.
```
