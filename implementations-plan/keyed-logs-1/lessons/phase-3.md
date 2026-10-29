# keyed-logs-1: phase 3

- The guard runs in about 45 ms. Its name scan covers `apps/` and `packages/` sources outside `tests/`; the five public
  names are listed in the test with their reasons.
- `SECURITY.md` no longer says env-exec masking is the only layer: `runKeyed` redacts first, env-exec masks second.
