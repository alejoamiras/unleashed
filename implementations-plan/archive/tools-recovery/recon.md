# tools-recovery — codebase recon (Phase 0.4)

Base: the tree with the earlier readiness stack merged. Two read-only explorers (a batched
reuse sweep, a journal-engine mapper) plus the driver's own verification of the three facts the
explorers could not grep (their shells were locked). Every citation is to this tree.

## Reuse map

| Capability needed | Existing code | Verdict | Note |
|---|---|---|---|
| **A1** L1→L2 message nullifier (hub scheme) | aztec-nr v5.0.1 `hash.nr:51-53` `compute_l1_to_l2_message_nullifier(message_hash, [secret]) = poseidon2_hash_with_separator([message_hash, secret], DOM_SEP__MESSAGE_NULLIFIER)`; `private_context.nr:890-910` (`consume_l1_to_l2_message` → `process_l1_to_l2_message` → `push_nullifier_unsafe`); TS mirror `@aztec/stdlib` `messaging/l1_to_l2_message.js:74-79` `computeFeeJuiceMessageNullifier(messageHash, secret)` (same formula, doc: "any consumer following the same scheme"), `hash/hash.d.ts:46` `siloNullifier(contract, inner)`; `DomainSeparator.MESSAGE_NULLIFIER = 3754509616` | **reuse-as-is** (primitives) + **build new** (the glue) | The leaf index is NOT part of the nullifier (it only locates the witness). The hub passes `[secret]` — one field — in `claim_public` (`main.nr:244`) and the DERIVED `derive_claim_secret(claim_salt, recipient)` in `claim_private` (`main.nr:265-271`), mirrored by `packages/bridge-core/src/claim-secret.ts:46-47` `deriveTokenClaimSecret`. Nothing in-repo computes this nullifier today. |
| **A2** nullifier membership read | `AztecNode.getNullifierMembershipWitness(referenceBlock, nullifier)` (`interfaces/aztec-node.d.ts:64`) — witness iff the nullifier IS in the tree | **reuse-as-is** | The node client the app already builds (`createAztecNodeClient(NODE_URL)`, `useSend.ts:250,273`). A read, no wallet, no prompt. |
| **A3** today's consumed probe | `useBridgeJournal.ts:1313-1329` `recordMessageConsumed` (re-runs `buildClaimHandles` → simulate, regex-sniffs `isMsgConsumed`, `:63-64`); `awaitConsumable` `:1103-1123` rethrows anything not `isMsgNotReady` (`:1117`) → `surfaceRunFailure` `:769-774` → `attention: "error"` | **replace the probe; add a branch** | The fresh-claim path (24b's) never reaches `recordMessageConsumed`; it dies in `awaitConsumable`'s rethrow. `isMsgConsumed`/`isMsgNotReady` stay for the FUEL message (`deposit-flow.ts:782`, `fuel-recovery.ts`) and `hub-l2.ts:198-201` `isRegisterRace`. |
| **A4** the private secret | `useBridgeJournal.ts:573-622` `resolvePrivateSecret` (ONE L1 signature via `deps.signL1` → `recoveryKeyFromSignature` → `openDepositEnvelope`, cached in module `secretCache` `:227`); gated by `interactive` in `resumeSentClaim` `:907-915`; `resumeSessionWork` always `interactive: false` (`:1456-1462`); the card's `onAction` (`BridgeJournalCard.vue:232-235`) is the only interactive caller | **reuse-as-is** | The owner's rule (prompt only on CLAIM click) is exactly this gate. The nullifier check reads `secretCache`/the public secret only; it never calls `resolvePrivateSecret` itself. |
| **B1** router ABI + calldata decode | `packages/bridge-core/src/router-abi.ts:6-122` `SWAP_BRIDGE_ROUTER_ABI` (`bridge(SimpleBridgeParams,PermitParams)`, `bridgeWithFuel(BridgeParams,PermitParams)`); `apps/tools/tests/browser/pages/journal.ts:93-107` `depositCalldata` (viem `decodeFunctionData`, TEST layer); `useHubExit.ts:264-286` `verifySendConsume` (production precedent: `getTransaction` + `decodeFunctionData` + field match) | **adapt** (pattern → `src/`) | Events `Bridge`/`BridgeWithFuel` (`SwapBridgeRouter.sol:84-97`) carry `aztecRecipient` (indexed), key/index, amount(s), secretHash(es), isPrivate — no token/portal. Calldata carries `bridgeToken`, `tokenPortal`, amounts, `isPrivate`. |
| **B2** L1 log scan by recipient, block window by chain time | viem `getLogs` — not used anywhere in `apps/tools/src` or `packages/bridge-core/src` (only `parseEventLogs` over a receipt: `flows.ts:173,443`, `send-flow.ts:318`, `fuel.ts:70`); chain time read once at `useSend.ts:884-886` (`publicClient.getBlock().timestamp`) | **build new** | `createdAt` is wall-clock (`journal.ts:40-66`); the window must be resolved to L1 block numbers by block timestamps. |
| **B3** leg recovery from a KNOWN hash | `deposit-flow.ts:282-298` `recoverDepositLeg` (receipt logs → `readSendReceiptLeaves`, `send-flow.ts:365-371`); engine gates `useBridgeJournal.ts:929-968` (`legRecoveryNeeded` / `recoverLegIfNeeded` bails at `:937-940` when no `depositTxHash`); `record-policy.ts:92-94` hides CLAIM for a `depositing` record with no hash | **reuse-as-is after the hash is found** | The reconcile step's only output is `depositTxHash`; everything after it is today's path. |
| **C1** L2→L1 message hash recompute | `@aztec/stdlib` `hash/hash.d.ts:121` `computeL2ToL1MessageHash({ l2Sender, l1Recipient, content, rollupVersion, chainId })` (not imported anywhere in-repo yet); `packages/bridge-core/src/content-hash.ts:58-61` `withdrawContentHash(recipient, amount, caller)` (mirrors `main.nr:290,307` `get_withdraw_content_hash`); the exit's inputs are all on the record: `bridge` (hub), `token.portal`, `recipientL1`, `amount`, `callerOnL1 = ZERO_L1` (`useHubExit.ts:382-389`), `chainId`; rollup version live from `node.getNodeInfo()` or `chain-constants.ts:20-37` | **reuse-as-is** (combine) | |
| **C2** find the L2 tx that emitted the message | `AztecNode.getL2ToL1Messages(epoch): Fr[][][][]` (checkpoint → block → tx → messages; deprecated but present), `getBlockData`, `getTxEffect(txHash)` (`IndexedTxEffect`, `tx_effect.d.ts:38` `l2ToL1Msgs: Fr[]`), `getL2ToL1MembershipWitness(txHash, message)` (`aztec-node.d.ts:141`); `useHubExit.ts:183-196` `expectedWitness` (needs the tx hash) | **build new** (a bounded block scan) | No helper walks blocks for a message hash. `exitBlock` is unknown for a hash-less exit; `createdAt` bounds the L2 block window via block timestamps. |
| **C3** the consume tail after attach | `useBridgeJournal.ts:1395-1433` `runWithdrawConsumeLocked` (`!rec.exitTxHash` → `unknown-outcome` note `:1404-1410`, today unreachable from the UI: `resumeActionFor` `:1451` skips, `record-policy.ts:95` hides FINISH for `stage === "exiting"`); `useHubExit.ts:227-261` `runSendConsume` + `consumedElsewhere` `:215-225` | **reuse-as-is after the hash is attached** | Attach writes `exitTxHash` (+ `exitBlock`); the existing tail (proven wait → consume → `consumedByOther`) runs unchanged. |
| **D** conditional writes after awaits | `packages/bridge-core/src/journal.ts:373-386` `patchRecordWhen` (expected-value guard, "not a CAS"); used at `useBridgeJournal.ts:1214-1234` (`reportRevertedClaim`), `:1242-1281` (`advanceReceiptStreaks`) | **reuse-as-is** | The guard for B/C: "still has no `depositTxHash` / `exitTxHash`". |
| **E** engine deps + wiring + fakes | `JournalEngineDeps` `useBridgeJournal.ts:138-219`; production wiring `useSend.ts:228-254` (`ensureSendJournalDeps`), `useHubExit.ts:289-308`; unit fakes `useBridgeJournal.test.ts:139-155` `baseDeps`, `:123-137` `smartClaimFake` (throws the consumed wording after `send`), record builders `:84-121` | **adapt** (three new optional deps) | A: `messageNullified?(rec) → boolean \| null`; B: `findDepositTx?(rec) → {txHash} \| "none" \| "ambiguous"`; C: `findExitTx?(rec) → {exitTxHash, exitBlock} \| "none" \| "ambiguous"`. |
| **F** action gating + copy | `record-policy.ts:80-125` (`showClaim` needs `depositLegRecoverable`; `showFinish` false for `exiting`; `retry` on `error`/`unknown-outcome`); `bridge-steps.ts:47-51` `TERMINAL_ATTENTIONS`; `BridgeJournalCard.vue:160-196` copy ("The deposit never confirmed on Ethereum…" `:172`, "The exit was interrupted…" `:186`), buttons `:355-391` | **adapt** | A new affordance per shape (a FIND/CLAIM path for a hash-less deposit, a FIND/FINISH path for a hash-less exit) beside Discard; Discard stays the fallback. |
| **G** tests pinning today's behaviour | `tests/browser/specs/recovery.spec.ts:117-172` (24b), `l1-wallet.spec.ts:14-59` (26d), `exits.spec.ts:123-172` (31b); fixtures `pages/relayer.ts` (`claimAsRelayer`), `pages/journal.ts`, `test-wallet/main.ts:144-171` (`holdNext`/`release`/`swallowNext`/`dropNextSubmission`), `fixtures/l1-wallet.ts` (`holdNext("transaction", { to })`) | **adapt** (each cell flips to the fixed behaviour) | |

