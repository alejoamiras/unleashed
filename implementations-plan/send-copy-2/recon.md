# send-copy-2 recon (main at e1d1c4c)

One Sonnet explorer inventoried the strings; the gate and error traces were read by hand. Paths are under
`apps/tools/src/` unless named otherwise.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Read the route's pause | `assertDepositsOpen(net, reads, intent)` (`packages/sdk/src/execution/l1-deposit.ts:91`), through `@unleashed/sdk/internal` | reuse as is |
| The checked network for those reads | `bridgeNetwork(reads)` (`contracts/bridge-generation.ts:82`), cached per session | reuse as is |
| Ethereum reads while the wallet sits on the source chain | `readClientFor(NETWORK.l1ChainId)` (`composables/useEthereumReader.ts:17`), already imported by `useSend.ts:66` and used by `useCrossChainSend.ts:213` | reuse as is |
| The paused sentence | `DEPOSITS_PAUSED` (`composables/useSend.ts:803`) | reuse as is |
| The confirm's hold and its post-await guard | `heldCheck` + `reviewStands` (`components/send/SendWizard.vue:1186-1212`) | adapt: `heldCheck` takes the check to run |
| A sentence on the cross-chain review | `xcError`, rendered as `sendReviewError` (`components/send/CrossChainReview.vue:255`), cleared by `clearCrossChainReview` at every `enterReview` | reuse as is |
| One place every review entry passes | `enterReview` (`SendWizard.vue:949`); Back, Next, the strip, a stand-down and a requote all reach it | reuse: P9-02 clears there |
| Testnet/mainnet copy branches | `figures.fixed`, `route.terms === "fixed"`, `IS_MAINNET`, `RETRY_WORDS` (`lib/crosschain-figures.ts:131`) | reuse; no new branch mechanism |
| Mainnet controls in copy tests | `CrossChainReview.test.ts:122`, `CrossChainOutcome.test.ts:138`, `useActivityFeed.test.ts:124` | reuse; extend where a string gains a branch |
| Paused-route browser fixture | `setPaused` on the factory, `deposit-crosschain.spec.ts:250` (cell 53), serial (`workers: 1`) | reuse for one pre-confirm step |

No new module is needed. Absence search for an existing cross-chain pause check: `grep -rn "depositsPaused\|assertDepositsOpen\|DEPOSITS_PAUSED" apps/tools/src` finds only the Ethereum path (`useSend.ts`).

## P9-01 trace: the cross-chain path and the pause

- The wizard skips the bridge check for a cross-chain review (`SendWizard.vue:1174`, `!snapshot.crossChain && …`).
- `runCrossChain` (`:1123`) reads `contractRefusal` (a source-chain code read, no prompt), then `xc.send`. The first
  wallet prompt is inside `xc.send`: the seal for a private send, else the approval or the LI.FI transaction
  (`composables/crosschain-deposit-flow.ts:1-8`).
- `useSend.check` reads through the wallet's own client (`sendReads`, `useSend.ts:807`). On a cross-chain review that
  client answers for the source chain (`xcWalletChainId` holds confirm until the wallet is there, `SendWizard.vue:1300`),
  so reusing `check` unchanged would read the wrong chain.
- The cross-chain delivery calls the router's `bridgeFromCaller` on Ethereum (`packages/bridge-core/src/crosschain-route.ts:43`),
  which reverts on `FACTORY.depositsPaused()` for every leg (`contracts/bridge/evm/src/DepositRouter.sol:29`, `:235`).
  `assertDepositsOpen` reads the same flag on `net.bridge.factory` for every intent of a network with a bridge.
  So the pause the Ethereum preflight reads is the pause that refuses a cross-chain delivery.
- Today a paused route lets the send go; the delivery recovers to the user's Ethereum wallet and the relay fee is
  spent (cell 53; card "Delivered to your Ethereum wallet instead").

## P9-02 trace: errors that survive Back then Next

| State | Shown as | Written by | Cleared today by |
|---|---|---|---|
| `sendFlow.error` | `sendReviewError` (`ReviewStep.vue:172`) | the bridge check (`SendWizard.vue:1197`), `performSend` failures | the next confirm (`useSend.ts:491`), `standDown` (`SendWizard.vue:1485`) |
| `exitFlow.error` | same line | `performExit` (`composables/useHubExit.ts:594-625`) | the next exit (`:533`), `standDown` |
| `exitFlow.paused` | `sendPausedNotice` (`ReviewStep.vue:168`) | an exit refused as paused (`useHubExit.ts:611`) | the next exit (`:641`) |
| `grantState: "declined"` after a deposit | `sendGrantDeclined` (`ReviewStep.vue:161`) | `runSend`'s tail (`SendWizard.vue:1373`) | `resetAmount`, the next confirm |
| `xcRefusal`, `xcError` | the cross-chain review | the cross-chain confirm | every `enterReview` already (`clearCrossChainReview`) |

