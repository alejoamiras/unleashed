---
plan: lifi-routing
tier: mega-deep
driver: claude-code
eli5_mode: artifact
code_review: off
claude_model: opus
codex_model: sol
status: approved; arc 1 in progress; G-UX-1 and G-UX-2 signed
base: main
budget: "research: lead 4 subagents + the fable and codex drafts' own; code-review: off; foreign reviewer at high"
---

# lifi-routing: deposits from any chain through LI.FI, token and gas, one provider

## Summary

A new contract, **`DepositRouter`**, replaces the Uniswap V4 fuel leg with one swap seam: it executes LI.FI
same-chain swap calldata (`GenericSwapFacetV3` on the LI.FI Diamond on mainnet; an ABI-identical
`TestnetFuelSwapper` on testnet and in the sandbox) against an **immutable** target, two pinned selectors and
an on-chain `_receiver == router` check, with its own balance-delta floor as the binding guarantee. It has two
entrypoints into one internal settle: `bridgeWithPermit` (Ethereum EOAs, Permit2 witness) and
`bridgeFromCaller` (LI.FI's destination Executor after a cross-chain bridge: it measures what arrived, bounded
by `maxPull`, swaps a fixed slice into Fee Juice and deposits the rest into the token's portal). Every failure
reverts, so LI.FI's receiver hands the full amount to the user's own Ethereum address.

On the source chain the user signs an exact approval and a LI.FI transaction the app has decoded byte for byte
(one prompt when the wallet batches through EIP-5792). Testnet runs Base Sepolia → Across → Sepolia → Aztec
testnet through LI.FI's real contracts and our own calldata builder; mainnet is proven on forks with real LI.FI
quotes over Stargate V2, the only rail LI.FI quotes there. `DepositRouter` deploys **alongside** today's
`SwapBridgeRouter`; every arc leaves `main` working, and Uniswap goes last. Owner target: testnet live,
mainnet-ready on forks, **no mainnet deploy**, deposits only.

## Outcome & Quality Bar

**For whom.** A person holding USDC (or WETH) on an L2, with no ETH on Ethereum, who wants tokens on Aztec plus
the gas to use them and will close the tab while the bridge runs; the existing Ethereum-origin user, whose flow
keeps working under a new swap provider; the operator who deploys and canaries from the runbook; the maintainer
who inherits one swap seam instead of a Uniswap stack.

**What excellent looks like.**
1. **One source transaction lands tokens and Fee Juice on Aztec testnet, and the live canary claims them**
   (public, private, private fuel) from Base Sepolia. The same router bytecode and the same LI.FI Executor run on
   mainnet forks with real LI.FI quotes, and the same client decoder accepts those recorded quotes. The app's
   mainnet path (li.quest from the browser, its CSP) and discovery against mainnet's older Inbox `MessageSent`
   (`research/lifi-onchain.md:34`) are not exercised here; both are entry gates of the mainnet plan.
2. **Every path ends in a named, recoverable place that survives a reload.** Deposited (claimable on Aztec),
   delivered to the user's own Ethereum address (LI.FI recovery, shown with its transaction and the
   "continue from Ethereum" path), or expired on the source chain (refund pending). None is `blocked`. A fork
   test proves each branch; halmos and a stateful invariant prove the router never spends funds it did not
   acquire in the current call and leaves no approval behind.
3. **The app signs nothing it did not build.** Before any source signature, the client decodes the transaction
   down to the nested fuel swap, compares the destination call byte for byte with its own encoding, and refuses
   on any difference. The decoder is mutation-tested: moving any single field of a recorded route outside its
   policy (any change for a pinned field, past the bound for a bounded one) makes it refuse, naming the field.
4. **Uniswap is gone.** No V4 contract, script, CI pin, manifest field or copy remains; the only residue is a
   frozen legacy-router ABI that lets in-flight testnet records recover.
5. **The screens are the ones the owner signed.** Every visible surface matches its signed board (Design binding,
   under UI surfaces) at both viewports and in both themes; nothing on screen was invented during implementation.

**Where good enough stops.** Source assets are the bridged rail assets (USDC, WETH): no source-side swaps. No
any-chain exits. No smart-contract source accounts (EOAs and EIP-7702-delegated EOAs only). No Permit2Proxy or
EIP-2612 source path. No hosted testnet relayer: liveness rests on Across's relayers plus `fill-testnet.ts`, an on-demand self-fill.
The Stargate rail is proven on forks only; the LI.FI quote API is proven by unit tests, recorded fixtures and the
fork replay, never in the browser (mainnet renders its placeholder). The UI implements the signed board set and
nothing beyond it.

## Architecture & Implementation

### Proposed architecture

```
Source L2 (Base | Arb | OP; Base Sepolia on testnet)    Ethereum (Sepolia on testnet)                         Aztec
user ── approve(exact) + tx (or one EIP-5792 batch) ──► LiFiDiamond
          decoded by the app first                      (StargateFacetV2 mainnet | AcrossFacetV4 testnet)
                                                          │ rail: Stargate V2 (mainnet) | Across (testnet)
                                                          ▼
                              ReceiverStargateV2 | ReceiverAcrossV4 ──try──► LI.FI Executor (permissionless)
                              catch: everything → user's Ethereum address      │ approve + call, one step
                              (LiFiTransferRecovered)                           ▼
                                        DepositRouter.bridgeFromCaller(intent, swapData, minReceived, maxPull)
                                          ├─ pull min(balance, allowance, maxPull) from msg.sender, ≥ minReceived
                                          ├─ fuel slice → SWAP_TARGET (Diamond swapTokens*V3 | TestnetFuelSwapper)
                                          │     pinned selector, _receiver == router, exact approval reset to 0
                                          ├─ fee-asset Δ ≥ minFuelOutput → FeeJuicePortal ─────────────────► FJ claim
                                          └─ remainder → factory portal clone (get-or-create) ─────────────► token claim
Ethereum EOA ── Permit2 witness ──► DepositRouter.bridgeWithPermit(intent, swapData, amount, permit)   (same _settle)

SwapBridgeRouter (V4) stays deployed and in source until the last arc; in-flight records keep reconciling against it.
```

- **One new contract, two entrypoints, one internal `_settle`.** No abstract base and no second contract:
  nothing is duplicated, so recon's dedup risk 1 disappears instead of being managed. One transient reentrancy
  lock covers every path.
- **`TestnetFuelSwapper`** (testnet and sandbox only) has the exact ABI of `swapTokensSingleV3ERC20ToERC20`, so
  the router's selector and `_receiver` checks, its bytecode and the client decoder are identical on every
  network. It pays Fee Juice at a fixed per-token rate from inventory, topped up from the permissionless testnet
  `FeeAssetHandler.mint`, and its constructor reverts on chain id 1.
- **No Noir, portal or factory change.** Portal clones accept any caller and the claim reads only
  `(amount, secret, leaf)`; `createPortal` is get-or-create. A new router is a router-only deploy on the current
  generation, not a new generation (`promotion.ts` locks identity, factory and hub only).
- **Core, app and ops** changes are listed per arc in the *File-level change map*.

### Key interfaces, types, schemas

**Solidity: `contracts/bridge/evm/src/DepositRouter.sol`**

```solidity
contract DepositRouter is Ownable2Step, ReentrancyGuardTransient {
    struct DepositIntent {
        address token;            // the Ethereum ERC-20; == permitted.token on the Permit2 path
        bytes32 aztecRecipient;   // public token leg only; 0 when private or fuel-only
        bytes32 tokenSecretHash;  // 0 ⇔ fuel-only
        bool    isPrivate;
        uint256 fuelSlice;        // token units into the swap (or the identity leg); 0 = no fuel leg
        bytes32 fuelRecipient;    // the user (public fuel) or the PrivateFPC (private fuel)
        bytes32 fuelSecretHash;
        uint256 minFuelOutput;    // floor on the router's own fee-asset delta; > 0 whenever a swap runs
    }
    ISignatureTransfer public immutable PERMIT2;
    IFeeJuicePortal    public immutable FEE_JUICE_PORTAL;
    IPortalFactory     public immutable FACTORY;
    address            public immutable FEE_ASSET;     // FEE_JUICE_PORTAL.UNDERLYING()
    address            public immutable SWAP_TARGET;   // LI.FI Diamond (mainnet) | TestnetFuelSwapper; also the spender
    bytes4 internal constant SWAP_SINGLE   = 0x4666fc80; // swapTokensSingleV3ERC20ToERC20
    bytes4 internal constant SWAP_MULTIPLE = 0x5fd9ae2e; // swapTokensMultipleV3ERC20ToERC20

    function bridgeWithPermit(DepositIntent calldata, bytes calldata swapData, uint256 amount, PermitParams calldata) external;
    function bridgeFromCaller(DepositIntent calldata, bytes calldata swapData, uint256 minReceived, uint256 maxPull)
        external returns (uint256 tokenAmount, uint256 fuelOut);
    function sweep(address token, address to) external onlyOwner;   // donated residue only

    event Deposited(bytes32 indexed tokenSecretHash, bytes32 indexed fuelSecretHash, address indexed token,
        address payer, uint256 received, uint256 tokenAmount, bytes32 tokenKey, uint256 tokenIndex,
        uint256 fuelIn, uint256 fuelOut, bytes32 fuelKey, uint256 fuelIndex, bool isPrivate);
}
```

Shape rules, checked before any pull:
- `FACTORY.depositsPaused()` ⇒ revert, for **every** leg, fuel-only included (Ask A8).
- Fuel-only ⇔ `tokenSecretHash == 0`; then `aztecRecipient == 0`, `fuelSlice > 0`; on the caller path
  `minReceived == maxPull == fuelSlice`, on the Permit2 path `fuelSlice == amount`.
- Private ⇒ `aztecRecipient == 0` (today's `witnessRecipient`, `send-flow.ts:155-160`).
- `fuelSlice == 0` ⇒ empty `swapData` and zero fuel fields.
- `token == FEE_ASSET && fuelSlice > 0` ⇒ identity leg: empty `swapData`, the slice goes straight to the
  FeeJuicePortal, and any remainder goes only to the fee asset's own clone, never the FeeJuicePortal.
- Otherwise a swap runs: `swapData.length ≥ 164`, its selector ∈ {`SWAP_SINGLE`, `SWAP_MULTIPLE`}, the full
  word at calldata offset 100 (`_receiver`, identical in both functions' heads) equals `address(this)`, and
  `minFuelOutput > 0`.

Consumption rule: the caller path with a token leg accepts `consumed ≤ fuelSlice`, and the unconsumed input joins
the token leg (`GenericSwapFacetV3` returns leftover input to `_receiver`). The Permit2 path and every fuel-only
send require `consumed == fuelSlice`: the Permit2 path keeps its exact v2 envelope, and a fuel-only send has no
token leg to absorb leftovers. On the Permit2 path that revert costs a retry. On the caller fuel-only path it
becomes a LI.FI recovery: the bridge fee is spent and a retry needs ETH on Ethereum, so Phase 2 proves the allowed
venues consume the slice exactly.

Stray input at the target: `GenericSwapFacetV3` returns the Diamond's **whole** input-token balance (once above one
unit; a one-unit balance stays as dust, so one unspent unit counts as consumed), not a delta,
so anyone can put 2 wei there first, and `swapTokensMultiple…` lets each step skip its pull (`requiresDeposit`), so
the facet may also swap a balance it already held. The router therefore measures, rather than assumes, the gross
pull: `pull = fuelSlice − the allowance left after the swap` (read before it is zeroed; the rail and manifest
tokens decrement allowances). With `targetBefore = balanceOf(SWAP_TARGET)` read before the swap and `returned` the
input that comes back: `stray = min(returned, targetBefore)` is residue (kept, sweepable, never deposited, never a
revert); `leftover = returned − stray` must be ≤ `pull`; `consumed = pull − leftover`, to which the rules above
apply, and the unpulled `fuelSlice − pull` is unconsumed input like any leftover. `TestnetFuelSwapper` always
pulls the slice and returns nothing.

Permit2 witness (`bridgeWithPermit`; Permit2 itself binds the token, the amount, the router as spender, the
nonce and the deadline; `SWAP_TARGET` is immutable; `intent.token == permitted.token` and
`amount == permitted.amount` are required):

```
DepositWitness witness)DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)TokenPermissions(address token,uint256 amount)
```

`swapDataHash = keccak256(swapData)`; plain sends sign `fuelSlice = 0` and the hash of empty bytes. This follows
Across's `SwapAndDepositData` pattern of hashing every `bytes` field.

**`contracts/bridge/evm/src/TestnetFuelSwapper.sol`**: `swapTokensSingleV3ERC20ToERC20(bytes32, string, string,
address payable _receiver, uint256 _minAmountOut, LibSwap.SwapData _swapData)` pulls `_swapData.fromAmount` of
`sendingAssetId` from `msg.sender`, requires `receivingAssetId == FEE_ASSET`, pays
`fromAmount · rate[token] / 10^decimals` to `_receiver` (≥ `_minAmountOut`), mints from the handler at most three
times when short and otherwise reverts. Owner (`Ownable2Step`): `setRate(token, fjPerWholeToken)` and `sweep`;
`quote(token, amountIn)` is a view. The constructor takes `(feeAsset, feeAssetHandler /* 0 = inventory only */,
owner)` and reverts when `block.chainid == 1`.

**Manifest (`packages/bridge-core/src/manifest-v2.ts`; stays `schema: 2`, `.strict()` throughout)**

```ts
bridge.l1 += {
  depositRouter?: Address                 // arcs 2-4 additive; the only router after arc 5
  fuelSwapper?: Address                   // = the router's SWAP_TARGET off mainnet; refused when l1ChainId === 1
  fuel?: { slippageBps, crossChainSlippageBps, minFuelFj, fjPerTx, fjRegister }   // budgets out of the V4 `swap` block
  legacyRouters?: Address[]               // in-flight reconcile only
}
bridge.routing?: null | { provider: "lifi",
  sources: [{ chainId, rail: "acrossV4" | "stargateV2", tokens: [{ address, symbol, decimals, destToken }] }] }
// arc 5 removes l1.router, l1.swapTarget, l1.swap and tokens[].pools, and moves the old router into legacyRouters
// refine: every routing destToken is a manifest token with a portal; fuelSwapper is present iff depositRouter is and l1ChainId !== 1 (so today's manifests
//   still parse); it is refused whenever l1ChainId === 1
```

LI.FI, Across and Stargate addresses are third-party constants like Permit2: **`packages/bridge-core/src/lifi-addresses.ts`**
holds, per chain (1, 8453, 42161, 10, 11155111, 84532): Diamond, Executor, ReceiverAcrossV4, ReceiverStargateV2,
the FeeCollector the API uses, the facet behind each selector we accept, Across SpokePool, Stargate pools and
LayerZero EndpointV2, plus pinned runtime code hashes for the immutable, non-proxy periphery (Executor,
receivers). The manifest only enables sources. The mainnet book therefore exists, and is verified, before any
mainnet manifest does.

**Core TypeScript.** `fuel-quote.ts`: one `FuelQuote { provider, swapData, amountIn, expectedOut, minOut }` for
the LI.FI and testnet-swapper providers. `lifi-decode.ts`: `verifyRoute(tx, expected)` returns
`{ ok: true, decoded } | { ok: false, field, reason }` and fails closed: any selector, encoding or field it does
not know is a refusal. It never re-encodes provider bytes; it compares each field against a stated policy:
- **Transaction**: `chainId`, `from` = the connected account, `to` = the pinned Diamond; `value` = 0 on Across and
  = the LayerZero native fee on Stargate, bounded by the Stargate rule below.
- **Source fee step** (LI.FI's FeeCollector call, if present): selector, token = `srcToken`, our integrator fee 0,
  LI.FI's fee ≤ the pinned 0.25 % (`research/lead-lifi-api-shapes.md:29`), the collector address from the book; the approval spender is the
  Diamond and the amount is exactly the input.
- **Across**: every `AcrossV4Data` field equal to what our builder produced (testnet builds the bytes itself). An
  API-authored Across route (mainnet) has no policy yet and is refused.
- **Stargate**: asset and pool from the book, destination EID = Ethereum, padded recipient = the pinned
  ReceiverStargateV2, `minAmountLD ≥ T`, `oftCmd` empty, execution options = exactly one compose option with
  index 0, value 0 and gas ≥ the measured limit (no native drop, no lzReceive value), messaging fee ≤ the pool's own
  `quoteSend` read from the source chain plus 10 %, refund address = the user.
- **Destination message**: `transactionId` = `lifiTxId`, receiver (the compose fallback) = the user's own address,
  exactly one `SwapData` step whose seven members all equal our builder's (`callTo = approveTo = depositRouter`,
  `sendingAssetId = receivingAssetId` = the rail asset, `fromAmount` per D7, `callData` byte-equal to our
  `bridgeFromCaller` encoding).
- **`ILiFi.BridgeData`**: `transactionId` = `lifiTxId`, `integrator` = `unleashed` (A9), `sendingAssetId` =
  `srcToken`, `receiver` per rail (Across: our builder's value; Stargate: the user, as LI.FI's recorded quote has
  it, `research/lead-lifi-api-shapes.md:35`, while the transport recipient and compose fallback are checked
  separately below), `minAmount` = the input minus the fee step,
  `destinationChainId` = the manifest's `l1ChainId`, `hasSourceSwaps` = whether the fee step is present,
  `hasDestinationCall` = true; `bridge` and `referrer` are listed as unpoliced labels.
- **Nested fuel swap** (inside our calldata, so built by us from the LI.FI quote): selector ∈ the two pinned ones,
  `_receiver` = the router, `_minAmountOut` = `minFuelOutput`, the first inner `sendingAssetId` = the rail asset
  with `fromAmount` = `fuelSlice`, at most one asset-changing step after LI.FI's fee step (the facet returns each
  step's leftover input to `_receiver`, so a multi-hop route would strand intermediates in the router), the last
  `receivingAssetId` = the fee asset, the quote's tool in the Phase 2 allow-list
  (D9; an API field, so the floor still binds). Inner `callTo`/`approveTo` are not policed client-side: the facet's on-chain `LibAllowList` gates
  them and the router's floor bounds any loss to the slice (D4).
The mutation suite is generated from every decoded ABI leaf, not from the policies: each leaf is either policed
or named in the decoder's unpoliced list with its reason, so a field nobody polices fails the suite.
`crosschain-discovery.ts`:
`discoverCrossChain(record, reads)` returns pending, incomplete, not-sent (only a source receipt with status 0 at
a finalized source block; absence proves nothing, because a submitted transaction can still mine after any quote
expiry), deposited, delivered-to-wallet or expired-on-source. A send with no known hash stays pending and watched;
the app says that resending may let both go through.

**Journal (`packages/bridge-core/src/journal.ts`): cross-chain records are schema 4, under their own storage
key.** Ethereum-origin records stay schema 3 under `JOURNAL_KEY`. An already-open old tab rewrites `JOURNAL_KEY`
from `loadJournal`, which drops what its validator rejects (`journal.ts:357`, `:368-391`), so a schema-4 record
there would vanish with its sealed secret; a separate key is one old code never reads or writes. The new client
reads both keys, and backups carry both.

```ts
type CrossChainDepositRecord = Omit<SendDepositRecord, "schema"> & { schema: 4; route: {
  provider: "lifi"; rail: "acrossV4" | "stargateV2"
  srcChainId: number; srcToken: Address; srcAmount: string; srcSender: Address; srcScanFromBlock: string
  srcBatchId?: string                             // EIP-5792 call-batch id; not a transaction hash
  srcTxHash?: Hex
  lifiTxId: Hex                                   // BridgeData.transactionId
  transport?: { kind: "across"; originChainId: number; depositId: string; relayHash: Hex }
    | { kind: "stargate"; guid: Hex; pool: Address }
  router: Address; minReceived: string; maxPull: string; scanFromBlock: string; etaSeconds: number
  fillDeadline?: number                           // Across only
  outcome?: "not-sent" | "delivered-to-wallet" | "expired-on-source"; outcomeTxHash?: Hex; outcomeAmount?: string
  extraDeposits?: { txHash: Hex; leafIndex: string; amount: string }[]   // authenticated gifts to the same secret
  depositFinal?: true      // the deposit's block is at or below Ethereum `finalized`; never beside an outcome
} }
```

`JournalBase.chainId` keeps meaning the destination L1 (recon risk 5). New display stage `bridging` before
`syncing`; outcomes are terminal facts with `completedAt`, never `blocked`, set only once the deciding block is
at or below `finalized` on its own chain (the source chain for `not-sent`, Ethereum for every other outcome; block
heights are never compared across chains) (until then the outcome shows as provisional and resume keeps watching). A cross-chain
record is never auto-pruned or evicted by `capRecords` (`journal.ts:350-354`), which counts it as unfinished,
unless it ended `deposited` and claimed: a `delivered-to-wallet`, `expired-on-source` or
`not-sent` record, or one with an unclaimed `extraDeposits` leaf, keeps its secret until the user dismisses it, so
a read RPC lying about an outcome can mislabel a record but never delete its secret.

**Envelope (`packages/bridge-core/src/recovery-crypto.ts`)**: `DepositEnvelopeV3 = { v: 3; secret; recipient;
minAmount; maxAmount; sealerL1; salt? }`, used only while a cross-chain private record is bridging; it matches a
record when the recipient is equal and `minAmount ≤ record.amount ≤ maxAmount`, with `record.amount` taken from
the authenticated chain event. The window is `[minReceived − fuelSlice, maxPull]`: under the caller path's
`consumed ≤ fuelSlice` the facet may consume almost nothing and return the rest to the token leg, so the upper
bound is `maxPull`, never `maxPull − fuelSlice`. The intended deposit must fall in that window; extras (Discovery 5) have only the floor as a bound and never
replace the intended deposit's amount or leaf. As soon as the per-record key is in memory (in session after discovery, or at the
claim-time unseal), the record is re-sealed as an ordinary exact v2 envelope. v2 is untouched; neither version
parses as the other.

