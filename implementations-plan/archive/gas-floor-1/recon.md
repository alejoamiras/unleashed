# gas-floor-1 recon

Base: `main` a111e8a. One Sonnet explorer (reuse sweep) plus the planner's own reads and live reads. Paths are
relative to the repository root; `src/` means `apps/tools/src/`.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Tell a venue refusal from an outage | `gasFailure` (`src/composables/useCrossChainRoute.ts:179`), fed only `c.venue.reverted()` | adapt: give it the `FuelQuoteRefusal` |
| The refusal's reason and figures | `FuelQuoteRefusal` (`packages/sdk/src/execution/fuel-quote.ts:48-54`): `provider`, `unsafe { field }`, `floor { expectedOut, floor }` | reuse as is |
| The claim-minimum sentence | `gasMinimumShortfall(quote, minFuelFj)` (`src/lib/send-model.ts:124`), shown by the Ethereum send (`SendWizard.vue:528`) and by `gasErrorOf` (`src/composables/useCrossChainSend.ts:188-197`) | reuse as is |
| Where a cross-chain gas refusal renders | `gasError` → `stepRoute.gasError` (`SendWizard.vue:392-396`) → `GasBreakdown :error` (`AmountStep.vue:325`) | reuse as is |
| The outage notice | `noticeOf` (`useCrossChainSend.ts:133-146`) string-matches `"The gas venue could not be read."` → `CrossChainState` `venue` | keep; add the new outcome kind |
| An SDK mapping of `floor` | `quoteRefusal` (`packages/sdk/src/execution/fuel-venue.ts:36-42`): `below-floor` with raw base units | not reused: SDK error text, not app copy; borrow its name |
| Route unit fixtures | `routeDeps({ venue })`, `Venue = "swapper" \| "reverts" \| "down" \| "answers-another-slice"` (`src/test/crosschain.ts:71-97`), real `testnetSwapperFuelProvider` with `minFuelFj: 1n` | adapt: add venues for under the floor, a zero rate and a broken pin |
| Send unit fixtures | `setup()` in `src/composables/useCrossChainSend.test.ts`, `routeDeps: (slice) => ({ ...routeDeps(), slice })` | adapt |
| Browser below-minimum check | cell 17 (`apps/tools/tests/browser/specs/deposit-token-gas.spec.ts:220-237`): Ethereum send, half of 1 USDT under the 1 FJ minimum, asserts `sendGasBreakdown` contains "minimum a claim needs", Next disabled, no signature | adapt as a new cross-chain cell in `deposit-crosschain.spec.ts` |
| Step estimates | `bridge-steps.ts:340` (`etas.sync`), `:435` (`DEPOSIT_ESTIMATES.sync`); `crosschain-steps.ts:316-317` (`aztecCopy().sync`) | change the four strings |

## Facts (verified)

1. **The defect, by trace.** On a fixed-terms (testnet) send, `quoteAcross` → `routerCallAt` → `gasAt`. The sizer
   (`sizerFor` → `useGasShare.propose`) caps the slice at half the delivery. `quote` runs `floorFor`, which refuses
   `{ reason: "floor" }` when the quote is under `minFuelFj`. `gasAt:200` passes no refusal to `gasFailure`. The read
   did not revert, so `reverted()` is false, and the result is `unavailable("The gas venue could not be read.")` →
   notice `venue` → "Gas can’t be priced right now." Demonstrated by the code; the arc's first test reproduces it.
2. **Live numbers** (Sepolia block 12021260, swapper `0x2b22…86ab`, USDC `0x1c7D…7238`): 1 USDC → 32 FJ, 0.3 USDC →
   9.6 FJ, 0.93 USDC → 29.76 FJ. Testnet manifest `l1.fuel`: `minFuelFj` 29773418555864000000, `slippageBps` 300.
3. **A `floor` refusal always means a quote under the minimum.** `signedMinFuelOutput` = max(q·(1−s), m) ≤ q
   whenever q ≥ m, so `floor > q` holds only when q < m; q ≤ 0 refuses with `floor = m`. The `floor ≤ 0` branch needs
   `minFuelFj = 0`, which `assertStaticRoots` (`packages/sdk/src/network.ts:79-80`) refuses unless the network's
   `feeJuice.minFj` is 0 (testnet 16 FJ). The explorer's claim that slippage alone can cause a `floor` refusal is wrong.
4. **`gasErrorOf`'s shortfall branch never fires.** It needs a route with `expectedOut < minFuelFj`, and the venue
   refuses any such quote first (fact 3). So no cross-chain send shows the claim-minimum sentence today.
5. **The Ethereum send, same amount:** `gasPlanFor` (`SendWizard.vue:482-503`) prices `fuelAmount × probe rate`
   and shows `gasMinimumShortfall` in the gas breakdown, with Next disabled (cell 17; `SendWizard.test.ts:900`).
   `GAS_TOO_SMALL` shows only when the slice takes the whole amount, which the half cap never allows for token + gas.
6. **The gas share already sizes to the floor.** `proposeGasShare` (`packages/sdk/src/protocol/gas-share.ts:47-71`)
   raises the target to `minFuelFj ÷ (1 − s)` (`capped: "min"`) unless that exceeds half the delivery
   (`capped: "half"`). An under-floor slice comes only from the half cap (out of scope). With live numbers a public
   token + gas send needs about 1.92 USDC delivered for an uncapped slice.
7. **Other outcome consumers.** Only `useCrossChainSend.ts` reads `CrossChainRouteOutcome` kinds (`noticeOf`,
   `route`). The review re-quotes through `requoteInPlace` → `settleRequote` (`SendWizard.vue:1093-1105`), which waits
   for `xc.loading` to fall; it then drops to the amount step when the answer is not ready.
8. **Readable answers shown as outages today:** a `floor` refusal, an `unsafe` refusal (LI.FI only: the swapper
   builds its own bytes) and a probe that reads zero (`sliceOf:186`) all reach `venue`.
9. **Inbox timing on the pinned line (6.0.0).** Both rollups: 72 s slots, 32-slot epochs, a checkpoint every slot
   (mainnet: 16 in 100 L1 blocks). The 6.0.0 Inbox is bucketed (`getCurrentBucketSeq`, `getBucket`), and a checkpoint
   consumes up to any bucket boundary (`inboxConsumedBucket` in the rollup's checkpoint log). Measured from each
   message's L1 block to the first L2 block whose `l1ToL2MessageTree.nextAvailableLeafIndex` passes its index:
   testnet 36–84 s (median 60 s, 11 messages, leaves 563–653); mainnet 36–96 s (median 72 s, 11 messages,
   leaves 329–419). Public reads: `aztec-testnet.drpc.org`, `aztec-mainnet.drpc.org`, publicnode L1 RPCs.

## Collisions

- PR #59 (send-copy-1) edits `SendWizard.vue`, `CrossChainReview.vue` and `crosschain-steps.ts` (lines 87-107 and
  252-255), not lines 316-317. This plan does not edit `SendWizard.vue` or `CrossChainReview.vue`.
- No open issue and no closed `known-limit` issue covers the gas floor or the step estimates (`gh issue list`
  searches "gas floor", "floor gas venue"; known limits #31 and #36 are unrelated).

## Search trail for absences

- Floor mappings: `reason === "floor"`, `"floor"`, `quoteRefusal` over `apps/` and `packages/`, tests excluded.
- Venue notice tests: `venue|sendXcNotice|data-notice` over `src/**/*.test.ts` and `apps/tools/tests/browser/`.
- Estimates: `git grep "1-4 min\|1–4 min\|1-4 minutes\|1–4 minutes"` outside the archive.
