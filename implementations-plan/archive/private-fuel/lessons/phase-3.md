# Phase 3 — faucet: B-presets UI + private claim/recovery

Status: **in progress.** P3-A (UI) implementing; P3-B (claim/recovery) spec locked via codex.

## Codex P3-B decision (session 019ec69a, xhigh) — recovery/fee routing
**Verdict: Option A** — branch on `rec.isPrivate` at the TOP of `useDeposit.ts`'s `claim` dep: an entirely
separate private path that builds `privateMintAndPayFee(...)` + explicit gas, with its OWN minimal
recovery, NEVER touching `decideFuelClaim` / `sendStandaloneFjClaim`. The public L14 ladder stays
byte-stable. (Option B — extending `decideFuelClaim` with `isPrivate` — rejected: it is public-biased
[`sponsored-plus-standalone-fj`, fee-spike heuristic] and mixing private in is the bigger regression risk.)

Folded into the plan as the P3-B implementation rules:
- **L1 deposit leg (CRITICAL, do first):** for private, `fuelRecipient = PRIVATE_FPC_ADDRESS` (not user — `:481/:509`),
  `fuelSecret = deriveBridgeSecret(salt, claimer)` (not `Fr.random()` — `:375`), and WRITE the journal's
  `bridgeSecretSalt`/`fpc` (currently unwritten). Privacy/recovery is broken before the ladder if this is skipped.
- **Consumption signal:** the overall claim tx receipt becoming INCLUDED — NOT a sim/send failure. If the
  bundled tx lands and `claim_private` app-reverts, setup already ran ⇒ FJ consumed at the FPC. Persist
  `claimAttempt`/`claimTxHash`, wait for receipt, mark consumed on inclusion, NEVER route to public.
- **Retry allow-list (narrow):** retry the private FPC claim ONLY if there is NO tx hash/receipt AND the
  error matches the exact `mint_and_pay_fee` insufficiency form. Otherwise fail closed to wait/user-retry —
  never auto-fallback to public/Sponsored. (No typed selector exists; treat the string-match as a narrow allow-list.)
- **No-fuel (L7):** make `fee` OPTIONAL and OMIT it entirely (`:214` currently defaults to sponsored). Omitting
  resolves wallet-side to `PREEXISTING_FEE_JUICE` = self-pay from existing public FJ (NOT sponsorship).
  Detect "cold" via a `balance_of_public(recipient)`
  read; zero ⇒ BLOCK with guidance.
- **Journal retry path (`useBridgeJournal.ts:662`):** must not re-embed private fuel after any INCLUDED prior attempt.
- Gas-settings pass-through + PROPOSED-not-inclusion + receipt-normalization reuse: confirmed fine.

## P3-A — BridgeForm.vue B-presets (this iteration)
Design from the approved mockup: two preset cards "How it arrives" —
PRIVATE (default) + PUBLIC — with fuel as a shared add-on below (now enabled for BOTH; gas-follows-token).
- `isPrivate = ref(true)` (private default); delete `watch(isPrivate → fuelOn=false)`; drop the `!isPrivate`
  fuel gates (toggle `v-if`, fuel-config `v-if`, onSubmit fuelSlice); remove the "private gas is coming" note;
  add the "+ private gas — claimed with your tokens, fully private" note; submit label "BRIDGE PRIVATELY TO AZTEC".
- testids: + `bridgePresetPrivate` / `bridgePresetPublic` (cards replace the single privacy toggle).
- Test migration (~9 cases across `BridgeForm.test.ts` + `BridgeForm.fuel.test.ts`): public→private default
  inverts; `bridgePrivacyToggle` clicks → card clicks; the two guard tests (private→fuel-off, private→no-fuel-note)
  invert to "private CAN carry private fuel".

## P3-B progress (loop fire 2)
- **Deposit leg DONE:** private fuel routes `fuelRecipient=PRIVATE_FPC_ADDRESS`, the secret is
  `deriveBridgeSecret(salt, claimer)` (not random), and `bridgeSecretSalt`/`fpc` are written to the journal
  fuel block. Public path byte-identical. faucet typecheck + biome green.
