## Outcome

Archived. Seeds retired.

# deposit-decomposition (arc 4, monster 1 of 3)

Decompose `apps/faucet/src/composables/useDeposit.ts`'s two monsters — `deposit()` (cognitive 132, 334 lines) and the journal `claim` dep (cognitive 75, 154 lines) — plus their shells, burning all **6** baseline directives in the file (4 length + 2 cognitive; codex audit corrected the initial 5-count). Money path: behavior-preserving is the entire game; every extraction is a verbatim transcription with the invariants named below carried as comments and pins.

## Success criteria

- All 6 directives in `useDeposit.ts` removed; manifest shrinks 158 → 152 in the same PR (count re-stated after rebase).
- No ladder decision, latch ordering, seal ordering, or witness field changes: **pre-extraction characterization traces** (below) captured over the CURRENT code, then kept green unchanged over the decomposed code — that identity is the equivalence proof.
- `audit:vue` + `test:ci-gating` + faucet suite + bridge-core suite green; no e2e regression on the smoke surface (deposit path has no CI network gate — see Validation).

## Load-bearing invariants (transcribe, never re-derive)

1. **L11 privacy fence**: a private FUELED record reaches the private ladder or fail-stops; it NEVER falls through to the public/sponsored ladder (deanonymization). The `decideFuelLadder`/`decidePrivateFuelClaim` calls and their `stop(...)` returns must keep exact order and copy.
2. **Journal-first latching**: every attempt latch (`claimAttempt`, `claimAttemptAt`, `setupInsufficiency:false`) writes BEFORE the wallet call; `claimTxHash` writes at PROPOSED; `consumed` is only ever set inclusion-grade from a receipt probe.
3. **Record-before-signature**: `addRecordVerified` precedes every prompt; the sealed-envelope patch is write-and-verified before any L1 tx; `depositTxHash` persists the moment it exists (chain-recoverability).
4. **Witness field law**: private zeroes `aztecRecipient` (indexed-event leak), `fuelRecipient` = FPC for private / user for public, `swapTarget` bound (F-004), `fuel.received` comes from the EVENT, never the quote.
5. **Cleanup matrix**: explicit user rejection before any tx hash discards the record (with the approve-outcome nuance in copy); ambiguous failures keep it flagged.
6. **Fee ceilings**: fee-juice claims pin `maxFeesPerGas` to predicted-worst (claim dep: NO padding; private fuel path: ×1.5) — the two multipliers are deliberately DIFFERENT; transcribe each with its comment, and PIN both (a padded direct-FJ claim reverts "Amount too low"; an unpadded private claim gets repriced-rejected).
7. **Claim-material conservation** (codex audit): `record.amount` == sealed `envelope.amount` == token claim amount == `amount - fuelSlice`; the private token path stores the RAW salt but L1-commits `hash(deriveTokenClaimSecret(salt, recipient))`; private fuel commits `hash(deriveBridgeSecret(fuelSalt, recipient))` with the FJ routed to the pinned FPC; `bridgeSecretSalt` + `fpc` survive every wholesale `fuel`-object replacement. A drop anywhere here is silent permanent fund loss.
8. **(BUG PIN — preserve verbatim)** Nested `fuel` patches are wholesale replacements (journal patching is shallow), and several callbacks spread a STALE captured `fuel`: the public-fjwc PROPOSED write drops the pre-send `claimAttemptAt`; the direct-FJ `latchFuel` can resurrect a cleared `setupInsufficiency`. This contradicts the clean-latch reading; it is pre-existing, gets characterized with (BUG PIN) tests, is transcribed verbatim, and is reported to the owner as a follow-up fix candidate — NOT silently fixed during extraction.

## Architecture

New sibling module `apps/faucet/src/composables/deposit-flow.ts` (codex: broader name — it owns claim + recovery builders too; module-scope helpers, no Vue reactivity — pure + effect functions taking explicit deps), keeping `useDeposit.ts` as the composable + wiring surface. **State-ownership rule (codex):** `sealKeys`, `fuelOverrides`, journal mutators, receipt probes, and clocks/RNG stay owned where they live today and are passed as explicit deps — never duplicated as second module state, never reached via hidden imports.

### Shared primitives (both monsters + recovery)

- `parseBridgeWithFuelEvent(logs)` → typed `{ tokenKey, tokenIndex, fuelKey, fuelIndex, fuelAmount } | undefined` — replaces 2 inline casts (fueled leg, recoverDepositLeg).
- `bestEffortL2Block()` → `number | undefined` — replaces 2 inline try/catch snapshots.
- `finalizePrivateEnvelope({ id, key, secret, recipient, tokenAmount, from, leafIndex })` — the identical re-seal block from both legs (retained-key path, deletes the key).

