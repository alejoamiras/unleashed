---
plan: private-exit-fence
tier: light
driver: claude-code
status: merged (phase 1 ✓; codex loop converged, approve); phase 2 — the exit canary — measured `PRIVATE_HUB_EXIT_GAS` on the sandbox (lessons/phase-2.md)
eli5_mode: none (owner-directed follow-up of the deposit fence; no ELI5)
code_review: off
codex_effort: high
budget: recon done inline (the exit path is 1 composable + 1 wizard branch); codex high, single post-impl pass
---

## Outcome

Archived. Seeds retired.

# private-exit-fence — a private exit never names a public fee payer

## Summary

An earlier PR closed the deposit side: a private bridge pays its claim only from the account's PrivateFPC
credit, because a transaction's fee payer is public and the claim's public side effects link that
payer to the L1 deposit. The exit side has the same leak in the other direction, found by codex
during that PR's review: `useHubExit.ts` deliberately sends every exit with NO app-set fee
(`buildExitSendOpts` — "the connected wallet pays its own default"), so the wallet's fee card picks
the payer — the Sponsored FPC where one is funded, otherwise the account's own Fee Juice. A
*private* exit (`exit_to_l1_private` → `Token.burn_private` under an off-chain authwit) then sits
in a transaction whose fee payer is the user's account, publicly, and whose L2→L1 message names
the L1 recipient and amount. An observer links the two.

