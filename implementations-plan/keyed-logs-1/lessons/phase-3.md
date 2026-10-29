# keyed-logs-1: phase 3

- The guard runs in about 45 ms. Its name scan covers `apps/` and `packages/` sources outside `tests/`; the five public
  names are listed in the test with their reasons.
- `SECURITY.md` no longer says env-exec masking is the only layer: `runKeyed` redacts first, env-exec masks second.

## Implementation round 1

- Codex (gpt-6.1-sol, high, fresh): 1 Medium, reproduced with a local batch JSON-RPC server at `LOG_LEVEL=debug`
  (a first probe answering a batch with a single object never reached the inspected line). Opus review: 4 findings,
  all verified. Fixed in two commits; controls run for C1 and O3.
