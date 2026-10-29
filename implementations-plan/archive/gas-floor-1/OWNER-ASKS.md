# gas-floor-1 owner asks

The plan itself needed none: ask28 reuses the claim-minimum sentence the Ethereum send shows, and ask32 is the
owner's own wording ("~1 min", "usually ~1 min"). The arc's review found two timing sentences that now sit beside
the new estimate. Neither is in the approved budget, so the arc ships without changing them.

## 1. The Ethereum review's end-to-end time

- **Surface:** the Ethereum send's review, `DEPOSIT_TAKES` in `apps/tools/src/components/send/SendWizard.vue`:
  "usually 3–8 min end to end". Its comment says it is the rail's own estimates summed and rounded up.
- **Why now:** with Cross to Aztec at "~1 min", the steps sum to about 2–4 min (deposit under 1 min, crossing about
  1 min, your signature, confirm 1–2 min). The review now says about twice what the step list says.
- **Options:**
  - A: keep "usually 3–8 min end to end". The review overstates the total, and the comment's rule no longer holds.
  - B: "usually 2–4 min end to end", by the same summing rule.
- **Recommendation:** B.
- **What ships now:** A (unchanged).

## 2. The cross-chain review's Aztec pickup

- **Surface:** the cross-chain review's "takes" line in `apps/tools/src/components/send/CrossChainReview.vue`:
  "…, a few minutes for Aztec to pick it up, then your claim."
- **Why now:** the step list directly under it now says "Cross to Aztec ~1 min" for the same wait.
- **Options:**
  - A: keep "a few minutes for Aztec to pick it up".
  - B: "about a minute for Aztec to pick it up".
- **Recommendation:** B. ask32's "wherever the app shows the Cross to Aztec step" may already cover it; the owner
  decides.
- **What ships now:** A (unchanged).