Fix, in `apps/tools` only: a private exit names the PrivateFPC as payer through its `pay_fee`
route (the `fpc-credit` shape the deposit's claim already uses), refused before anything is
authorised when the credit is short; the wizard blocks a private exit the account cannot pay
privately; public exits keep the no-app-fee rule. Owner's directions carried over from the deposit
fence: hard block at send time; no escape hatch (pre-production).

**In.** `useHubExit.ts` (the exit's fee), `SendWizard.vue` (the send-time block + the review's fee
line for a private exit), pins in `useHubExit.test.ts` / `SendWizard.test.ts`, a ledger row in the
tools-console plan, the tools README paragraph on fees.
**Out.** The wallet; bridge-core; the contracts; public exits' fee (unchanged); the nine frozen
wizard step files (`TokenStep`, `TokenList`, `TokenTile`, `MintStrip`, `AmountStep`, `ChoiceCards`,
`GasBreakdown`, `ReviewStep`, `ReviewDetails`) — the fence lives in the wizard's gate and the
composable, as the deposit fence does.

## Acceptance criteria

1. `exitViaHub` for a private plan is called with `fee: { paymentMethod: PrivateFPC pay_fee, gasSettings }` and the transaction's payer is the FPC; for a public plan the send carries no `fee` (the existing pin stays green).
2. A private exit whose credit at the FPC is under the committed ceiling (limits × predicted worst fees) is refused in `readOnlyPreflight`, before any authwit is created, with a message that says why; the record is never opened.
3. The wizard greys out / stands down a private exit the account cannot pay privately, with the same reason, at the amount step and again at confirm (the gate is re-read); a public exit is unaffected.
4. The review's fee line for a private exit names the private gas set aside, not "your Aztec wallet's own fee".
5. `<lint>`, `<typecheck>`, `<unit>`, `<smoke>`, `<frozen>` exit 0; no new complexity suppression.

## Architecture & Implementation

- **The fee.** `useHubExit.ts`: `buildExitSendOpts(from)` stays fee-less and is used for the public
  exit and for the public authwit transaction. A new `privateExitFee(aztec, from)` reads the credit
  (`readPrivateFeeJuiceBalance`) and the predicted worst fees (`predictedWorstMinFees`), computes the
  ceiling with the deposit's `privateFpcFeeLimit` over `PRIVATE_HUB_EXIT_GAS`, and returns
  `{ paymentMethod: privateFeeJuicePayment(PRIVATE_FPC_ADDRESS), gasSettings }` or throws
  `ExitNeedsPrivateGasError` (a stop before authorisation, like `ExitPausedError`). The private
  exit's `submitExit` spreads that fee into the send opts. `PRIVATE_HUB_EXIT_GAS` is a new constant in
  bridge-core's `private-fuel.ts` beside the claim's, set to the claim's limits: the private exit is
  one private frame (`burn_private` + the hub's private frame) and one public enqueue
  (`_assert_exits_open`), lighter than the claim's mint; measured headroom is a canary follow-up,
  noted at the constant.
- **The gate.** `SendWizard.vue`: `exitBlocked` gains a second reason: a private exit whose
  `heldGasSource(ceiling, true)` is `none` / `short` (with `gasShare.ownGasCeilingFor(state, true)`
  as the ceiling — it prices the claim's limits, the same figure the composable commits to). At
  confirm, `preflight` re-reads `gasHeld` for a private exit exactly as it does for a token-only
  deposit (`preflightReads(tokenOnly=true)`), and `preflightStandDown` returns the private-exit
  reason when the re-read no longer covers. `networkFeeOf` for a private exit says
  "≈ N FJ from the private gas you already hold" like the deposit's held-gas line.
- **Pins.** `useHubExit.test.ts`: a private exit carries the FPC fee and the ceiling's gas settings;
  a public exit carries none; short credit refuses before `createAuthWit` and opens no record.
  `SendWizard.test.ts`: a private exit with zero credit is blocked at the amount step and stood down
  at confirm; a public exit with zero credit is not.

## Security & Adversarial Considerations

- The payer for a private exit is the shared PrivateFPC, never the account; the FPC deducts the
  committed ceiling from the account's credit (no refund), so the review shows the ceiling.
- The check runs before any authwit exists (nothing to replay if refused). The wallet still shows
  the locked "fee set by the app" card and the user confirms; the app never bypasses it.
- A public exit is public anyway (public authwit tx + public burn); no fence, and no change.
- Failure modes: an unreadable credit refuses (fail closed); a ceiling under the live fee at
  inclusion fails recoverably at the FPC's assert and the record is not opened (the refusal is
  pre-authorisation); a record already exiting is untouched.

## Phases

`<lint>` = `bun run lint`; `<typecheck>` = `bun run --cwd apps/tools typecheck`; `<unit>` = `bun run --cwd apps/tools test`; `<smoke>` = `bun run --cwd apps/tools test:e2e`; `<frozen>` = `git diff --quiet <rev> -- <the nine step files>`; `<bc>` = `bun run --cwd packages/bridge-core test`.

### Phase 1 ✓ — the fence
- Constant, composable fee + refusal, wizard gate + confirm re-read + review line, pins, ledger row in `implementations-plan/archive/tools-console/plan.md`, README.
- **Gate:** `<lint>` ∧ `<typecheck>` ∧ `<unit>` ∧ `<smoke>` ∧ `<frozen>` ∧ `<bc>` all exit 0; the exit pins named above green; `LESSONS_FILE=implementations-plan/archive/private-exit-fence/lessons/phase-1.md`.

## Post-implementation

`code_review: off`. One `/codex high` fresh pass over the diff with the adversarial ask (can a private exit still reach a public payer; can the fence be bypassed by a resumed record or a wallet without the FPC); apply findings; resume until "no new material findings" (max 3 rounds); `lessons/post-impl.md`. Then `gh pr create` into the base branch, title `fix(tools): a private exit never names a public fee payer`, babysit to green, merge (owner's standing instruction for this arc: "babysit PR until green and merge").

## Decision ledger

| # | Point | Decision |
|---|---|---|
| 1 | Where the fence lives | The composable commits the payer; the wizard refuses early. Same split as the deposit fence. |
| 2 | Exit gas limits | Reuse the claim's measured limits as the ceiling (an upper bound for a lighter transaction); a measured `PRIVATE_HUB_EXIT_GAS` is a canary follow-up. **Done in phase 2:** the sandbox smoke's FPC-paid private exits, as a Schnorr account under the wallet's key derivation, billed 826,543 L2 / 1,696 DA over one credit note and 888,143 / 1,760 over three (≈30,800 L2 per further note); the constant is now `{ daGas: 50_000, l2Gas: 1_900_000 }` (2.3× the one-note bill, room for thirty-two notes beyond the three-note one; 28× DA), see `lessons/phase-2.md`. |
| 3 | The "no app-set fee" rule | Kept for public exits and re-scoped: the pin becomes "a public exit carries no app-set fee; a private exit names the PrivateFPC". |
| 4 | Sponsored FPC for private exits | No: the sponsor's `sponsor_unconditionally` is a public call paid by a public contract — the payer is not the user, but the sponsor is absent on mainnet (owner ruling, "no sponsorship on bridge paths") and the fence must not depend on it. |