An exit's `grantState` is written at token selection (`ensureExitGrant`, `SendWizard.vue:818`), not by a send.

## The before list (testnet only; mainnet strings are unchanged)

| Id | Surface | When it shows | Today | Where |
|---|---|---|---|---|
| R1 | Review notice | every testnet cross-chain review | Testnet: our testnet relayer fills this send on {l1}, usually within a few minutes. | `CrossChainReview.vue:121` |
| R2 | Review, Send row | same | Fixed testnet terms: the relay fee is {fee} of the amount, and one send carries at most {cap} {symbol}. | `:75` |
| R3 | Review, Takes row | same | Usually a few minutes for our testnet relayer to fill it on {l1}, a few minutes for Aztec to pick it up, then your claim. | `:92` |
| R4 | Review, fallback note | same | If the deposit can’t run on {l1}, the {symbol} goes to your own address {user} there instead. You can continue from there later; that needs a little test ETH for gas. | `:197-199` |
| R5 | Review, Details "Quote" | Details open | Fixed testnet terms, rebuilt every 60 s | `:241` |
| R6 | Review, band under it; on phones the review's bottom bar | while the review stands | Terms valid for {0:42} · rebuilt before you sign | `lib/crosschain-figures.ts:127`; both templates hard-code "valid for … before you sign": `SendWizard.vue:1874-1875`, `CrossChainReview.vue:260-262` (shown at ≤760 px) |
| R7 | Review, in Sign's place | after 60 s on the review | These terms expired. / They’re rebuilt from the latest block; nothing was signed. / [Rebuild terms] | `CrossChainState.vue:71-72`, `:128` |
| W1 | Review and card buttons; also the amount step's refused-route box (`AmountStep.vue:331` renders `CrossChainState`) | a refused or switched-account route; an expired or unsent card | [Get new terms] | `lib/crosschain-figures.ts:137`, used at `CrossChainState.vue:49`, `CrossChainOutcome.vue:163` |
| S1 | Progress, Bridge step; card guide while bridging | from the source confirm until the fill lands | {rail} holds your {symbol} until our testnet relayer fills it on {l1}. Nothing for you to do. | `lib/crosschain-steps.ts:97`, `lib/crosschain-activity.ts:249` |
| S2 | Progress, Bridge step time; also the background strip (`SendWizard.vue:1549`) | same; and as a pending step's estimate | usually a few minutes, up to {window} / up to {window} | `lib/crosschain-steps.ts:254-255` |
| C1 | Card guide | an expired send | It wasn’t filled on {l1} within {window}. (no window recorded: "… in time.") | `lib/crosschain-activity.ts:266-270` |
| C2 | Outcome panel | an expired send | title Not filled on {l1}; happened This transfer waited {window} for our testnet relayer on {l1} and wasn’t filled, so it expired. (no window: "This transfer wasn’t filled on {l1} in time, so it expired."); means Nothing reached {l1} or Aztec, and there is nothing to claim. {rail} keeps the {symbol} in its pool on {src}: testnet sends are not refunded automatically. The network fee for the send is not returned.; next Try again with new terms. Or send from another network instead. | `lib/crosschain-outcome.ts:137-162` |
| C3 | Outcome panel, "What to do next" | an unsent send | Get new terms and sign again. (open approval: "Revoke the approval, or get new terms and sign again."; reverted: "… Your amount, privacy and gas choice are kept.") | `lib/crosschain-outcome.ts:180-206` (`RETRY_WORDS.signAgain`) |

Activity row: no testnet string names a mechanism. An expired testnet row reads "Expired" with the visibility
(`lib/crosschain-activity.ts:122`, `:146`); every other row word is shared with mainnet. Strings shared by both
networks (route lines, You sign, the session log, the finalize lines) stay out: mainnet copy is unchanged.

## Collisions

- gas-floor-1 edits `useCrossChainRoute.ts`, `useCrossChainSend.ts` and the step-estimate strings: S2 is a step
  estimate, so it is an owner ask that names the overlap. Neither arc edits either composable.
- balances-1 edits `SendWizard.vue`'s balance reads; a1 edits its preflight and `enterReview`, different hunks.
- #65 (repeated-send record) is out of scope. No closed `known-limit` issue covers a cross-chain pause.
