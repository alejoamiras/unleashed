## Outcome

Archived. Seeds retired.

# Bridge form-stepper round (third UX amendment)

Blueprint tier: `mid`. Continues the bridge-ux-trust arc, still unmerged. Substrate: the journal engine + narration (`useBridgeJournal` runtime `step`/`stepDetail`), the flows (`useDepositFlow`/`useWithdrawFlow`), `BridgeForm`/`BridgeJournal`/`BridgeJournalCard`, and the wallet panels.

Driving feedback (user, testnet session) + Phase-0 decisions:
1. The actively-driven transaction must NOT appear as a Pending card — cards are for lost-track/reloaded records. The FORM guides the user through what's happening and what they're signing.
2. The form becomes a 3-step guided flow: form → live phase stepper → receipt with both explorer links. **Decided: the stepper TAKES OVER the form until the receipt; a "RUN IN BACKGROUND" action hands the bridge to a Pending card and frees the form. The receipt STAYS until "NEW BRIDGE".**
3. Ethereum + Aztec wallet connections share ONE row as compact chips with ✕-to-disconnect.
4. "IN-FLIGHT BRIDGES" renamed (user floated "Pending Transactions"; copy finalized below).

## Design decisions

### D1 — Foreground ownership: UI-owned CAS token + the cleanup matrix
`activeFlowId = ref<string | null>(null)` is **UI/SESSION-owned, never flow-owned** (final-codex CRITICAL: the engine DETACHES later receipt rounds via fire-and-forget re-entry, so a flow's `finally` fires before the bridge truly completes — a blind finally-clear would yank the stepper mid-watch, or bridge A's stale finally would clear bridge B's ownership). API on the journal module:
- `claimForeground(id)` — set by the FORM at submit (the flow returns the record id synchronously after record creation).
- `releaseForeground(id)` — **compare-and-swap**: no-ops unless `activeFlowId === id`. Called by the form on NEW BRIDGE / RUN IN BACKGROUND / the clean-reject path. The flow promise settling does NOT end ownership — the stepper's form→receipt transition is driven by the RECORD's `completedAt` (via the mapper), not by the promise.
- **In-memory only** — a reload clears it; the record surfaces as a Pending card. `BridgeJournal` renders `visibleRecords` minus the active id. Backgrounding never pauses the flow; only the narration surface moves.
- **Foreground ownership ≠ flow running**: the form's takeover binds to `activeFlowId` presence — NOT the flows' `busy`. The flows' `busy`/`error` demote to pre-record validation.
- **Cleanup matrix** (deposits create their record BEFORE approve/deposit; "clean reject" is classified ONLY by explicit provider rejection — EIP-1193 code `4001` / viem `UserRejectedRequestError` — via a tested `isUserRejection(err)`; final-codex HIGH: "no tx hash yet" alone over-classifies — ambiguous RPC/wallet failures must keep the record):
  | Failure point | Record | activeFlowId | Surface |
  |---|---|---|---|
  | Seal sign rejected (record not yet created) | none | released (CAS) | form + inline error |
  | EXPLICIT user rejection (`isUserRejection`) of approve/deposit/exit, NO tx hash | **discarded** | released (CAS) | form + inline error |
  | AMBIGUOUS pre-hash failure (RPC error, wallet crash, anything non-4001) | **kept** | kept — ✕ phase + note + background/discard offered | stepper |
  | Any failure AFTER a tx hash exists | kept, never auto-discarded | kept — ✕ phase + per-phase retry routing | stepper (or card after background) |
  | Reload at any point | kept | gone (in-memory) | card (the structural fail-open) |

### D2 — ONE narration channel: flow legs write into the per-record journal runtime
(Codex CRITICAL-1 + HIGH-1 + HIGH-2 convergent fold — replaces the draft's separate `flowStep` ref.) The runtime `step` union extends with the flow legs: `sealing | approving | depositing | exiting` (still ephemeral display state, never persisted, never an input to engine logic). The flows replace their console-only leg narration with an exported `setRecordStep(id, step, detail?)` writing into the SAME per-record runtime the engine uses. Consequences:
- **One source of truth**: a single tested mapper — `lib/bridge-steps.ts: stepperPhases(record, runtime)` → `{ key, label, prompt, state }[]` — feeds BOTH the stepper and (in compact form) the cards. No dual flowStep/runtime drift.
- **Backgrounding is safe at ANY moment, including mid-wallet-prompt**: the card can narrate `sealing — sign in your Ethereum wallet` from the same runtime (the draft's card couldn't see L1 legs at all).
- **Concurrency just works**: narration is keyed by record id; the foreground stepper reads `runtime[activeFlowId]`, backgrounded cards read theirs.
The stepper maps the phase list (each phase: pending ▢ / active ● (pulsing) / done ✓ / skipped ⊘ / failed ✕):

- Deposit: `SEAL` (private only — "sign in your Ethereum wallet; first time signs twice") → `APPROVE` ("confirm the allowance" — rendered ⊘ SKIPPED when the allowance suffices) → `DEPOSIT` ("confirm the deposit; then waiting for Ethereum") → `SYNC` (engine `syncing`, poll detail) → `CLAIM` (engine `sending` — "confirm in your Aztec wallet"; private resumes show `unsealing` first) → `CONFIRM` (engine `confirming` + `verifying`, check counts).
- Withdraw: `EXIT` ("confirm in your Aztec wallet" — public shows "2 signatures: authorization + exit") → `PROVE` (the proven-block countdown from runtime) → `FINISH` (engine `confirming` pre-consume — "confirm in your Ethereum wallet") → `CONFIRM` (receipt wait).
- **Monotonic phase latch** (fable MEDIUM-3): `withRecordLock`'s finally clears `step` on EVERY lock exit — including between chunked receipt rounds — so a live-step-driven stepper would flicker CONFIRM→blank→CONFIRM. The mapper derives phase STATES primarily from RECORD FACTS (depositTxHash/leafIndex/claimTxHash/consumeTxHash/completedAt — the `deriveDepositStage` pattern); runtime steps only select WHICH fact-bounded phase is "active" and its prompt text. A cleared step between rounds therefore cannot regress a phase. Pinned with a between-rounds test.
- **The skipped/done gap one scalar can't carry** (final-codex HIGH): once runtime advances past APPROVE, `(record, step)` cannot distinguish "APPROVE skipped" from "APPROVE completed" — no persisted fact records it. `RecordRuntime` gains an ephemeral `approveOutcome?: "skipped" | "done"` written by the deposit flow at the allowance decision (runtime-only, never persisted, display-only); the mapper renders ⊘ vs ✓ from it, and `undefined` (e.g. post-reload) renders the phase as plain done-by-implication with no badge — honest degradation.
- Step 3 (receipt): ✓ headline, amount + direction, BOTH explorer links. **The receipt SNAPSHOTS its data (direction, amount, both tx hashes) into component state at the stepper→receipt transition** (fable MEDIUM-2 — reading live by id can blank mid-display on a cross-tab discard, and `lastCompleted` carries only one hash). "NEW BRIDGE" resets to step 1.
- Errors while active: the stepper marks the failed phase ✕ with the engine note + **per-phase RETRY routing** (fable HIGH-3): engine phases (SYNC/CLAIM/CONFIRM) retry via `runDepositClaim`/`runWithdrawConsume`; flow-leg phases (SEAL/APPROVE/DEPOSIT/EXIT) follow the D1 cleanup matrix — clean prompt rejections discard + reset to the form (deposits gain the same clean-reject discard withdraws already have — public deposits create their record BEFORE any prompt, so this closes their lingering-record hole too); post-tx failures keep the record with honest "background it or discard" copy (no fake RETRY on phases the engine cannot re-drive).

### D3 — One wallet row: chips with ✕
`BridgeView`'s `.wallets` becomes a flex ROW hosting both existing components restyled as compact chips (the components keep ALL their logic — connect, chain-switch, the Aztec verification modal):
- Connected: `[ETHEREUM · 0xef4d…f2d ✕]` / `[AZTEC · 0x1018…c0d ✕]` — the ✕ is the disconnect (testids `l1Disconnect`/`bridgeL2Disconnect` move onto it; `aria-label="Disconnect"`).
- Disconnected: the chip renders its connect button (`CONNECT ETHEREUM` / `CONNECT AZTEC`); wrong-chain keeps the switch affordance inside the L1 chip.
- The Aztec panel's INTERMEDIATE states (setting-up / capability-approval / error) render as a wider status chip with the existing copy — the chip grows, the row wraps; the VerificationModal overlays as today (fable MINOR-a).
- Narrow viewports wrap to two rows naturally (flex-wrap).

### D4 — Rename + copy
- Section heading: **"PENDING BRIDGES"** (more precise than "Pending Transactions" — each card is a multi-transaction bridge), sub-line: "Bridges this browser started but isn't actively driving. Resume, finish, or discard them." Empty state: "Nothing pending."
- The stepper's phase labels + prompts are part of the copy review surface (frontend addendum). All existing card copy unchanged.

## Phases

### P1 — Runtime narration channel + suppression + mapper ✓
Files: `useBridgeJournal.ts` (`BridgeStep` union += `sealing | approving | depositing | exiting`; `RecordRuntime.approveOutcome`; exports `setRecordStep(id, step, detail?)`, `claimForeground(id)`/`releaseForeground(id)` (CAS) + `activeFlowId`; `visibleRecords` additionally excludes the active id for NON-completed records); `useDeposit.ts`/`useWithdraw.ts` (legs call `setRecordStep`; the flows return the record id at creation; the D1 matrix with the `isUserRejection` classifier — NEW `lib/wallet-errors.ts` (EIP-1193 4001 + `UserRejectedRequestError`, tested); flows NEVER touch foreground state); NEW `lib/bridge-steps.ts` (`stepperPhases(record, runtime)` — the single mapper, monotonic latch on record facts, `approveOutcome` consumption); tests.
Testing strategy (fable MEDIUM-4 — no flow tests exist and the flows call wallet singletons directly): the MAPPER carries the proof weight (pure unit tests over fact/runtime matrices, incl. the between-rounds no-flicker pin: step cleared + facts unchanged ⇒ phases unchanged); flow-level behavior (leg ordering, clean-reject discard, matrix rows) via a `vi.mock` harness over `useL1Wallet`/`useBridgeWallet` — NOT "existing fakes" (none exist).
Smallest proof: suppression in/out (claim → hidden from journal; release/background → visible; reload-sim → visible); CAS pins (releaseForeground with a stale id no-ops; a second claimForeground takes over; a settled flow promise does NOT release); `isUserRejection` matrix (4001 ⇒ true; UserRejectedRequestError ⇒ true; RPC/network errors ⇒ false); mapper matrices per direction (pending/active/done/skipped/failed; `approveOutcome` ⊘/✓/undefined honest-degradation; engine steps select the active phase; cleared-step-between-rounds regression pin); EXPLICIT rejection pre-hash ⇒ record discarded (deposit AND withdraw); AMBIGUOUS pre-hash failure ⇒ record kept; post-tx failure ⇒ record kept.
Validate: `bun run --cwd packages/faucet test && bun run --cwd packages/faucet typecheck && bun run lint`.

### P2 — Stepper + receipt in BridgeForm ✓
Files: `BridgeForm.vue` (the `formStage: form | stepper | receipt` machine — **all form gating re-keys to `formStage`, never flow `busy`** (fable HIGH-1); new `BridgeStepper.vue` + `BridgeReceipt.vue` children), `testids.ts` (`stepper`, `stepperPhase` (+`data-phase`/`data-state`), `stepperBackground`, `stepperRetry`, `receipt`, `receiptNewBridge`, `receiptLink`), component tests.
Smallest proof: submit flips form→stepper and the journal hides the active record (mock journal); phases render from the MAPPER (mock it — the matrices live in P1); RUN IN BACKGROUND clears `activeFlowId` ⇒ card appears AND the form is immediately interactive (the HIGH-1 pin); receipt SNAPSHOT: populated at transition, survives the record being discarded cross-tab; NEW BRIDGE resets; ✕ phase shows per-phase retry routing (engine phase ⇒ engine action invoked; flow phase post-tx ⇒ no retry button, background/discard copy); the one-surface invariant pinned FOR NON-COMPLETED records (stepper xor card), plus both completed behaviors pinned explicitly: completion under the form ⇒ receipt + no card; reload-during-receipt ⇒ ✓ card visible (runtime `hidden` is gone after reload — fable MEDIUM-1).
Validate: P1 commands + `bun run --cwd packages/faucet test:e2e` (smoke extended: submit → no card while driving → background → card appears + form usable).

### P3 — Wallet chips row + rename + gates ✓
Files: `L1WalletPanel.vue`, `BridgeWalletPanel.vue` (chip restyle, ✕ disconnect, logic untouched), `BridgeView.vue` (`.wallets` row), `BridgeJournal.vue` (heading/sub/empty copy), tests updated.
Smallest proof: chips render address + ✕ when connected (✕ fires disconnect with the existing testids); connect buttons when disconnected; wrong-chain switch still reachable; journal heading/empty copy pins.
Gates: `bun run audit:faucet` + `bun run audit:vue` → `/code-review max --fix` (separate commit) → codex post-impl audit → manual checklist.

### NEEDS MANUAL TEST (testnet, signature-gated)
1. Deposit (private, first-time wallet): the stepper narrates SEAL (×2 signs) → APPROVE → DEPOSIT → SYNC → CLAIM → CONFIRM → receipt with both links; NO Pending card at any point; NEW BRIDGE resets.
2. Repeat deposit: SEAL shows one signature; APPROVE shows SKIPPED when allowance remains.
3. RUN IN BACKGROUND mid-SYNC: the stepper yields, the card appears claiming/syncing and keeps narrating; the form is immediately usable for a second bridge.
4. Reload mid-SYNC: form returns empty; the bridge appears as a Pending card — resume from there. Reload mid-DEPOSIT (pre-receipt): the card appears at `depositing` with honest no-action copy (the engine cannot drive a leafIndex-less record — discard-only unless the deposit tx later lands).
5. Withdraw (public + private): EXIT → PROVE (countdown) → FINISH → CONFIRM → receipt; backgrounding during PROVE hands the countdown to the card.
6. Wallet chips: both on one row; ✕ disconnects each side; Aztec reconnect runs the verification modal; wrong-chain switch works from the chip.

## Decision ledger
| # | Decision | Source | Rejected / notes |
|---|---|---|---|
| S1 | `activeFlowId` (in-memory) + journal suppression; reload/background = the record surfaces as a card | main + user model | persisting the active id — rejected: reload MUST surface the card (the user's exact ask) |
| S2 | Stepper takeover + RUN IN BACKGROUND handoff; receipt stays until NEW BRIDGE | user (Phase 0) | concurrent in-form submissions; hard block; auto-return receipt |
| S3 | Flow legs narrate into the PER-RECORD journal runtime (`BridgeStep` extended; `setRecordStep` export); ONE tested mapper feeds stepper + cards | codex CRITICAL-1/HIGH-1/HIGH-2 + fable HIGH-2 (overruling main's draft) | main's separate `flowStep` ref — rejected: dual source of truth, singleton refs break concurrency, cards blind to L1 legs (backgrounding mid-prompt unsafe) |
| S7 | Form gating re-keyed to `formStage`, never flow `busy` | codex CRITICAL-1 + fable HIGH-1 | busy-gating — RUN IN BACKGROUND would be a no-op (busy spans the whole bridge) |
| S8 | Cleanup matrix: explicit user rejections discard pre-tx records (deposits gain parity with withdraws); post-tx never auto-discards; reload is the structural fail-open (S13 owns foreground lifecycle) | codex CRITICAL-2 + fable HIGH-3, narrowed by S14 | the draft's "no record lingers" claim — was FALSE for approve rejections and public deposits |
| S9 | Per-phase RETRY routing; no fake retry on undriveable flow phases | fable HIGH-3 | blanket "RETRY re-invokes the engine action" |
| S10 | Monotonic phase latch: states from record facts, runtime selects the active phase | fable MEDIUM-3 | live-step-driven states — flicker between chunked rounds |
| S11 | Receipt snapshots its data at the stepper→receipt transition | fable MEDIUM-2 | live read by id — cross-tab discard blanks it; `lastCompleted` has one hash |
| S12 | One-surface invariant scoped to NON-completed records; completed: receipt-no-card under the form, ✓ card after reload | fable MEDIUM-1 | the over-strong "always exactly one surface" |
| S13 | `activeFlowId` is UI-owned with CAS claim/release; flow promises never end ownership (the engine detaches receipt rounds) | final codex CRITICAL (revising S1) | flow-finally clears — race-prone + too short-lived |
| S14 | Clean-reject = EXPLICIT provider rejection only (`isUserRejection`: 4001 / UserRejectedRequestError); ambiguous pre-hash failures keep the record | final codex HIGH (narrowing S8) | "no tx hash yet" as the discard trigger — auto-discards ambiguous records |
| S15 | Ephemeral `approveOutcome` runtime bit carries skipped-vs-done; undefined degrades honestly | final codex HIGH (widening S3) | deriving it from `(record, step)` — impossible once runtime advances |
| S4 | Keep both wallet panel components, restyle as chips (logic untouched) | main | a merged single component — rejected: the Aztec panel owns the verification modal lifecycle; merging multiplies risk for zero UX gain |
| S5 | "PENDING BRIDGES" heading | main (user delegated) | "Pending Transactions" — each card is a multi-tx bridge; "transactions" undercounts |
| S6 | Stepper/receipt as child components if size demands; testids per phase with `data-phase`/`data-state` | main | — |

## Security & Adversarial Considerations
- No engine/trust changes: `activeFlowId` and `flowStep` are display-routing state — never inputs to completion, hiding-from-the-journal does not alter record lifecycle (the engine drives identically whether the stepper or a card renders it).
- The suppression must fail OPEN: ownership is UI-owned CAS (S13) — the form releases on its explicit paths, ambiguous failures keep the record VISIBLE in the stepper (never surfaceless), and a reload structurally clears the in-memory owner (card appears). P2 pin: a NON-COMPLETED record is visible in exactly one surface (stepper xor card); completed records follow S12 (receipt-no-card under the form; ✓ card after a reload — runtime `hidden` doesn't survive reloads by design).
- Receipt links reuse the strict-hash helpers (no new URL surface). Chips render addresses via the existing `AddressDisplay` (no truncation-spoofing change).
- Copy: signing prompts must say WHICH wallet signs WHAT (anti-blind-signing, consistent with the seal-note pattern); the APPROVE phase must not imply value transfer ("allowance for the bridge portal").
- No new deps; no storage schema change.

## Assumptions
**Facts (verified):** flows expose only `busy`/`error` (`useDeposit.ts` `useDepositFlow` return); the L1 legs live in the flows and narrate via console only; engine runtime `step`/`stepDetail` exists and feeds the cards (`useBridgeJournal.ts`); `visibleRecords` filters `hidden`; both wallet panels are self-contained (~94/138 lines) with disconnect buttons + testids (`L1WalletPanel.vue:24`, `BridgeWalletPanel.vue:49`) and the Aztec one owns `VerificationModal`; the journal heading lives in `BridgeJournal.vue`; allowance-skip exists in the deposit flow (logged, not surfaced).
**Inferences (attackable):** backgrounding mid-prompt is safe — the flow runs detached, the popup resolves into the journal regardless of surface, AND the card can now narrate the open prompt (S3 runtime channel); the chip restyle doesn't disturb the VerificationModal (it's a teleported overlay, not row-layout-dependent — verify in P3).
**Corrected by audit:** ~~"existing flow fakes can drive flowStep tests"~~ — NO flow tests exist (`BridgeForm.test.ts` mocks the flows wholesale) and the flows call wallet singletons directly; the mapper carries the proof weight, flows get a `vi.mock` harness (P1 testing strategy).
**Asks:** resolved at Phase 0 — takeover+background ✓, receipt-stays ✓. None open.

## Out of scope
Swap (next arc); engine/trust model; storage schema; CSP pass; Playwright real-browser flows.

## Approval
**USER VERDICT: APPROVE** (gate, this session) — scope as written incl. the PENDING BRIDGES rename. Seeds finalized; implementation begins at P1.

## Audit verdicts
- Dual audit (parallel, both outlines):
  - **codex: conditional approve** (split detached-run state from busy; explicit cleanup/fail-open matrix; one tested step-mapper; pin mid-prompt background + receipt sourcing) — ALL folded (S3, S7, S8, plus the D2 rewrite).
  - **fable: conditional approve** (form re-gating off busy; per-record step/error keying; per-phase RETRY routing + deposit clean-reject parity; invariant rescope + reload-during-receipt pin; receipt snapshot; monotonic phase latch + between-rounds pin; testing strategy reframe) — ALL folded (S7–S12, P1/P2 rewrites). Outline: dedicated stepper, unanimous.
- Final fresh-context codex pass (new session): initial **reject** — 3 blocking findings (flow-owned activeFlowId race; over-broad clean-reject; underivable approve skipped-vs-done), ALL folded same-round as S13/S14/S15 (UI-owned CAS foreground; `isUserRejection` classifier; `approveOutcome` runtime bit). Verdict-flip resume: **conditional approve** — condition (stale flow-finally wording) scrubbed same-commit; one ownership rule throughout. Gate-ready.

## Seeds
`/goal` recommended (transcript-observable completion); `/loop 15m` fallback. Finalized post-approval.

---

## Competing outline (alternative angle: reuse the card AS the stepper)
Instead of a dedicated stepper, the form's step 2 mounts `BridgeJournalCard` for the active record (suppressed from the journal list, rendered in the form area), extended with a phase rail. Pros: one narration component, less new UI. Cons: the card is status-shaped, not flow-guiding (no upcoming-phases preview, no "what you'll sign next"), its actions (DISCARD/CLEAR) are wrong mid-takeover and need conditional surgery, and the form-level L1 legs (seal/approve/deposit) still need flow-step plumbing ANYWAY — so the savings are one template at the cost of overloading a component that two rounds of feedback shaped for a different job. Both outlines go to the auditors; main recommends the primary.
