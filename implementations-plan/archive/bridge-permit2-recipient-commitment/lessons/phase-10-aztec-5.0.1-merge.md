# Phase 10 — merge the base branch (aztec 5.0.1 + testnet redeploy) into the arc

`[✓]` Merge (parents mine + the base branch), pushed.
The base branch shipped, while this arc waited: aztec `rc.2 → 5.0.1`,
a **testnet redeploy** (new bearer-bridge addresses), and bridge recovery fixes
(registerContract conformance, L1-timeout deposit recovery, stranded-card claim,
resilient receipt wait). My branch was 19 behind / 42 ahead.

## The 11 conflicts + the 5.0.1 adaptations
- **Noir array API**: `consume_l1_to_l2_message(content_hash, [secret], …)` and `compute_secret_hash<N>([Field; N])` — 5.0.1 made the secret an explicit array. Kept the recipient-commitment derivation; **re-ran the keystone `aztec-nargo test` on 5.0.1 → all 6 vectors BYTE-IDENTICAL to rc.2** (the load-bearing result: no private deposit strands from the bump; `compute_secret_hash([x])` for N=1 == the rc.2 scalar hash, and the TS `computeSecretHash(scalar)` internally hashes `[scalar]` so it matches). v5.0.1 Noir tags across the 3 Nargo.toml + the `claim_secret` lib.
- **Recompiled** the recipient-committed `token_bridge` via `compile.sh` on the pinned 5.0.1 toolchain → new class id `0x2cb5c634…`; updated the supply-chain pin in `noir-artifact-classids.test.ts`.
- **Manifest**: took the base branch's LIVE 5.0.1 **bearer** manifest. See the gated-state caveat below.
- **useDeposit/useFuel**: kept the Permit2-router path (my arc); the base branch's recovery fixes auto-merged AROUND it (merged useDeposit 1099 lines > base 1038 > mine 1019 — union preserved both). Re-added the merge-dropped `InboxAbi` import; ported the resilient `awaitL1Receipt` to the fuel approval (codex Medium).
- **5.0.1 API churn caught by typecheck (not the git merge)**: `deriveSigningKey` removed → `deriveNuloAccountKeys` (relayer); `@alejoamiras/aztec-standards` → `@aztec-foundation/aztec-standards` Token + a 5th `auth_contract = ZERO` constructor arg (verify + relay scripts — the orphaned rc.2 package MASKED this in typecheck); `candidate-schema` (the base branch's new strict zod) rejected `privateClaimMode` → added it; sole-consumer dataflow regex updated for `[secret]` (and tightened to reject a multi-element `[secret, X]`).

## codex gpt-5.6-sol @ ultra review (the user's ask — it earned its keep)
Verdict: no Critical. It found **4 High + 1 Medium + 1 Low, ALL fixed before commit**: (H1) the
recompiled artifact was UNSTAGED — a commit would have paired new source+pin with the rc.2 bytecode
(clean tooling → VK-size mismatch); (H3) candidate-schema `privateClaimMode` rejection would fail the
re-deploy after irreversible on-chain steps; (H4) the rc.2 Token import/arity in the scripts; (Med)
the fuel-approval regression; (Low) the `[secret, X]` regex hole. It confirmed the crypto has **no
secret-hash mismatch** and that the deposit recovery, the stranded-card claim + the resilient waits survived. Session `019f80c0-…`.

## GATED — the faucet is code-ahead-of-config on 5.0.1 (worse than "private only")
The recompiled artifact is recipient-committed; the base branch's live manifest is the **bearer** bridge
(`0x00e3…`). `rebuildBridgeInstance` derives a different address (`0x06ff4d…`) from the recipient
artifact, and `registerContract` is unconditional — so the connect-time scope check rejects setup for
**the whole faucet (faucet + public bridge + Fuel), not just private** (codex H2). This is the
documented F1/L9 pre-cutover state, now on 5.0.1. **Resolution = a fresh recipient-committed Phase 6/7
re-deploy on the 5.0.1 testnet + promote a matching candidate manifest — HARD-GATED on explicit user
go.** (An alternative codex floated: make the runtime select the bearer artifact until cutover — a
bigger design change, not done.) The deploy tooling is now 5.0.1-ready (candidate-schema accepts
salt-v2, Token 5-arg, the base branch's journal-resume reuse logic).

Gates green: typecheck:all (13 pkgs), bridge-core 181, faucet 450, keystone 6/6 on 5.0.1,
sole-consumer self-test 5/5, biome lint.

## `[✓]` Smoke-feedback batch: public fuel self-pay (mainnet shape) + 3 UX fixes

Owner feedback from manually smoking the promoted 5.0.1 deployment — 5 items, one a real fee-strategy
decision (owner call: the Sponsored FPC does not exist on mainnet, so a self-pay bug must SURFACE,
never be masked): switch the public fuel-only claim from sponsor+app-phase-claim to
`FeeJuicePaymentMethodWithClaim` self-pay, plus SIGN→AUTHORIZE, journal auto-surface on
completion, and a titling fix on the wallet's side.

**The load-bearing discovery (codex gpt-5.6-sol ultra, 3 rounds): `BatchCall([]).simulate({fee})` is
a silent NO-OP.** SDK `batch_call.ts`: `request()` merges `options.fee.paymentMethod`'s payload, but
`simulate()` reads ONLY the batch's own interactions — an empty batch produces zero batchRequests and
never executes the fee payload. Consequences: the journal's message-availability gate
(`useBridgeJournal` polls `interaction.simulate()` expecting `isMsgNotReady` throws) and the
`recordMessageConsumed` rediscovery probe both silently "pass" for a carrier-less claim. Pre-existing
on the shipped private fuel path (masked because this-process claims complete via the receipt path,
not the probe); would have become public's problem too once it lost its real app-phase claim
interaction. Fix shipped for BOTH branches: `simulateViaPayload` = `BatchCall([]).request({fee})` →
`wallet.simulateTx(payload)` — throws the real not-ready/consumed shapes.

Second codex catch: the protocol's balance check is against `getFeeLimit()` = Σ gasLimit×maxFee (the
LIMIT, not the actual charge), so a bridge clearing the static 16e18 floor can still revert once fees
spike. Shipped `clearsFeeLimit()` fail-closed on both branches + calibrated `PUBLIC_CLAIM_GAS` to
1.5M/3k from the live canary's measured 659,123 l2Gas (the private 4M limit at a 2× spike would graze
the floor).