### Data & control flow

**Cross-chain send (testnet shape; mainnet differs where marked).**
1. **Plan, no signature.** Read the Ethereum and source-chain heads (`scanFromBlock`, `srcScanFromBlock`). Fuel: `proposeGasShare` sizes the slice from
   a rate probe (testnet: swapper `quote`; mainnet: LI.FI same-chain), a quote at that exact slice gives
   `swapData`, `signedMinFuelOutput` the floor (both reused unchanged), and `fuel-quote.ts` overwrites the facet's
   `_minAmountOut` word (offset 132) with that floor; the quote is requested at the same slippage, so the venues'
   own inner minima sit at or below it, though a moved venue can still refuse first; mainnet cross-chain fuel quotes use
   `fromAddress = toAddress = router` and the venue options of D9. Rail: testnet = Across `/suggested-fees` (sent
   our `message`; gas depends on it) + our `across-v4.ts`; mainnet = `POST /v1/quote/contractCalls` with our
   calldata, `toAmount = T`, `toFallbackAddress = user`, the fork-measured `toContractGasLimit`. `minReceived` /
   `maxPull` per D7. Quotes are debounced, latest wins, 60 s TTL on Review.
2. **Verify.** `verifyRoute` on the exact bytes to be signed (on our own testnet bytes too: one decoder, one
   path). Review screen.
3. **Journal first.** Write the schema-4 record (`route`, secrets, `amount = minReceived − fuelSlice`, the floor).
   Private: seal the v3 envelope (the seal message binds `chain=<Ethereum id>` from the binding, not the wallet
   chain, `recovery-crypto.ts:27`). The record is written and read back before any source signature.
4. **Sign on the source chain.** `assertChain(srcChainId)`; re-run `verifyRoute`; exact `approve` (skipped only when
   the allowance already equals the input; a larger standing allowance, MAX included, is replaced by the exact
   amount, through 0 first for tokens that require it) + the LI.FI transaction, or one `wallet_sendCalls` batch with
   `atomicRequired: true` when `wallet_getCapabilities` reports atomic support. Persist `srcTxHash` the moment the
   wallet returns it; a batch returns only an id, so persist `srcBatchId` and take the hash from
   `wallet_getCallsStatus` receipts. An uncertain wallet reply (or a batch the wallet forgot) never offers a
   resend: `LiFiTransferStarted` indexes nothing, so discovery finds the source transaction through the indexed
   ERC-20 `Transfer(srcSender → Diamond)` on `srcToken` from `srcScanFromBlock`, then requires
   `LiFiTransferStarted.transactionId == lifiTxId` from the pinned Diamond in that receipt; a retry is a new
   record. Stage `bridging`.
5. **Watch** (read clients, no wallet needed): see *Discovery* below.
6. **Deposited** → rewrite `amount` and the fuel `received` from the event; set `depositTxHash`, `leafIndex`,
   `messageHash`; re-seal exact if the key is in memory → the existing `syncing → claimable → registering →
   claiming → done` path, unchanged (`fee-juice.ts`, `private-fuel.ts`, `hub-l2.ts`). **Delivered to wallet** →
   amount and address shown, plus "continue from Ethereum" as a fresh Ethereum-origin record (needs ETH on
   Ethereum: said before it is offered). **Expired on source** → "refund pending on Base".

**Destination execution** (inside the relayer's transaction) follows the diagram: shape and pause checks →
pull → portal get-or-create → swap → fee-asset floor → fuel deposit → token deposit → `Deposited`. Portals are
approved only after the swap returns, because the Diamond hands control to third-party pools mid-call.

**Ethereum-origin send.** As today (`send-flow.ts`), except the router (`depositRouter`), the entrypoint
(`bridgeWithPermit`, plain sends included) and the fuel quote source; the user's own receipt carries
`Deposited`. Permit2 allowances survive the router change (SignatureTransfer names the spender per signature).

**Discovery** (`crosschain-discovery.ts`; budgeted, resumable reads shared with `deposit-reconcile.ts`, extracted,
not copied):
1. Source receipt → the rail's own source event from its pinned emitter: Across `FundsDeposited` (every relay
   field) or Stargate `OFTSent` (guid). Persist `transport`: for Across the full relay hash recomputed from that
   event, since a fill takes caller-supplied relay data and `(originChainId, depositId)` alone is forgeable
   (`research/fork-proofs/AcrossFill.t.sol` fills with no source deposit); for Stargate the guid with the pool,
   the receiver and compose index 0.
2. Fast path: Ethereum `getLogs(depositRouter, Deposited)` with the secret hash as an indexed topic, from
   `scanFromBlock`. Across also queries fills by the indexed `(originChainId, depositId)` and keeps only the one
   whose recomputed relay hash, message hash included, equals ours.
3. **The intended outcome is the marker of our authenticated execution, not anything else in its receipt** (an
   attacker can bundle a gift, or a forged `LiFiTransferCompleted(lifiTxId)`, into the same transaction). The
   marker is the pinned Executor's `LiFiTransferCompleted(lifiTxId)` or the pinned receiver's
   `LiFiTransferRecovered(lifiTxId)` adjacent to the transport event on its callback side: Across, the first after
   the fill event if the deployed SpokePool emits before calling the handler, else the last before it; Stargate,
   the last before `ComposeDelivered`. Phase 0 F3 and Phase 2 pin each side. Recovered ⇒ delivered to wallet.
   Completed ⇒ the last router `Deposited` before it is ours (the router and the Executor are non-reentrant, so
   nothing interleaves), with the portal's and FeeJuicePortal's events (emitter-filtered; `parseFeeJuiceDeposit`
   gains the filter, recon risk 6) and recomputed message hashes ⇒ deposited. Every other `Deposited` for the
   secret hash is at most an extra.
4. Across only: the destination `fillStatuses(relayHash)` unfilled and `fillDeadline` passed, both read at the
   same finalized block ⇒ expired on source. Copy says "refund pending", never "refunded".
5. Any other authenticated `Deposited` for the same secret hash at or above the floor is a gift only this user
   can claim: recorded in `extraDeposits` and shown ("another deposit with this credential exists"). Below the
   floor or from another emitter: ignored. No first-match rule, no ambiguity verdict, no secret-hash latch.
6. RPC failure or an exhausted scan budget ⇒ `incomplete`, retried; never terminal. LI.FI `/v1/status` is an
   untrusted accelerator (mainnet only) that can only suggest a transaction to check.

### Positions on the twelve design questions

Rejected alternatives and their reasons live in the **Decision ledger** (D-numbers).

1. **Contract shape**: one new `DepositRouter`, two entrypoints, one `_settle`, beside the old router (D1, D2).
2. **Who swaps to $AZTEC**: (b), our router runs LI.FI same-chain calldata (D3) against an immutable target with
   pinned selectors and `_receiver` (D4, D5); expiring RFQ venues excluded, a time-warped fork test picks the
   venues, the floor binds, a stale swap reverts into recovery (D8, D9).
3. **Amounts**: measured and bounded on the caller path, exact on the Permit2 path, fixed slice in token units,
   measured fuel output (D6, D7); envelope v3 `[minAmount, maxAmount]`, re-sealed exact (D14); discovery
   transport-correlated, decoys are gifts (D12).
4. **Trust boundary**: the client decoder is the only guard against a redirected intent; on-chain checks bound
   value loss; immutable policy; exact approvals everywhere we control (D4, D12, D16).
5. **Source signature**: exact approve + the decoded LI.FI transaction, one EIP-5792 batch when available (D11).
6. **Failure**: revert-to-recover, no router try/catch; deposited, delivered to wallet, expired on source (D17).
7. **Ethereum origin**: the same `_settle` through `bridgeWithPermit`; the witness binds `keccak256(swapData)` (D30).
8. **Testnet**: LI.FI's real Base Sepolia Diamond/AcrossFacetV4 and Sepolia ReceiverAcrossV4/Executor, our
   builder, Across, `TestnetFuelSwapper` (D20, D21); a different rail from mainnet, both decoders ship (D10).
9. **Testing**: every owner layer, see *Testing architecture* (D22–D24, D35).
10. **Ops**: router-only deploy on the current generation, journalled and intent-gated, or a reset generation if
    Aztec 6.0.0 final lands first (A3); old records via `legacyRouters` + a frozen ABI; `verify-l1` checks the
    address book on chain.
11. **Frontend**: wallet-independent read clients per chain (D25), a source registry in `@/lib/network`, the LI.FI
    client over an extracted `cappedFetch`, schema-4 records, the owner-chosen direction behind sign-off.
12. **Economics**: fees per line with the quote's age, a per-network fee ceiling (A7), destination gas = fork
    measurement × 1.3, cross-chain only to tokens with pre-created portals (D37), no liquidity cap (D8).

### Testing architecture

