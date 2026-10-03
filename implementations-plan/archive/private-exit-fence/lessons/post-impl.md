# Post-implementation — codex fix loop

`code_review: off`. Reviewer: codex (GPT-6 Astra) at `high`, fresh session
`01a0767e-c843-7cc0-8fe8-714c8ef4a58b`, over the diff, with the adversarial ask
(can a private exit still reach a public payer; the ceiling arithmetic; the wizard's stand-in
ceiling; the fee on the simulate) and the two rules.

## Round 1 — VERDICT: conditional approve

| # | Finding | Verified | Action |
|---|---|---|---|
| 1 P2 | The confirm checked affordability only: fees up under the review with ample credit signed for a ceiling nobody approved, and exits stored no `ownGasCeiling` | yes | The review snapshots the exit ceiling (`setsAsideHeldGas`); `privateExitStoodDown` applies the token-only rule (now-priced / moved past a tenth); the composable takes `approvedCeiling` (shown + the tenth) and refuses a higher final price before any authwit (`repriced`). Pins: rising fees with ample credit stand down; the sent bound equals shown + tenth; the composable refuses above the bound. |
| 2 P3 | "would link your account" is categorical where a funded sponsor would not name the account | yes | "your wallet's default could name your account as the public fee payer" |
| 3 P3 | An exit's unpriced stand-down said "a claim from your held gas" | yes | `UNPRICED_EXIT` names the withdrawal |
| 4 P3 | The constant's comment claimed an unproven upper bound (a burn + `pay_fee`'s note selection is not bounded by a mint) | yes | Marked PROVISIONAL pending the exit canary; no constant change |

Codex's read of the fence: a journal resume only finishes on Ethereum and never resends the burn;
the public authwit transaction is sent for public exits only; the wallet's fee override keeps the
embedded `pay_fee` call (a conflicting payer fails setup rather than replacing the FPC); a wallet
without the FPC fails closed with no public fallback; the ceiling arithmetic matches `getFeeLimit`
with teardown zero; the wizard's stand-in ceiling cannot add the REGISTER limit because an exit
requires a registered token.

Applied in the follow-up commit; round 2 below.

## Round 2 — resumed session, the fix diff — VERDICT: approve

> No new material findings. All four fixes verified. The frozen ceiling's 10% tolerance is applied
> once, and the final composable pricing check enforces that bound before any authwit. No
> public-payer fallback was introduced. VERDICT: approve

Loop converged after two rounds; the PR opens after this entry.
