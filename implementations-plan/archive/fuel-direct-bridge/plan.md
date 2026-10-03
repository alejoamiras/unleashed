## Outcome

Archived. Seeds retired.

# Fuel — direct L1 fee-asset → L2 Fee Juice bridge

**Tier:** `/blueprint deep` (3 parallel plans → consolidate → contradiction-check + double audit → final codex pass).
**Status:** ✅ APPROVED — all five open decisions resolved at their recommended defaults (A: pin + `UNDERLYING()` hard-block · B: private live-deferred, acknowledged · C: shared journal · D: $AZTEC/Fee Juice copy · E: no migration). Final codex = conditional approve (condition applied). Ready to implement; awaiting the user's go to start the `/loop`.
**Plan dir:** `implementations-plan/archive/fuel-direct-bridge/`

## 1. Summary

A third faucet flow — **Fuel** — that bridges the L1 fee asset ($AZTEC / the Fee-Juice token) **directly** to L2 **Fee Juice**, no swap, no token leg, public or private. It reads the user's L1 fee-asset balance, deposits into the **canonical** rollup `FeeJuicePortal`, and claims the result on L2 as gas. It is the naive sibling of the existing "Bridge + Swap for Fee Juice" fuel add-on and reuses that machinery (journal engine, sync gate, fee-juice payment wrappers, the Wonderland private-FPC crypto) wherever sound.

The direct path is **less coupled** to the forked-Uniswap-V4 swap stack than the existing bridge: it needs only the canonical `FeeJuicePortal` + the L1 fee asset, sourced from the node — not the `BRIDGE_FUEL` config.

## 2. Goal / success criteria

**Done =** a user with an L1 fee-asset balance can, in a new **Fuel** tab, enter an amount, pick public or private, and bridge it to L2 Fee Juice; the flow persists/recovers like the bridge; both paths are implemented to full parity (locked decision 2) and pass all local gates; the public path is locally end-to-end-verifiable; the **private path's live correctness is deferred to live sign-off** (locked decision 1) with its dominant risk (I2, §8) explicitly flagged.

Measurable: all local gates green (typecheck/lint/unit/component/smoke-e2e); a Fuel smoke-e2e drives a mocked public happy-path to `done` and rejects a sub-floor private amount; an App-level multi-tab smoke proves a single foreground owner across Bridge↔Fuel; `/harden security` on the diff returns no unaddressed High/Critical.

## 3. Scope

**In:** Fuel tab/view/form; L1 fee-asset balance reader; direct `FeeJuicePortal.depositToAztecPublic` deposit; public claim (`claim_and_end_setup`, sponsored) + private claim (carrierless embedded-FPC payload); journal/engine generalization to carry a fee-juice asset variant; the shared-foreground-shell refactor that makes a third view safe; harden + docs.

**Out:** no FeeAssetHandler mint affordance (assume held); no new L1/L2 contract deploy; no reverse direction (FJ is consumed as gas, never bridged back); no live-network validation (locked decision 1); no swap. **Not a scope lever:** private fuel is NOT droppable to "documented-blocked" in this plan — locked decision 2 fixed "both, full parity." The "what if the carrierless claim is rejected live" decision is a **future follow-up gated on live sign-off**, explicitly out of this plan.

## 4. Locked decisions (user-answered; do not re-litigate)