## Conventions and invariants that bind the design

- **Prompt-free**: the journal never asks for a signature on its own — `recordMessageConsumed`
  ("null when the secret isn't available for the probe (prompt-free rule)", `:1312`),
  `resumeSessionWork` ("Auto-continue ONLY what this page session initiated, plus prompt-free receipt
  waits", `:1455`), `resumeActionFor` (`:1436-1453`). The owner keeps it: the unseal happens only on a
  CLAIM click (`interactive: true`).
- **Never resubmit from a record**: `resumeSentClaim` (`:903-906`) and `finishSubmittedConsume`
  (`:1358`). The three fixes ADD facts (`depositTxHash`, `exitTxHash`, "done by another") and then
  run today's paths; none re-sends.
- **Milestone facts only** (`journal.ts:6-14`): persisted records hold facts; stages are derived;
  runtime attention/notes are ephemeral (`RecordRuntime`, `useBridgeJournal.ts:85-127`).
- **Fail closed on ambiguity**: `verifySendConsume` returns false on any throw; `isOutboxMessageConsumed`
  treats unknown as not consumed; `recordMessageConsumed` returns null. Two identical historical exits
  (same portal, recipient, amount) hash to the same message: attach must refuse unless exactly one
  candidate tx is not already another record's `exitTxHash`.
- **Complexity budget** (Biome cognitive ≤15, ≤80 lines): `runDepositClaimLocked` (`:797-832`),
  `runWithdrawConsumeLocked` (`:1395-1433`), `awaitConsumable`, `advanceReceiptStreaks` are already
  branch-dense — new logic goes in new helpers called from one new branch each.
- **Logging discipline**: ids, stages, hashes only — secrets/nullifiers never reach `log(...)`
  (`useBridgeJournal.ts:42-44`, `useSend.ts:82-83`, `deposit-flow.ts:67-68`).
- **Scope**: everything lands in `apps/tools/**` (+ possibly `packages/bridge-core/src` for
  pure helpers with unit tests); nothing changes in the wallet.
- **Naming collisions to avoid**: `reconcileFuelConsumed` (`fuel-recovery.ts:40`), `recoverDepositLeg`
  (hash-keyed contract), the many `consumed*` names on the withdraw path.

## Search trails for the absences

- No in-repo L1→L2 nullifier computation: `grep -rn "computeL1ToL2MessageNullifier\|MessageNullifier\|siloNullifier" apps/tools/src packages/bridge-core/src` → 0; stdlib hits only.
- No `getLogs`/block-window scan in production code: `grep -n "getLogs\|fromBlock" packages/bridge-core/src/*.ts apps/tools/src/composables/*.ts` → 0 (only `parseEventLogs` over receipts).
- No `computeL2ToL1MessageHash` import: `grep -rn computeL2ToL1MessageHash apps packages` → 0 (declared at stdlib `hash.d.ts:121`).
- No tx-effects/block scan for a message: `grep -rn "getL2ToL1Messages\|l2ToL1Msgs" apps/tools/src packages/bridge-core/src` → only `useHubExit.ts:189` (`eff.data.l2ToL1Msgs[0]`, hash known).
- `reconcile|attach|orphan` in production code: `reconcileFuelConsumed`, `reconcileFuelSalt` only; no attach/orphan.
- Noir source: AztecProtocol/aztec-packages v5.0.1, noir-projects/aztec-nr/aztec/src: `hash.nr:51-53`, and `private_context.nr:890-910` under context/ (the hub's Nargo.toml pins `v5.0.1`; the node is 5.2.0 — the formula and `DOM_SEP__MESSAGE_NULLIFIER` are the same in stdlib 5.2.0).
