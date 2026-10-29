# rpc-caps-1 recon

Base: `main` at bee3a71. One Sonnet explorer (reuse sweep and caller map) plus the planner's own reads and live,
read-only probes of the keyless endpoints (curl, JSON-RPC, no key).

## Reuse map

| Capability | Found | Verdict |
|---|---|---|
| Chunked log scan | `scanRange` (`packages/sdk/src/execution/chain-scan.ts:94`): consecutive fixed chunks, no split, no error handling. Callers: `crosschain-discovery.ts:463` `logsOf` (source and Ethereum) and `deposit-reconcile.ts:179` (Ethereum only) | reuse as-is: the cap is the endpoint's, not the scan's |
| Per-endpoint cap data | none. `SourceChain.rpcUrls` is `readonly string[]` (`source-chains.ts:18`); the caps exist only as prose (`source-chains.ts:27`, wrong). Searched `maxLogRange\|blockRange\|logsRange\|logRange\|maxRange\|CHUNK_BLOCKS\|chunk` over apps/ and packages/ | build new: one optional field beside `rpcUrls` |
| Splitting a log query per endpoint | none. viem 2.57.1 has no chunking transport; `fallback` only hops (below). Searched `getLogs` wrappers, `custom(`, `createTransport` in apps/ and packages/ | build new: a transport wrapper in bridge-core |
| RPC refusal classifiers | none (`-32614\|-32701\|-32602\|LimitExceeded\|shouldThrow\|block range`). `receiptOrNull` matches a viem error by name (`crosschain-discovery.ts:293`) | not needed: per-endpoint caps avoid parsing refusals |
| App read client | `readClientFor` (`apps/tools/src/composables/useEthereumReader.ts:17`): `fallback(urls.map(http(url, { timeout: 20_000, retryCount: 1 })))`, no fallback options | adapt: wrap each `http` with its cap |
| URL lists | `SOURCE_CHAINS[84532].rpcUrls`; `BASE_SEPOLIA_READ_RPCS` hand-copied in `apps/tools/src/lib/network-targets.ts:88` (Node-safe; a test pins equality); `SEPOLIA_READ_RPCS` PublicNode only | reuse; caps are looked up from the catalogue, so `network-targets.ts` changes its doc only |
| Fetch stub for the app's reader | `stubRpcs` (`useEthereumReader.test.ts:13`): 503 or an `eth_chainId` answer per URL | adapt: answer `eth_getLogs` and JSON-RPC errors |
| Live-data test pattern | `describe.skipIf(!process.env.TOKEN_LIST_LIVE)` (`packages/bridge-core/src/token-list.test.ts:214`), off in `test:all` | reuse the pattern: `RPC_CAPS_LIVE` |
| Discovery stubs | `chain()` in `crosschain-discovery.test.ts:258`; `fakeChain` in `deposit-reconcile.test.ts:108` | untouched: discovery does not change |

## Who reads logs where

- **App discovery** (`discoverCrossChain`, called by `crosschain-watch.ts:107` with `{ now }` only, chunk 2,000).
  Its source read is the `Transfer` scan (`crosschain-discovery.ts:399`), which runs only for a record whose source
  hash is missing or does not bind. Its client is `readClientFor(84532)`, a fallback over PublicNode then
  `sepolia.base.org`. This is the one production path that can send a 2,000-block query to the capped endpoint.
- **App discovery, Ethereum side** reads Sepolia through PublicNode only (cap 50,000). **SDK reconcile**
  (`findDepositTx`) reads the caller's L1 client: the wallet's provider in the app (`useSend.ts:184`,
  `useL1Wallet.ts:28`), the caller's `r.l1` in `claim-run.ts:192`. Neither reaches a source chain.
- **Scripts**: `script-l1.ts:89` `sourceRpcUrl` takes `BASE_SEPOLIA_RPC_URL` or `rpcUrls[0]` (PublicNode); the canary's
  discovery (`lifi-canary-run.ts:419`) reaches the capped endpoint only through an operator override, where it fails
  closed (refused → `incomplete`).
- **Testnet relayer** (`packages/testnet-relayer/src/run.ts:43`, `CHUNK_BLOCKS = 500n`, its comment says Base's own
  endpoint serves 500): out of scope (relayer-2 owns it); its default RPC is PublicNode.
- Sandbox relayer and `deployer-funding.ts` read local or L1 chains only.

## Live measurements (Base Sepolia head ≈ 51,911,205; Sepolia head ≈ 12,021,794)

| Endpoint | Range cap (`to − from`) | Refusal | Other |
|---|---|---|---|
| `sepolia.base.org` | ≤ 200 (201 blocks served, 202 refused) | `-32614 "eth_getLogs is limited to a 200 range"`, no partial result | unfiltered queries allowed (4,099 logs over 200 blocks); served logs at block 31.9M (one sample) |
| `base-sepolia-rpc.publicnode.com` | ≤ 50,000 | `-32701 "exceed maximum block range: 50000"` | refuses a query over 20,000 results (`-32602`, names a narrower range); requires an address |
| `ethereum-sepolia-rpc.publicnode.com` | ≤ 50,000 | `-32701` | refuses pruned logs explicitly (`4444 "pruned history unavailable"`) from about 12,000 blocks back (about 1.7 days); serves blocks there |

- **Discovery's Ethereum side therefore refuses** any record whose Ethereum window starts more than about 12,000
  blocks back: such a record reads `incomplete` before Base's retention gap below can matter.
- **Consistency**: for a busy emitter over the same 2,000 blocks, PublicNode's single answer (2,916 logs) equals the
  sum of ten 200-block answers from `sepolia.base.org`.
- **Block time**: 1,000 Base Sepolia blocks span 200 s of timestamps (0.2 s per block, as #60 says).
- **PublicNode Base Sepolia retention (not a range cap)**: below block ≈ 47,000,000 (about 11 days back) it answers
  `eth_getLogs` with an empty list and `eth_getTransactionReceipt` with `null`, though it serves blocks and
  transactions there, and its own refusal names 46,500,000 as the earliest block. A range across the boundary
  (46,999,800–47,000,199) returns only the part above it: 44 logs where `sepolia.base.org` returns 62. Below
  46,500,000 it refuses with `4444`.

## viem `fallback` (2.57.1), as installed

Each request starts at the first transport (no `rank`). An error hops to the next unless `shouldThrow` (user
rejection, revert, 5000); the last transport's error is thrown. `http`'s own `retryCount: 1` overrides the 0 the
fallback passes; the fallback retries the whole chain (default 3) only on retryable errors (-1, -32005, -32603, 429,
5xx). `-32614`, `-32701` and `-32602` are not retryable. So within one scan, chunk k may come from one endpoint and
chunk k+1 from the other; a success, an empty list included, never hops.

## Open work and limits

Open issues: #60 (relayer window, relayer-2's), #61 (this lane), #65 (unrelated). Closed known limit #43 (the SDK's
week-of-blocks reconcile window) covers the Ethereum side's retention. No issue covers PublicNode's Base Sepolia
retention. `follow-ups.md` "Discovery windows" is about window size, not caps.
