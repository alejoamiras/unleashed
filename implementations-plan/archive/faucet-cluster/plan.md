## Outcome

Archived. Seeds retired.

# faucet-cluster — round-2 plan 6 (blueprint light, BL/E then BL/C)

Recon: [`recon.md`](recon.md) (one correction below). Burns **12 directives, 74 → 62** — PR-a 4
(`createAztecWalletSession.ts`), PR-b 8 (`useFuel.ts` ×3, `fuelClaim.ts`, `lib/bridge-steps.ts`,
`useL1FeeAsset.ts`, `useWithdraw.ts`, `packages/bridge-core/src/backup.ts`). `lib/errors.ts` and
`lib/phase-clock.ts` are owner-ACCEPTED — untouched.

Behavior-preserving only. Every extraction keeps the await-parity toolkit: sync helpers for zero-await
spans; an awaited helper only where the caller already awaited that exact span (under the caller-side
guard); register-immediately spans never gain a hop; helpers creating cancellable resources own
create→register; **a lookup-to-registration (or resolution-to-completion) span is ONE continuation — the
await stays in the caller and the classifier is sync** (plan 5's lesson). Never raise a ceiling,
hand-edit the manifest, or ship a generator-inserted directive.

## Assumptions

Facts (verified against the tree at the base branch; codex audit corrections folded):
- F1 `createAztecWalletSession` is a 405-line closure factory (`:129-854`) over refs + mutable locals.
  The concurrency rule, stated precisely: STALE teardown must use CAPTURED handles (never the mutable
  session fields, which may belong to a newer flow); CURRENT-flow reads of mutable state (e.g.
  `connectingViaRemembered`) are allowed only behind a passing epoch guard. Cleanup is SYNCHRONOUS
  (`wipeToIdle` / `cleanupSession`) before any awaited SDK teardown (`:121-126`).
  `preferredWalletName`'s initializer reads `storageKey`, which must exist first (`:130-133`).
- F2 The two stale-disconnect blocks in `requestCapabilities` (`:640-645`, `:652-657`) are byte-identical to
  `disconnectStaleSession`'s body (`:517-523`); `flowProvider` is captured before either await.
- F3 `useFuel.ts:181-212` is `deposit-flow.ts:852-883` (`ensurePermit2Approval`) with `FUEL_ASSET` in place of
  the hardcoded `L1_USDC`; `useFuel.ts:270-275` is `bestEffortL2Block` (`deposit-flow.ts:151-157`) inline.
  The router `bridge()` spans match only up to hash persistence (`useFuel.ts:214-260` ≈ `runPlainDepositLeg`
  `:1055-1105`: nonce/deadline → witness → typed data → sign → write → `updateRecord(depositTxHash)`),
  with different step prompts, `aztecRecipient: plan.to`, `isPrivate: false`, and deposit-flow's extra
  `log("bridge (confirm in your Ethereum wallet)")` between sign and confirm. **The post-receipt tails
  differ** (plain: two journal updates around `bestEffortL2Block`; fuel: `parseFeeJuiceDeposit` → block →
  fresh-record read → one composite update) and stay caller-specific.
- F4 The fuel record (`useFuel.ts:104-127`) diverges from `buildDepositRecord` (always schema 2,
  `assetKind: "fee-juice"`, `fuel.minOutput: "0"`, top-level `secret` for public) — scope forbids forcing it
  through the token builder.
- F5 `validateBackupRecord` (`backup.ts:74-155`) is a STRICT SHAPE validator (not semantic: several required
  strings may be empty, numbers are type-checked only) with ONE error string — its exact acceptance set
  is preserved, never "improved". `depositPhases` (`bridge-steps.ts:64-166`) is sync.
  `buildFuelClaimInteraction` (`fuelClaim.ts:106-243`) has zero awaits in its own body but STAYS `async`
  (a sync signature would turn thrown parsing errors from rejections into synchronous throws), and its
  `stop()` closures keep creating a fresh `Error` per invocation.
- F6 Tests (counted): `createAztecWalletSession.test.ts` 51 (drives the factory through a push-driven fake
  discovery stream), `fuelClaim.test.ts` 21, `useL1FeeAsset.test.ts` 14, `useWithdraw.test.ts` 2 (only
  `buildWithdrawSendOpts`), `bridge-steps.test.ts` ~30, **`packages/bridge-core/src/backup.test.ts` 13
  (direct `validateBackupRecord` coverage — recon missed it)**, `useBridgeBackup.test.ts` (indirect).
  `useFuel.deposit` has NO coverage anywhere: `FuelForm.test.ts` mocks `deposit` and **`fuel-smoke`
  mocks `useFuelFlow` itself** (`tests/e2e/fuel-smoke.test.ts:53`). The three faucet smokes need no
  anvil/sandbox (`apps/faucet` `test:e2e`, jsdom). `packages/bridge-core` has its own `test` script.
- F7 Biome charges nested functions/lambdas nesting rent: hoisting a closure to module level lowers every
  branch inside it by one.

Inferences (audited):
- I1 Module-level controllers over a per-factory `SessionState` are observationally identical to the
  closures when (a) nothing becomes module-global, (b) `provider`/`pending` are never re-read for stale
  cleanup, (c) construction is explicit two-stage — the key strings exist before the ref that reads them
  (`readPreferredFor(storageKey)` is the primitive; `readPreferred(s)` delegates). Pinned: the exact
  28-key surface and order; two concurrently created sessions stay isolated; the hostile
  remembered-account validation table (mandatory).
- I2 `ensurePermit2Approval` takes a REQUIRED `token` in a named parameter object (no default — a
  default would let a future fuel caller silently approve `L1_USDC`); deposit-flow's call site passes
  `token: L1_USDC` explicitly and stays runtime-equivalent. Pinned (fuel): the allowance read, the approve
  write, the Permit2 typed-data `permitted.token`, the witness `bridgeToken`, and the router calldata
  `bridgeToken` are all `FUEL_ASSET`.
- I3 The shared router leg is shared ONLY through hash persistence; each caller owns
  `setRecordStep(id, "depositing", "waiting …")` → `awaitL1Receipt` → its own parse, so the
  receipt-resolution → parse continuation never crosses a helper boundary. The `beforeConfirm` hook runs
  after signing, immediately before the confirmation step.

Asks (surfaced): none blocking. Existing residue surfaced by the audit for a SEPARATE hardening decision
(no behavior change here): hostile `preferred-wallet.id` is bounded on write but not on read, and live
provider announcements are neither count- nor size-bounded (claimed provider ids stay untrusted; emoji
verification remains the trust anchor).

## PR split

- **PR-a (BL/E)** — `apps/faucet/src/composables/createAztecWalletSession.ts`: 3 cognitive + 1 length.
  Existing 51-test suite zero-edit is the proof, plus the three seam pins from I1 (surface/order,
  isolation, hostile remembered-account table) committed with the refactor.
- **PR-b (BL/C)** — pins committed FIRST for `useFuel.deposit` (traces + failure classification + token
  identity), `useWithdraw` consume ordering + interval cleanup, `fuelClaim` stop-precedence conflicts, and
  the `validateBackupRecord` rejection cases the bridge-core suite lacks; then the eight extractions,
  reusing deposit-flow per scope.

## Decomposition — PR-a

`SessionState` (plain object, module-private type): `config`, `storageKey`, `selectedStorageKey`, every
ref, and the mutable fields (`provider`, `pending`, `cancelDiscovery`, `unsubscribeDisconnect`,
`pendingAccountChoice`, `nextNoticeKey`, `providersByKey`, `nextKey`, `epoch`, `activeFlowEpoch`,
`connectingViaRemembered`, `ambiguityTimer`). `createSessionState(config)` computes the two keys first,
then builds the object in the ORIGINAL declaration order with
`preferredWalletName: ref(readPreferredFor(storageKey)?.name ?? null)`. `createAztecWalletSession(config)`
= state + the returned surface, each member a thin binding (`connect: () => connectImpl(s, false)`, …),
same 28 keys in the same order — under 80 lines.

Controllers (module-level, all take `s`; plain functions, no class — the functional API stays, no `this`):
- **storage**: `readPreferredFor(key)` / `readPreferred(s)`, `writePreferred`, `clearPreferred`,
  `readRememberedMap` → `parseRememberedEntries(parsed: unknown): Array<[string, string]>` with a sync
  `rememberedEntryOf(entry): [string, string] | null` (shape + bounds), dedupe + cap loop kept — burns
  the score-26 directive; `readRememberedAccount`, `writeRememberedAccount`, `applySelection`.
- **flow ownership**: `isStale`, `releaseFlowIfOwner`, `clearAmbiguityTimer`, `stopDiscovery`,
  `claimantsOf`, `wipeToIdle`, `cleanupSession`, `disconnectStaleSession`, notices push/consume.
- **discovery** — `connectImpl(s, forcePicker)` (score 57): sync `sweepErroredResidue(s)` (`:367-373`),
  sync `openFlow(s, forcePicker): { flowEpoch, preferred }` (`:375-386`), the `for await` stays in
  `connectImpl` with its stale/status `return` first and its body as sync `admitAnnouncement(s, p,
  preferred, flowEpoch)` (`:404-427`, owns the ambiguity-timer arm). The natural-end block is a SYNC
  classifier `settleDiscoveryEnd(s, preferred, flowEpoch)` (`:431-451` minus the await/throw): returns
  `{ kind: "stale" } | { kind: "done" } | { kind: "proceed", key } | { kind: "choosing" } |
  { kind: "no-wallet" }` after applying its own sync side effects (`cancelDiscovery = null`,
  `scanning = false`, `clearAmbiguityTimer`, `connectingViaRemembered = true` / picker state);
  `connectImpl` keeps `await proceedWith(key, flowEpoch)` and `throw new Error("No wallet discovered")`
  inline, so the picker / no-wallet paths gain no microtask (codex condition). The catch tail stays
  verbatim. `fireRememberedWindow`, `selectWallet`, `proceedWith` hoist unchanged.
- **verification**: `confirmVerification`, `cancelVerification`, `retryCapabilities`, `cancelChoice`,
  `disconnect`, `forgetPreferredWallet`, `switchWallet` hoist unchanged.
- **capability** — `requestCapabilities(s, flowEpoch)` (score 34): both stale blocks become
  `await disconnectStaleSession(flowProvider)` (F2); the grant handling (`:663-688`) becomes sync
  `chooseGrantedAccount(s, granted, hiddenCount, flowWallet, flowProvider, flowEpoch): "paused" | "chosen"`
  preserving atomically: assign grant refs → reject empty grant (sync throw inside the caller's `try`) →
  truncation notice → remembered lookup → selection persistence/notice, or captured pause-token
  registration + `choosing-account`; the caller returns on `"paused"`, else falls through to
  `await finishSetup`.
- **setup**: `finishSetup`, `confirmAccountChoice`, `cancelAccountChoice`, `selectAccount`, `reset`
  hoist unchanged.

Rejected alternatives: a shared `failFlow(s, epoch, err, flags)` for the five catch tails (their cleanup,
logging and preference-clearing policies genuinely differ; they do not drive the scores — verbatim); a
class (adds `this` binding hazards for no gain).

## Decomposition — PR-b

- **`deposit-flow.ts` (reuse surface, not a burn)**: `ensurePermit2Approval({ permit2, token, needed,
  recordId, l1 })` — `token` REQUIRED; the deposit-flow call site passes `token: L1_USDC`. New exported
  `signAndSendRouterBridge(l1, p)` extracted from `runPlainDepositLeg` `:1055-1105` — inputs `{ id, router,
  permit2, swapTarget, tokenPortal, bridgeToken, amount, aztecRecipient, secretHash, isPrivate, prompts:
  { sign, confirm }, beforeConfirm? }`, ends with `updateRecord(id, { depositTxHash })` and returns
  `{ depositTxHash }`; `runPlainDepositLeg` passes its prompts + `beforeConfirm: () => log("bridge (confirm
  in your Ethereum wallet)")`, then keeps its waiting step, receipt await, router-event parse and both
  journal updates unchanged. `bestEffortL2Block` reused as-is.
- **`useFuel.ts`**: `deposit` hoists to module-level `runFuelDeposit(ctx: FuelFlowCtx, amount, isPrivate,
  opts)` (`ctx` = `{ l1, feeAsset, bridgeWallet, journal, busy, error }`), staged as: sync
  `checkFuelPreconditions(ctx): { wallet, from, aztec, recipient } | null` (`:74-89`, same messages/order);
  sync `buildFuelRecord(...)` (`:104-127`, fuel-specific per F4); awaited `sealFuelSalt(...)` under the same
  `isPrivate && plan.salt` guard (`:134-160`); sync `resolveFuelRouterConfig()` (`:167-175`, same throw);
  `await ensurePermit2Approval({ permit2, token: feeAssetAddr, needed: amount, recordId: id, l1: {
  publicClient: l1.publicClient, wallet, from } })`; `await signAndSendRouterBridge(...)` with the fuel
  prompts (no `beforeConfirm`); then, caller-owned: `setRecordStep(id, "depositing", "waiting for the
  Ethereum confirmation")` → `awaitL1Receipt` (same `onStillWaiting` text) → awaited
  `finalizeFuelDeposit(journal, id, receipt)` (`:268-286`, `await bestEffortL2Block()`) →
  `setRecordStep(id, undefined, undefined)` → `await runDepositClaim(id)`. The catch keeps `error.value =
  msg` FIRST, then sync `settleFailedFuelRecord(journal, id, e, msg): string | undefined` (journal
  discard + the approval-standing/rejection message, or `flagRecordError`), assigned only when
  `!== undefined`; `finally` clearing `busy` stays in `runFuelDeposit`. `useFuelFlow` shrinks to wiring +
  `withOperation` (burns the 191L directive too).
- **`fuelClaim.ts`**: sync `checkClaimBudget(received, gas, deps): FuelClaimInteraction | null` (the
  floor try/catch + fee-limit, identical in both branches modulo the gas constant),
  `buildPrivateFuelClaim(...)` / `buildPublicFuelClaim(...)`; the function stays `async`; guard ORDER per
  branch unchanged (floor → fee limit → fpc drift → salt / secret); `stop()` creates a fresh `Error` per call.
- **`bridge-steps.ts`**: sync `depositActiveKey(rec, rt)` (`:94-109`), `depositPrompts(rec, rt, fueled)`
  (`:120-139`), `syncProgress(rec, rt, activeKey)` (`:149-160`); `depositPhases` keeps keys/labels/etas +
  `buildPhases`.
- **`useL1FeeAsset.ts`**: each method hoists to a module-level function over the `l1` handle
  (`refreshBalance`, `readAllowance`, `verifyPortalAsset`, `approveFeeAsset`, `verifyHandlerAsset`,
  `mintFeeAsset`) — bodies verbatim, module singletons already module-level; `useL1FeeAsset` = bindings +
  the watch.
- **`useWithdraw.ts`**: `expectedWitness(l1, rec)`, `consumeExit(l1, rec, onProgress)`,
  `waitConsumeReceipt(l1, txHash)`, `verifyConsumeIdentity(l1, rec, txHash)` hoist verbatim;
  `wireWithdrawDeps` = the idempotency guard + `connectJournalDeps({...})` thin bindings.
- **`backup.ts`**: `assertCommonRecordShape(r)`, `validateDepositRecord(d)` (with
  `assertFuelBlockShape(f)`), `validateWithdrawRecord(r)`; the single error string hoisted to a const;
  the exact acceptance/rejection set preserved (F5).

## Equivalence

- PR-a: `createAztecWalletSession.test.ts` (51) zero-edit green; seam pins
  `createAztecWalletSession.pins.test.ts`: the 28-key surface in order; two sessions created concurrently
  don't share state (a flow in one never mutates the other); the remembered-map read rejects/bounds
  hostile entries (non-array, wrong arity, non-string, empty, over-long, duplicate id, over-cap) and only
  ever pre-selects within the live grant. `useWalletConnection` untouched.
- PR-b pins (committed first, byte-identical after):
  - `useFuel.pins.test.ts` — public and private `deposit` call-order traces through mocked deps (verify →
    plan → record shape → seal (private) → permit2 → sign → write → hash journaled → waiting step →
    receipt → block → event journaled → claim); preconditions messages; token identity (I2); failure
    classification on five paths: no record, rejection before approval, rejection after approval
    (approval-standing message), ambiguous failure (`flagRecordError`), rejection after `depositTxHash`
    (`flagRecordError`, no discard); `finally` clears busy on every path.
  - `useWithdraw.pins.test.ts` — receipt poll → `onProgress(targetBlock)` → proven wait with the interval
    cleared on throw → witness → simulate → write; `verifyConsumeIdentity` false on unverifiable.
  - `fuelClaim.precedence.pins.test.ts` — conflict cases: floor over fee-limit/FPC/salt; fee-limit over
    FPC/salt; FPC drift over missing salt (both branches where applicable).
  - `packages/bridge-core/src/backup.pins.test.ts` — only the rejection cases `backup.test.ts` lacks
    (checked against its 13), e.g. schema-1-with-fuel, malformed fuel extras, provisional withdraw id,
    invalid `assetKind`; two accepted shapes.
- Existing suites zero-edit: fuelClaim (21), bridge-steps, useL1FeeAsset (14), useWithdraw (2),
  bridge-core backup (13), useBridgeBackup, the deposit-flow characterization harness. No new
  bridge-steps / useL1FeeAsset pins (existing suites prove them).
- Gates per PR: `audit:vue` + `test:ci-gating`, faucet unit (`bun run --cwd apps/faucet test`), faucet
  smokes (`bun run --cwd apps/faucet test:e2e`: faucet-smoke · bridge-smoke · fuel-smoke), and for PR-b
  `bun run --cwd packages/bridge-core test`. No sandbox.

## Security & adversarial considerations

- Hostile `localStorage` (remembered wallet/account maps): the read path keeps every bound/shape check and
  never selects outside the live grant — the storage controller extraction is validation-only; the table
  pin guards regressions. Write bounds (`STORED_STRING_MAX`) unchanged. Existing residue (surfaced, not
  changed here): `preferred-wallet.id` unbounded on read; provider announcements unbounded.
- Epoch ownership (F1, precise form): stale teardown on captured handles only; current-flow mutable reads
  only behind a passing epoch guard; nothing becomes module-global.
- Permit2: the token is REQUIRED and explicit at every call site; `verifyPortalAsset` (fail-closed
  UNDERLYING check) still runs before any approval; the token-identity pin couples allowance read,
  approve write, typed data, witness and calldata to one address.
- Fail-closed validators: `validateBackupRecord` keeps its exact rejection set (pinned);
  `buildFuelClaimInteraction` keeps `stop(...)` precedence (pinned conflicts).
- Never validate by broadcasting: no live-network runs in this plan's gates.

## Decision ledger

| Decision | Codex position (blueprint audit, session `01a05eba…`) | Adopted |
|---|---|---|
| Session factory shape | module-level controllers over a plain state object; no class | yes |
| Five catch tails | keep verbatim | yes (already) |
| `settleDiscoveryEnd` | awaited helper adds a microtask on picker / no-wallet paths → sync classifier, await + throw stay in caller | yes |
| `chooseGrantedAccount` | acceptable as sync two-outcome, must keep its atomic step order | yes |
| Permit2 token | required, named-object, identity-pinned | yes |
| Router leg sharing | only through hash persistence; receipt→parse stays per caller | yes |
| Fuel catch | sync helper, base error first, override via `!== undefined`, five pinned paths | yes |
| Backup pins | extend/complement bridge-core's suite, gate bridge-core tests | yes (separate pins file) |

## Delivery

Two PRs, sequential, each regenerating the baseline (`bun run baseline:complexity`, diff read, zero
inserted). Codex: one session — plan audit (done) → PR-a review → PR-b review.

## Acceptance

- PR-a: 4 directives, 74 → 70, zero inserted; the session suite zero-edit + the three seam pins; faucet
  unit + smokes green.
- PR-b: 8 directives, 70 → 62, zero inserted; pins first; all faucet + bridge-core suites zero-edit;
  smokes green.

## Rollback

Squash revert per PR; no storage, wire or contract-call shape change (the router `bridge()` args and
the Permit2 approval sequence are equivalent by construction and pinned).