- **Claim branch NEXT** (the Option-A private path in `useDeposit.ts`'s `claim` dep). Two research items to
  resolve FIRST (don't guess — L14-critical per codex):
  1. **gasSettings passing:** how does the faucet supply explicit `maxFeesPerGas` (current-min) + `teardownGas=0`
     through `bridge.methods.claim_private(...).send({ from, fee })`? Wonderland's method `getGasSettings()` is
     undefined; the wallet's gas cap fills `maxFeesPerGas` from node min-fees when omitted but
     does NOT zero teardown. Verify the SendOptions/fee gasSettings shape (check what the wallet honors +
     aztec.js). A non-zero teardown can break `mint_and_pay_fee`'s `gasLimits*maxFeesPerGas <= amount` assert.
  2. **insufficiency classifier:** the narrow retry allow-list needs the exact error shape of a pre-inclusion
     `mint_and_pay_fee` insufficiency (no typed selector exists — string-match). Find the failure form; default
     fail-closed to `wait` otherwise. NEVER public/Sponsored.
- Budget gate: use `fuel.received >= BRIDGE_FUEL.minFuelFj` (calibrated 2x-fee floor) as the conservative
  pre-claim fail-closed proxy; refine to `requiredBudget = maxGasCostFor(explicit gas)` once (1) is known.
- WIP note: until the claim branch lands, a private+fuel deposit writes to the FPC but the claim still hits the
  public ladder (would fail, not leak — the FJ is FPC-bound). Branch-only intermediate; not shippable yet.

## P3-B research RESOLVED + decider done (loop fire 3)
- **Classifier:** the insufficiency assert is `"Amount too low to cover gas cost"` — CONFIRMED present in the
  INSTALLED 215fd08 artifact (not just the clone). `isPrivateFuelInsufficiency()` string-matches it; fail-closed.
- **gasSettings:** aztec.js `interaction_options.d.ts:33` — the send `fee.gasSettings?: Partial<FieldsOf<GasSettings>>`.
  So the private claim passes `fee: { paymentMethod, gasSettings: { teardownGasLimits: Gas.empty() } }` and OMITS
  maxFeesPerGas → the wallet's gas cap fills it with node current-min (1.0×, no padding =
  exactly L14); teardownGasLimits passes through untouched. (Live-honored teardown=0 is validated at P4.)
- **Decider DONE** (tested, 10 cases): `decidePrivateFuelClaim` + the classifier in `fuel-claim-state.ts`.
  Its action type (`private-fpc`|`consumed`|`wait`) makes L11 structural — it CANNOT return sponsored/public.
- **NEXT:** wire it into `useDeposit.ts`'s `claim` dep (Option-A branch at the top for private fueled records):
  build `privateMintAndPayFee(fpc, fuel.received, deriveBridgeSecret(salt, claimer), salt, fuelLeaf)` + the
  gasSettings above; latch claimAttempt journal-first; receipt-inclusion ⇒ consumed; on send-error run
  `isPrivateFuelInsufficiency` for the retry; pre-claim budget `fuel.received >= minFuelFj`. Plus no-fuel L7
  (omit fee + balance_of_public cold-block). Edge: included-but-app-reverted leaves FJ credited at the FPC →
  recover via the FPC `pay_fee` (documented follow-up, not first-pass).

## P3-B claim branch WIRED (loop fire 4)
- The Option-A private path is live in `useDeposit.ts`'s `claim` dep (separate early-return for
  `rec.isPrivate && fuel.received && fuel.leafIndex && fuel.bridgeSecretSalt`): builds `privateMintAndPayFee`
  (feePayer=FPC) + `gasSettings.teardownGasLimits = Gas.from({daGas:0,l2Gas:0})` (maxFeesPerGas omitted →
  wallet fills current-min); `decidePrivateFuelClaim` drives action; FPC-drift FAIL-STOP (L15) + budget floor
  (received ≥ minFuelFj) + narrow setup-insufficiency retry; NEVER public/Sponsored. Journal gained
  `setupInsufficiency`. faucet typecheck + biome clean; bridge-core 107/107; faucet 68/68 (no regressions).
- The claim-dep wiring isn't unit-tested (it's a chain-dep closure, like the public ladder — only the pure
  `decidePrivateFuelClaim` is unit-tested); the integration is proven by typecheck + P4 live + the P2 network-e2e.
