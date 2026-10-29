# Phase 1: per-endpoint log caps

## Gate (7b79322)

- `bun run lint`: exit 0 (two `noDelete` infos in files this arc does not touch).
- `bun run typecheck:all`: exit 0, every workspace.
- bridge-core `capped-logs.test.ts` + `source-chains.test.ts`: 6 passed, 1 skipped (the live case).
- tools `useEthereumReader.test.ts` + `network.test.ts` + `network-targets.test.ts`: 24 passed.
- `RPC_CAPS_LIVE=1` on `capped-logs.test.ts`: 4 passed against the keyless endpoints. Each catalogued cap served,
  the next range refused with `-32614` (official) and `-32701` (PublicNode), and the official endpoint's ten-request
  split matched PublicNode's single answer over a recent 2,000-block range of the WETH predeploy.
- Mutations, each restored: no wrapping in `readClientFor` → the wiring test fails; the wrapper forwarding every
  request → test 1 and both test 2 cases fail; a `null` part returning the prefix → test 2 (`null`) fails; a wrong
  expected live code → the live case fails, naming `sepolia.base.org`.
- `bun run test:all`: first run red on `apps/tools/src/contracts/bridge-generation.test.ts` (5 s timeout at load
  average about 140; the file is untouched here). Alone it passed 10/10, and `bun run audit:tools` then passed all
  1,695 tools tests, the build and the deployment check (exit 0). Counted as host load.

## Runtimes

- `capped-logs.test.ts`: test 1 37 ms; test 2 26 ms (error) and 15 ms (`null`); live case 2.0 s.
- `useEthereumReader.test.ts`, the new wiring case: 170 ms.

## Notes

- A stub must throw viem's `RpcRequestError`, as `http` does: a plain thrown object becomes `UnknownRpcError` (code
  -1), which viem retries, and the request counts no longer match what an endpoint sees.
- The backup in test 2 needs its own wider limit: behind the capped endpoint it gets the whole range in one request.

## Fix loop

- Round 1: Codex (session in a gitignored scratch dir) clean with 2 Low comment findings; Opus same-family review 1
  material Low (no remainder range) and 3 Low. Fixed in c4924b8. New mutations, each restored: a loop that drops the
  last partial part fails test 1; a split that drops `address` fails tests 1 and 2.
- Round 2 (resumed Codex): clean. Converged in 2 rounds.