**Live proof ×2**: converted `fee-juice-canary-testnet.ts` to the self-pay shape (zero-app-call
`BatchCall([])` + `claim_and_end_setup` in setup — the exact unproven combination) and ran it twice
against the promoted manifest: both PASSED (16e18 deposit → ~14.72e18 net, fee ~1.28e18,
revertCode 0). The 5.0.0 "149 failed simulates" bug was the APP-phase variant under a sponsored fee;
setup is the correct home. Fuel-only titling: the wallet titled the claim after
`mint_and_pay_fee` ("Mint And Pay Fee"); it now treats both self-pay fee payloads as
fee methods, while a bare `claim` deliberately stays a user method
(third-party airdrop claims).

Deliberately NOT done (codex-agreed pre-existing, cross-path): the ambiguous post-broadcast/no-hash
recovery machine (affects old public + private + token claims equally — separate PR); the canary
still sponsor-deploys its fresh account (faucet flows require a deployed wallet before any claim).

Round 3 (post-implementation confirm) caught one more: `simulateTx` was called with only `{from}`, so
the standalone simulation ran under the wallet's ESTIMATION defaults (max limits + padded fees) —
mismatching send and able to spuriously fail the self-pay budget check. Fixed by routing the
interaction options through the SDK's own `toSimulateOptions` (exactly what a non-empty
`BatchCall.simulate` does), unit-pinned for both branches' explicit gasLimits + predicted fees.

Gates: faucet typecheck + 459 (7 new), biome; canary ×2 live.

## `[✓]` Codex-ultra UX/fee audit of the feedback arc → 1 High + 5 more, all fixed