| Layer | Suites (N new, C changed) | Proves | Runs |
|---|---|---|---|
| forge unit | `DepositRouter.t.sol` N, `TestnetFuelSwapper.t.sol` N, `DepositWitness.t.sol` N (3-way pin with the TS witness) | shape rules, pause, identity, partial fee asset → clone, selector and offset pins (`abi.encodeCall` vs offset 100), `_receiver`, `minFuelOutput > 0`, leftover input → token leg, exact consumption where required, donations | CI hermetic |
| forge fuzz | `DepositRouterFuzz.t.sol` N | received / slice / floors / `maxPull` / allowance, FiatToken-style decrementing max allowance | CI |
| forge invariant | `DepositRouterInvariant.t.sol` N | actors: Executor, Permit2 user, donor, hostile DEX (returns less, more, leftover or its whole input balance; re-enters; pulls beyond approval), pause. Funds leave only to the clone, the FeeJuicePortal or `SWAP_TARGET` (≤ slice); no allowance the router grants survives a call (the Executor's MAX − pulled allowance to the router is the caller's own); router balances never drop below pre-call residue | CI |
| adversarial | `DepositRouterBlackhat.t.sol` N | the `research/alt-adversarial.md` §2 list, including the selector-free counterexample (now rejected), a target that is the token itself, BN254-overflow secret hash → revert | CI |
| halmos | `FormalDepositRouter.t.sol` N, 11 proofs over mocks (halmos 0.3.3 lacks `deployCode`, so no LI.FI artifact loads) | `check_permit_conservesUserFunds`, `check_fromCaller_pullsOnlyFromCaller`, `check_fromCaller_boundedPull`, `check_fromCaller_conservesReceived`, `check_tokenLegIntoDerivedPortal`, `check_partialFeeAssetNeverIntoFeeJuicePortal`, `check_fuelOnly_noTokenLeg`, `check_swap_rejectsUnpinnedSelectorOrReceiver`, `check_revertsWhenPaused`, `check_noStandingApproval`, `check_sweep_revertsForNonOwner`; guard-shaped proofs carry a forge canary that fails against a guard-stripped mock | CI (`11 FormalDepositRouterTest` in the workflow's `EXPECTED` block, every name in its list) |
| gas | `.gas-snapshot` C | `test_gas_permit_firstTime`, `test_gas_permit_known`, `test_gas_fromCaller_withFuel` | CI `--check --tolerance 2` |
| fork, Permit2 | `DepositRouterPermit2Fork.t.sol` N, the successor of `SwapBridgeRouterPermit2Fork.t.sol` | real Permit2 on a mainnet fork: nonce replay, expired deadline and witness tamper (`:298`, `:309`, `:318`, `:383-403`), plus a mutated `swapData` under an unchanged witness; identity legs | opt-in `ETH_RPC_URL` |
| fork, testnet | `LifiTestnetRailFork.t.sol` N (Base Sepolia + Sepolia in one test) | Phase 0 F1–F3, then the real router + swapper against the live Sepolia generation; floor unmet → recovered; paused → recovered | opt-in `BASE_SEPOLIA_RPC_URL`, `SEPOLIA_RPC_URL` |
| fork, mainnet destination | `LifiDestinationFork.t.sol` N | real SpokePool → ReceiverAcrossV4 → Executor → router → real Diamond with recorded USDC → AZTEC calldata → real FeeJuicePortal; public, private, fuel-only; a deadline-free-venue fixture survives `vm.warp`/`vm.roll` by ETA·3, and a fixture explicitly carrying an RFQ venue, warped past its decoded expiry, takes the recovery path; price impact of the allowed venue set at the largest expected slice recorded; leftover input → token leg; a donation to the real Diamond before the fill stays residue; worst-shape gas ≤ `toContractGasLimit / 1.3` | opt-in `ETH_RPC_URL` |
| fork, Stargate | `LifiStargateComposeFork.t.sol` N | credit the receiver, prank the pool into `EndpointV2.sendCompose`, `lzCompose` with the quote's gas; the worst shape (private token + private fuel) succeeds with exactly the decoder's minimum compose gas, ReceiverStargateV2's `recoverGas` reserve included; a compose below `recoverGas` → recovered; native delivery → recovered | opt-in `ETH_RPC_URL` |
| dual-fork replay | `LifiReplayFork.t.sol` N | a recorded `contractCalls` quote (Base USDC → Ethereum, our calldata embedding a recorded same-chain quote) runs on a Base fork at its block; the OFT amount and compose message are captured and delivery is rebuilt on an Ethereum fork into the router at the fixture address; FJ ≥ floor, zero residue; the captured compose message is committed for Phase 4's decoder test | opt-in `BASE_RPC_URL` + `ETH_RPC_URL` |
| TS unit | N: `lifi-decode`, `across-v4`, `lifi-api`, `fuel-quote`, `crosschain-discovery`, `lifi-addresses`, `deposit-router-abi`; C: `l1`, `journal`, `backup` + `backup.pins`, `recovery-crypto`, `manifest-v2`, `fuel` | the Phase 3 and 4 gates' pass criteria | CI |
| live-data TS | `describe.skipIf(!process.env.LIFI_LIVE)` on `lifi-addresses` (book vs `deployments/*.json` at a pinned commit and `/v1/chains`) and `lifi-api` (one live same-chain quote parses) | real external data | opt-in, ≤ 3 li.quest calls |
| sandbox integration | `crosschain.integration.test.ts` N | the sandbox's LI.FI contracts at CREATE2 addresses, with book entries injected from the sandbox handle into local builds and tests only (never the testnet or mainnet book); `relayer.ts` serves a loopback `/suggested-fees`; second anvil with `SourceAcrossStub` → relay loop → `TestSpokePool.fillRelay` → compiled LI.FI ReceiverAcrossV4 + Executor → router → swapper → portals → **L2 claim** paid by the bridged fuel (public, private, private fuel, fuel-only); paused → recovered to the user's L1 address | CI (integration job) |
| browser e2e | `deposit-crosschain.spec.ts` N; existing deposit specs C (on `DepositRouter`) | public and private token+gas, delivered to wallet, expired, reload while bridging, reload between `wallet_sendCalls` and its receipts, another deposit exists, decoder refusal before signing; egress loopback-only | CI (`pr-tools-e2e.yml`) |
| live | `lifi-canary-testnet.ts` N | Base Sepolia → Aztec testnet, the Phase 6 matrix | disposable key (A2) |

**Fork policy.** Every fork suite reads its RPC with `vm.envOr(…, string(""))` and skips when empty (the repo's
pattern, `MainnetFuel.fork.t.sol:56`, `FactoryFork.t.sol:30`); every suite name contains `Fork`, so CI's hermetic
`--no-match-contract Fork` skips them. Blocks are pinned in the fixture, never `latest`. Fixtures
(`contracts/bridge/evm/test/fixtures/lifi/*.json`: chain ids, blocks, the trimmed quote, the fixture router
address, recorder version) come only from `packages/bridge-core/scripts/lifi-fixtures.ts` (≤ 5 li.quest calls
per run, no key). Replaying a committed fixture needs an archive RPC; `lifi-fixtures.ts --run` records and
immediately runs the suites at the fresh blocks, which works on a full node. The TS decoder tests read the same
fixture files, so the decoder and the forks cannot drift apart.

**LI.FI code in tests and the sandbox** (D22, A4): `lifinance/contracts` (LGPL-3.0-only) as a gitignored lib at
a pinned commit, installed `--no-git`, compiled under its own `lifi` profile, destination half only (Executor,
ERC20Proxy, ReceiverAcrossV4, ReceiverStargateV2), never imported by production sources. After install, every `.env`/`.env.*` and every agent instruction
file (`CLAUDE.md`, `AGENTS.md`, `.claude/`, `.mcp.json`, `.cursorrules`) under the lib is deleted, nested libs
included; its own dependencies (solady, OpenZeppelin) stay, since `LibAsset.sol` imports them. `env-exec` refuses
any untracked `.env*` file (the v4-core lesson in `lessons.md`), and agent files must not reach an implementing
session. Default-profile sources never import the lib: suites load the `lifi` profile's artifacts by path, so arc
1's tools-e2e run (`contracts/bridge/**` triggers it) builds without the pin. Every place that builds
the forge tree also installs the pin and runs `FOUNDRY_PROFILE=lifi forge build`: G0, `_bridge-contracts.yml`'s
build and integration jobs, `_tools-e2e.yml`, and `sandbox/forge.ts`'s `ensureForgeArtifacts`. Fallback after Phase 1's
time-box: twins plus a fork parity test against the real deployed bytecode.

### File-level change map

Cross-checked with `recon.md` and `research/uniswap-removal.md`. A = add, M = modify, D = delete; the arc that
does it in brackets.

- **Contracts** (`contracts/bridge/evm`): A `src/DepositRouter.sol`, `src/TestnetFuelSwapper.sol`,
  `src/interfaces/IFeeAssetHandler.sol`, `src/interfaces/ILiFiSwap.sol` (the two selectors' ABI only) [1];
  `src/mocks/TestSpokePool.sol`, `src/mocks/SourceAcrossStub.sol` (sandbox only) [2]; tests per the table, their
  `test/mocks/DepositRouter{Fixture,Mocks,Mutants}.sol`, `test/lifi/` fork bases, `lifi-build/LifiArtifacts.sol` (the
  `lifi` profile's only source) [1]; M `script/DeployGeneration.s.sol` (router-only path, swapper) [2], `foundry.toml`
  (`lifi` profile [1]; `fs_permissions` read-write on `test/fixtures/lifi`, where the recorder's runs write receipts
  [1]), `test/fixtures/lifi/testnet-rail.json` and its two receipt files [1], `.gas-snapshot` [1], `README.md` (threat model:
  the caller path, the immutable swap policy; INFO: the swapper never targets mainnet; "12 halmos proofs" → 23 [1]
  → 15 [5]) [1, 5]; `foundry.toml` and `packages/bridge-core/scripts/gen-remappings.ts` drop `@uniswap/v4-core/` [5];
  D the old router, every V4 contract, mock and pool script, and their suites, per `research/uniswap-removal.md`
  [5], after moving the Uniswap-free fakes the new suites import (`MockPermit2`, `MockFeeJuicePortal`,
  `MockTokenPortal`, `FakePortalFactory`) out of `test/mocks/RouterMocks.sol`, which imports the old router [5]. The research fork proofs move in only after their imports, blocks and RPC names are reconciled (recon risk 9).
- **Core** (`packages/bridge-core/src`): A `across-v4.ts` (the Phase 0 vector), `lifi-abi.ts` (the shared struct ABIs, Phase 0), `deposit-router-abi.ts` (pinned
  against the forge artifact), `lifi-gas.ts` (the measured `toContractGasLimit` and venue set) [1]; A `lifi-addresses.ts`, `lifi-api.ts`, `lifi-decode.ts`, `stargate.ts` (decoder), `fuel-quote.ts`,
  `source-chains.ts`, `crosschain-discovery.ts` (its `Deposited` parser is the only one; arc 4's
  `send-flow.ts` `readSendReceiptLeaves` switches to it), `capped-fetch.ts`
  (extracted from `token-list.ts`, which switches to it) [2]; M `manifest-v2.ts`, `journal.ts`, `backup.ts`,
  `recovery-crypto.ts`, `fuel.ts`, `index.ts`, `l1.ts` (additive `DepositWitness` builders) [2], `l1.ts` (old witness
  removed), `send-flow.ts`, `send-generation.ts`, `flows.ts`,
  `router-abi.ts` → `legacy-router-abi.ts` [4, 5]; D `route.ts`, `route-discovery.ts`, `quote.ts` and their tests,
  `route-conformance.test.ts`, `swap.test.ts`, `quoter-abi.test.ts` [5]. Reused as-is: `gas-share.ts`,
  `claim-secret.ts`, `seal-trust.ts`, `private-fuel.ts`, `hub-l2.ts`, `fee-juice.ts`.
- **Core scripts**: A `lifi-fixtures.ts` (`testnet-rail` since Phase 0; encodes through `deposit-router-abi.ts`, records raw li.quest responses
  with a plain timed `fetch`; the decoder validates them in Phase 4) [1]; A `lifi-canary-testnet.ts`
  (reads `CANARY_PRIVATE_KEY`, public Sepolia and Base Sepolia RPCs by default), `sandbox/relayer.ts` [2]; M `sandbox/forge.ts` builds the `lifi` profile [2];
  A `fill-testnet.ts` (self-fills one named Base Sepolia source transaction on Sepolia from the canary key) [2];
  `verify-l1` reads `BASE_SEPOLIA_RPC_URL`, defaulting to the PublicNode endpoint (A5) [2]; M `deploy-generation.ts` (`--router-only`), `generation.ts` (`deployDepositRouter`,
  `deployFuelSwapper`, `readRouterBindings`), `deploy-manifest.ts` (additive kinds `fuel-swapper-deployed`,
  `deposit-router-deployed`; old kinds stay parseable), `verify-l1.ts` (router immutables, swapper, address book
  on chain, Executor/receiver code hashes), `script-l1.ts`, `live-intent.ts` (router-only intent, source-chain caps,
  the canary key's public address pinned, `verifyGenerationBindings` also checking `depositRouter` and
  `fuelSwapper`, `implementations-plan/lifi-routing/lessons/` added to `OPERATIONAL_ALLOWLIST`), `calibration.ts` (writes `fuel.*`), sandbox `deploy.ts`, `l1.ts`,
  `manifest.ts`, `handle.ts`, `local-network.ts` (second anvil, own ports from the registry, own process group),
  `smoke.ts`, `cli.ts`, `fixtures/sandbox-manifest.json`, `test/integration/*` [2]; `script-send.ts`, `flows*.ts`,
  `fuel-testnet.ts` on the new router [4]; D the sandbox's V4 wiring (`manifest.ts` `sandboxSwapBlock`, `flows.ts`
  `flowNoRoute` and smoke step f4, `gas-leg.integration.test.ts` rewired to the swapper), `discover-mainnet-fuel.ts`, `deploy-seed-tokens.ts`'s "sorts below WETH" rule,
  pool seeding; `smoke-swap-existing-testnet.ts` → `smoke-fuel-existing-testnet.ts` (the fueled smoke survives:
  skipping it would promote an unproven fuel route) [5].
- **App** (`apps/tools`) [4]: M `composables/useL1Wallet.ts` (one EIP-1193 provider for signing; reads per chain),
  `useSend.ts`, `deposit-flow.ts`, `deposit-reconcile.ts` (current + legacy routers; `Deposited`),
  `useBridgeJournal.ts` (both journal keys, bridging watchers), `useGasShare.ts` (`fuel.*`), `useTokenCatalog.ts`,
  `useRowBalances.ts`, `lib/network.ts` (source viem chains, the one file allowed `viem/chains`),
  `lib/network-targets.ts` (CSP), `lib/bridge-steps.ts`, `lib/send-model.ts`, `lib/testids.ts`,
  `contracts/bridge-generation.ts`, the send components and stepper/journal/receipt/footer per the chosen direction;
  `useRouteQuote.ts` → `useFuelQuote.ts`, whose debounce and latest-wins core `useCrossChainRoute.ts` shares; A `useCrossChainRoute.ts`, `useSourceChain.ts`, `useEthereumReader.ts`,
  `crosschain-deposit-flow.ts`; browser `fixtures/l1-wallet.ts`, A `fixtures/relayer.ts`, M `pages/send.ts`,
  `pages/journal.ts`, specs.
- **Manifests**: `apps/tools/public/testnet-bridge.json` gains the additive fields by promotion [3] and loses the V4
  fields by promotion [5]; `mainnet-bridge.json` stays `bridge: null`.
- **CI and docs**: `_bridge-contracts.yml` (`lifinance/contracts` pin and `lifi` profile build in the build job
  [1] and the integration job [2]; halmos `EXPECTED` and list: + `FormalDepositRouterTest` [1], − `FormalRouterTest` [5]; v4-core pins at `:56`, `:303` removed [5]),
  `_tools-e2e.yml` (`lifi` pin and profile build [2]; `:62` removed [5]); `.claude/skills/bridge-generation/SKILL.md` (the router-only section and the swapper [2]; swapper refill,
  LI.FI pins, canary [3]; pool seeding and V4 calibration prose removed [5]); `UPDATE.md`; READMEs (root,
  `apps/tools`, `packages/bridge-core`, `contracts/bridge/evm`, browser); `AGENTS.md` (one line: LI.FI contracts
  and API are a routing dependency and the decoder is the trust boundary) [4]; `implementations-plan/lessons.md`
  (retire the v4-core entry) [close-out].

### Non-obvious mechanics

- **LI.FI's `_minAmountOut` is not our floor.** `GenericSwapFacetV3` checks it against the Diamond's whole balance
  and sends that whole balance to `_receiver`; the router's own fee-asset delta is the binding check.
  `fuel-quote.ts` overwrites the word with our floor so the facet's check matches the router's; an inner venue
  minimum can still be stricter, which Phase 2 pins (output between the two floors reverts into recovery).
- **The router decodes one word.** Besides the selector it reads only `_receiver` (offset 100 in both pinned
  functions), compared as a full 32-byte word so dirty upper bits cannot alias; a Solidity test pins the offset
  against `abi.encodeCall`. Inner DEX calls are guarded by LI.FI's `LibAllowList` in the facet (the Executor has
  none, which is why the swap never runs as an Executor step).
- **The pull.** `pulled = min(balanceOf(msg.sender), allowance(msg.sender, this), maxPull)`, measured as the
  router's balance delta. USDC decrements even a max allowance, so `min` stays right. A fee-on-transfer token ends
  in the portal's `InexactTransfer` and therefore in recovery. `maxPull` is not an attacker defence (D7).
- **Delta-only accounting.** A donation never reverts a deposit and never joins one; `sweep` reaches it. That
  includes a donation to the Diamond, which the facet forwards to us whole (the stray split above).
- **Receiver differences.** ReceiverAcrossV4 reserves no recovery gas. Under a pre-Amsterdam schedule an
  out-of-gas destination makes the whole fill revert, the relayer does not fill and the deposit is refundable at expiry.
  Under Amsterdam's (Sepolia today) an underfunded fill is recovered to the user instead, and a node's gas estimate
  settles on that recovery (D46). ReceiverStargateV2 reserves
  `recoverGas = 100000`, so a starved compose recovers to Ethereum, and anyone can trigger that compose.
- **The Executor forwards only deltas.** It sends `balance − start` of the bridged token to `receiver` after the
  steps; a Stargate surplus above `maxPull` therefore lands at the user's Ethereum address as dust, and
  pre-existing Executor balances stay where they are.
- **Stargate on a fork.** Credit the receiver (`deal`, mirroring `lzReceive`), prank the pool into
  `EndpointV2.sendCompose(receiver, guid, 0, composeMsg)`, then `lzCompose` with the quote's compose gas; if the
  endpoint path fights the fork, prank the endpoint into `ReceiverStargateV2.lzCompose` directly.
- **`ReentrancyGuardTransient`** (already used by `TokenPortalImpl.sol:25`) leaves no storage to seed when the
  replay places the router at the fixture's address.

## Security & Adversarial Considerations

**Threat model.**

| Adversary | Capability | Bound under this design |
|---|---|---|
| Compromised LI.FI API or MITM | authors the mainnet source tx: secret hashes, recipients, fallback, floors, fuel calldata | `verifyRoute` with byte-equal re-encoding of our call, mutation-tested per field. **Top risk**: on the executor path no on-chain check knows the user's intent, so a decoder bug is the attack surface |
| Compromised Diamond facet (LI.FI's `diamondCut`) | runs inside our swap call | exact `fuelSlice` approval, pinned selectors, `_receiver == router`, delta floor `minFuelOutput > 0`. Worst case: the slice priced at the floor |
| Compromised Executor or receiver | holds bridged funds before our call | pinned code hashes in `verify-l1`; accepted residual of the owner's choice of LI.FI |
| Anyone calling `bridgeFromCaller` | permissionless entrypoint (the Executor is permissionless too) | spends only `msg.sender`'s funds (halmos); decoys are gifts filtered by floor and transport correlation |
| Stargate compose griefer | `lzCompose` is permissionless; ReceiverStargateV2 hands the Executor `gasleft − recoverGas`, so any gas below the router's need forces recovery | forced delivery to the user's wallet; first-class outcome; accepted residual of LI.FI's receiver |
| Across relayer | refuses or delays the fill; under Amsterdam's schedule, underfunds it | refundable at expiry, returned by Across's settlement; a late fill is still bounded by the floors; an underfunded fill is recovered to the user's wallet (D46) |
| MEV searcher | sandwiches the destination swap | signed floor `quote·(1 − s)` on our own delta; loss bounded by the slippage the user accepted |
| Decoy depositor | reuses the public secret hash | transport correlation picks the intended deposit; decoys are extra claimables, never ambiguity |
| Hostile token | hooks, lying `balanceOf`, fee-on-transfer | transient lock, delta checks, exact portal pulls; cross-chain limited to manifest rail assets |
| Router owner | `sweep` only | no target rotation, no pause power; cannot touch user funds (the router holds none) |
| Guardian | pause deposits, now every router leg | delay only; in-flight fills recover to Ethereum (Ask A8) |
| RPC providers | lie about logs, balances or finality | claims authenticate against the Aztec node's message tree; a lie delays or mislabels, never redirects; non-deposited cross-chain outcomes are never auto-pruned, so a lie cannot delete a secret |
| Storage tamperer | edits the journal | envelope binds secret, recipient and the amount window; chain facts re-derived |
| Testnet swapper drainer | mints test tokens to drain FJ inventory | testnet only; handler top-up, refill command, chain-1 constructor revert |

**Least privilege.** The router's only external calls are Permit2, the factory and its clones, the
FeeJuicePortal and the immutable `SWAP_TARGET`; it holds no standing approval and its owner keeps only `sweep`.
Source approvals are exact and never raised to max (LI.FI's largest past exploit drained standing unlimited
approvals to the Diamond). No new CI secret; fork suites stay opt-in; Actions holds no Cloudflare credential.
Live operator keys stay pinned in `PLAN_PINNED_L1_SIGNERS` (`live-intent.ts:48`) with `CAPS` (`:72`); the canary
key is testnet-only, single-purpose and distinct from the generation deployer (Ask A2).

**Cryptography.** No new primitive. Permit2 (canonical) SignatureTransfer with witness; OZ 5.7 (`SafeERC20`,
`ReentrancyGuardTransient`, `Ownable2Step`); EIP-712 and keccak via viem (`npm:@aztec/viem@2.38.3`); envelopes via
`@alejoamiras/nulo-wallet-crypto` 0.2.0 (AES-GCM, PBKDF2), unchanged. v3 reuses the v2 machinery with a different
payload and a version check that refuses cross-version parsing.

**Input validation.** LI.FI and Across responses: fixed origin, `redirect: "error"`, timeout, streaming byte
cap, zod `.strict()` on every field read, fail closed; Across `outputAmount` bounded against the input and
`fillDeadline` against now. The source tx: `verifyRoute` at review and again right before submission; a chain or
account change invalidates the review. Chain ids: `assertChain` before every signature. Secret hashes below the
BN254 modulus (client). On chain: the shape rules before any pull; amounts ≤ `uint128` (portal).

**Supply chain.** No new runtime dependency (raw `fetch`, viem `decodeFunctionData`, zod; no `@lifi/sdk`). The
7-day gate and frozen lockfile are unchanged. `lifinance/contracts` enters as a pinned, gitignored test lib, never
committed and never linked into production contracts. Removing v4-core shrinks the forge dependency set. The
address book is verified on chain by `verify-l1` and, opt-in, against two independent publications. **CSP
widening** (testnet: Sepolia and Base Sepolia RPCs, the Across testnet API) is listed in the PR as a visible-risk
change.

**Smart-contract and cross-chain risks.** *Reorg*: discovery re-checks canonicality (receipt and tip checks,
`chainEpoch`) and a terminal outcome waits for `finalized` on its deciding chain (the source chain for `not-sent`,
Ethereum for the rest); the claim waits for the Inbox; the source deposit's own finality before delivery is the
rail's concern. *Replay*: Permit2 nonces;
the caller path spends fresh funds each call; Across deposit ids and LayerZero guids deliver once; Aztec nullifiers
protect claims. *Front-running*: copying a caller intent deposits one's own funds; the Permit2 owner is
`msg.sender`; `createPortal` is idempotent; no per-hash uniqueness to burn. *Censorship*: Across refusal ends in a
refund; Stargate delivery and compose are permissionless and retryable. *Oracle / MEV*: no oracle; floors on our
own deltas. *Reentrancy*: a transient lock on every entry, portals have their own, approvals are zeroed; the
Diamond has no guard, which is why our deltas wrap the call. *Native ETH*: the router is non-payable; a native
delivery reverts into recovery; routes request WETH. *Recovery failure*: a blacklisted address or an out-of-gas
recovery leaves the operation pending, never "paid".

**Privacy.** A cross-chain private deposit links the source address, the source tx and the secret hash exactly as
an Ethereum-origin private deposit links the L1 sender; privacy remains an L2 property. Read RPCs learn addresses
and secret hashes (public anyway).

**Hard prerequisite recorded:** `/harden security` before any mainnet deploy (outside this plan).

## Assumptions

### Facts

1. `SwapBridgeRouter` binds `swapTarget` and `routeHash` in its witness (`contracts/bridge/evm/src/SwapBridgeRouter.sol:58-62`),
   plain `bridge()` included (`:251`, `:277`); its constructor takes the swap target (`:150-163`); the fuel slice
   must be consumed exactly (`:316-334`); it uses storage `ReentrancyGuard` (`:55`).
2. Portal clones pull from `msg.sender`, accept any caller and check pause, `uint128` and exact-in
   (`TokenPortalImpl.sol:60-86`, `:116-132`); `predictPortal` is a view (`PortalFactory.sol:72`) and
   `createPortal` is permissionless get-or-create (`:86`); the factory owns `depositsPaused` (`:43`, `:62`).
3. The fuel budgets live in the optional V4 `swap` block (`packages/bridge-core/src/manifest-v2.ts:76-91`); the
   manifest is `schema: 2` (`:108`) and bundled at build time (`apps/tools/src/contracts/bridge-generation.ts:16`).
4. Gas sizing is provider-agnostic (`packages/bridge-core/src/gas-share.ts:43-78`); `PERMIT_DEADLINE_SECONDS = 600n`
   (`l1.ts:163`).
5. The v2 envelope commits `amount` and `envelopeMatchesRecord` compares it exactly (`recovery-crypto.ts:107-119`,
   `:155-160`); the recovery-key message binds the chain from the binding (`:27`).
6. Journal records carry `schema: 1 | 2 | 3` (`journal.ts:46`); invalid stored entries are moved to
   `QUARANTINE_KEY` at boot, not deleted (`:336-342`); `blocked` is terminal (`:62-65`).
7. Private sends zero the public recipient (`send-flow.ts:155-160`); `sendGenerationOf` copies `swapTarget`
   (`send-generation.ts:16`).
8. Hash-less Ethereum-origin reconcile treats two verified router transactions as `"ambiguous"`
   (`apps/tools/src/composables/deposit-reconcile.ts:113`); message recomputation authenticates amount and leaf,
   not source provenance (`apps/tools/src/lib/message-nullifier.ts:39`).
9. `parseFeeJuiceDeposit` has no emitter filter (`fuel.ts:69`).
10. Reads go through the wallet because the CSP refuses HTTP RPC (`apps/tools/src/composables/useL1Wallet.ts:24-31`);
    `cspConnectSrc` per target (`apps/tools/src/lib/network-targets.ts:96`, `:116`; mainnet `:133` is
    `'self' data: blob:` only).
11. Promotion locks identity, factory and hub only, so a router move is legal (`packages/bridge-core/src/promotion.ts:32`).
12. CI pins v4-core (`.github/workflows/_bridge-contracts.yml:56`, `:303`; `_tools-e2e.yml:62`) and checks halmos by
    name and count: 8 `FormalRouterTest` + 2 `FormalFactoryTest` + 2 `FormalCloneTest` proofs, 3 summaries
    (`_bridge-contracts.yml:96-132`); the sandbox integration suite runs in CI (`:311`).
13. Fork env names in use: `ETH_RPC_URL` (`test/MainnetFuel.fork.t.sol:56`), `SEPOLIA_RPC_URL` + `AZTEC_REGISTRY`
    (`test/FactoryFork.t.sol:30-31`).
14. The testnet fee-asset handler is `0x5602…f4bfc9` (`apps/tools/public/testnet-bridge.json:111`); the live
    testnet router is `0xb6d6…cfab`; mainnet ships `bridge: null`.
15. `env-exec` pins a keyed request to HEAD and refuses untracked files (`.claude/skills/bridge-generation/SKILL.md:170-181`).
16. LI.FI contracts (`research/lead-lifi-contracts.md`, `research/alt-adversarial.md`): the Executor has no
    allowlist, pulls the receiver's allowance, max-approves `approveTo` without reset and forwards only deltas;
    ReceiverAcrossV4 is `onlySpokepool`, approves the Executor exactly, recovers to `receiver` on any revert and
    reserves no gas; ReceiverStargateV2 reserves `recoverGas = 100000`; `GenericSwapFacetV3` enforces
    `LibAllowList` on inner calls, checks `_minAmountOut` on the whole balance, returns leftover input to
    `_receiver` and has no deadline or reentrancy guard; licence LGPL-3.0-only.
17. Testnet wiring (`research/lead-testnet-wiring.md`, `research/alt-testnet-parity.md`): Base Sepolia Diamond
    `0x816F…1770` → AcrossFacetV4 → SpokePool `0x82B5…0F8F`; Sepolia SpokePool `0x5ef6…B662` → ReceiverAcrossV4
    `0x51Cd…0f44` (immutables: Sepolia Executor `0x7b01…a533` and that SpokePool); Across testnet with a message:
    4.89–8.00 USDC per deposit, ~24 % fee at 5 USDC; neither Circle Sepolia USDC nor Sepolia WETH has a portal
    in our generation; `FeeAssetHandler.mint` is permissionless (1,000 FJ per call). Patcher is absent on the
    testnets.
18. API shapes (`research/lead-lifi-api-shapes.md`, `research/alt-aztec-swap.md`): same-chain quotes use the
    Multiple form with a FeeCollector 0.25 % step and `_receiver = toAddress`; contract calls into Ethereum route
    only via Stargate V2 (Across and Relay: code 1002); the destination `SwapData.fromAmount` is `minAmountLD`; a
    two-call request is silently wrong; the default single AZTEC call uses a bitget RFQ with a ~10-minute signed
    expiry; OKX `uniswapV3SwapTo`, Sushi `snwap` and 1inch V6 carry no deadline.
19. **Mainnet $AZTEC liquidity is deep** (owner, plus director-verified read-only LI.FI same-chain quotes, USDC →
    AZTEC, 1 % slippage, LI.FI's fee included): 1k USDC −0.32 % (nordstern), 10k USDC −0.43 % (nordstern), 100k
    USDC −1.5 % (bitget, gas estimate 276,740); 1M USDC has no quote (code 1002). `research/alt-aztec-swap.md`
    measured only the Uniswap v3 1 % pool and did not check V4 pools; the repo's own mainnet fuel route used a V4
    ETH/AZTEC pool (`MainnetFuel.fork.t.sol`, `discover-mainnet-fuel.ts`).
20. Fork proofs (`research/lifi-onchain.md`): LI.FI's real Executor and receivers deliver into our portals on a
    mainnet fork (8/8); Across direct into our live Sepolia generation (6/6); a secret hash ≥ the BN254 modulus
    reverts into recovery. The direct-Across proof builds relay data without a source transaction, so it does
    not prove the LI.FI source facet (Phase 0 does).

### Inferences (each settled by a named test)

- **I1** LI.FI's testnet bytecode behaves like its mainnet deployment. *Phase 0 F1/F2.*
- **I2** An Across testnet relayer fills a message-bearing deposit within the caps. *The Phase 6 canary; it
  self-fills when no relayer does and records which happened.*
- **I3** At least one deadline-free AZTEC venue that LI.FI quotes survives a warp of ETA·3. *Phase 2; the
  `allowExchanges` set is whatever passes. If none does, cross-chain fuel is unavailable on mainnet until it does
  (cross-chain token sends and Ethereum-origin fuel are unaffected), surfaced to the owner.*
- **I4** Stargate delivers `≥ T` when the decoded `minAmountLD ≥ T`, and close to `toAmount`. *Phase 2 replay.*
- **I5** The fill and compose events carry the identities discovery needs (Across fill indexed by origin chain
  and deposit id; EndpointV2 `ComposeDelivered` with the guid). *Phase 0 for Across, Phase 2 for Stargate; if an
  event lacks a field, discovery reads the receipt's calldata instead.*
- **I6** The pinned `lifinance/contracts` destination half compiles under a dedicated profile. *Phase 1 time-box.*
- **I7** Destination gas ≈ 530k with a swap on a known portal. *Phase 2 measures; the constant is 1.3× the worst
  shape.*
- **I8** The FeeCollector LI.FI uses moves over time; the decoder pin fails closed until refreshed.
- **I9** Aztec 6.0.0 final may reset the testnet mid-plan (`implementations-plan/follow-ups.md`).

### Owner authorization on record

Owner, Phase 0: *"you can drive it with a **disposable key**; I can help fund it if open faucets don't suffice."*
Scope: the testnet live canary only; the key is held outside the repository, never committed, never reused,
never printed. At the gate the owner chose that route for the canary (A2 below), which makes it a recorded,
canary-only exception to AGENTS.md's keyed-run rule. The generation signer and the 1Password RPC URLs stay keyed:
`deploy-generation.ts --router-only`, `verify:l1` and the fuel regression remain `env-exec` runs the owner approves
with `op-remote`, batched into one sitting.

### Owner answers at the approval gate (verbatim)

- **Plan**: *"The plan is approved."* Arcs 1–2 start before the boards are signed; they touch no UI.

- **A1**: *"I'm more inclined into (5) on how to select the assets, but keeping everything else from (1)."* Read
  as: direction 1's wizard (Token → Amount → Review, its stepper and phone layout) with direction 5's flat
  cross-network asset picker ("Send from": search on every network, chain filter, chain badge per row) as the
  Token step. Not yet G-UX-2: the hybrid is drawn as its own boards, cut to v1 scope, and signed off (Design
  binding).
- **A2**: *"Just do the disposable key, don't wait for me on keyed runs."* Route (a) for the canary. The agent
  generates the key into `~/.cache/unleashed-canary/testnet.key` (0600), reports only its address for funding,
  and never reuses it.
- **A3**: *"ok. As long as I can test on Testnet too (the UI, etc.) Yes."* Approved, with that condition: arc 4's
  testnet preview builds run against the live router, and `fill-testnet.ts` (A10) completes any send Across's test
  relayer leaves unfilled. The owner also asked about retiring the test tokens and seeding Sepolia $AZTEC pools. No
  pools: the testnet fuel leg is `TestnetFuelSwapper` (fixed rate, minted inventory), li.quest does not quote
  testnets so a Sepolia pool would never be on the route, and a Uniswap pool would rebuild what arc 5 removes; the
  swap leg's fidelity comes from mainnet forks with real $AZTEC liquidity. Retiring Test USDC/USDT/EURC/GBPC is
  outside this plan (the Drip faucet and Ethereum-origin testnet sends use them); it is a follow-up candidate.
- **A4**: *"I trust you."* Accepted as written.
- **A5**: *"please, fetch base sepolia's and sepolia's free RPC online."* Probed for chain id, `eth_getLogs` range
  behaviour and browser CORS from the testnet origin:
  - Sepolia: `https://ethereum-sepolia-rpc.publicnode.com` (CORS `*`; `Transfer` logs over 1k, 10k and 50k blocks
    returned consistent supersets).
  - Base Sepolia: `https://base-sepolia-rpc.publicnode.com` (CORS `*`; refuses explicitly above 20,000 results),
    falling back to the official `https://sepolia.base.org` (500-block `eth_getLogs` cap; CORS echoes the origin).
  - Refused: the Tenderly gateways truncate silently (a 50k-block Sepolia query returned 685 logs where its own
    10k-block tail returned 13,964), which would make discovery miss a deposit; `1rpc.io` caps logs at 50 blocks;
    dRPC's free tier serves no Sepolia; `rpc.sepolia.org` answers 404; thirdweb answers rate-limit text.
  - The Across testnet API (`https://testnet.across.to`) needs no key or sign-up and answers with CORS `*`. It was in
    the CSP for the browser to ask it for the relay fee and limits; once every testnet send rode fixed terms (D45,
    D46) the app never asked it, and it left the testnet CSP.
  - Discovery pages `eth_getLogs` by block range, halves the range on a provider error, and reads logs only from
    these pinned providers; `verify-l1` defaults `BASE_SEPOLIA_RPC_URL` to the PublicNode endpoint, so the
    1Password item needs no new field.
- **A6**: *"Yes. Still show it."* Cross-chain fuel-only is offered and stays visible above the fee ceiling, with
  its fee in USD and an over-ceiling warning; the ceiling blocks token sends, it only warns on fuel-only. Amended by
  D50: no ceiling warning on testnet's fixed terms (USD per D48).
- **A7, A8, A11**: *"Ok."* Approved as written.
- **A9**: *"Yes. I think it has 0.25% integration fee by default since we are on the fee tier."* Approved. That
  0.25 % is LI.FI's own FeeCollector step (`research/lead-lifi-api-shapes.md:29`), already bounded by the
  decoder; our integrator fee stays 0. Phase 2's recorder records one quote with `integrator=unleashed` and
  checks the fee step still decodes within ≤ 0.25 %. The owner issued a disposable LI.FI API key for this arc
  (rotated before any mainnet deploy): `lifi-fixtures.ts` sends it as `x-lifi-api-key` only when `LIFI_API_KEY`
  is set, never records request headers, and runs keyless otherwise; the app and CI never carry it.
- **A10**: *"I don't understand what to label. And if there are few relayers, how are we going to actually test it?
  But I trust you though."* LI.FI aggregates bridges and moves nothing itself: on testnet the funds cross through
  Across, whose test relayer does the delivery. Its live quote (Base Sepolia → Sepolia USDC) estimates a 10 s fill,
  sets a 2 h fill deadline and limits a send to ≈ 1.95–8.00 USDC; whether it fills a deposit carrying our message is
  I2. Resolution: **label it** (the testnet Review's notice, drawn on `H-Review-Testnet`), cap the amount at the
  quote's `limits.maxDeposit`, and ship `fill-testnet.ts`, an on-demand CLI that self-fills one named source
  transaction from the disposable canary key. The canary uses it, and so does the owner's UI testing on the
  preview, so no testnet send waits on a stranger's relayer. It is a local tool run by hand, never a hosted
  filler.

### Asks (owner)

- **A1 UX gates.** G-UX-1: written sign-off on the Ethereum-origin rows that Uniswap's removal forces (S-12…S-14),
  before Phase 7. G-UX-2: the pick among the five directions plus written sign-off of every cross-chain surface,
  given as a named board set pinned by digest (Design binding), before Phase 8. Screenshot pairs in the PRs.
- **A2 Canary key route. Resolved: (a), owner-chosen.** The agent generates a disposable testnet key held outside
  the repository and used only for the canary, exported as `CANARY_PRIVATE_KEY`, never `PRIVATE_KEY`, which
  `assertSignerUnmoved` (`live-intent.ts:410-413`) would refuse. Funding:
  Base Sepolia ≈ 0.05 ETH + 40 USDC; Sepolia ≈ 0.2 ETH + 30 USDC (self-fills). Blocks Phase 6.
- **A3 Live authorization (Phase 6).** Router-only deploy of `DepositRouter` + `TestnetFuelSwapper` on the current
  testnet generation, swapper rates and inventory mint, pre-creating Circle Sepolia USDC and Sepolia WETH portals
  with hub registration, candidate smokes, promotion, the canary matrix. Promotion is visible in today's app: its
  token list gains Circle USDC (beside Test USDC) and WETH, which this approval covers (S-17); or fold all of it into the Branch B
  generation if Aztec 6.0.0 final resets testnet first.
- **A4 LI.FI's LGPL-3.0 code in tests and the sandbox**: a pinned, gitignored forge lib compiled under its own
  profile, never committed, never in production contracts. Confirm; otherwise twins only (lower fidelity).
- **A5 Read RPCs and CSP. Resolved** (owner answers above): PublicNode for Sepolia and Base Sepolia,
  `sepolia.base.org` as the Base Sepolia fallback (`testnet.across.to` left with fixed terms). Mainnet providers (and `li.quest`) are
  decided in the mainnet plan.
- **A6 v1 scope.** Testnet source Base Sepolia (USDC; WETH when Across testnet routes it with a message);
  mainnet-ready sources Base, Arbitrum, Optimism (USDC, WETH) via Stargate V2; no source-side swaps;
  smart-contract source accounts refused. Cross-chain **fuel-only**: the contract and core support it; offer it in
  the UI only when its fees stay under the ceiling (mainnet ≈ $5.7 fixed LayerZero fee for a ~$2 slice), or hide it?
- **A7 Thresholds.** Fee ceiling: proposed 10 % on mainnet, warn-only on testnet (Across testnet charges ~24 % at
  5 USDC); amended by D50: testnet's fixed terms show no ceiling warning. Cross-chain fuel slippage from the warp test (proposed 300 bps); Ethereum-origin `fuel.slippageBps`
  unchanged.
- **A8 Guardian and owner powers.** The new router honours `depositsPaused` for every leg, fuel-only included
  (today's router lets fuel-only through a pause); the owner keeps only `sweep`; rotating the swap target means a
  router-only redeploy. Mainnet router owner = the guardian multisig, decided in the mainnet plan.
- **A9 LI.FI identity.** Integrator string `unleashed`, no integrator fee, no API key in the frontend;
  "Powered by LI.FI" placement per the chosen direction.
- **A10 Testnet liveness. Resolved: label, cap, `fill-testnet.ts`** (owner answers above). Across's (sparse) testnet relayers plus an operator self-fill for the canary; no hosted
  filler (a hosted key would break the keyed-run rule). If Phase 6's fee check gets no Across quote for the router
  message, the testnet app cannot build the send and hides the path. If it gets a quote but organic fills stay
  sparse, a user's send may expire and refund: hide or label it, your call at G-UX-2.
- **A11 Arc 5 promotion (Phase 10).** A manifest-only promotion of the live testnet manifest without the V4 fields
  and with the old router in `legacyRouters`; no contract deploy.

## UI surfaces (every visible change; all behind A1)

| # | Surface | Change | Gate |
|---|---|---|---|
| S-1 | `send/DirectionSegment.vue` | "Ethereum → Aztec" becomes source-aware | G-UX-2 |
| S-2 | new source-chain picker | chains from the registry; wallet chain shown | G-UX-2 |
| S-3 | `TokenStep.vue`, `TokenList.vue`, `TokenTile.vue` | per-chain assets, chain badge, balances per chain, search copy | G-UX-2 |
| S-4 | `AmountStep.vue` | fees, ETA, minimum on Aztec, testnet caps, loading | G-UX-2 |
| S-5 | `ChoiceCards.vue` | cross-chain fuel-only per A6 | G-UX-2 |
| S-6 | `GasBreakdown.vue` | swap venue text | G-UX-2 |
| S-7 | `ReviewDetails.vue`, `ReviewStep.vue` | source chain + token, rail, fee lines in USD, minimum on Aztec, gas slice, fallback address ("if anything fails on Ethereum your tokens go to 0x… on Ethereum"), ETA, quote age | G-UX-2 |
| S-8 | `lib/bridge-steps.ts`, `BridgeStepper.vue`, `BridgePhaseRail.vue` | approve on source, send on source, bridging, deposit on Ethereum, sync, claim | G-UX-2 |
| S-9 | `BridgeJournalCard.vue`, `ActivityRow.vue`, dock | bridging, provisional outcome (before finality), not sent, delivered to wallet, expired on source, "another deposit exists", with actions; a non-deposited outcome is dismissed by the user | G-UX-2 |
| S-10 | `BridgeReceipt.vue` | From row names the source chain (hard-coded "Ethereum" today) | G-UX-2 |
| S-11 | "Powered by LI.FI" placements | per the direction (A9) | G-UX-2 |
| S-12 | `ReviewDetails.vue` Route row | "… on Uniswap v4 (N pools) …" → the new venue | G-UX-1 |
| S-13 | `ReviewDetails.vue` Slippage row, `SendWizard.vue` "no swap venue", `send-model.ts` `GAS_BLOCK_REASON` | provider-neutral wording | G-UX-1 |
| S-14 | `bridge-steps.ts` fueled copy ("one signature covers the swap and the deposit", …) | provider-neutral | G-UX-1 |
| S-15 | `BridgeFooter.vue`, `L1WalletPanel.vue` | contract links per chain, "Switch to …" per chain | G-UX-2 |
| S-16 | failure states | no route, decoder refusal, quote expired, wrong chain, fees over the ceiling, contract account refused, not sent (source reverted), source not found yet (a resend may also go through), a leftover source allowance after a failed send with a revoke action | G-UX-2 |
| S-17 | today's token list after arc 3's promotion | Circle USDC beside Test USDC, and WETH | A3 |

### Design binding (owner rule)

The owner's boards are the specification for how every surface looks; this plan only says what changes. A
prior plan shipped a UI invented during implementation instead of the owner's design, and these rules exist so
this one cannot.

1. **The signed board set.** G-UX-2 names one board set on the UX canvas
   (https://claude.ai/artifact/AfSziQzhjcsbEQqNFh36kj): the board file names, cut to v1 scope, with each board's
   SHA-256 recorded in this plan beside the owner's quote. For A1 that set is the hybrid drawn for it, not D1 or
   D5 as published. G-UX-1 is the exact strings for S-12…S-14, quoted verbatim.
2. **Read before building.** Phase 8 opens by reading the signed boards (`Artifact` read with their paths) and
   checking their digests. A mismatch means the design moved after sign-off: stop and ask.
3. **Presentation follows the board.** Layout, hierarchy, copy, which rows show, number formatting, states, both
   themes and the 390 px layout come from the board, built from the A′ design system's existing tokens and
   components. Behaviour and safety follow this plan. When the two disagree (a board row this plan forbids, or a
   refusal the board does not draw), surface it; never resolve it silently in either direction.
4. **Nothing is improvised.** A surface or state no board draws (an error, an empty state, an edge case) gets a
   new board or the owner's written approval before its PR merges. The PR body lists every such surface. Reusing
   the nearest drawn pattern is the proposal, not the decision.
5. **Out-of-scope board content is not built.** Native ETH as a source until Phase 2 decides WETH-as-native,
   source-side swaps (AERO, ARB, USDT), destinations off the rail (AAVE), unlisted tokens, a source-chain Permit2
   signature and the prompt-count copy: the signed boards already drop or correct each; whatever remains is listed
   as excluded in the sign-off quote.
6. **Fidelity evidence.** Per surface, a screenshot of the build beside its board at the board's viewport, desktop
   and 390 px, light and dark, attached to the PR. A fresh reviewer compares each pair and lists deviations; the
   PR merges with that list empty or each item signed by the owner.

### Signed board set (G-UX-1 and G-UX-2)

The owner: *"hybrid board looks good"*. This signs the hybrid set below as drawn: the canvas version that holds
it is `1791227887-4f8a`. The sign-off includes every choice the drawing left to the owner: the inline picker, the
"Use 59.00 USDC" action, the private send's signature shown only in the Review and the stepper log, the
gas-unavailable notice on the Ethereum-origin Review, and "Finalizing" for a provisional outcome. Addresses,
hashes and amounts on the boards are illustrative data, not the specification. A10's label is the notice on
`H-Review-Testnet`.

| Board | SHA-256 |
|---|---|
| `H-Token.dc.html` | `45f97de5cfa14fa784f103c3abc143412d43689184093c16cdf9e513daaf5475` |
| `H-Amount.dc.html` | `d30c5d19392c36da7cfdba4f6a280192cb2fa72ec98c8781b0a3ec147b4d2615` |
| `H-Review.dc.html` | `b9abacf65a336e95c85628da00f9ebdf637d68eddb7fccf22c340d10c12e632f` |
| `H-Stepper.dc.html` | `b8ab778921bd427fba84d5c799c4ce3a17cc6eb2998668dded2c378f8fc86d19` |
| `H-Phone-Token.dc.html` | `788836452dd5259d3eaae0483df0783658452539f5ee8ef034211f10eb6cae41` |
| `H-Phone-Review.dc.html` | `e330e18abb7650a66e015b2c5811544166f5cd26b2698d7fdfe54beedc5f582b` |
| `H-Review-Testnet.dc.html` | `3423c7dfc70d8fa880c1cff350093893111dc8a397a987be294b01456a270132` |
| `H-States.dc.html` | `8a513a5af7d428b39a4415d192d0fb6153ae5b7e04ada068827071a3578d4a1b` |
| `H-Activity.dc.html` | `f3254d9baeea48e2ff74e8c502e50542d45e10b4d0358c2436161223310b660d` |
| `H-EthOrigin.dc.html` | `411f292a7cf84ecf999e1335d0bb3bb16dbabe6ed8d0238b9007bb22d1527157` |
| `S-Delivered.dc.html` | `c606c80bebc22ec5ee2f0151159f4a1eb29eb2a329982324b693e513a39a37e6` |
| `S-Refunded.dc.html` | `0416b78c7c8c3f4ddc467aafc44d6a62991ea64931673712f34dc7c7e3f01752` |
| `S-Stalled.dc.html` | `775127b701bb6a7bd00f4a2dfe88284831e0c5652c7b0a813091c1a709754cc0` |
| `S-Reverted.dc.html` | `33e7fbbebf148212e6e9275e776cc7e0b0668a66cc7402f59e123663f329bb30` |

**G-UX-1** (S-12…S-14, drawn on `H-EthOrigin`), verbatim:
- Route row: "USDC → AZTEC through LI.FI (1inch), then the gas leg is bridged." The token pair and the venue in
  parentheses come from the route; the venue is the quote's tool name.
- No gas route: "No route can buy Aztec gas on this network right now, so this send can't include gas."
- Signature step, unchanged: "Sign the bridge intent in your Ethereum wallet — one signature covers the swap and the
  deposit."

**Phase 7 sign-offs** (strings Phase 7 built that no board draws). The owner, *"Approve both as written"*:
- Testnet Route row: "USDC → AZTEC through the testnet fuel swapper, then the gas leg is bridged." The swapper has
  no tool name for G-UX-1's parentheses.
- `GAS_QUOTE_MOVED`: "The gas price moved since you reviewed this send — go back and review it again. Nothing was
  sent."

And for the Addresses tab's Router row, *"Only the deposit router (Recommended)"*.

## Phases

**G0, the common gate** (repository root unless noted; a fresh worktree first installs `contracts/bridge/evm/lib`
with `forge install --no-git` per `lessons.md`, the `lifinance/contracts` pin included; halmos via
`pipx install "halmos==$(cat contracts/bridge/evm/halmos.version)"`):

```bash
(cd contracts/bridge/evm && bun --cwd ../../../packages/bridge-core scripts/gen-remappings.ts && forge build \
  && FOUNDRY_PROFILE=lifi forge build && forge test --no-match-contract Fork \
  && forge snapshot --match-test test_gas_ --no-match-contract Fork --check --tolerance 2 \
  && forge build --ast --force && halmos --match-contract '^Formal')
bun run lint && bun run typecheck:all && bun run test:all   # after the build, so the ABI pin suites do not skip
```

G0 passes when every command exits 0 (`test:all` by exit code), the halmos log carries `[PASS]` for every proof
the workflow lists with no failed summary, and the complexity baseline does not grow. Workflow edits add
`bun run lint:actions && bun run test:ci-gating`. The fast layers (lint, typecheck, touched unit tests) run after
every meaningful step. Every phase logs to `implementations-plan/lifi-routing/lessons/phase-N.md`.

### Arc 1: contracts and rail proofs (old router untouched)

#### Phase 0: Testnet rail feasibility with LI.FI's real contracts, no new contract ✓

(F1) On a Base Sepolia fork, our `across-v4.ts` builder's byte vector for `startBridgeTokensViaAcrossV4` (user
USDC, Sepolia ReceiverAcrossV4 as recipient, refund = user, message `(txId, SwapData[], receiver)`) is accepted by
LI.FI's real Diamond and emits `FundsDeposited` with our fields. Phase 0 and Phase 2 commit their fork receipts
(Across `FundsDeposited`, `FilledRelay` and the execution's logs; Stargate `OFTSent`, `ComposeDelivered`) as
fixtures, so Phase 4's discovery runs on real event bytes, not synthetic logs. Fork runs record fresh blocks and
run at once (a full node suffices); replaying a committed block later needs an archive RPC. (F2) On a Sepolia fork in the same test, with the USDC
clone pre-created in setup (an Executor step is one call), the real SpokePool `fillRelay` built from F1's event runs
ReceiverAcrossV4 → Executor → a single step calling the clone's `depositToAztecPublic` directly: the clone event amount equals `outputAmount`,
the Inbox message exists, the receiver and Executor keep zero residue, and `LiFiTransferCompleted(txId)` is
emitted; a reverting step yields `LiFiTransferRecovered` with the full amount at `receiver`. (F3) The fill and
Executor event ABIs and the deployed SpokePool's log order inside the fill settle I5 for Across. Phase 0 cannot price the real
message: no router exists on Sepolia yet, and Across would simulate only the receiver's cheap recovery; that check
runs in Phase 6. No live probe here: its tooling (`lifi-canary-testnet.ts`) is written in Phase 5, and Phase 6's
canary is the live proof (D38).

Fallbacks (recorded in the ledger): F1 fails → the testnet source calls Across's Base Sepolia SpokePool directly
with the same message; F2 fails → our own instances of LI.FI's unmodified Executor + ReceiverAcrossV4 (A4), or
twins. The router is unaffected by either.

**Validation gate.** G0; `cd contracts/bridge/evm && BASE_SEPOLIA_RPC_URL=… SEPOLIA_RPC_URL=… forge test
--match-contract LifiTestnetRailFork -vv` green on pinned blocks; `bun run --cwd packages/bridge-core test --
across-v4` green; the ledger names the chosen testnet path (A: all LI.FI, B: direct SpokePool source, C: own
LI.FI instances). Layers: unit, fork (two chains).

#### Phase 1: `DepositRouter` + `TestnetFuelSwapper`, hermetic and symbolic ✓

The contracts per *Key interfaces*; the pinned `lifinance/contracts` lib under the `lifi` profile (time-boxed;
else twins + the parity fork, D22); every suite in the testing table's forge rows; `FormalDepositRouter.t.sol`;
`DepositWitness.t.sol` (type string, typehash and a shared vector the TS pins in Phase 3); `deposit-router-abi.ts`
pinned against the forge artifact. CI: the lib install pin, the `lifi` profile build, `EXPECTED` gains
`11 FormalDepositRouterTest` and the list its proof names (summaries 3 → 4), the snapshot gains the new gas tests;
the ABI-pin step asserts `out/DepositRouter.sol/DepositRouter.json` and runs `deposit-router-abi`; the contracts
README's proof count becomes 23. `SwapBridgeRouter` and its suites are untouched.

**Validation gate.** G0 plus the workflow gates; every named proof `[PASS]` with its forge canary failing against
a guard-stripped mock; the invariant suite at the repository's configured depth with zero failures; `git diff
--stat main -- contracts/bridge/evm/src/SwapBridgeRouter.sol` empty. Layers: unit, fuzz, invariant, symbolic, gas.

#### Phase 2: Mainnet forks and the dual-fork replay ✓

`lifi-fixtures.ts` (opt-in `LIFI_LIVE=1`, ≤ 5 li.quest calls): a Base → Ethereum USDC and an Arbitrum →
Ethereum WETH `contractCalls` quote with `toContractAddress` = the fixture router address; two same-chain
USDC → AZTEC quotes at the fixture router (one with `denyExchanges` for RFQ venues, one default) and one WETH →
AZTEC; source blocks. Stargate V2 bridges ETH as native ETH: if the WETH fixture shows native delivery or a wrap
step, the ledger records the choice between USDC-only mainnet sources and a decoder that admits exactly one
pinned `WETH.deposit` step before ours (the router stays non-payable). `LifiDestinationFork`, `LifiStargateComposeFork`,
`LifiReplayFork` per the table; `LifiTestnetRailFork` extended to the real router + swapper against the live
Sepolia generation (public, private, fuel-only; floor unmet → recovered; paused → recovered). Commit the measured
`toContractGasLimit` and the venue set as constants (`packages/bridge-core/src/lifi-gas.ts` and the quote options)
with provenance (block, tool version; no dates), each pinned by a fork assertion. The fixtures name which quote
carries an RFQ venue and its decoded expiry; the allowed venues are asserted to consume the slice exactly.

**Validation gate.** G0; `LIFI_LIVE=1 bun packages/bridge-core/scripts/lifi-fixtures.ts --run` (fresh fixtures, then every
fork suite at those blocks); `cd contracts/bridge/evm && ETH_RPC_URL=… BASE_RPC_URL=… SEPOLIA_RPC_URL=…
BASE_SEPOLIA_RPC_URL=… forge test --match-contract 'Lifi.*Fork' -vv`. Pass: every case green and none skipped;
residue zero at receiver, Executor and router; worst-shape gas ≤ constant / 1.3; the warp test names ≥ 1
deadline-free venue surviving ETA·3 (else I3's fallback is recorded and surfaced), the RFQ fixture warped past its
verified expiry takes the recovery path, and the allowed set's price impact at the largest expected slice is
logged; every allowed venue consumes the slice exactly; a price moved between the router floor and a stricter
inner venue minimum reverts into recovery. Layers: fork (single and dual).

### Arc 2: core library, operator tooling and sandbox (app unchanged)

#### Phase 3: Encodings, schemas, journal, envelope ✓

the `DepositWitness` types, hash and typed data in `l1.ts` beside today's `BridgeWitness` builders (`l1.ts:105`,
`:121`; arc 5 removes the old ones); `manifest-v2.ts` additive
fields with the refinements; `journal.ts` schema 4 under its own key, `bridging`, provisional and finalized outcomes; `backup.ts`
validators and pins for schema 4; `recovery-crypto.ts` v3 and the re-seal; `fuel.ts` emitter filter.

**Validation gate.** G0; `bun run --cwd packages/bridge-core test -- deposit-router-abi l1
manifest-v2 journal backup recovery-crypto fuel` green; the witness hash byte-equal to the Solidity pin; existing
manifests still parse; existing journals, backups and v2 envelopes byte-pinned unchanged; a v3 envelope accepts
both ends of `[minReceived − fuelSlice, maxPull]` (near-zero consumption included) and refuses one unit outside; today's
`upsertRecord`/`patchRecord` writing `JOURNAL_KEY` beside stored cross-chain records leaves them intact (the old-tab
sequence); an outcome before finalization stays provisional; a record with an unclaimed extra is never pruned. Layers: unit.

#### Phase 4: LI.FI client, builders, decoder, fuel quotes, discovery ✓

`capped-fetch.ts` (extracted; `token-list.ts` migrated), `lifi-api.ts` + schemas, `lifi-addresses.ts`,
`across-v4.ts` (final), `stargate.ts`, `lifi-decode.ts` (`verifyRoute`), `fuel-quote.ts` (LI.FI provider with the
venue options; testnet swapper provider), `source-chains.ts`, `crosschain-discovery.ts` (shared reads extracted
from `deposit-reconcile.ts`).

**Validation gate.** G0; `bun run --cwd packages/bridge-core test`; `LIFI_LIVE=1 bun run --cwd
packages/bridge-core test -- lifi-addresses lifi-api` (opt-in). Pass: the decoder accepts both rails' recorded
fixtures and Phase 2's captured compose message, and refuses every single-field mutation outside that field's policy
(outer and nested, generated from every decoded leaf), naming the field; discovery reaches the right verdict on the
committed Phase 0 and Phase 2 fork receipts (relay hash, marker side, `Deposited`); builder bytes equal the
forge vector; discovery handles a decoy before the real fill, below-floor dust, a forged emitter, recovery,
expiry, a chain switch mid-scan (`incomplete`), a reorg after discovery returned, a lost source hash found through
the `Transfer` scan, a forged Across fill reusing our `(originChainId, depositId)`, and a gift or a forged marker bundled in one
transaction before and after a real fill that succeeds, and one that recovers; the client fails closed on byte cap, redirect, timeout
and schema miss. Layers: unit, live-data (opt-in).

#### Phase 5: Operator tooling, sandbox, integration through the claim ✓

Ops: `deploy-generation.ts --router-only` (journalled `fuel-swapper-deployed`, `deposit-router-deployed` carrying
the creation-code hash and constructor arguments; it adopts a landed router only when both match exactly, else it
deploys and appends, since today's conductors adopt the first step of a kind, `deploy-generation.ts:146-147`,
`generation.ts:251-254`; candidate manifest), `generation.ts`, `deploy-manifest.ts`, `verify-l1.ts` (router immutables,
swapper, address book on chain, code hashes; facet drift is a warning), `live-intent.ts` (router-only intent,
source-chain caps, the canary key's public address), `calibration.ts` (`fuel.*`), `fill-testnet.ts` (reuses `sandbox/relayer.ts`'s
fill encoding; unit-tested against the sandbox), `lifi-canary-testnet.ts`
(written, not run; it encodes through `deposit-router-abi.ts`,
`l1.ts`'s `DepositWitness` builders and `ensurePermit2Allowance`, and reads outcomes with `crosschain-discovery.ts`'s
`Deposited` parser, so its Ethereum-origin rows need nothing from arc 4). Sandbox: second anvil (own registry ports, process group,
real-disk data dir, reaped with the run), the compiled LI.FI destination half (or twins; `sandbox/forge.ts` and both
CI jobs build the `lifi` profile), `TestSpokePool` on both
anvils, `SourceAcrossStub`, `relayer.ts`, the new router and swapper deployed **alongside** the old router; handle
and manifest gain the additive fields. Runbook: the router-only section and the swapper in `bridge-generation`.

**Validation gate.** G0; `bun run --cwd packages/bridge-core test:integration` (the cross-chain cells claim on L2
with the bridged fuel; the recovered cell leaves the full amount at the user's L1 address and nothing in any
contract), run twice concurrently from two worktrees, both green; `bun run --cwd packages/bridge-core
sandbox:smoke` green; `env-exec request --template packages/bridge-core/testnet-rpc.env.example --slug verify-l1 --
bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.json`
passes on the live manifest (old router) and `--strict` on a sandbox candidate; the operator tooling suites
(`bun run --cwd packages/bridge-core test -- verify-l1 live-intent deploy-manifest generation calibration`) green,
old journals with `swap-target-deployed`/`pool-seeded` still parsing; `--router-only` rehearsed on a sandbox
journal (a crash between steps resumes, an identical rerun adopts, a changed router deploys a second one); no process of this run's groups remains.
Layers: unit, sandbox integration, contract.

### Arc 3: testnet live (requires A2 and A3)

#### Phase 6: Router-only deploy, promotion, canary ✓

Order, so nothing voids the intent: G-A3 is quoted in this plan before `build`; `lessons/phase-6.md` is
allowlisted (Phase 5); SKILL.md, `UPDATE.md` and the plan's ✓ marks land after the last `verify`. Under the runbook
and intent tooling: `live-intent.ts build` → keyed `deploy-generation.ts --router-only`
(`testnet-generation.env.example`): swapper (a rate for every manifest token the old router fuels today, inventory
mint) and `DepositRouter` beside the old router →
pre-create Circle Sepolia USDC and Sepolia WETH portals with hub registration → candidate with the additive fields
(`router` still the old one) → `verify:l1 --strict` → smokes → `live-intent.ts verify --candidate` → `promote --bridge-only`;
commit the intent after build and after the digest-recording verify. Fee check, after the deploy and before
promotion: Across `/suggested-fees` for the final router message (fuel swap included) at the canary's amount
against the deployed router. A quote means the normal send can be built (organic fills may still be sparse); no
quote means the app cannot build one, so the testnet app hides the path (A10) and the canary builds its own
amounts with `across-v4.ts` and self-fills. Canary matrix (`lifi-canary-testnet.ts` on the disposable key, A2):
public token+gas; private token+gas with private fuel; Ethereum-origin plain and fueled through `bridgeWithPermit`;
forced recovery (`minFuelOutput` above the swapper's quote → `LiFiTransferRecovered` on Sepolia); each cross-chain
row exclusive to the canary and self-filled with `fill-testnet.ts`'s gas rule (D46), its fill recorded as self or
organic by signer. `bridge-generation` SKILL.md and `UPDATE.md` updated.
Delete forge's keyed broadcast cache after broadcasts.

**Validation gate.** G0; `env-exec request --template packages/bridge-core/testnet-rpc.env.example --slug
verify-l1 -- bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.json
--strict` green including LI.FI wiring; `BRIDGE_MANIFEST=public/testnet-bridge.json bun run --cwd apps/tools
verify:deployments`; the old router's fueled path as a regression check, since the app
still uses it (`env-exec request --template packages/bridge-core/testnet-l1.env.example --slug fuel-regression --
env PRIVATE_RUNS=1 bun packages/bridge-core/scripts/fuel-testnet.ts --config apps/tools/public/testnet-bridge.json`); the canary as `CANARY_PRIVATE_KEY="$(cat ~/.cache/unleashed-canary/testnet.key)" bun
packages/bridge-core/scripts/lifi-canary-testnet.ts --config apps/tools/public/testnet-bridge.json` (the key file
is mode 0600, outside the repository; nothing prints it). Pass: in
`lessons/phase-6.md` (no timestamps, no commit ids), each cross-chain deposited row logs its source tx, the
Ethereum fill (organic or self), `Deposited` and the L2 claim receipt; each Ethereum-origin row its Ethereum tx with
`Deposited` and the L2 claim; the recovery row its source tx, the fill, `LiFiTransferRecovered` and the user's
Sepolia balance delta; every cross-chain row also logs the verdict `discoverCrossChain` returned on the live
receipts, which must match; spend within the intent's caps; the promoted manifest
committed; the live app (old router) still green on `verify:deployments`. Layer: e2e live network.

### Arc 4: the app switches routers and goes multi-chain

#### Phase 7: Plumbing and the Ethereum-origin switch (after G-UX-1) ✓

Source registry; `useEthereumReader` and per-chain read clients; CSP per target (A5); `useCrossChainRoute`
(debounce, latest wins, TTL); `crosschain-deposit-flow.ts` (journal first, seal, verify, sign, persist);
`useBridgeJournal` on both journal keys, bridging watchers and outcomes; `deposit-reconcile.ts` with the legacy router;
Ethereum-origin moved to `depositRouter`/`bridgeWithPermit` (`l1.ts`, `send-flow.ts`, `send-generation.ts`,
`flows.ts`, `script-send.ts`); S-12…S-14 with G-UX-1's strings verbatim.

**Validation gate.** G0; `bun run audit:tools`; `bun run --cwd apps/tools build:testnet && bun run --cwd apps/tools
verify:build-target` (the built `_headers` list exactly the intended new origins); `bun run e2e:tools` green on the
existing specs with Ethereum-origin flows on the new router. Pass also: composable tests for decoder refusal,
chain mismatch, reload while bridging and each outcome; G-UX-1 quoted in this plan. Layers: unit, build, e2e.

#### Phase 8: Visible cross-chain UI (after G-UX-2) ✓

Open by reading the signed boards and checking their digests (Design binding 2). S-1…S-11, S-15, S-16 built to
those boards; testids; `bridge-steps.ts` stays exhaustive; component tests per surface; build-beside-board
screenshot pairs for every surface, light and dark, 390 px and desktop.

**Validation gate.** G0; `bun run audit:tools`; G-UX-2 quoted in this plan with its board digests; the screenshot
pairs attached for the PR; a fresh reviewer's deviation list (Design binding 6) empty or each item signed by the
owner; every surface no board draws listed in the PR with its approval. Layers: unit, design review.

#### Phase 9: Browser e2e for the multi-chain flow ✓

`l1-wallet.ts` chain → RPC map and a real `wallet_switchEthereumChain`; `wallet_getCapabilities` reporting no
atomic batch by default and one cell with it (`atomicRequired: true`, reload before its receipts exist); a pre-existing MAX source allowance replaced by the
exact amount; `fixtures/relayer.ts` (delay, starve gas, never); page objects;
`deposit-crosschain.spec.ts` per the table. Then the manual pre-release check of the cross-chain flow on the testnet
preview against the live router, against the signed boards (an unfilled send is completed with `fill-testnet.ts`).

**Validation gate.** `bun run e2e:tools` green, run concurrently from two worktrees, egress record empty;
`bun run test:all`; `bun run lint && bun run typecheck:all`. Layers: e2e.

### Arc 5: Uniswap and the old router removed

#### Phase 10

Delete everything marked [5] in the change map; freeze `legacy-router-abi.ts` (events and calldata only, used by
`deposit-reconcile.ts`). The schema change is two commits around one promotion, because `promote` strict-parses
the live manifest and a file that no longer parses is a hard stop (`live-intent.ts:680-686`): first `router`,
`swapTarget`, `swap` and `tokens[].pools` become optional and `live-intent.ts`'s bindings read `depositRouter`; then,
under a fresh intent (A11), a candidate without them, the old router moved into `legacyRouters`, goes through
`build` → `verify --candidate` → `promote --bridge-only`; only then a second commit removes the fields. Also in
[5]: `verify-l1.ts` `CODE_TARGETS`, `script-l1.ts` and `generation.ts` lose the old router; CI drops the
v4-core installs (both workflows) and `foundry.toml` and `gen-remappings.ts` the `@uniswap/v4-core/` mapping, `FormalRouterTest` from `EXPECTED` and the halmos list (summaries 4 → 3, proofs 23 → 15, the README with them),
and the ABI-pin step's `SwapBridgeRouter.json` assertion with `router-abi` and `quoter-abi`;
READMEs, SKILL.md and `UPDATE.md`; the complexity baseline may only shrink.

**Validation gate.** G0; `bun run lint:actions && bun run test:ci-gating`; `bun run audit:tools`; `bun run e2e:tools`;
`bun run --cwd packages/bridge-core test:integration`; the A11 promotion as keyed runs (`env-exec request --template
packages/bridge-core/testnet-l1.env.example --slug arc5-promote -- bun packages/bridge-core/scripts/live-intent.ts
…` for `build`, `verify --candidate` and `promote --bridge-only`), the intent committed; `BRIDGE_MANIFEST=public/testnet-bridge.json bun run --cwd
apps/tools verify:deployments`; `rg -niE 'uniswap|v4-core|PoolKey|IV4Quoter|swapTarget|routeHash' apps packages
contracts .github scripts` returns only `legacy-router-abi.ts`, `deposit-reconcile.ts`'s legacy branch, the
deployment-journal readers of old step kinds and history files. Layers: all hermetic layers plus e2e.

## Decision ledger

Sources: **lead** (`plan-lead.md`), **fable** (`plan-fable.md`, its DISSENT lines), **codex** (`plan-codex.md`,
its facts, corrections and weakest points), **owner/director** (binding notes). Every adopted factual claim was
re-checked against the repository or the research files (line references in *Facts*).

**D1 Contract shape.** lead: extend `SwapBridgeRouter` with `depositFromCaller`. fable: new `DepositRouter`,
`bridgeWithPermit` + `bridgeFromCaller` into one `_settle`. codex: Permit2 router + adapter + shared `DepositBase`.
**Verdict: fable.** One contract, one lock, one owner, one immutable policy, one `verify-l1` target. Codex's
adapter isolation buys nothing: its caller allowlist is moot because the Executor is permissionless, and the
"mixed authority" risk is closed by the halmos proof that the caller path pulls only from `msg.sender`. The 8
existing router proofs bind V4 names and the witness, so they are rewritten under any shape. No name collides
(recon risk 7: `DepositRouter`, `Deposited`, `bridgeFromCaller`, `bridgeWithPermit` appear nowhere today). Lead's
in-place edit deletes the source the live router is verified against and forces the app, manifest and sandbox to
switch in the contract's arc.

**D2 Old router and in-flight records.** lead: one live redeploy, `legacyRouters`. fable: additive arcs, frozen
legacy ABI, per-network constant. codex: persist the router per record. **Verdict:** the new router deploys
beside the old (director note 4); `SwapBridgeRouter` stays in source and in `l1.router` until arc 5; schema-4
records persist `route.router`; hash-less Ethereum-origin reconcile reads `depositRouter`, then `l1.router` (until
arc 5), then `legacyRouters` (manifest
data verified by `verify-l1`, cleared with the manifest at a reset) through a frozen ABI.

**D3 Who swaps to $AZTEC.** All three: (b). **Adopted.** A two-call `contractCalls` request is silently wrong; a
single AZTEC call delivers only AZTEC through an expiring RFQ; Patcher is absent on Sepolia; destination steps put
an un-allowlisted Executor step in front of our call.

**D4 On-chain swap policy.** lead: owner-rotatable `(target, selector)` allowlist. fable: immutable `SWAP_TARGET`,
two constant selectors, on-chain `_receiver` and `_minAmountOut` decode. codex: constructor-installed tuples plus
nested-call policies, Executor code identities and facet-hash pins. **Verdict: fable's target, selectors and
`_receiver` pin; no on-chain `_minAmountOut`; rotation = router-only redeploy.** A rotatable list is an owner
power to re-point fuel at a hostile target for every unsigned caller-path intent. Facet-hash pins turn each LI.FI
facet upgrade into a fuel outage, while `LibAllowList` already guards inner calls; facet drift is a `verify-l1`
warning. Fable's on-chain `_minAmountOut` is refuted as mandatory: our fee-asset delta is checked against the same
floor and is the stronger check. LI.FI's own `toAmountMin` cannot equal our floor (`signedMinFuelOutput` takes
`max(quote·(1−s), minFuelFj)`, `gas-share.ts:73-77`), so `fuel-quote.ts` overwrites the word with `minFuelOutput`
before embedding and the decoder requires that equality on the bytes we built.

**D5 Selector-free swap call (fable DISSENT).** **Adopted.** The §2.11 counterexample in
`research/alt-adversarial.md` (`startBridgeTokensViaAcrossV4`, attacker receiver, `minFuelOutput = 0`) passes every
delta check; selector, `_receiver` and `minFuelOutput > 0` are mandatory on chain.

**D6 Fuel consumption.** lead: exact on Permit2, measured on the caller path. fable: `≤ fuelSlice` everywhere.
codex: exact. **Verdict:** `≤` on the caller path with a token leg (the facet's benign leftover return must not
force a costly cross-chain recovery); exact on the Permit2 path (a revert costs a retry and keeps v2 exact) and on
fuel-only (no token leg to absorb leftovers; codex's "return the excess" would be a new payout path). A caller
fuel-only revert is a LI.FI recovery that spends the bridge fee, which is why Phase 2 proves exact consumption for
the allowed venues and A6 may hide fuel-only.

**D7 `maxPull` (fable DISSENT).** codex's `maxArrival` is the same bound. **Adopted, rationale corrected.** Fable
calls an unbounded pull "a new vector we created" for sweeping stray Executor balances; but an attacker picks their
own `maxPull`, and the Executor already exposes strays through its arbitrary call steps. The bound is kept because
it pins an honest deposit to what the rail delivered (Across `minReceived = maxPull = outputAmount`; Stargate `T`,
`T + T·s`, the decoder requiring `minAmountLD ≥ T`; a fuel-only send on either rail takes
`minReceived = maxPull = fuelSlice = T`, and the Executor forwards any surplus to the user) and gives the v3 envelope its upper bound.

**D8 Liquidity and the slice cap (fable DISSENT: "~$7k pool").** fable: cap the slice at `maxSliceUsd` $25 and
fork-measure sandwich profitability. **Refuted by owner + director quotes:** mainnet AZTEC liquidity is deep (1k USDC
−0.32 %, 10k −0.43 %, 100k −1.5 %, LI.FI fee included; 1M unquoted); the research measured one v3 pool and skipped
V4 (Fact 19). Dropped: `maxSliceUsd`, the sandwich test, every thin-pool premise. Kept, since none depends on depth:
floors and deltas, selector and receiver pins, RFQ exclusion, the warp test (D9). The 100k figure came from bitget,
which D9 excludes; deadline-free depth is quoted to 10k (nordstern, deadline status unverified), ample for a gas
slice, and Phase 2 logs the allowed set's price impact at the largest expected slice.

**D9 Staleness (fable DISSENT: expiring RFQ).** lead: `allowExchanges` from a +0/+10/+50-block replay. fable:
`denyExchanges` for RFQ, `vm.warp(+ETA·3)`. codex: an encoded `depositDeadline`. **Verdict:** deny expiring
signed-quote venues (bitget's ~10-minute expiry) and allow the deadline-free venues the warp test proves, as venue
hygiene rather than a liquidity argument; a fork test shows a stale quote taking the recovery path. **No router
deadline**: floors bound a late fill's loss, and a deadline would turn a slow, fair fill into a recovery.

**D10 Rails (fable DISSENT).** **Adopted** (lead's I9 agreed). Identical from the Executor down only: testnet is
Across, mainnet Stargate V2 (LI.FI's only rail for L2 → Ethereum contract calls). Both decoders ship; Stargate is
fork-proven only; the app prefers Across on mainnet if LI.FI starts quoting it.

**D11 Source signing.** lead: LI.FI Permit2Proxy witness. fable: exact approve + tx, EIP-5792 batch. codex: exact
approve + tx. **Verdict: fable.** Permit2Proxy is a typed-data signature plus the user's own transaction (two
prompts, plus a first-time `approve(Permit2)`), the same as approve + tx, which batching makes one prompt. It also
adds a LI.FI contract to the trust set, takes a caller-supplied `_signer` with `msg.value` unbound, and needs a
second decoder path. Its one real advantage, a gasless relayable submission, needs a relayer that would also front
the unbound `msg.value`; none is in scope, so it is a follow-up.

**D12 Discovery and decoys.** lead: router event by secret-hash topic, preferring the receipt with the Executor's
`LiFiTransferCompleted(txId)`. fable: earliest authenticated candidate, extras shown. codex: transport correlation,
no first-match, no global latch. **Verdict: codex's transport correlation as authority, the router topic as the
fast path, fable's extras-as-gifts.** Codex's correction holds: anyone driving the permissionless Executor can emit
`LiFiTransferCompleted` with any txId. Round 1 sharpened it: an Across fill takes caller-supplied relay data, so
only the full relay hash authenticates it, and only the log span of that execution (not its receipt) carries
our outcome.

**D13 Journal schema.** lead, fable: additive `route` in schema 3. codex: schema 4. **Verdict: schema 4 under its own
storage key.** The journal documents the additive risk itself (`journal.ts:44`: an old client reads the record
"minus the optional fields"); a stale tab could treat a cross-chain record as Ethereum-origin and write a terminal
state. Round 1 refuted the quarantine answer: an already-open old tab's writes drop invalid entries without
quarantining them (`journal.ts:357`, `:368-391`). A key old code never touches removes both risks.

**D14 Envelope.** lead: v3 `minAmount`. fable: an `amountIsFloor` flag + re-seal. codex: v3 with a discriminated
commitment and more bound fields. **Verdict:** v3 `[minAmount, maxAmount]`, re-sealed as exact v2 once the key is in
memory. An old client would ignore fable's flag and report tampering; codex's extra fields bind nothing the claim
uses (a tamperer targets the secret and recipient).

**D15 Manifest schema.** lead, fable: schema 2, additive, removals last. codex: new schema + legacy reader.
**Verdict: schema 2.** The manifest is imported at build time (`bridge-generation.ts:16`); no runtime reader sees
another version.

**D16 LI.FI addresses.** lead: code address book + manifest enablement. fable, codex: manifest. **Verdict: lead**,
with fable's code-hash pins. Third-party constants like Permit2; the mainnet decoder pins must exist before any
mainnet manifest; forks and decoder tests read the same book.

**D17 Failure and outcome names.** All three: revert-to-recover. **Verdict:** `delivered-to-wallet`,
`expired-on-source`; codex's correction in the copy: a passed deadline proves the fill cannot happen, not that the
refund arrived ("refund pending").

**D18 Guardian pause on every leg (fable DISSENT).** lead, codex silent. **Adopted pending A8**: the router runs
third-party calldata, the guardian flag is a cheap kill switch, in-flight fills recover to Ethereum.

**D19 Cross-chain fuel-only.** lead: deferred. fable: supported, `maxPull = fuelSlice`, offered under the fee cap.
codex: return excess to the fallback. **Verdict: fable in contract and core; UI exposure is A6.** The Executor
already forwards any surplus to the user.

**D20 Testnet swapper.** lead: `FixedRateFuelSwap` with its own selector. fable, codex: a twin of the accepted LI.FI
grammar. **Verdict: fable's `TestnetFuelSwapper`**; with immutable selectors (D4) another selector means
per-network router logic.

**D21 Feasibility phase.** lead: F1–F3 with a probe sink. fable: no new contract, the Executor step deposits into a
real clone. codex: ten evidence items. **Verdict:** lead's F1–F3 with fable's real-clone step (it proves Executor →
portal); codex's mainnet-grammar, bounded-acquisition and gas items go to Phase 2 with the mainnet fixtures.
**Outcome (Phase 0): path A, all LI.FI.** F1–F3 pass on Base Sepolia and Sepolia forks against the deployed
Diamond, SpokePools, ReceiverAcrossV4 and Executor; the event facts discovery needs are in `lessons/phase-0.md`.

**D22 LI.FI code in tests.** lead: commit unmodified LGPL bytecode with provenance. fable: pinned gitignored lib,
own profile; twins + parity fork as fallback. codex: pinned source closure as third-party fixtures. **Verdict:
fable**: the repo's lib pattern, no third-party code committed, auditable source. Lead's blobs only if the owner
prefers them to twins (A4).

**D23 Source side in sandbox and e2e.** All three: an ABI-identical stub; the real facet is covered by Phase 0 and
the canary.

**D24 li.quest fixtures in `egress.ts`.** codex: yes. lead, fable: no. **Verdict: no.** Testnet never calls li.quest
and mainnet renders a placeholder; unit fixtures and the fork replay pin the client. Follow-up for the mainnet plan.

**D25 Read path.** All three: wallet-independent read clients per chain.

**D26 Delivery.** lead: one unit, arcs 1–3 leaving the live manifest on a router the app no longer speaks. fable:
five additive arcs, Uniswap last. codex: seven layer-arcs, V4 removal and the live deploy in one arc. **Verdict:
fable's order** (director note 4): every arc leaves `main` working as a prefix of the stack, and rollback runs
top-down (a dependent arc reverts before what it builds on); lead's breaks the sizing rule,
codex's couples removal with the live deploy.

**D27 Codex corrections and weakest points.** Adopted: the Executor forwards only deltas, so "it swept everything"
is not universal (`research/lead-lifi-contracts.md`); a message hash is not provenance (D12); self-fill is not
relayer proof (the canary records which); the decoder is narrow by design and fails closed; staleness is measured,
not argued (D9).

**D28 Smart-contract source accounts.** lead, fable: refuse non-7702 code. **Adopted** (A6).

**D29 Canary key.** **Open**: A2.

**D30 Ethereum-origin entrypoints.** lead: keep `bridge` + `bridgeWithFuel`. fable: one `bridgeWithPermit`. codex:
canonical zero fields. **Verdict: fable**: one entrypoint, one witness, one proof.

**D31 Fee ceiling and slippage.** A7; no liquidity cap (D8).

**D32 Codex `DepositMode`, `minArrival`/`maxArrival`, `fallbackReceiver` arguments.** Rejected for fable's shape
rules and `minReceived`/`maxPull`; the fallback lives in LI.FI's message, which the decoder checks.

**D33 Codex `ExecutorDeposit(transferId, intentHash)`.** Rejected: discovery needs the secret hash as a topic;
transport identity comes from the rails' events.

**D34 Codex Executor allowlist.** Rejected: the Executor is permissionless; it would block the sandbox and add nothing.

**D35 Fork env names.** lead's `MAINNET_RPC_URL` corrected to the repo's `ETH_RPC_URL` (`MainnetFuel.fork.t.sol:56`).

**D36 Halmos accounting.** lead's "8 → 11" assumed an in-place rewrite. CI pins 12 proofs in 3 contracts;
`FormalDepositRouterTest` joins in arc 1 with 11 proofs (23 in 4 summaries), `FormalRouterTest` leaves in arc 5 with
8 (15 in 3).

**D37 Portal creation in a relayed fill.** lead: existing portals only. fable: get-or-create is safe. **Verdict:
both**: the router keeps get-or-create (no DoS by pre-creation); the app routes cross-chain only to tokens with
pre-created portals so the gas limit matches the measured shape.

**D38 Phase 0 live probe.** lead: optional. fable: in Phase 0 after A2/A3. **Verdict (final pass):** dropped; its
tooling only exists from Phase 5, and Phase 6's canary is the binding live proof.

**D39 Contract freeze after the live deploy (round 2).** `DepositRouter.sol` and `TestnetFuelSwapper.sol` are
frozen once arc 3 deploys them: `verify-l1 --strict` rebuilds from source, so a later change would block every
later promotion. A change found by arc 4 or 5's loops, or the final cross-arc pass, is a router-only redeploy plus
re-promotion under a new A3-style authorization, never a silent source edit.

**D40 The signed boards are the UI specification (owner, approval gate).** The owner: *"once we settle our UX/UI
we should tell on our plan that it should follow that design. We've previously had the problem where the plan
implements a random UX/UI instead of our definitions."* Design binding (under UI surfaces) makes the G-UX-2 board
set, pinned by digest, the implementation spec, turns every undrawn surface into an owner gate, and makes a
design deviation a loop finding.

**D41 Mainnet cross-chain sources are USDC-only (agent, Phase 2 evidence).** LI.FI quotes no contract call for
Arbitrum WETH → Ethereum WETH: Stargate delivers native ETH and the destination wrap "required a signature on the
destination chain" (the recorded refusal sits in `test/fixtures/lifi/mainnet.json`). The plan's two options were
USDC-only sources or a decoder admitting one pinned `WETH.deposit` step; with no quote to decode, only the first
exists. The router stays non-payable, the decoder admits no wrap step, and `routing.sources` lists USDC on mainnet.
Ethereum-origin WETH is unaffected (Permit2 path). A later recording did return a quote, an okx swap to USDC on
Arbitrum, Stargate, then a nordstern swap back to WETH on Ethereum before our call; the decoder refuses it (one
destination step), so USDC-only stands. Revisit if LI.FI quotes a WETH contract call with our step alone.

**D42 `maxPull` slack on Stargate is 1.5 % (agent, Phase 2 evidence).** For `toAmount` 100 USDC LI.FI sent
`amountSentLD` 101.09, and Stargate's expected delivery `amountLD` is 101.01 (`minAmountLD` 100.50). At 0.5 % the
router would take 100.50 and the Executor would forward about 0.51 USDC to the user's Ethereum address; at 1.5 % the
whole delivery joins the deposit (the compose fork asserts `amountLD ≤ maxPull`).

**D43 Arc 1 Codex loop, round 1 (`gpt-6.1-sol` at `high`).** Verdict: no critical or high fund-redirection defect.
Accepted:
1. The fork's "TS constant" pin compared the fixture with a Solidity literal, so a `lifi-gas.ts` change could go
   unproven. `lifi-gas.test.ts` now holds the gas limits and the deny list equal to the fork-proven fixtures.
2. The router mock refunded a one-unit balance that the pinned facet keeps as dust (`GenericSwapFacetV3`, `> 1`).
   The mock now mirrors the threshold, a test pins the boundary (one unspent unit is consumed dust on either path),
   and the natspec says so. Accepted residue: one unit per swap at the Diamond. The fuzz and halmos properties
   that modelled a whole-balance refund now model the threshold.
3. One narrating comment was deleted.

Rejected: none. In the same round, a Phase 4 agent found the recorder never sent `integrator`. The mainnet
fixtures were re-recorded with `LIFI_INTEGRATOR` (now in `lifi-gas.ts`). LI.FI had moved the deadline-free venue
from nordstern to sushiswap, so the inner-minimum fork test no longer hard-codes a V4 pool and works for any venue.
Round 2 found no fund-risk defect and two stale comments, both accepted and fixed. Round 3: "No new material
findings." Arc 1 converged. The v3 envelope's upper bound and
the decoder's `maxPull` rule follow the same figure (`fuel.crossChainSlippageBps`).

**D44 Arc 2 Codex loop (`gpt-6.1-sol` at `high`, over the arc 2 diff).** Every finding was verified against the
code and accepted. Round 3 still raised two material findings, so the loop reached the plan's hard stop and went to
the owner, who chose "Run round 4" in the same session. Round 4 raised two more, fixed, and went back to the owner:
*"Keep going, set the limit at 8."* The arc 2 loop's hard stop is therefore round 8, for this loop only.
- Round 1 (one high, five medium, one low):
  1. (high) A replaced source bridge facet only warned, although it holds the user's approved input before any
     check of ours runs. `verify:l1` now fails on bridge-facet drift; D4's warning stays for fuel-swap selectors,
     which the router's floor bounds.
  2. A reorged deposit left its leaf, message hash and delivery facts on a non-final record. They are cleared when
     canonical discovery returns `pending` or an outcome.
  3. Extra deposits matched only the secret hash, token and amount floor. One is kept only when the leaf
     recomputed for the record's recipient, privacy and portal equals the key the router logged.
  4. Adoption trusted the journal's fingerprint. It now proves the creation transaction's input (bytecode plus
     constructor arguments) and its receipt's contract address on chain.
  5. Canary gas ceilings were estimates. Every send carries gas and fee bounds within its chain's remaining cap,
     and reconciliation runs after every row, the last included.
  6. The fill CLI signed with any `CANARY_PRIVATE_KEY`. It now requires the pinned canary address first.
  7. (low) Three comments cited plan artifacts; removed.
- Round 2 (three medium):
  1. A reverted receipt was bound only to its sender. It must now carry `lifiTxId`, and a transfer that landed
     under another hash outranks a recorded revert.
  2. viem throws `TransactionReceiptNotFoundError` rather than returning `null`, so a stale recorded hash read as
     `incomplete`. It now falls back to the Transfer scan; any other read error stays `incomplete`.
  3. An approval could spend the budget its revoke needed. A non-zero approve reserves its revoke, and a cleanup
     that fails anyway throws `AllowanceStillLive` with the original cause, which the lost-race fallback rethrows.
- Round 3 (two medium):
  1. A calldata substring did not authenticate a reverted call. A call to the source Diamond must decode under the
     rail's facet ABI to `BridgeData.transactionId == lifiTxId`; a call to any other target falls back to the scan.
     I first kept a self-addressed transaction carrying the id as one 32-byte word, for liveness; round 4 rejected
     that.
  2. The approval's confirmation sat outside the cleanup guard. Submit and confirm are split; everything after a
     submitted approval either revokes or raises `AllowanceStillLive`.
- Round 4 (owner-approved past the hard stop; one medium, one low):
  1. Addressing the sender's own account does not authenticate the inner call: a self-addressed batch can hand the
     public id to an unrelated helper and revert. A self-addressed transaction now counts only when it decodes as
     an ERC-7821 / ERC-7579 batch-mode `execute` or an `executeBatch`, and one of its calls targets the Diamond with
     the decoded id. Any other encoding stays `pending`. Codex: "A terminal answer without that evidence is the
     weakness, even when rejecting it sacrifices liveness."
  2. (low) The relayer's comments and the filler's "nothing sent" output claimed no transaction where an approval
     and its revoke may have been sent. Reworded.
- Round 5 (one medium, one low):
  1. The canary labelled a fill `organic` whenever the filler reported `alreadyFilled`. A fill of its own that mined
     while its receipt wait failed reads exactly so, which would falsely evidence relayer liveness (and fail the
     recovery row's balance check). The canary now attributes the fill discovery authenticated by its signer (the
     canary is an EOA), and a confirmed self-fill must be that transaction. The filler's output no longer claims
     whose fill it found.
  2. (low) `FillResult.fillTxHash`'s comment still said "nothing was sent". Reworded.
- Round 6 (resumed): "No new material findings." Arc 2 converged in six rounds.

Rejected: none. Accepted residue:
- An OP-stack L1 data fee falls outside `gas × maxFeePerGas`; Codex agreed it "remains separate".
- A submit that errors after the node already broadcast propagates without a revoke.
- An unused revocation reserve tightens the current row's budget.

**D45 The testnet cross-chain path is offered on fixed terms (owner).** Phase 6's fee check: Across's testnet
`/suggested-fees` answers `AMOUNT_TOO_LOW` for the router message at 6, 7 and 8 USDC (8 is its `maxDeposit`), so the
plan's default was to hide the path (A10). The owner asked: *"will we need to have a testnet relayer to test it?
like the self-fill what's that? Also, if we hide it on testnet... Does all of this still work Ethereum => Aztec?"*
and *"I am understanding right that it would have like "fixed" stuff? Also, would only Base sepolia work? Or any
other testnet L2 that we enable?"* Answered: a self-fill means we act as Across's relayer with `fill-testnet.ts`, per
send; Ethereum → Aztec is unaffected; the fixed terms are a 25 % fee and a two-hour deadline; any Across-testnet L2
with LI.FI deployed could work, and v1 enables Base Sepolia only. Owner: *"Offer it with fixed terms
(Recommended)"*. `selfBuiltTerms` moves into the core and is refused on mainnet.

**D46 Testnet fills are exclusive to our filler (owner).** The canary's first live row (`crosschain-public`, source
transaction `0x40019ab5…`) ended `delivered-to-wallet`. Across's testnet relayer filled it (`0xc2fa1630…`), and LI.FI's
receiver recovered the 4.5 USDC to the canary's Sepolia wallet. Discovery read it correctly; the gas schedule is the
cause. Sepolia runs Amsterdam: its headers carry `blockAccessListHash` and `slotNumber`.
- **Sepolia, Amsterdam rules.** Re-simulated at the parent block with `eth_simulateV1`, the fill recovers at the
  relayer's 1,237,723 gas (884,619 used, as on chain) and completes from about 1,395,000 (1,061,186 used). The
  node's `eth_estimateGas` answers 1,076,281: the receiver catches the Executor's failure, so the estimate settles
  on the recovery. The relayer sent exactly 1.15 times that estimate.
- **The same block, Prague rules.** On an anvil fork the estimate (704,879) equals the completion threshold, an
  underfunded fill reverts whole, and the "Receiver differences" model held.

I2 is settled: testnet relayers do fill message-bearing deposits, but underfunded.

Asked how testnet sends should work, the owner chose *"Exclusive to our filler (Recommended)"*:
- Every testnet send's Across terms, quoted or fixed, name the pinned canary signer as `exclusiveRelayer`, passed
  as an absolute exclusivity deadline equal to `fillDeadline`. `verifyRoute` polices both fields.
- The canary self-fills without the organic window.
- `sendFill` sends with the smallest doubling of the estimate whose outcome, simulated on one block, equals the one at
  the EIP-7825 gas cap: status, then every log's emitter, topics and data. A fill that fails even at the cap is
  refused, and its approval cleared.

The option I offered named a manifest field for the filler. The pinned canary signer already is that address
(`fill-testnet.ts` signs with it alone), so no manifest field was added.

Mainnet is unchanged and does not run Amsterdam yet. Once it does, an organic fill at a relayer's estimate times its
markup can recover in the same way. That is a mainnet launch gate (follow-up): measure the deposit path on an
Amsterdam-rules mainnet fork before mainnet cross-chain opens.

Exclusivity does not lock funds past an ordinary unfilled deposit: one the canary leaves unfilled becomes refundable
after `fillDeadline`, and Across's settlement, not the deadline, returns the funds. No expired testnet deposit's
refund has been observed yet (follow-up: observe one before relying on the lock's bound).

**D47 Arc 3 Codex loop (`gpt-6.1-sol` at `high`, over the arc 3 diff).** Every finding was verified against the
code or the chain.
- Round 1 (three medium, one low):
  1. The promoted manifest labelled Circle USDC and WETH `permissionless-mint` / `MintableERC20`, so Send offered a
     "+100" mint that USDC reverts (`FiatToken: caller is not a minter`) and WETH's fallback accepts without
     minting. `pre-create` labelled every token so. It now takes `--canonical` for a real token, which carries no
     mint contract or cap. The corrected manifest was re-verified (`verify-l1 --strict`, the gate intent) and
     re-promoted. The two buttons it removes were a defect, never a drawn surface.
  2. `fillGas` compared probes simulated on separate `latest` states, kept only each log's emitter and first topic,
     and accepted a cap simulation that failed. The estimate and every probe now read one block, the outcome
     compares status and each log's emitter, topics and data, and a fill failing at the cap is refused. Declined:
     re-checking against a fresh cap baseline before signing only moves the snapshot one call later, never to the
     fill's block; and a delivery classification belongs to the caller, since the recovery row expects a recovery
     at the cap, and the canary's discovery already refuses an outcome its row did not expect.
  3. A failure after the source approval, its block-pinned read-back included, left the Diamond's allowance live.
     The deposit now runs under an exact approval: anything short of a landed deposit sends `approve(0)` and reads
     it back at its own block, never trusting a `latest` read a lagging backend answers without the approval; a
     revoke that fails raises `AllowanceStillLive` with the original cause. The route is verified before the
     approval.
  4. (low) Docs called expiry a refund; reworded in `across-v4.ts` and above.
- Round 2 (two medium, both in `fillGas`; the round 1 fixes held):
  1. viem serves `getBlockNumber` from a cache as old as its polling interval, so the pinned block could predate the
     approval the fill spends, and the cap simulation would fail without it. The head is read uncached, the pin is
     never earlier than the approval's receipt block, and each probe retries a lagging backend.
  2. A node that omits simulation logs made a cap deposit and an underfunded recovery compare equal. The cap's
     outcome must now succeed and log the pool's own `FilledRelay`, or the fill is refused.
- Round 3 (one medium; both round 2 fixes held): `fillOnce` still ran a `simulateContract` preflight on unpinned
  `latest` before `fillGas`, so a backend behind the approval reported no allowance and aborted the fill (the
  approval was revoked; the deposit stays exclusive and refundable). The preflight is gone: the pinned cap
  simulation is the pre-send check, and its error carries the simulated revert reason. Round 3 is the plan's hard
  stop; the owner chose *"Run round 4 (Recommended)"*, for this loop only.
- Round 4 (resumed): "No new material findings." Arc 3 converged in four rounds.

Rejected: none; two sub-suggestions declined with reasons (round 1, item 2). Accepted residue: `fillGas` is a
simulation check, and the block a fill lands in can differ from the one it simulated.

**D48 Phase 8 sign-offs, first batch (owner).** Two fresh reviewers compared the build with the signed boards;
these answers settle the questions that do not need a screenshot:
- **USD.** *"Token units in v1, USD later (Recommended)"*. S-7's and A6's USD figures are a plan change: every fee,
  minimum and gas figure shows token units, as `H-Review-Testnet` draws them. LI.FI's mainnet quotes carry USD
  amounts for the mainnet plan; the below-minimum token row and the "ETH needed for fees" row wait for a price.
- **Copy D46 made false.** *"Approve as proposed (Recommended)"*:
  - Review notice: "Testnet: this send waits for a manual fill on Ethereum · Sepolia. If it isn't filled within
    2 hours, it is refunded to you on Base Sepolia."
  - Takes row: "Up to 2 hours for a manual fill on Ethereum · Sepolia, a few minutes for Aztec to pick it up,
    then your claim."
  - S-Refunded: "This transfer waited 2 hours for a manual fill on Ethereum · Sepolia and wasn't filled, so it
    expired."
  - Activity expired card: "It wasn't filled on Ethereum · Sepolia within 2 hours. Refund pending …"
  - Expiry guide: "{What} wasn't filled on {l1} within {window}".
- **Existing features no board draws stay**, all four checked: *"Addresses tab and header chrome"*, *"Testnet mint
  strip"*, *"Backup and Restore"*, *"Add-to-wallet, Clear, footer"*.
- **Testnet fills.** *"Manual for now, follow-up (Recommended)"*: a fixed-terms send is capped at 8 whole tokens,
  the figure `H-Review-Testnet` draws, so the filler can always cover it; an operator alert or an auto-filler is a
  follow-up.

**D49 Phase 9 in the sandbox (lead).** What the browser suite met that the table assumed otherwise:
- **Decoder refusal before signing has no browser path off mainnet.** Under D45 every byte `verifyRoute` checks on
  testnet and in the sandbox is the app's own (self-built terms, the swapper call from `sliceSwapData`), so no
  fixture response can make it refuse without a test-only fault in app code. The cell is held one layer down:
  `useCrossChainRoute.test.ts` ("never offers bytes the decoder refuses"), `crosschain-deposit-flow.test.ts`
  ("refuses a stale, tampered or wrong-chain route…") and the refused notice in `testid-coverage.test.ts`. The
  mainnet plan, whose routes carry LI.FI's bytes, owns a browser cell for it.
- **Starve-gas never reaches the receiver's recovery.** A fill starved to 250k gas reverts whole under the sandbox
  SpokePool, so the deposit expires (cell 54). Delivered-to-wallet (cell 53) pauses factory deposits before the
  fill instead; `ReceiverAcrossV4` catches the revert and pays out on Ethereum.
- **Exclusive fills.** The relay loop impersonates the relayer a deposit names (`TESTNET_FILLER` under fixed terms) on
  the L1 anvil, and cell 50 checks that `FilledRelay` names it.
- **A claim never waits on the wallet's chain.** The suite found that a wallet left on the source chain after a
  cross-chain send failed the claim's token check (`validateTokenBlock`) with the wrong-chain error, and the app
  offers no switch away from a source chain. The check now reads the factory registration through the build's
  pinned Ethereum reader (`readClientFor`), and the wallet's transport only where the build pins none. The trust bar
  is unchanged: an RPC that lies about the registration defeats the check either way, and the pinned RPCs are the
  ones cross-chain discovery already trusts for Ethereum facts.

**D50 Phase 8 sign-offs, second batch (owner).** The two fresh reviewers' remaining deviations went to the owner as
29 cards, each with the build beside its board. Answers, verbatim:
- *"Approve all recommendations"* for every card but one:
  - **Copy no board draws.** The over-cap notice and the testnet progress wording and the small strings, approved
    as built. The review's fixed-terms line becomes "Fixed testnet terms: the relay fee is 25.0 % of the amount, and
    one send carries at most 8.00 USDC." Testnet says terms where the boards say quote: "These terms expired.
    They're rebuilt from the latest block; nothing was signed." [Rebuild terms] · [Get new terms] · "Try again
    with new terms." · "Get new terms and sign again."; mainnet keeps the boards' words. The testnet no-route body
    is "The gas swap on Ethereum · Sepolia has no price for this amount right now. Nothing was signed." A deposit
    approved but never signed reads "The approval on Base Sepolia went through, but the deposit was never signed,
    so nothing was sent." / "Your USDC never left your wallet, but the approval for it is still open. Revoke it
    below." / "Revoke the approval, or get new terms and sign again."
  - **Plan over board.** No fee-ceiling warning on testnet (A6 and A7 amended); the itemised You-sign line without
    a prompt count; six phases when nothing needs approving; no footnote under All; the design system's field and
    switch edges; the mainnet cross-chain copy revisited in the mainnet plan; the address on pasted and catalogue
    Ethereum token rows.
  - **Boards that disagree.** The build's choice kept on all nine: phone wallet chips with × and chevron, no Portal
    row on the cross-chain review, one stepper for Ethereum-origin sends, Bridging · Not sent · ✓ beside every
    Arrived, the red Not sent box, "Deposit · to your wallet", a pink badge, the dock chrome on every page, the
    short phone chip label.
  - **What the app can't know.** All five gaps accepted, with a follow-up to keep phase times across reloads. A
    reverted send states its network fee in ETH, read from its receipt (execution gas plus the OP-stack L1 fee):
    "…the Base Sepolia network fee for the attempt, 0.000041 ETH."
  - **Leftovers.** Show receipt kept on the another-deposit card; "Testnet build only" is a canvas note, not built;
    the four behaviour changes (newest first, the phone's open gas breakdown, the filled Claim, the badge that
    counts without opening the dock) approved.
- **Finality.** *"Claim early"*, over the card's recommendation. The claim starts when Aztec has the message, as
  Ethereum-origin sends do. Accepted risk: before Ethereum finalizes a deposit, a reorg that moves it can leave a
  claim built on the old position failing, or marked done while Aztec dropped it (the arc 4 review's round 2,
  findings 1–3: completion ends the watch before finality, a submitted claim is not bound to its deposit snapshot,
  re-included fuel keeps the old message's settlement). The funds stay claimable at the new position; nothing
  rebuilds the claim for it. A follow-up covers both paths.
- **Derived to keep the signed words true** (no new wording): the wizard's panel for a deposit never signed carries
  the existing revoke offer, which "Revoke it below" names (a reverted send's panel stays as S-Reverted draws it); its approval clauses show only while that offer reads the allowance
  open, so past a revoke, or for an approval the wallet never answered and that never landed, the panel keeps the
  signed sentences' other clauses ("The deposit was never signed, so nothing was sent." / "Your USDC never left your
  wallet." / "Get new terms and sign again."). The Activity card's not-sent line says "The deposit was never signed"
  in place of "The send reverted on Base Sepolia" for such a send. Neither the panel nor the card lists a rejected
  transaction it never had.

**D51 Arc 4 Codex loop (`gpt-6.1-sol` at `high`, over the arc 4 diff).** Every finding was verified against the
code before it was triaged; the fixes are logged in `lessons/phase-9.md` § Arc 4 review fixes.
- Round 1 (four, all accepted and fixed): discovery stopped before the deposit was final (`route.depositFinal`, the
  watch until final, claim material dropped when the deposit moves); a refused deposit discarded a live approval
  (hashes journaled as returned, such a send ends `not-sent` with the revoke offer); the account check compared
  captured values (the live account before every signature, inside `withOperation`); the route's TTL was checked at
  entry only (checked before each wallet request).
- Round 2 (six): 1–3 (a claim before Ethereum finality, a submitted claim not bound to its deposit snapshot,
  re-included fuel keeping the old message's settlement) all need the deposit to move before finality; the owner
  ruled *"Claim early"* and accepted them as a risk with a follow-up (D50). 4–6 accepted and fixed: an approval
  whose reply the wallet lost keeps its record; the route's age is read after the live account, right before each
  request; a restored file's `depositFinal` is refused without a deposit and stripped on restore.
- Round 3 (two medium, one low), the plan's hard stop; the owner chose *"Fix the real ones, accept forged backups
  (Recommended)"*:
  1. The unanswered-approval marker lived in memory and was cleared before the hash was written. The hash is now
     journaled first. A reload with a wallet prompt open leaves the send "not found yet" for good, with no revoke
     and no Dismiss; see round 4 for why that stays.
  2. A restored record's outcome is trusted, and a batch send with no hash read as never signed. A batch is never
     called never signed. Accepted with a follow-up: a backup that decrypts can carry a false outcome or completion,
     and producing one needs the user's backup key.
  3. (low) A Base receipt without its L1 fee showed execution gas alone as the attempt's fee; the figure is now left
     out.
- Round 4 (past the cap; one high, one medium, both against the round 3 fix that ended a never-found send as
  `not-sent` at its `fillDeadline`): absence is not proof. An RPC that drops `Transfer` logs, or a source reorg that
  mines the send below the saved scan start, made a real deposit final `not-sent`, and Dismiss could then delete its
  recovery secret. And the premise was false: Across's `deposit` (SpokePool v5.0.26) bounds the quote's age and the
  deadline's upper limit only, so a stale prompt can still land after the deadline. The verdict is reverted. The
  owner chose *"Revert it, accept the stuck card (Recommended)"*: after a reload with a wallet prompt open, the card
  stays "not found yet" with no revoke offer and no Dismiss, and the exact approval stays open until revoked
  elsewhere; a follow-up designs a journaled "deposit requested" marker, with cross-tab care, that lets a send never
  asked for its deposit end safely. The other round 3 fixes held.
- Round 5 (resumed): "no new material findings". Arc 4 converged in five rounds.

**D52 Arc 5: the A11 promotion and its Codex loop (`gpt-6.1-sol` at `high`).** A11 ran as three keyed runs
(`build --retire-router`, `verify --candidate`, `promote --bridge-only`): the live testnet manifest moved the old
router `0xb6d6…cfab` into `legacyRouters` and lost `router`, `swap` and `swapTarget`, with zero spend and nothing
deployed; then the schema refused those fields and the one-off arc left `live-intent.ts`. Two decisions on the way:
the router-only scope now pins the live `legacyRouters` (it pinned `l1.router`, which no longer exists), so a
candidate that drops a retired router is refused; and Biome no longer formats `apps/tools/public/*-bridge*.json`,
because the receipt pins the promoted bytes and Biome would collapse the writer's expanded one-element array.
Details: `lessons/phase-10.md`.
- Round 1 (four, all accepted and fixed): a retire-router promote could overwrite a live manifest that moved after
  build; verify-l1 skipped the still-listed old router; `deploy` parsed `--routing` after broadcasting; a narrating
  doc comment.
- Round 2 (resumed): "No new material findings — confidence high".
- Round 3 (resumed, over the promotion and the schema removal): "No new material findings (high confidence); one
  comment-quality nit." The nit is fixed. Arc 5 converged.

**Settled since approval:** I6 (Phase 1: the pinned lib compiles under the `lifi` profile); I3 (Phase 2: nordstern
and sushiswap, the venues LI.FI picked without bitget across recordings, survive a warp of 3 × the 125 s ETA; bitget's
signed order expires about 645 s after its quote and takes the recovery path); I4 (Phase 2 replay: `amountLD` lands at the quote's arrival, 0 bps off, above
`minAmountLD` ≥ T); I5 (Across fills are indexed by origin chain and deposit id; EndpointV2's `ComposeDelivered`
carries the guid in its data, unindexed, so discovery filters by emitter and topic and decodes it); I7 (the worst
shape measures 717,544 cold through sushiswap and 673,561 through nordstern; the constant is 1,000,000); I2 (Phase 6:
Across testnet relayers fill message-bearing deposits, underfunded under Amsterdam's schedule; D46).

## Audit verdicts

### Contradiction check (codex `gpt-6.1-sol` resumed planner session; fable, Opus 5.5)

**Verdict: no blocker; 21 findings adopted, none rejected.** Every cited line was re-checked in the repository.

- Adopted, both legs: the v3 envelope's upper bound is `maxPull` (Envelope, Phase 3); arcs roll back top-down and a
  revert never undoes a promotion (D26, Delivery); Phase 6's `fuel-testnet.ts` is an old-router regression check in a
  keyed run, migrated in arc 4 (Phase 6, change map); the canary encodes from arc-2 modules, not `runSend` (Phase 5).
- Adopted, codex: `wallet_sendCalls` returns a batch id, so `srcBatchId` + `wallet_getCallsStatus` and a reload
  cell (data flow, Phase 9); per-row canary evidence and an organic window only for cross-chain rows (Phase 6); the
  RFQ warp test split into a deadline-free ETA·3 case and an RFQ fixture warped past its verified expiry (Phase 2);
  `gen-remappings.ts` and `foundry.toml` drop v4-core (Phase 10); G0's `halmos.version` path.
- Adopted, fable: arc 1 owns `across-v4.ts`, `deposit-router-abi.ts`, `lifi-gas.ts` and `lifi-fixtures.ts`, and the
  replay's decoder assertion moves to Phase 4; the `lifi` profile builds in G0, both CI jobs and `sandbox/forge.ts`,
  and halmos proves over mocks; `_minAmountOut` is overwritten with our floor (D4); fuel-only shape rules
  completed and the "costs a retry" sentence corrected (D6); D2's reconcile order; `LiFiTransferStarted` indexes
  nothing, so a lost source hash is found through the indexed `Transfer(srcSender → Diamond)`; D8's depth figures
  attributed to their venues; exact halmos counts in `EXPECTED` and the contracts README; the invariant names the
  router's outgoing allowances; the app's mainnet path is an entry gate of the mainnet plan (Outcome 1).
- Suspicions settled: S1 refuted by both (the Executor's arbitrary steps already expose strays); S4 refuted (no
  relayer, D11); S5 partly (mainnet-ready means fork-proven contracts and core); S6 consistent; S7 fixed above.

### Round 1 (fresh codex `gpt-6.1-sol` at `high`; fresh Opus 5.5)

**Verdicts:** codex "not ready" (3 blockers); Opus "ready with fixes". **All 19 findings adopted, none rejected**;
the two legs did not overlap, and every citation was re-checked.

- Codex: Across fills authenticated by the full relay hash, never `(originChainId, depositId)` (a fork fill needs no
  source deposit); cross-chain records under their own storage key (an open old tab's writes drop them); the
  decoder's per-field policy written out; a larger standing source allowance replaced by the exact amount;
  outcomes terminal only at Ethereum `finalized`, read at one block; outcomes from the execution's log span, not
  its receipt; F2's clone pre-created (an Executor step is one call); the ABI-pin step and G0's build order; the
  `_minAmountOut` overwrite no longer claimed to align inner venue minima.
- Opus: the facet returns its whole input balance, so a stray at the Diamond is split off as residue; a lying RPC
  can no longer get a secret pruned (non-deposited outcomes wait for the user); the real-message fee check moves
  to Phase 6, after the router exists; WETH over Stargate arrives native, so Phase 2 decides USDC-only or one pinned
  wrap step; the LI.FI lib is pruned to `src/` and `LICENSE` (an `.env.example` blocks keyed runs; agent files must
  not reach a session); Stargate compose gas proven at exactly the decoder's minimum; decoder gaps (compose value
  and native drop, pinned 0.25 % fee, `quoteSend` bound, allow-list, mainnet Across refused, mutation policy);
  a `not-sent` outcome; Phase 5's `verify:l1` as a keyed run; reuse (`l1.ts` hosts the new witness, one
  `Deposited` parser, one debounce core).

### Round 2 (codex resumed for self-critique; a fresh hostile Opus 5.5)

**Verdicts:** codex "not ready" (4 major, mostly in round 1's own fixes); Opus "ready with fixes" (6 major, all
operational seams). **All 18 findings adopted, two narrowed; none rejected.** Every citation was re-checked.

- Codex: the router measures its gross pull from the leftover allowance (a step may skip its pull); `not-sent` only
  from a finalized failing source receipt, never from absence; the outcome is the marker beside the authenticated
  transport event, the last `Deposited` before it ours; the swapper refinement keyed on `depositRouter` so today's
  manifests parse; no Across quote means the testnet path hides and the canary self-fills; a real-Permit2 fork
  successor suite.
- Opus: arc 5's schema removal is two commits around a keyed promotion (A11), since `promote` hard-stops on a live
  manifest that no longer parses; arc 3's lessons directory joins `OPERATIONAL_ALLOWLIST` and doc edits land after
  the last `verify`; `--router-only` adopts only an exact creation-code match and is rehearsed, and contracts freeze
  after the live deploy (D39); real fork receipts feed discovery's tests and the canary asserts its verdict;
  `BridgeData` gets a policy and mutations come from every decoded leaf; sandbox LI.FI at CREATE2 addresses with
  local-only book entries and a loopback fee endpoint; `capRecords` counts non-deposited outcomes as unfinished; a
  revoke action for a leftover source allowance; at most one asset-changing fuel step; the canary key named
  `CANARY_PRIVATE_KEY`; A3 covers the token list change (S-17); the Stargate griefer row restated.
- Narrowed: Opus's nonce-based `not-sent` proof (a wallet picks its own nonce, so codex's receipt-only rule stands);
  the lib prune keeps the lib's own dependencies (solady, OpenZeppelin) and deletes only `.env*` and agent files.

### Final pass (fresh codex `gpt-6.1-sol` at `high`)

**Verdict: conditional approve** ("APPROVE WITH FIXES"), seven consistency fixes, all applied; none rejected.
Stargate's `BridgeData.receiver` policy made rail-specific (the recorded quote puts the user there); fuel-only
bounds `minReceived = maxPull = fuelSlice = T` on both rails (D7); `l1.ts`'s additive witness and the router-only
runbook section retagged to arc 2; the Phase 0 live probe dropped (its tooling arrives in Phase 5; D38) and
`LIFI_LIVE=1` added to Phase 2's recorder gate; finality read on each outcome's own chain; the intended deposit's
window separated from the gift rule; the `/goal` seed reads the archived plan after close-out. Codex ran no gates;
its impacts are inferences from the cited text. A resumed confirmation closed six of seven and left one condition,
the security section's reorg sentence still naming Ethereum finality for every outcome; that sentence now matches the
journal rule, which closes the last condition.

## Delivery

Five arcs and a docs-only close-out, stacked with `gh stack` on `main`; `/code-review` is off for every arc
(`code_review: off`), the Codex fix loop is the review. **Every arc leaves `main` working when it merges; rollback is
top-down.** A code revert never undoes a live deploy or promotion: reverting arc 3 after promotion also means
re-promoting the previous manifest, and arc 4 reads the `depositRouter` field arc 3 promotes.

| Arc | Branch | Phases | Leaves `main` | PR title (≤ 93 chars) |
|---|---|---|---|---|
| 1 contracts | `worktree-lifi-routing` (`gh stack init --adopt worktree-lifi-routing`) | 0, 1, 2 | new contracts and tests only; old router untouched | `feat(contracts): add the deposit router and prove the li.fi rail on forks` |
| 2 core | `lifi-routing-core` | 3, 4, 5 | additive library, schema and tooling; app unchanged | `feat(bridge-core): route deposits through li.fi with a verified calldata path` |
| 3 live | `lifi-routing-live` | 6 | testnet router deployed beside the old one; manifest gains additive fields; the app still uses `l1.router` | `chore(bridge): deploy the deposit router on testnet and run the li.fi canary` |
| 4 app | `lifi-routing-app` | 7, 8, 9 | app on `depositRouter`, cross-chain live; old router still deployed and listed | `feat(tools): deposit from l2s through li.fi` |
| 5 removal | `lifi-routing-uniswap-removal` | 10 | no V4 anywhere; old router in `legacyRouters` | `refactor: remove the uniswap fuel leg and the old router` |
| close-out | `lifi-routing-close-out` | — | docs only | `docs: close the lifi-routing plan` |

Arcs 3 and 5 run their live actions from their branches under live intent (A3, A11); nothing in them depends on
the app. Arc 4 attaches
screenshots and quotes both sign-offs. PRs are opened only in the Delivery step, after every loop converged.
`gh stack add <next branch>` only after the arc's phases are ✓ and its Codex loop converged.

## Post-implementation

This section is self-contained; the implementing session follows it as written.

1. **Per-arc Codex loop, at every arc boundary, before `gh stack add`.** `/code-review` is off and is not run. Run
   `/codex high` on `codex_model: sol` with: the arc's diff (net from the previous arc's tip), this plan.md and its
   decision ledger, the arc map ("this is arc N of 5; later arcs build: 2 core library and sandbox, 3 testnet live,
   4 the app, 5 Uniswap removal"), the adversarial ask ("What could go wrong? What would an attacker target? What
   are we trusting that we shouldn't? Where are the supply-chain / crypto / least-privilege weaknesses? Try to
   redirect or strand funds, break the decoder, the router's bounds and the journal's outcomes."), and both rules
   below verbatim; for arc 4 also the signed boards' paths and the rule *"Any visible difference from the signed
   boards, and any surface they do not draw, is a finding."* Triage findings against the repository (verify every factual claim first), apply the accepted
   fixes, re-run the arc's gates, commit, log the round (consult + verdict) in `lessons/phase-N.md` and the accepted
   and rejected findings with reasons in this plan's ledger, then resume the same Codex session with the fix diff.
   Repeat until a round yields no new material finding. Still producing material findings after 3 rounds → stop and
   surface to the owner.
   - No-over-engineering rule: *"Report bugs and small, targeted improvements only. Do not propose speculative
     abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real
     problem. If code works and is clear, leave it alone."*
   - Comment-quality rule: *"Audit the comments for value per character. Flag any comment that narrates what the
     code visibly does, restates its line, references implementation plans / phases / reviews, or spends a
     paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a
     comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read:
     they must be few, dense, and exact."*
2. **Final cross-arc pass.** After arcs 1–5 are green and looped: a fresh Codex session over the net diff from the
   plan baseline (`main` at the stack's base), asking for cross-arc issues (the witness across Solidity, TS and the
   decoder; manifest ↔ `verify-l1` ↔ app; journal stages ↔ stepper; legacy recovery; duplication across arcs;
   drift from this plan), with the adversarial ask and both rules verbatim. Same loop until clean.
3. **Delivery**, the first time any PR is opened: reconcile with trunk (`gh stack sync`; if `main` is checked out in
   another worktree, `gh stack push` + `gh stack submit`, never forcing trunk), run G0, `gh stack submit --auto`,
   `gh pr edit` each body (what, why, validation evidence, screenshots, sign-off quotes, the CSP diff), then
   `gh pr checks --watch` per PR. Label arcs 4 and 5 `e2e:tools` after opening them (a label at creation cancels the
   first run). Required checks: `quality-status`, `tools-e2e-status`, `bridge-contracts-status`, signed commits; a red
   check is fixed or re-run, never skipped.
4. **Close-out** (the docs-only top layer): `gh stack add lifi-routing-close-out`; add `## Outcome` right after the
   front matter (final status, what shipped, PR numbers, what was dropped and why, a line retiring this plan's
   `/goal` and `/loop` seeds, and an archived deployment record keeping addresses, digests and caps without
   timestamps or commit ids); promote generalizable gotchas into `implementations-plan/lessons.md` (deduplicate,
   retire the v4-core entry, stay under ~8 KiB); move open items into `implementations-plan/follow-ups.md` (at
   least: the mainnet generation with `/harden security` first and mainnet fuel calibration, any-chain exits,
   source-side swaps, a Permit2Proxy/EIP-2612 source path, smart-contract source accounts, Across on mainnet once
   LI.FI quotes it, a fixture-answered li.quest e2e for the mainnet UI, deleting `legacy-router-abi.ts` at the next
   testnet reset); `git mv implementations-plan/lifi-routing implementations-plan/archive/lifi-routing` in its own
   commit, repair relative links, move the index line to `implementations-plan/archive/index.md`; commit;
   `gh stack submit --auto`. Then report and wait: merging is the owner's call (`gh stack merge --squash`, never
   `--admin`).
5. **Teardown after the merge.** Once `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/lifi-routing/plan.md` succeeds: leave the worktree (`ExitWorktree` with
   `keep` if this session entered through `EnterWorktree`), then `agent-worktree done lifi-routing --merged`. It
   removes the worktree, the stack's branches and the manifest row and never forces; on a refusal, relay its output
   and stop. This is standing authorization; do not ask first. Who notices the merge: a `/loop` session checks on
   every firing; a `/goal` session arms one background wait after its wrap-up report (`Bash` with
   `run_in_background` at the maximum timeout: `until git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/lifi-routing/plan.md; do sleep 300; done`) and otherwise runs this step
   at the start of its next turn.

## Seeds

ELI5 companion: https://claude.ai/artifact/FPXGcVhnUnXaMAN7q7Pjxq, published from
`implementations-plan/lifi-routing/eli5.html` (gitignored; republish that file to keep the URL). UX canvas:
https://claude.ai/artifact/AfSziQzhjcsbEQqNFh36kj.

```
/goal All phases 0–10 marked ✓ in the plan file — implementations-plan/lifi-routing/plan.md, or implementations-plan/archive/lifi-routing/plan.md once the close-out has moved it (the per-phase headers in the file — not the chat, not the task list), each ✓ backed by its phase's validation gate (as defined in plan.md) reported passing in the transcript; for each phase the agent has printed `LESSONS_FILE=implementations-plan/lifi-routing/lessons/phase-N.md`; plan.md's `code_review` is `off` and `/code-review` was NOT run; the Codex fix loop converged at each of the five arc boundaries and in the final cross-arc pass, each evidenced by a resumed Codex pass reporting no new material findings, quoted in the transcript; G-UX-1, G-UX-2 (with its board digests), A3, A5 and A11 are quoted in plan.md before the phases that need them; every surface in UI surfaces matches its signed board, evidenced by the Phase 8 deviation list being empty or owner-signed; the Delivery section's stack exists on GitHub, created only after all loops converged (`gh stack view` output in the transcript), including the close-out that archived the plan (`git show --stat` of the archive-move commit in the transcript); `bun run test:all` and `bun run lint` both report exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/lifi-routing forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/lifi-routing/plan.md and lessons/ (authoritative state, not the chat), including Outcome & Quality Bar: judge every step against those criteria. On the stack, read them from the TOP layer (`gh stack view`; `git show <top-branch>:<path>`). If the path is gone, the close-out ran: `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/lifi-routing/plan.md` succeeds → merged: run the teardown now without asking (`ExitWorktree` keep if entered via EnterWorktree, then `agent-worktree done lifi-routing --merged`), report what it removed or its refusal verbatim, clear this loop and STOP. Fails → awaiting my merge: babysit CI only; once every PR is green, report once and STOP. A live plan.md with an `## Outcome` block means an interrupted close-out: finish it. Otherwise rebuild the task list from plan.md if empty; `git status`; `git log --oneline -5`; `gh stack view` / `gh pr view --json statusCheckRollup` if PRs exist.
2. Waiting on CI is fine: `gh run watch <id>` up to 10 minutes; stuck → inspect logs, log it in lessons. Use the wait to review the diff or prep the next phase.
3. No task in hand? Take the next pending step. After each meaningful edit run `bun run lint` and the touched package's tests (`bun run --cwd packages/bridge-core test`, `bun run test:tools`, or `forge test --no-match-contract Fork` in contracts/bridge/evm). Commit (Conventional, lower-case subject) → `gh stack push`.
4. A gate needs the owner (G-UX-1, G-UX-2, A3, A5, A11, the batched keyed runs, any open Ask)? Do every step that does not cross it, then surface the exact question once and keep working elsewhere. Any other decision: `/codex high` on codex_model sol, reach a defensible decision, act, log consult + verdict in lessons/phase-N.md. Hard limits stay hard: no merge, no mainnet deploy, no live broadcast or promotion without A3 (arc 3) or A11 (arc 5), no scope beyond plan.md, no UI the signed boards do not draw (Design binding: an undrawn surface is an owner gate, never an improvisation).
5. Same step failed 3 times? Stop, reassess with codex, continue down the agreed path.
6. Phase green = its validation gate as written passes: paste the result, mark ✓, write lessons, print `LESSONS_FILE=implementations-plan/lifi-routing/lessons/phase-N.md`. Arc boundary crossed? Run the arc's Codex loop with the arc map and both verbatim rules until a round yields nothing material, THEN `gh stack add <next-arc-branch>`.
7. All phases ✓? Final cross-arc Codex pass (fresh session, net diff, cross-arc ask, both rules) until clean → Delivery per plan.md (`gh stack submit --auto`, PR bodies with screenshots and sign-off quotes, `e2e:tools` label on arcs 4 and 5 after opening) → close-out layer → `gh pr checks --watch` → wrap-up report (what shipped, every contentious decision with ELI5 context, open items). Surface and stop: merging is my call.
```