- **NEXT (last P3-B piece): no-fuel L7.** The claim dep still defaults `fee = sponsored` for NO-fuel records
  (`:216`). Change to OMIT fee (→ wallet self-pays via PREEXISTING_FEE_JUICE) for FUNDED accounts + BLOCK cold
  (zero-FJ) accounts. Research item: how to read the FeeJuice public balance to detect "cold" (a scoped
  balance_of_public sim, or a node storage read) — may need a manifest scope addition. Then P4 (live) + P5.

## No-fuel L7 — codex verdict (session Hg9e0Nid) + SCOPE FINDING (loop fire 5)
Codex: faucet-side `FeeJuice.balance_of_public` (scope it in `simulation.transactions`), hard-block no-fuel
at the FORM + re-check at claim — but **"omit fee" alone does NOT guarantee never-sponsored end-to-end**:
- [CRIT] the wallet popup AUTO-SELECTS sponsored when available.
  So omit-fee → PREEXISTING_FEE_JUICE is true at the account layer but the
  wallet UX still auto-picks sponsored. Strict end-to-end never-sponsored needs a WALLET change too.
- [HIGH] the claim simulate gate is NOT a cold detector (the wallet's simulate defaults skipFeeEnforcement
  true; the journal gate treats simulate-success as ready) → a cold account passes simulate, fails at send.
- [HIGH] do NOT change the shared `fee` default (`useDeposit.ts:304`) — it also mutates the FUELED sponsored
  fallback + the journal UI advertises sponsored recovery. Isolate the no-fuel path explicitly.
- [OK] balance_of_public is the right source; omission syntax is fine
  (the wallet maps no-embedded-fee → PREEXISTING_FEE_JUICE).

**Scope fork (USER decision needed):** "strictly never sponsored" — faucet-only (faucet never SENDS
sponsored + block cold; funded accounts = the wallet chooses, may auto-sponsor) vs a wallet change too (also stop
the wallet auto-sponsoring the dApp no-fuel claim). The private-fuel HEADLINE is DONE + green (329/329);
no-fuel L7 + the sandbox-gated P2/P4 all need the user. Loop paused here pending that decision + the sandbox.

## No-fuel L7 DONE (faucet-only — user decision)
Per the user's choice (faucet-only, not the strict variant that needs a wallet change):
- Claim dep: no-fuel records OMIT the embedded fee (wallet self-pays via PREEXISTING_FEE_JUICE) instead of
  forcing Sponsored; isolated to the no-fuel `else` (the fueled fallback + shared default untouched — codex).
- Cold (zero public-FJ) accounts: blocked PRE-DEPOSIT in `deposit()` (so tokens aren't bridged unclaimable)
  AND re-checked at claim (the simulate gate doesn't enforce fees) — both via `readPublicFeeJuiceBalance`
  (reuses `readBalance` from useTokenBalance; `FeeJuice.balance_of_public` now scoped in the manifest sim).
- Read errors don't block (fail-safe; the other gate backstops). Funded accounts: the wallet may still
  auto-pick Sponsored — accepted as "the wallet chooses" (the strict variant, a wallet change too, was declined).
- typecheck clean; faucet 330/330. **P3 code is COMPLETE.**

## P3 COMPLETE — remaining is sandbox-gated
Private fuel is implemented end-to-end (deposit→FPC→self-paying claim, never public/Sponsored) + B-presets UI
+ no-fuel L7. Remaining: the wallet-side P2 network-e2e + P4 live dust-canary (needs testnet) + P5 harden.
The claim-dep wiring (private branch + no-fuel) is live-validated (no useDeposit unit test; the pure deciders ARE tested).

## Manual P4 canary PASSED (live testnet) — private fuel VALIDATED
Real run: 0.15 AZLO bridged + a slice that bought 87.70 FJ, PRIVATE, 5m02s end-to-end; the claim self-paid
via the PrivateFPC. PRIVACY CONFIRMED — the user's PUBLIC Fee Juice stayed ZERO (the 87.70 went private,
credited at the FPC; no sponsor). The headline feature works live.
Calibration: the private claim cost 2878299568939200000 = 2.878 FJ. So minFuelFj=11 is SAFE (~3.8× the real
private fee) — NO raise needed (the worry that private needs a higher floor is disproved; could even tighten
to ~6). Banked ≈ 84.8 FJ private (87.70 − 2.88), usable for future txs via the FPC pay_fee path (follow-up).
UI: "Pending Bridges" → "Your Bridges". Receipt-improvement directions drafted (plan.md § Receipt-improvement directions).