### Monster 1: `deposit()` → orchestrator + stage functions

`deposit()` keeps: guards, `busy` latch, record id lifecycle, try/catch/finally shape. Stages extracted (each with its comment block):

1. `coldAccountPreflight(aztec, recipient)` → `"blocked" | "proceed"` (no-fuel cold-check; read-failure = proceed).
2. `prepareFuelSlice({ l1, amount, fuelSlice, isPrivate, recipient })` → `fuelPre | undefined` (quote gate + secret derivation; L3/L4 comment).
3. `buildDepositRecord({ ... })` → `DepositJournalRecord` (schema 1/2 shape, fuel sub-object law).
4. `sealPrivateRecord({ ... })` — trust-aware seal + write-and-verify (throws to abort pre-tx).
5. `ensurePermit2Approval` — hoisted from inline closure to module scope with `{ l1, wallet, from }` deps (body verbatim).
6. `runFueledDepositLeg({ ... })` — witness build → typed-data sign → `bridgeWithFuel` → receipt → event parse → fuel record update → finalize envelope → `runDepositClaim`.
7. `runPlainDepositLeg({ ... })` — router `bridge()` mirror of 6.
8. `handleDepositFailure(e, id, error, journal)` — the cleanup matrix catch body (mirrors batch C's `handleWithdrawFailure` shape).

Expected post-split scores: orchestrator ≤ 12; each leg ≤ 12 and ≤ 80 lines (the legs are long but linear; if a leg still trips the line cap, split its witness-build into `buildFueledWitness(...)` / `buildPlainWitness(...)` — pure, unit-testable).

### Monster 2: journal `claim` dep → dispatcher + per-ladder builders

`claim` keeps: the 4-way dispatch skeleton. Extracted:

1. `buildFeeJuiceClaimDep(rec, envelope, secretHex, { aztec, latchFuel })` — the fee-juice branch (predicted-worst NO-padding comment).
2. `buildPrivateFuelClaim({ rec, fuel, bridge, recipientAddr, amount, secret, leaf, aztec })` — the whole L11 private path incl. its decision, kill-switch, floor, and the send's journal-first latch + insufficiency catch.
3. `resolvePublicClaimFee(...)` → strict discriminated result `{ kind: "stop"; why } | { kind: "no-fuel" } | { kind: "fjwc"; fee } | { kind: "sponsored-standalone" }` (codex: no optional-fee-plus-booleans shape — impossible combinations must be unconstructible), with the no-fuel balance gate as its own named `gateNoFuelClaim(...)`.
4. `buildTokenClaimInteraction({ ... })` — the final simulate/send pair (latch ordering + standalone fire-and-forget verbatim).
5. `recoverDepositLeg` hoisted to a named module function (uses `parseBridgeWithFuelEvent`; schema-2 fail-closed comment intact).

`ensureDepositJournalDeps` then wires named functions — under both caps.

## Equivalence test plan (two layers, both inline with the change)

**Layer 1 — pre-extraction characterization traces (the equivalence proof).** Committed FIRST, against the CURRENT code, then kept byte-identical over the decomposition. `useDeposit.characterization.test.ts` drives the real `useDepositFlow().deposit()` AND the real `connectJournalDeps` wiring over full fakes (viem clients, wallet, aztec, journal storage, clock/RNG seeded), recording exact call order + exact values for: record construction, sealing, Permit2 approval, typed-data input, contract calldata, journal patches (every intermediate `fuel` object — the stale-spread BUG PIN lives here), receipt handling, final sealing, claim handoff. Four token modes: public/plain, private/plain, public/fueled, private/fueled — plus the direct fee-juice claim dep (public + private) since `useFuel` consumes it.

**Layer 2 — post-extraction specification pins** (`deposit-flow.test.ts`):

1. **Witness + calldata vs INPUT semantics**: fields compared against the original inputs (not just witness==calldata — a consistent wrong value passes that): private fueled zeroes `aztecRecipient`, `fuelRecipient` = FPC; public = user; plain leg zeroes all fuel fields; `swapTarget` bound; amounts follow the `amount - fuelSlice` law.
2. **Secret-derivation pins**: private token commits `hash(deriveTokenClaimSecret(salt, recipient))` while persisting the RAW salt; private fuel commits `hash(deriveBridgeSecret(fuelSalt, recipient))`; `bridgeSecretSalt`+`fpc` survive the post-event `fuel` replacement.
3. **Both fee-multiplier pins**: direct-FJ claim = raw predicted-worst; private fueled claim = exactly ×1.5.
4. **Latch-order pins for EVERY ladder**: private-fuel, public fjwc, direct-FJ callbacks, standalone — journal-first attempt, PROPOSED-hash-only, `consumed` never set pre-inclusion, insufficiency-only `setupInsufficiency`, rethrow otherwise.
5. **L11 fence, all decisions**: `private-incomplete`, `wait`, `consumed`, FPC drift, floor failure — each yields a fail-stop; no private-fuel decision can construct a public/sponsored/standalone fee.
6. **`recoverDepositLeg` branch matrix**: pending receipt, reverted, direct FJ, fueled router event, schema-2 fail-stop, plain Inbox fallback, absent/unrecognized event.
7. **Leg trace pins**: send → journal tx hash (hash-before-wait) → receipt wait → event patch → final seal → clear step → `runDepositClaim`; seal-before-L1 (the sealed-envelope write + readback precede any IRREVERSIBLE L1 transaction — sealing itself prompts for signatures, so the fence is on the tx, not on prompts).
8. **Re-seal pin**: key deleted only after seal+patch succeed; retained when either throws.
9. **Cleanup-matrix pin**: rejection with no `depositTxHash` discards (approve-nuance copy); rejection after hash flags.
10. **`parseBridgeWithFuelEvent`**: encoded-log fixture round-trip + absent-event undefined.

Existing suites that must stay green: `fuel-claim-state` (51), `fuelClaim`, `useBridgeJournal` (60), `BridgeForm*`. **`permit-deadline.test.ts` scans `useDeposit.ts` for exactly 2 deadline sites — its site map is updated in the same commit that moves the signing sites** (never weakened: the count moves with the code, staying exact).

**Network validation**: no CI network gate exercises the faucet deposit (`apps/faucet/**` is outside the network filter; the faucet jsdom smoke mocks this composable). The candidate smoke scripts rehearse bridge-core, NOT this composable — they prove the protocol is live, not this diff. Residual risk is transcription error, mitigated by the characterization traces + codex adversarial pass; a faucet-driven live rehearsal remains the operator-level gate before any production deploy.

**Rollback (narrowed per codex)**: a squash revert stops NEW bad attempts; it cannot undo L1 deposits/approvals or repair records a faulty build failed to persist. The characterization traces double as record-parity evidence: the decomposed code persists the SAME fields at every failure point, so records it emits remain resumable by pre-change recovery code (no schema or API change; all current exports unchanged).

## Security & Adversarial Considerations

- The witness and secret-derivation blocks are the theft/strand surface: transcription drops here are fund-loss bugs. Both get field-by-field pins (tests 1) and the codex audit is asked to diff-check them token-by-token.
- The L11 fence and the never-re-mint private decisions are deanonymization/double-spend guards — pinned (test 3) and carried with their comments.
- Plaintext-safety commentary (fuel secret claimer-committed; sealed envelope carries only the token salt) moves verbatim; no new logging of secrets/salts (log-payload-ban covers the file already).
- No new trust boundaries introduced; helpers take already-validated values.

## Decision ledger (dual positions reconciled — codex session 01a05afa-4079-7f61-8dba-1ac150eb309c)

1. **Module split**: both positions independently YES — sibling module, renamed `deposit-flow.ts` (codex: it owns claims + recovery too) with the explicit state-ownership rule above.
2. **Leg granularity**: both independently TWO mirrored legs (one parameterized leg would admit invalid combinations; the amount law, witness shape, and tails genuinely differ) — only small pure primitives shared.
3. **Claim dispatcher**: both independently FOUR named builders; codex's refinement adopted — `resolvePublicClaimFee` returns a strict discriminated union, no optional-fee-plus-booleans.
4. **Codex conditional-approve conditions, all folded**: 6-directive scope (158→152); pre-extraction characterization traces as the equivalence mechanism; secret-derivation + conservation + dual fee-multiplier + ordering pins; full recovery/ladder branch matrices; permit-deadline scan relocation; stale-`fuel` overwrite bug-pinned verbatim (owner follow-up, never silently fixed); rollback claim narrowed.

## Delivery

Single PR into the base branch (arc 4 PR 1 of 3): `refactor(faucet): decompose useDeposit — deposit legs + claim ladder under budget (158→152)` (count re-stated after rebase). Sequence: characterization traces commit FIRST (green on current code) → decomposition commits (traces untouched, still green) → spec pins. Post-implementation codex loop (same session): round 1 fix-first with six test-strengthening findings (raw commitment-id asserts, sponsored-arm pins, wait sendWhy, journal-write re-seal retention, typed-data domain/types pins, envelope decryption round-trip) — all applied; round 2: "No new material findings; all six proof gaps are substantively closed. Verdict: approve." The production transcription itself was judged behavior-equivalent in round 1.
