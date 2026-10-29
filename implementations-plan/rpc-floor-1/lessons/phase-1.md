# Phase 1: per-endpoint history, routed by the fallback

## Gate (head 9e4a606, on main b8c2289)

- `bun run lint`, `bun run typecheck:all`: exit 0.
- Touched files: bridge-core 3 files, 12 passed and 2 skipped (the live blocks); apps/tools 3 files, 25 passed and
  1 skipped. `RPC_CAPS_LIVE=1`: bridge-core 11 passed (about 3 s), apps/tools 5 passed (about 2.3 s).
- Mutations, each red then restored with `git checkout`: `keptLogs` dropped from the wiring (the wiring test fails);
  `receiptOrNext` never hops (one bridge-core and the wiring test fail); `keptLogs` forwards below the floor (test 1
  fails); a hop on any mined transaction, without the 1,000-block line (the boundary and polling tests fail); a probe
  failure that throws (the probe-failure cases fail).
- `bun run test:all` and `bun run audit:tools`: exit 0 (tools 1,704 passed, bridge-core 538, sdk 446).
- Runtimes of the new tests: `kept-history.test.ts` about 40 ms for six cases; the wiring case about 15 ms.
- Mainnet bundle (the orchestrator's condition on A1): `build:mainnet` then `verify:build-target mainnet` passes
  (connect-src `'self' data: blob:`, legal links present). `_headers` is byte-identical to the build before the
  change. 35 of 40 files are identical. The rest are the catalogue chunk, which already carried the testnet URLs as
  inert data and now also names ethPandaOps; the app shell, which carries the wrappers, inert without read RPCs;
  `build.json` and `index.html`, which differ only in the build id; and the index chunk, which differs only in chunk
  hashes. `verify:build-target testnet` passes with ethPandaOps in connect-src.

## Measurements

- I3 confirmed: 27 reads of 2,000 Base Sepolia blocks through `cappedLogs(http(sepolia.base.org), 200)` at
  head − 5,000,000 took 47.8 s on this loaded host, past discovery's 45 s deadline. An old record with a lost source
  hash therefore reads `incomplete` on that path.
- WETH on Base Sepolia is sparse near head − 3,000,000 (about 37 logs per 2,000 blocks), so a 200-block live
  comparison can be empty on both endpoints. The live check compares 2,000 blocks.

## Notes

- viem's `waitForTransactionReceipt` with replacement checks on calls `eth_getBlockByNumber` after a not-found
  receipt. A stub without that method rejects the wait for a reason unrelated to receipts, so the polling case runs
  with `checkReplacement: false`.
- A `custom` stub's `switch` over methods passes Biome's cognitive-complexity limit only as a handler map.

## Review rounds

- Codex round 1 (`gpt-6.1-sol`, high, new session): clean.
- Opus review alongside: 4 Low, all fixed. Two new mutations confirm the added assertions: `receiptOrNext` on the
  last endpoint too (the wiring test fails), `earliest` treated as a head tag (test 1 fails).
- Stub pitfall: viem sends `eth_blockNumber` without `params`, so a fetch stub that reads `params[0]` throws and the
  fallback silently moves to the next endpoint; the wiring test caught it as a missing PublicNode call.
