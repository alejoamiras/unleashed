# keyed-logs-1: phase 2

- The verify-l1 regression runs in about 0.5 s (a local JSON-RPC server answering -32601, which viem does not retry).
- Controls: with `fail` unredacted the verify-l1 case fails; with `RunError` cutting before redacting the run.test case
  fails. Both pass with the fixes.
- `check-fpc-version`, `lifi-canary-testnet`, `live-intent` and `relay-claim-testnet` keep their own failure text through
  `describe`; `live-intent`'s dispatch became a function so it starts inside `runKeyed`.
