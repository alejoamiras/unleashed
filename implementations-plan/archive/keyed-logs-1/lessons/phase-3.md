# keyed-logs-1: phase 3

- The guard runs in about 45 ms. Its name scan covers `apps/` and `packages/` sources outside `tests/`; the five public
  names are listed in the test with their reasons.
- `SECURITY.md` no longer says env-exec masking is the only layer: `runKeyed` redacts first, env-exec masks second.

## Implementation round 1

- Codex (gpt-6.1-sol, high, fresh): 1 Medium, reproduced with a local batch JSON-RPC server at `LOG_LEVEL=debug`
  (a first probe answering a batch with a single object never reached the inspected line). Opus review: 4 findings,
  all verified. Fixed in two commits; controls run for C1 and O3.
- Round 2 (resumed): no material finding; one Low comment nit fixed. Converged.

## Orchestrator steer: #49 folded in

- A1 reversed. The entry rule (a `scripts/` file with a CLI entry that reads a `KEYED_ENV` name must call `runKeyed`)
  found five entries, not three: `deploy-seed-tokens` and `lifi-fixtures` read L1 keys as well. All five now run
  through `runKeyed` with their existing failure text; a reverted `pause-factory` entry fails the guard.
- Fact 6 was wrong on one point: the relayer Worker imports `across-fill`, not `fill-testnet.ts`.
- Codex on the delta (gpt-6.1-sol, high, fresh): 2 Medium, 1 Low. Fixed: `lifi-fixtures --run` ran forge with
  inherited stdio, so a failing fork could print its keyed URL unredacted; forge's output is now captured and redacted
  (a child test with a fake forge; it fails with the fix reverted). Fixed: the entry rule now covers root `scripts/`
  and `void main()`. Known limit: viem prints a URL with its userinfo stripped, a derived form literal matching
  misses; recorded on #50, since no keyed template carries userinfo.
