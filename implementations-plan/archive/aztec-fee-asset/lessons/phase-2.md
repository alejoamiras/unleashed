# Phase 2 — The mint button and the Drip card

- `useFeeAssetMint` keeps the lock, the per-call amount and `lastMinted` at module level. Each caller gets its own `error`, so a Drip failure never shows on the Send strip. Its amount read is a `watch` scoped to the calling component; concurrent reads share one in-flight promise.
- Biome's cognitive-complexity cap (15) rejected the first `mint()` at 16. The fix was to split out `submitMint` (chain check, `FEE_ASSET()` guard, write, receipt), not to add a baseline exception.
- The strip shows the error of the last tap only (`lastTap`). Without it, a stale AZTEC failure would linger under a later manifest-token mint.
- **Deviation:** the plan said to register the card in `send/testid-coverage.test.ts`. That suite also asserts it covers exactly the files in `components/send/`, and the card lives in `components/`. The card's own test sweeps its interactive elements instead.
- `testid-coverage.test.ts` and `MintStrip.test.ts` mock `useL1Wallet` and `bridge-generation` field by field. The strip now calls `useFeeAssetMint`, so those mocks gained `isConnected`, `wrongChain`, `FUEL_ASSET` and `FUEL_ASSET_HANDLER` (coverage), or the composable was mocked outright (strip).
- `DripView.test.ts` counts card setups across tests. A new case that mounts the view must unmount it, or the next case counts its remounts too.
- `AddressesView.test.ts` timed out again on one full run (load average 224), then passed clean on the re-run. Same cause as phase 1.

Gate: `bun run lint` exit 0; `bun run typecheck:all` exit 0; `bun run test:tools` 112 files, 1662 tests (second run; the first failed only the 3 `AddressesView` timeouts); `test:e2e` 29/29; `build:testnet` built in 35 s.
