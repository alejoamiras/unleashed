# rpc-floor-1 recon

Base: `main` at f24e033. One Sonnet explorer (reuse sweep and caller map), the planner's own reads, and live
read-only probes of keyless endpoints (curl and Bun `fetch`, JSON-RPC, no key). Earlier measurements:
`archive/rpc-caps-1/recon.md`.

## Reuse map

| Capability | Found | Verdict |
|---|---|---|
| Per-endpoint read facts | `SourceChain.maxLogBlocks` (`packages/bridge-core/src/source-chains.ts:23`), keyed by URL; only prose records the retention (`:36-39`). The L1 has no catalogue entry, so Sepolia's endpoints have no fact record (`useEthereumReader.ts:23` reads `sourceChain(chainId)`) | adapt: one optional record beside `maxLogBlocks`; Sepolia needs none (it refuses old logs natively) |
| Per-endpoint transport wrapper | `cappedLogs` (`capped-logs.ts:27`): wraps one endpoint inside the fallback, replaces only `request`, adds no retry layer | reuse the pattern for the two new wrappers |
| Routing between endpoints | viem 2.57.1 `fallback` (`clients/transports/fallback.js:36-62`): hops on every error except rejection, revert, 5000; never hops on a success; the last error is thrown | reuse as-is: the router is the fallback; a below-floor request only has to fail |
| Non-retryable refusal | viem `shouldRetry` (`utils/buildRequest.js:148-176`) retries `-1`, `-32005`, `-32603`, `-32007`, 429, some 5xx, and any error without a numeric code; 4444 is neither retried nor final | reuse: refuse with `RpcRequestError` code 4444, as PublicNode does; a bare `Error` would be retried up to 3 times by the outer layer |
| Read failure → verdict | `budgetedReads` (`packages/sdk/src/execution/chain-scan.ts:27-46`) turns any thrown read into `ScanIncomplete`; `discoverCrossChain` returns `incomplete` (`crosschain-discovery.ts:755`) | reuse as-is: discovery does not change |
| Missing receipt | viem's `getTransactionReceipt` throws `TransactionReceiptNotFoundError` on `null` (`actions/public/getTransactionReceipt.js:27-33`); `receiptOrNull` maps it back (`crosschain-discovery.ts:295`) | reuse; the wrapper acts below viem, at the endpoint |
| Wiring | `readClientFor` (`apps/tools/src/composables/useEthereumReader.ts:18-33`); URL lists in `apps/tools/src/lib/network-targets.ts:87-89` (Node-safe copy pinned equal to the catalogue, `network-targets.test.ts:44`); CSP derived by `readOrigins` (`:91`), pinned at `network-targets.test.ts:31-45` | adapt |
| Test prior art | `endpoint()` stub (`capped-logs.test.ts:16`), `stubRpcs` (`useEthereumReader.test.ts:29`), live gate `RPC_CAPS_LIVE` (`capped-logs.test.ts:93`, off in `test:all` and CI) | adapt; reuse the gate |
| A history floor anywhere | none in code (searched `4444\|pruned\|retention\|floor\|archive node` over apps/ and packages/); `exit-attach.ts` has its own Aztec-node "pruned" `Incomplete`, unrelated | build new |
| "Unreadable" UI state | none (searched `can't be checked\|cannot be read\|unreadable\|can't be read`). `incomplete` shows nothing: `crosschain-watch.ts:108-111` logs and retries every 15 s (`:41`); the record keeps its step copy. The only "can't be checked" copy is the 20-thrown-rounds give-up (`:152`) | none needed (no new state) |

## What discovery does today

- Any thrown read → `incomplete`, never terminal, no journal patch (`discoveryPatch`, `crosschain-discovery.ts:831`).
- A short answer → `pending`, which clears a provisional outcome and a non-final deposit (`:838`, `undecided`,
  `withoutDeposit`). Final records (`completedAt`, `depositFinal`) keep their facts (`:833`).
- Settling verdicts need positive evidence: a reverted receipt (`not-sent`), an authenticated execution
  (`deposited`, `delivered-to-wallet`). `expired-on-source` also reads `fillStatuses` at the finalized block and
  throws `incomplete` when it says filled (`:616`), so missing `FilledRelay` logs cannot mark a filled relay expired.
- Order: the source is read first (`readSource`), then Ethereum. The Ethereum window starts at `scanFromBlock`; for
  Across it closes at the first block past the fill deadline (testnet: about 2 h after the quote plus the 1 h quote
  buffer on the source side).
- Testnet enables one source, Base Sepolia on `acrossV4` (`apps/tools/public/testnet-bridge.json`). Mainnet has no
  read RPC (`network-targets.ts:184`). Scripts build single-URL clients (`script-l1.ts:165-185`) and never reach
  `readClientFor`.

## Live measurements (Sepolia head ≈ 12,022,483; Base Sepolia head ≈ 51,950,682)

| Endpoint | Logs | Receipts | Blocks |
|---|---|---|---|
| `ethereum-sepolia-rpc.publicnode.com` | refused `4444 "pruned history unavailable"` for any range starting more than about 10,000 blocks back (between head − 10,100 and head − 9,900; earlier the same day about 10,400); a range across the floor is refused whole | `null` below the floor (samples at 11,990,000 and 5,000,000) while `eth_getTransactionByHash` serves the transaction | served (5,000,000) |
| `base-sepolia-rpc.publicnode.com` | complete from 47,000,000; `[]` for 46,500,000–46,999,999; `4444` below, naming 46,500,000 as earliest; boundaries unchanged since head ≈ 51,911,205 | `null` below 47,000,000 (46,800,000 and 30,000,000 samples); the 46,800,000 transaction is served | served from 46,500,000; `4444` below |
| `sepolia.base.org` | served at 10,000,000 and 30,000,000 (cap 200) | served at 30,000,000 and 46,800,000 | `4444` below 46,500,000 (4 of 4 tries, same message as PublicNode) |
| `rpc.sepolia.ethpandaops.io` (candidate) | served at 5,000,000, 9,000,000, 11,000,000; one 5,000-block answer equals five 1,000-block answers and Tenderly's sum (USDC 10,719, WETH 2,966); one 6,000-block answer equals PublicNode's three 2,000-block answers (USDC 35,142); 50,000 refused (`-32012`); a busy 10,000-block query outran a 25 s probe | served at 11,990,000 and 5,000,000 | served (5,000,000); `finalized` tag and `eth_call` at it served |

Other keyless Sepolia endpoints, same probe: `sepolia.rpc.thirdweb.com` and `eth-sepolia.api.onfinality.io/public`
answered 429 from the first request; `sepolia.drpc.org` serves no Sepolia on its free plan; `1rpc.io/sepolia` caps
logs at 50 blocks; BlockPI needs a key; Blast is retired; `rpc.sepolia.org` (522), Omniatech (521), SubQuery and
RockX gave no answer. `sepolia.gateway.tenderly.co` was refused in `archive/lifi-routing/plan.md` (A5) for silent
truncation at 50,000 blocks; today it answers `-32602` past a few thousand. ethPandaOps answered 20 parallel log
requests without an error. Its CORS preflight echoes any origin (testnet host, a `workers.dev` preview, loopback)
with `allow-headers: *`.

## Open work and limits

Open: #75 (this lane). Closed known limits: #78 (PublicNode Base Sepolia's empty band; this lane makes it reachable
and closes the path), #43 (the SDK's reconcile window, separate), #44 (a dropped read believed, a different path).
Out of scope here: #65, #73, #80, the testnet relayer's own RPCs.