1. **Validation reach = LOCAL GATES ONLY.** typecheck + lint + unit + component + smoke-e2e (jsdom mock wallet). No live L1↔L2 (no L1↔L2 sandbox; per the user's out-of-band note the V4 testnet has halted for a V5 migration). Live sign-off is a deferred follow-up.
2. **Public + private BOTH, full parity.** The `amount >= max_gas_cost` self-pay floor is an in-plan item; not a reason to drop private.
3. **Assume the L1 fee asset is already held.** Read balance + bridge; no mint affordance.
4. **Quality bar = Production.** `/harden security` on the new flow is in-plan (Phase 5).

## 5. Design resolution

### DQ1 — private standalone claim → **carrierless raw embedded-FPC payload** (live correctness deferred; this is the dominant risk)

L1 half = identical to public: `FeeJuicePortal.depositToAztecPublic(to, amount, secretHash)` with `to = PRIVATE_FPC_ADDRESS` and `secretHash = privateFuelSecretHash(salt, claimer)` (the `FeeJuicePortal` has **no** `depositToAztecPrivate`; privacy is purely an L2-claim concern). L2 half = `privateMintAndPayFee(fpc, received, deriveBridgeSecret(salt, claimer), salt, leaf)`, whose `getExecutionPayload()` bundles `FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee` as **setup**, sets `feePayer = FPC`, and credits `(amount − max_gas_cost)` to `msg_sender` (a prepaid private-gas reserve at the FPC). The existing bridge uses `bridge.claim_private` as the carrier app-call; a fuel-only flow has none.

**Resolution:** send the Wonderland fee payload as the tx body with **no app call** — a carrierless raw `ExecutionPayload` (e.g. `BatchCall(wallet, [])` → `mergeExecutionPayloads([feePayload])`, or `wallet.sendTx` with the raw payload). Rejected: a no-op carrier call (the `FeeJuice` contract has no benign private no-op that doesn't fight the fee method for the same message); a deferred gas-reserve UX (breaks parity); a public downgrade (deanonymizes — forbidden).

**The dominant risk (I2 — HIGH, locally unprovable).** Precisely scoped: the **app phase is empty** (zero app calls). The setup phase IS populated (the two FPC calls) and those calls are proven-good as setup (the existing private bridge claim uses exactly them), so this is NOT the empty-*setup* failure that `useFaucetDrip.ts:63-67` documents ("rejected by the sequencer as 'Setup function not on allow list'") — that comment is an *adjacent* cautionary precedent, not a direct match. What is uncharted: whether the wallet's simulate/prove/**sequencer** accepts an **empty-app** tx. The wallet assumes app calls follow the fee prefix. No repo artifact exercises this shape, and there is no local sequencer (jsdom), so **no local gate can retire I2**. Per locked decision 1 the whole feature's live correctness is deferred; private simply carries the larger share of that deferred risk.

**Self-pay floor** (`amount >= max_gas_cost`): reuse the calibrated floor + `teardownGasLimits = {daGas:0,l2Gas:0}` + explicit `maxFeesPerGas` (the wallet's proven embedded-fpc path). **Re-home the floor as a MANDATORY config value with a hard, fail-CLOSED guard** (see Phase 0 / B3).

### DQ2 — record/flow/journal shape → **additive `assetKind` field (envelope schema stays 1) + generalize the deployment-bound consumers**

Keep `direction: "deposit"`. Add `assetKind: "bridge-token" | "fee-juice"` as an **additive optional record field** (absent ⇒ `"bridge-token"`). **Do NOT bump the storage-envelope schema** — `parseRecords` hard-checks `parsed.schema !== 1` (`journal.ts:145`) and `write()` fixes it at 1 (`:176`); an envelope bump would **silently drop every existing persisted record** (including an in-flight private deposit's sole sealed recovery blob → fund stranding). The per-record `schema: 1|2` field is **not read by the loader**, so a record-level bump protects nothing — drop that rationale entirely. Reject `direction:"fuel"` (too invasive — `runDepositClaim` filters `direction === "deposit"`).

**The real safety boundary is the deployment binding, not a schema number.** A fee-juice record's `portal` = the canonical FeeJuicePortal ≠ the token `L1_PORTAL`, so `deploymentMatches` already distinguishes them. Generalize the deployment-bound consumers to branch on `assetKind`:
- `deploymentMatches` (`useBridgeJournal.ts:273`), backup restore/export (`useBridgeBackup.ts:116`), and recovery-key derivation (`recovery-crypto.ts:27` binds `portal + bridge`) — today all token-bridge-hardcoded; they would wrongly quarantine/reject a fuel record.
- **Fuel record deployment binding (specified, not an ask):** `{ chainId, portal: <canonical FeeJuicePortal>, bridge: <L2 FeeJuice protocol-constant address> }`. Stable, distinct from the token bridge, meaningful (the L2 target). Recovery-key/backup-header/`deploymentMatches` use this when `assetKind === "fee-juice"`.
- `runDepositClaim` resolves claim material **by variant** (not bare `secretHex`); receipt snapshot, phase rail, toasts branch on `assetKind`.

**Residual:** an *older* faucet build (downgrade) would read a fee-juice record as a token deposit (the loader doesn't gate per-record schema). Low-severity testnet concern; not retroactively fixable; documented, not a blocker. A real compatibility boundary would require an envelope/key migration — see the migration-policy ask (§8). Recommendation: do not pay that cost.

**Phases of a fuel record:** `APPROVE → DEPOSIT → CROSSING → CLAIM → CONFIRM` (public and private alike). Private has **no** token-bridge bearer-secret `SEAL` phase (the secret is `deriveBridgeSecret(salt, claimer)`, reconstructable) — but the per-deposit **salt** is the only recovery input, so it is durably persisted **and sealed into the backup envelope**. `DepositEnvelopeV2` has no salt field (`recovery-crypto.ts:104`), so this is a 4-file change (envelope type · seal · open · `envelopeMatchesRecord`), not a single-touch reuse.

## 6. Phases

> Command vocabulary (project-real): `B=bun run --cwd packages/bridge-core test` · `FT=bun run --cwd packages/faucet typecheck` · `FU=bun run --cwd packages/faucet test` · `FE=bun run --cwd packages/faucet test:e2e` · `FB=bun run --cwd packages/faucet build` · `L=bun run lint` · `TA=bun run typecheck:all`. **No live-network gate exists.** Note: root `bun run audit:vue` does NOT run faucet tests/build, so it is NOT used as a Fuel gate.

### Phase 0 — ✅ DONE — Config seam + bridge-core Fuel primitives + fail-closed floor (pure, no UI)
<!-- Gate passed: bridge-core 121 tests · typecheck:all exit 0 · lint exit 0. Lessons: lessons/phase-0.md -->

- New Fuel config decoupled from `BRIDGE_FUEL`: canonical `FeeJuicePortal` + L1 fee-asset addresses from `node getNodeInfo().l1ContractAddresses.{feeJuicePortalAddress,feeJuiceAddress}`; pinned-in-config **plus** a runtime `UNDERLYING()` cross-check that **hard-blocks on mismatch**.
- **Floor as a mandatory, non-optional Fuel config value** with a hard guard (`if (received < FUEL_MIN_FJ) stop(...)` — no `&&`-shortcircuit escape). Re-home off `BRIDGE_FUEL` (B3: today's `if (BRIDGE_FUEL && …)` fails OPEN when `BRIDGE_FUEL` is absent).
- bridge-core: re-export `FeeJuicePortalAbi` (`@aztec/l1-artifacts`); pure arg builders `publicFuelDepositArgs` / `privateFuelDepositArgs` (both → `depositToAztecPublic` args); `parseDepositToAztecPublic(logs)` → `{ leafIndex, amount, secretHash }` (portal event). Reuse `private-fuel.ts` verbatim.
- **Validation gate.** `B && FT && TA && L`. Pass: deposit-arg + secret-derivation + event-parse unit tests; **a unit test that a missing/zero floor config fails CLOSED**; the `private-fuel.test.ts` keystone still green. Layers: unit · typecheck · lint.

### Phase 1 — ✅ DONE (STOP-gate PASSED) — Private-claim feasibility spike (proves construction + scope, NOT acceptance)
<!-- Gate passed: bridge-core 123 · faucet 336 · typecheck:all exit 0 · lint exit 0. Carrier-less payload = 2 calls, feePayer=FPC, feePayer!=claimer; scope already covered by capabilities.test.ts:192-266. I2 (live acceptance) stays deferred. Lessons: lessons/phase-1.md -->

- Build the carrierless `privateMintAndPayFee(...)` payload and drive it through the mock-wallet `simulateTx`/`sendTx` path.
- **Pass criteria (must all hold, else STOP and surface before any UI):** merged calls are exactly `[FeeJuice.claim, PrivateFPC.mint_and_pay_fee]`; `from = claimer`; `feePayer = PRIVATE_FPC_ADDRESS`; the wallet classifies it embedded `"fpc"`; **the granted capability scope includes `FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee` for both send AND simulate** (asserted in a faucet unit test alongside `capabilities.test.ts`, run by `FU`). The spike supplies explicit `maxFeesPerGas` + `teardownGas=0`; the embedded-fpc gas-cap behavior those satisfy is an *existing* wallet-pinned invariant this spike **depends on, does not re-run**.
- **Explicit limit:** there is no sequencer in jsdom — this gate proves *construction + faucet capability-scope + embedded-fee classification*, **not** prover/sequencer acceptance. It **cannot retire I2** (§8); it only catches a constructable-but-misscoped failure early.
- **Validation gate.** `B && FT && FU && TA && L` (`FU` runs the new construction + capability-scope unit tests — the gate now executes every layer its pass-criteria claim). Layers: unit (bridge-core + faucet) · typecheck · lint.

### Phase 2 — ✅ DONE — Journal/engine generalization (`assetKind`, envelope stays 1) + strict validation
<!-- Gate passed: bridge-core 127 · faucet 341 · e2e smoke 9 · typecheck:all exit 0 · lint exit 0. assetKind (additive) + deploymentMatches branch + backup restore/validator generalized; recovery-crypto binding-agnostic (no change); runDepositClaim variant deferred to Phase 3. Lessons: lessons/phase-2.md -->

- Add `assetKind` (additive optional; absent ⇒ `"bridge-token"`). Generalize `deploymentMatches`, backup restore/export, and recovery-key derivation to the fee-juice binding (§5 DQ2). Refactor `runDepositClaim` to resolve claim material by variant; generalize receipt snapshot, phase rail, toasts.
- **Tighten the backup validator now (not Phase 5):** validate the existing-but-currently-unvalidated private-fuel extras (`bridgeSecretSalt`, `fpc`, `setupInsufficiency`, `backup.ts:111-127`) plus the new fields — don't ship a generalized-but-loose validator (N2).
- **Validation gate.** `B && FT && FU && FE && TA && L`. Pass: schema/backup/journal/recovery-binding tests green; **existing Bridge flow unchanged** (unit + component + smoke-e2e); a regression test loads an existing (pre-Fuel) journal and recovers every record. Layers: unit · component · smoke-e2e · typecheck · lint.

### Phase 3 — ✅ DONE — Direct fee-asset deposit + standalone claims (public + private)
<!-- Gate passed: bridge-core 128 · faucet 354 · smoke 13 (fuel-smoke: renders, sub-floor rejection, public+private submit, engine drives a fee-juice record to done) · typecheck:all + lint exit 0. useL1FeeAsset + salt-seal + fuelClaim + engine wiring (Option C) + useFuel. Lessons: lessons/phase-3.md -->

- `useL1FeeAsset` (module-singleton, mirrors `useL1Usdc`: `balanceOf`/`allowance`/`approve`/`refresh`; no `mint`).
- `useFuel().deposit`: approve-if-short → `depositToAztecPublic` on the canonical portal → parse portal event → journal record → sync gate (`claim_*.simulate()`, PXE-aware) → claim via `runDepositClaim`.
- Public claim: generalize `sendStandaloneFjClaim` (`claim_and_end_setup`, sponsored, inclusion-gated, "already consumed ⇒ settle"). Private claim: carrierless embedded-FPC payload; the fail-CLOSED floor guard; FPC-drift kill-switch; the L11 no-public-fallback separation; `setupInsufficiency` retry; durably persist + **seal the salt** (the 4-file envelope change, §5). **Set explicit `maxFeesPerGas` + `teardownGas=0`** on the private claim — the existing fueled path *omits* explicit max fees (`useDeposit.ts:292`); the embedded-fpc gas-cap invariant only holds when they are supplied, so this is a required new implementation detail, not an inherited behavior.
- **Validation gate.** `B && FT && FU && FE && TA && L`. Pass: unit covers deposit-arg construction + both claim builders + fail-closed floor + kill-switch; smoke-e2e covers mocked public happy + private *flow-orchestration* happy + sub-floor rejection. **Gate honesty:** the private smoke-e2e (mocked wallet) proves flow-orchestration, NOT prover/sequencer acceptance (deferred — I2). Layers: unit · component · smoke-e2e · typecheck · lint.

### Phase 4 — ✅ DONE — Fuel UX (integrity via FuelView-no-journal, not a shared-shell refactor)
<!-- Gate passed: faucet 357 · smoke 14 (App-level integrity: switch to Fuel → 1 journal mount; Bridge smoke unchanged) · typecheck:all + lint exit 0. Tab + FuelView + FuelForm + fuel-accurate stepper (CLAIM GAS, approve-based). Double-owner avoided by FuelView mounting no journal + local formStage (not the shell lift) — verified by the App-level smoke. Lessons: lessons/phase-4.md -->

- **Lift the foreground surface** — `formStage`, the stepper/receipt rendering, `receiptSnapshot`, and the `releaseForeground` CAS — out of `BridgeForm` into a **shared shell above both forms**, so there is ONE owner of the journal's global `activeFlowId` regardless of which tab is active. Forms become pure input surfaces. (This is needed because `App.vue:46` keeps views mounted via `v-show` and the foreground is a module singleton — a second mounted form would double-own it. Note: `v-if` alone is insufficient — `formStage` is component-local and would reset on remount, losing an in-flight stepper across tab switches.)
- Fuel tab + `FuelView` + `FuelForm` (trimmed `BridgeForm`: amount, public/private preset, balance, submit; no flip/swap/quote). Fuel copy, `data-testid`s for every interactive element, receipt rows, journal card labels, recovery affordances.
- **Validation gate.** `FT && FU && FE && TA && L`. Pass: **a new App-level smoke that mounts `App`, switches Bridge↔Fuel tabs, and asserts a single foreground owner + no double-toast/double-render** (the prior "BridgeView-alone" smoke does NOT cover this); the gate explicitly includes the withdraw provisional→exit **rekey** path (`useBridgeJournal.ts:248-253`); existing Bridge smoke still green. Layers: component · smoke-e2e · typecheck · lint.

### Phase 5 — ✅ DONE — Harden + docs (post-impl codex audit + remediation; security posture in lessons/phase-5.md)
- No secret/salt logging; no public fallback on private; hard-block on node/config portal/`UNDERLYING` mismatch. **Preserve least-privilege capability scoping — keep `PRIVATE_FPC_ADDRESS` OUT of `contracts` registration** (`capabilities.ts:265`); scope the FPC calls in the manifest without registering the FPC as a contract (registration broadens scope). `/harden security` on the diff; address High/Critical.
- Docs: faucet README + bridge-core README + `implementations-plan/index.md` + `lessons/` (the I2 boundary + the live sign-off checklist, which gates on the FPC re-canary).
- **Validation gate.** `B && FT && FU && FE && FB && TA && L` (the explicit full set — NOT `audit:vue`, which does not run faucet tests/build) + `/harden security`. This feature modifies only `bridge-core` + the faucet, so this set IS its complete local surface; the wallet-path invariants it relies on (embedded-fpc gas-cap) are existing + pinned (cited, not re-run) and otherwise part of the deferred live sign-off. Pass: all green; harden no unaddressed High/Critical; docs updated. Layers: all local (feature surface) + harden.

## 7. Security & Adversarial Considerations

- **Wrong portal / wrong L1 asset (top theft/stranding risk).** Source the portal from the node; read `UNDERLYING()` and **hard-block** if it ≠ the configured asset; never reuse `BRIDGE_FUEL.feeJuicePortal`. The swap router itself defends this way (`SwapBridgeRouter.sol:188`).
- **Fail-CLOSED self-pay floor.** Decoupling the floor from `BRIDGE_FUEL` must not reintroduce the `&&`-shortcircuit fail-open (B3) — a missing/zero floor must stop the flow, never proceed to a stranding sub-cost claim.
- **Stranded FJ via wrong secret (private).** Must use `deriveBridgeSecret(salt, claimer)`; a random secret strands forever. Keystone tripwire stays. The salt is the sole recovery input → persist + seal it.
- **Double-claim / replay.** Reuse inclusion-gating + "already consumed ⇒ settle"; never re-mint.
- **FPC version drift.** `PRIVATE_FPC_ADDRESS` is bytecode+`@aztec`-version pinned via a GitHub-release tarball dep; keep the tripwire, refuse drift, never downgrade private→public. The documented `nodeVersion 4.3.1` vs `4.2.0` artifact mismatch (`private-fuel.ts:41`) gates the private **live** sign-off (Ask, §8).
- **Least privilege / capability scope.** Scope the FPC setup calls in the faucet manifest WITHOUT registering `PRIVATE_FPC_ADDRESS` as a `contracts` entry (`capabilities.ts:265`) — registration broadens scope unnecessarily.
- **Carrierless-payload abuse (I2).** Keep construction in bridge-core, unit-pinned to exactly the two known FPC calls, no external authwits/capsules.
- **Hidden mounted views = integrity surface.** The `v-show` + global `activeFlowId` double-owner is a correctness bug — Phase 4's shared shell fixes it; the App-level multi-tab smoke is the tripwire.
- **localStorage tamper / XSS.** Records persist facts only; authoritative copies AES-GCM-sealed; never log secrets/salts; content hash binds `(to, amount)` on L1.
- **Sponsored claim is testnet-only.** Keep the public sponsored-claim path explicitly bounded to the test deployment.
- **Supply chain.** No new deps (`FeeJuicePortalAbi` is in `@aztec/l1-artifacts`). Frozen lockfile + 7-day min-age for any bump.

## 8. Assumptions

### Facts (verified; file:line)
- `FeeJuicePortal` exposes **only** `depositToAztecPublic(bytes32,uint256,bytes32)` (no private variant) + `UNDERLYING()`; emits `DepositToAztecPublic(to indexed, amount, secretHash, key, index)`. — `@aztec/l1-artifacts/.../FeeJuicePortalAbi.js:2929,395,3014`.
- **Leaf index = the portal's `DepositToAztecPublic.index`, not `Inbox.MessageSent`** (was an inference; now confirmed by both audits).
- Canonical portal/asset from `node getNodeInfo().l1ContractAddresses`. — `packages/bridge-core/scripts/deploy-sandbox.ts:68-76`.
- Public standalone FJ claim already exists (sponsored, inclusion-gated, idempotent). — `packages/faucet/src/composables/useDeposit.ts:149-188`.
- `PrivateMintAndPayFeePaymentMethod` bundles `FeeJuice.claim` + `PrivateFPC.mint_and_pay_fee`, `feePayer=FPC`, credits `(amount − max_gas_cost)`; payload length pinned at 2. — `packages/bridge-core/src/private-fuel.ts:65`; `@wonderland/aztec-fee-payment/.../private.d.ts:6-21`; `private-fuel.test.ts:95-104`.
- `deriveBridgeSecret(salt,claimer)=poseidon2([salt,claimer],3952304070)`, claimer-reconstructable; random secret strands. — `private-fuel.ts:45-55`.
- Floor source is ONLY `BRIDGE_FUEL.minFuelFj`; guard `if (BRIDGE_FUEL && received < minFuelFj)` fails OPEN if `BRIDGE_FUEL` absent. — `bridge-deployments.ts:34,49`, `useDeposit.ts:267`.
- Loader ignores per-record `schema`; envelope `schema` hard-checked `=== 1`, `write()` fixes it at 1. — `journal.ts:145,176`.
- `deploymentMatches`, backup, and recovery-key are token-bridge-hardcoded (`portal + bridge`). — `useBridgeJournal.ts:273`, `useBridgeBackup.ts:116`, `recovery-crypto.ts:27,104`.
- `App.vue` keeps views mounted via `v-show`; `BridgeForm` owns the foreground state machine; `BridgeJournal` reads `activeFlowId`. — `App.vue:46-49`, `BridgeForm.vue:56-65`, `BridgeJournal.vue:55`.
- The Bridge smoke mounts `BridgeView` alone (does NOT exercise the multi-tab double-owner). — `packages/faucet/tests/e2e/bridge-smoke.test.ts:105`.
- `useFaucetDrip.ts:63-67` documents an *empty-setup* feePayer tx is sequencer-rejected ("Setup function not on allow list") — an adjacent precedent to the empty-*app* I2 risk.
- `BRIDGE_FUEL`/`l1.fuel.*` is the **forked-V4 swap deployment/config surface** (`bridge-deployments.ts:38`, `testnet-bridge.json` `portalSource:"forked-v1"`, `verify-l1.ts:136`). *(The "testnet halted" status is the user's out-of-band statement, not a repo fact.)*

### Inferences (labeled — attack these)
- **[I2 — HIGH; the dominant risk]** The wallet's simulate/prove/**sequencer** accepts a carrierless **empty-app-phase** tx. Unprovable locally (no sequencer in jsdom). Setup is populated+allowlisted; the empty *app* phase is the uncharted part; the wallet assumes app calls follow the prefix. → Phase 1 STOP-gate (construction+scope only) + deferred live sign-off.
- **[I1 — moderate]** Generalizing by `assetKind` is contained **given the additive approach (no migration)**; safety rests on the deployment binding, not on old-client gating (which doesn't exist). Regression risk concentrates in the Phase-4 foreground lift → the rekey path must be in the gate.
- **[I3 — moderate]** `depositToAztecPublic` is permissionless (no allowlist in the ABI); the runtime `UNDERLYING()` hard-block is the belt-and-suspenders regardless.
- **[I5 — confirmed 4-file]** Sealing the salt touches the envelope type + seal + open + `envelopeMatchesRecord` (`DepositEnvelopeV2` has no salt field, `recovery-crypto.ts:104`) — not single-touch.

### Asks (converted to explicit gate decisions — none silently assumed)
- **Ask A (config trust):** confirm `FUEL_PORTAL`/`FUEL_ASSET` = pinned-in-config **+ runtime `UNDERLYING()` hard-block on mismatch** (the plan's default; recommended).
- **Ask B (private live-trust acknowledgment):** acknowledge that private ships locally-complete with live correctness deferred, and that the deferred live sign-off **gates on** the `PRIVATE_FPC_ADDRESS` re-canary for the V5 target (the 4.3.1-vs-4.2.0 pin mismatch). This is an acknowledgment, not a scope change (locked decision 2 keeps private in).
- **Ask C (journal view):** shared `BridgeJournal` (records interleave; least surface; recommended) vs a filtered Fuel view. **Not purely UX** — a *split* Fuel journal must still prove single toast/watch ownership in the App-level smoke (`BridgeJournal.vue:49` reads the global `activeFlowId`), else the multi-mount double-toast class returns.
- **Ask D (copy):** L1 asset label — recommended: "$AZTEC" on L1-facing surfaces, "Fee Juice" on L2 (don't mix casually).
- **Ask E (migration policy):** pay the journal envelope/key migration cost for a real downgrade-compat boundary? Recommended: **no** (additive `assetKind`, envelope stays 1; downgrade-misread is a low-severity testnet residual).

**Resolved at the approval gate (all recommended defaults):** A = pin-in-config + runtime `UNDERLYING()` hard-block on mismatch. B = acknowledged (private ships locally-complete, live-deferred; the live sign-off gates on the `PRIVATE_FPC_ADDRESS` re-canary for the next-network version). C = shared `BridgeJournal`. D = "$AZTEC" on L1 surfaces / "Fee Juice" on L2. E = no migration.

## 9. Decision ledger

**Sources:** main (me), codex (`019ed76c…`), Opus planner + fresh Opus auditor ("fable" slot on Opus 4.8).

| Decision | Chosen | Source / rationale | Rejected |
|---|---|---|---|
| Private claim (DQ1) | Carrierless raw embedded-FPC payload; live correctness deferred | all three converged | no-op carrier (no benign FJ no-op); deferred-reserve UX (breaks parity); public downgrade (deanonymizes) |
| Journal shape (DQ2) | Additive `assetKind` field, **envelope stays 1** + generalize deployment-bound consumers | **Round-1 audits over codex's planning proposal** — record-schema bump is inert; envelope bump = data-loss (`journal.ts:145`); safety = deployment binding | codex planning: `assetKind` + bump to schema 3 (corrected — inert/data-loss); Opus planning: `fuelOnly` flag (subsumed by `assetKind`); `direction:"fuel"` (too invasive); separate journal (dup guarantees) |
| Private scope | In scope, full parity; risk deferred to live sign-off | **codex Round 1** — Ask-1 scope fallback re-opened locked decision 2 | "documented-blocked / cuttable private" (removed — re-opens a locked decision) |
| I2 severity | HIGH / dominant; empty-*app* precisely scoped | both Round-1 audits + main refinement | "LOW" (corrected) |
| Floor | Mandatory config + fail-CLOSED hard guard | **fresh Opus B3** | relocate the constant only (would keep the fail-open) |
| Third-view safety | Lift the foreground surface into a shared shell | codex planning + fresh Opus N1 | mirror `BridgeView` (ships the bug); `v-if` alone (resets `formStage` on remount) |
| Phase-4 gate | App-level multi-tab smoke + rekey path | **codex Round 1** | "Bridge smoke still green" (mounts BridgeView alone — doesn't test the bug) |
| Phase-5 gate | Explicit `B&&FT&&FU&&FE&&FB&&TA&&L` | **codex Round 1** | `audit:vue` (does not run faucet tests/build) |
| Fuel deployment binding | `{chainId, feeJuicePortal, L2 FeeJuice addr}` for recovery/backup/match | **codex Round 1** surfaced the gap; main specified | leave `bridge` undefined (would break recovery-key/backup) |
| Leaf index | Portal `DepositToAztecPublic` event | all (now a Fact) | `Inbox.MessageSent` |

**Process deviation (logged):** the deep protocol's separate contradiction-check (step 4) and double-audit (step 5) were **collapsed into one combined hostile pass per reviewer** (codex resumed + a fresh cold Opus, in parallel), each asked to do BOTH. Rationale: the three plans converged tightly and the consolidator resolved disputes explicitly, so the marginal value of a separate non-anchored contradiction round was low vs the latency. Multi-look rigor is preserved by the fresh cold Opus + the still-pending final fresh-context codex pass.

## 10. Audit verdicts

- **Round 1 — codex (combined contradiction-check + audit):** *conditional reject* — 4 blockers (locked-decision re-open; schema-3 rationale; weak STOP-gate; wrong Phase-4 & Phase-5 gates). **All addressed** in this revision (§3, §5 DQ2, §6 Phases 1/4/5).
- **Round 1 — fresh Opus (cold hostile audit):** *conditional approve* — 3 blockers (B1 schema/data-loss; B2 I2 understated; B3 floor fail-open) + 5 nits. **All addressed** (§5 DQ2, §5 DQ1/§8 I2, §6 Phase 0, §6 Phases 2/3/4).
- **Final fresh-context codex pass (session `019ed792…`):** **conditional approve** — condition: *tighten the validation gates so they actually execute the layers they claim to prove* (Phase 1 add `FU` + reword the wallet-path claim as a cited dependency; Phase 5 clarify the feature-surface scope). **Applied** (§6 Phases 1/3/5, Ask C). Codex affirmatively confirmed: additive `assetKind` + envelope-stays-1 matches repo loader behavior (`journal.ts:141,175`); locked decision 2 no longer re-opened; **no new High/Critical beyond I2**. Plus two sharpenings folded in: Phase 3 must *set* explicit `maxFeesPerGas` (the existing path omits it); Ask C split-journal needs single-owner proof.
- **User approval:** `approve` — all five open decisions taken at their recommended defaults; no scope change. Implementation driven by the `/goal` seed (§12).
- **Post-implementation codex audit (xhigh; net diff + adversarial/security ask):** **conditional reject** — 1 HIGH (private-recovery stranding: the claim builder read the plaintext journal copy instead of the engine-unsealed authoritative copy) + 2 MEDIUM (UNDERLYING hard-block never shipped; fee-juice completion mislabelled on the shared bridge toast/card) + 2 LOW (public two-secret divergence; AZLO card labels). Fund-routing core, fail-closed floor, `assetKind` binding, and capability scope (PRIVATE_FPC out of `contracts`, no secret logging) confirmed **solid**. **All findings remediated** across 3 commits; the only deferral is the two-simultaneous-flows visual-stage edge → the documented shared-shell follow-up. Finding-by-finding remediation: [`lessons/phase-5.md`](lessons/phase-5.md).

## 11. Post-implementation hardening

`/harden security` (Phase 5) was satisfied by the post-impl codex audit (the adversarial security pass over the full diff) + remediation + an in-code trust-boundary verification (PRIVATE_FPC out of `contracts`, no secret/salt logging, fail-closed floor, runtime `UNDERLYING()` hard-block) — see [`lessons/phase-5.md`](lessons/phase-5.md). A full whole-app `/harden security` + `/harden quality` is recommended at release time (the "production quality → schedule /harden" decision), not gated on this plan.

## 12. Seeds

_Final — approved (defaults; no scope change). The user started the **/goal** seed to drive implementation. `/loop` retained below as the documented alternative. Use exactly one per session._

**/loop (recommended):**

```
/loop 15m Drive implementations-plan/archive/fuel-direct-bridge forward. Never idle. Each firing: reality-check plan.md + lessons/ + `git status` + `git log --oneline -5` (gh pr checks if a PR exists). STOP-GATE: if Phase 1's carrierless private-claim spike fails its pass-criteria, STOP and surface to me — do NOT start UI work. Else advance the next pending phase honoring its EXACT plan.md §6 validation gate. After each meaningful edit run the touched-package fast layers; commit small/conventional; push the feature branch. Decisions (carrierless model, shell refactor, recovery binding) → /codex xhigh, log the verdict in lessons/phase-N.md. Same step failing 5× → reassess with codex. Phase green = its plan.md gate passes (paste the output) → mark ✓ + file lessons + print LESSONS_FILE=implementations-plan/archive/fuel-direct-bridge/lessons/phase-N.md → next phase. All phases ✓ → /code-review max --fix (commit separately) → codex post-impl audit (xhigh; net diff + adversarial/security ask) → address high/critical → /harden security (Phase 5) → wrap-up report, then surface + stop. Hard limits: local gates only (no live network this plan); never main; private stays in scope (locked decision 2 — never silently drop it); keep PRIVATE_FPC out of contracts registration.
```

**/goal (alternative):**

```
/goal All phases ✓ in implementations-plan/archive/fuel-direct-bridge/plan.md (the per-phase headers), each ✓ backed by its plan.md §6 validation gate reported passing in the transcript; Phase 1's stop-gate explicitly resolved (spike passed, or surfaced-and-held if it failed); for each phase LESSONS_FILE=implementations-plan/archive/fuel-direct-bridge/lessons/phase-N.md printed; /code-review max --fix applied + committed separately; codex post-impl audit done with high/critical addressed; /harden security (Phase 5) done with no unaddressed high/critical; `bun run --cwd packages/faucet test` and `bun run lint` both exit 0 in the transcript. Constraints: local gates only; never main; private stays in scope.
```