Scoped audit (NOT the commitment work) after the history-vanishing fix. The High
invalidated a standing assumption: **App.vue mounts ALL views with `v-show`** (deliberate — per-tab
wallet sessions), so BridgeForm AND FuelForm are permanently mounted sharing ONE `activeFlowId` with
per-component `formStage`. A Fuel submit while a Bridge stepper was up (or vice versa) could snapshot
the foreign record as the wrong receipt, release the other form's takeover, and strand it in
"stepper" where the submit guard blocks forever. Fixed with kind-guards on the completion watchers +
a broadened fail-open guard in both forms (reset on vanished OR usurped; release ONLY a dead id,
never a live foreign takeover) + `discard()` releasing foreground at the source.

Also fixed: fuel-rejection soft-brick (same guard); `predictedWorstMinFees` now requests
`ManaUsageEstimate.Limit` (argless defaulted the node to Target — under-priced cap under rising
congestion); toast double-announce (the suppression keyed off the LIVE activeFlowId, which the form
releases before the toast watcher runs — `lastCompleted.foreground` is now captured synchronously);
completed direct-fuel cards falsely offering CLAIM YOUR GAS. The wallet's private-fueled-claim
mislabel ("Claim Fee Juice · 2 calls" — the embedded FPC payload pairs `claim` with
`mint_and_pay_fee`) was fixed on the wallet's side.

Lesson: "only one form is mounted" was an UNVERIFIED inference that survived four commits — the
audit's assumption-attack ask (verify against App.vue) is what caught it. Test-hygiene corollary:
BridgeForm.test's earlier full-file-only failure (stale mounted forms watching shared refs) was the
SAME defect wearing a test costume; production reached it through v-show instead of missing unmounts.

Gates: faucet 461 + bridge-core 185 (vitest — bare `bun test` has a pre-existing harness mismatch,
`expect.addEqualityTesters`) + typechecks + lint.

## `[✓]` Round-2 audits (codex verify + codex fresh + FABLE fresh): 1 High-class race, 1 unmeasured-shape gap, 6 more fixes

Three parallel passes on the UX/fee arc per owner ask. Codex-verify confirmed the cross-form High
fixed. Codex-fresh found the completion/usurp
microtask race (a fuel submit can re-point `activeFlowId` between a completion WRITE and the Vue
flush → receipt lost AND toast suppressed) — root-fixed by giving each form an `ownedId` (the record
IT started): receipts key off the owned record, foreground stays display-only, the fail-open guard
re-adopts the withdraw rekey and stands down on usurp without releasing a live foreign takeover.
Also from codex-fresh: the rail ran BACKWARD pre-narration (fallback activeKey was "deposit", so
AUTHORIZE rendered pre-done before anything signed; now seal/sign first-prompt + an explicit
"depositing" mapping) and `awaitL1Receipt` NEVER checked `status` (a REVERTED approve/deposit read as
success — now throws non-retryably; its comment claimed a check that didn't exist).

**FABLE H1 — the calibration's hidden assumption.** The public self-pay gas limits were measured on
a canary that sponsor-deploys the account first; the Nulo wallet defers account init to the FIRST tx
(it wraps `[ctor, entrypoint]` when the init nullifier is
absent), so a fresh wallet fueling first carries an unmeasured shape. The new `--fresh-selfpay`
canary run settled the question differently than expected: the EMBEDDED wallet has NO init wrap —
the undeployed account's entrypoint dies on its signing-key note (`Failed to get a note`) before gas
even matters — so the embedded canary CANNOT model the Nulo wallet's shape, and that shape's cost
stays unmeasured (documented on `PUBLIC_CLAIM_GAS`). Bounded, not stranding: any other tx
initializes the account and RETRY then claims normally; testnet's drip-first flow shields it.
Measure via a run driven by the Nulo wallet before mainnet.

Accepted (documented, unfixed): the >100-unfinished-records completion eviction (capRecords'
flood-protection is deliberate); hidden-tab completions rely on the receipt-on-return cue.

Test-hygiene rhyme: FuelForm.test needed the same `enableAutoUnmount` as BridgeForm.test — a stale
mounted form's fail-open guard fired across tests. Gates: faucet 462, bridge-core 187 (+2 reverted
pins), typechecks, biome.
