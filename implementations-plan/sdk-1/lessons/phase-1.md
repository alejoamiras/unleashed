# Arc a1: the mainnet fuel route

- **1.1 gate.** `forge test --no-match-contract Fork` 172/172; halmos 18/18 (`FormalFuelOnlyGateTest` 3), the CI
  count assertion simulated on the log.
- **1.2: the stale rc.1 fixture.** Five script tests failed under `test:all` because
  `test/fixtures/testnet-bridge.pre-lifi.json` carried the rc.1 PrivateFPC; the manifest now checks `privateFpc`
  against its line, so the frozen fixture moved to the installed line's FPC.
- **1.2: mainnet re-pin, read-only.** The keyless `https://eth.drpc.org` and `https://aztec-mainnet.drpc.org` gave the
  registry's canonical rollup (`0xE37A…402f`, 2070860440, node 6.0.0), its portal `0x5343…f3b3` and `getFeeAssetPortal()`
  naming that portal; the 5.0.1 rollup and its portal remain registered.
- **1.3: the mainnet node reports no `feeAssetHandlerAddress`.** `assertL1Pins` required all five addresses; it now
  skips the handler only when the pin and the node both lack it.
- **1.3: candidate-building tests read frozen manifests.** The new tests first read `apps/tools/public/mainnet-bridge.json`,
  which the first mainnet promotion rewrites; they read `test/fixtures/mainnet-bridge.placeholder.json` instead.
- **1.3: no forge build while the browser suite runs.** Its sandbox deploys from `contracts/bridge/evm/out`; the fork
  test was compile-checked into a scratch `--out` instead.
- **Review round 1.** Codex (`gpt-6.1-sol`, high) and Opus 5.5 both found that a first route's journal stamp failed
  its own intent; see the plan's Audit verdicts. Known limits filed closed: #30, #31.
