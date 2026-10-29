# send-copy-1 recon (base `main` a111e8a)

One Sonnet explorer (tests, browser cells, failure path) plus the driver's own reads. Paths are repo-relative;
`T/` is `apps/tools/`.

## Reuse map

| Capability needed | Existing code | Verdict |
|---|---|---|
| Testnet-only copy switch | `IS_MAINNET` (`T/src/lib/network.ts:63`); `figures.fixed` / `rec.route.terms === "fixed"` (fixed terms exist only off mainnet: `T/src/composables/useCrossChainRoute.ts:355`, `packages/bridge-core/src/across-self-built.ts:53`) | reuse-as-is |
| The review's notice, Takes line, Refund row | `T/src/components/send/CrossChainReview.vue:90-95`, `:119-124`, `:237-240` | adapt (strings, one `v-if`) |
| The Bridge step line and the strip's ETA | `bridgingPrompt` and `bridgeCopy` in `T/src/lib/crosschain-steps.ts:92-99`, `:255` | adapt (strings) |
| The expired card | `expiryHappened` and `expiredCopy` in `T/src/lib/crosschain-outcome.ts:136-158` | adapt (testnet branch) |
| The Activity row and card guide of an expired send | `currentRowParts`, `phaseDetail`, the expired guide in `T/src/lib/crosschain-activity.ts:119-124`, `:143-144`, `:258` | adapt (testnet branch) |
| A pause read before any prompt | SDK `assertOpen` (`packages/sdk/src/execution/l1-deposit.ts:92-96`), private; `depositL1` runs it unless `pauseCheck: false` (`:359`) | adapt: export it through `@unleashed/sdk/internal` |
| The bridge trust check | `bridgeNetwork` → `parseNetwork` (`T/src/contracts/bridge-generation.ts:82-88`, `packages/sdk/src/network.ts:136`) | reuse-as-is, called earlier |
| SDK error → app sentence | `appFailureOf` (`T/src/composables/useSend.ts:805-815`), `failWith` (`:449`) | adapt (one code, one call site) |
| A paused factory in the browser | `writeL1(..., "setPaused", [true, false])` in `T/tests/browser/specs/deposit-crosschain.spec.ts` cell 53 | reuse-as-is |
| After shots | the shots lead's method: a throwaway `zz-*.spec.ts` through `scripts/e2e/agent.sh`, with a display-only label change in `T/src/lib/network.ts`, reverted | reuse-as-is |

No new module is needed. Searched for an existing "paused" sentence on the deposit path: `paused` in `T/src`
finds only the exit notice (`T/src/components/send/ReviewStep.vue:168-169`) and the wallet session.

## Failure path today

- `performSend` (`T/src/composables/useSend.ts:486-521`) checks the wallet chain, then runs the Aztec wallet's
  grant prompt (`ensureSendGrant`, `:461-471`, `useTokenGrant.ts:46-63`, a prompt for a token not yet granted),
  then `executeSend`.
- `executeSend` (`:634-666`) runs `bridgeNetwork(reads)`, then `depositL1` with `pauseCheck: false`
  (`:681`, pinned by `useSend.test.ts:794-805`).
- A node that does not answer throws its raw error from `getNodeInfo` (`network.ts:92`). A contract mismatch throws
  `invalid-network` "the deployed contracts are not this release's network: …" (`network.ts:126`).
- `appFailureOf` passes both through. `sendFailureCopy` (`T/src/lib/wallet-errors.ts:36-46`) keeps the raw
  message. `ReviewStep.vue:172-173` shows it as `sendReviewError`.
- A paused route reaches the router's revert at the estimate, after the Permit2 approval and the signature.

## Tests that assert the copy that changes (all run as the testnet build)

- `T/src/components/send/CrossChainReview.test.ts:65-66`, `:78`, `:102`.
- `T/src/lib/crosschain-steps.test.ts:155-161`.
- `T/src/components/CrossChainOutcome.test.ts:53-57`.
- `T/src/components/BridgeJournalCard.crosschain.test.ts:85-88`.
- `T/src/composables/useActivityFeed.test.ts:113-114`, `:164`.
- `T/src/components/ActivityRow.test.ts:105-108`.
- `T/src/composables/useSend.test.ts:794-805` (the `pauseCheck: false` pin).
- No unit test runs the mainnet branch of these strings. The mock pattern for `IS_MAINNET` is in
  `T/src/components/BridgeFooter.test.ts:11-15`.
- No browser spec asserts this copy. `deposit-crosschain.spec.ts` cell 54 checks only the expired phase. No spec
  drives a paused route or a failed trust check on the Ethereum send. Searched `paused|trust|invalid-network`
  under `T/tests`.

## Collisions

- Open issues: only #40. Closed known limits #34 (a missed testnet deposit stays in the source pool) and #39 (the
  relayer's float) back the new wording.
- `sdk-1` works in the claim engine, `harden-1` reads only. Neither touches the send lane's copy or `performSend`.
- The cross-chain path (`useCrossChainSend.ts`, `crosschain-deposit-flow.ts`, `useCrossChainRoute.ts`) has no pause
  or trust check. A pause at fill time ends in LI.FI's recovery to the Ethereum wallet (cell 53).
