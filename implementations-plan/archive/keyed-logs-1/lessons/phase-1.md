# keyed-logs-1: phase 1

- `KEYED_ENV` takes names from `src/` reads too: `RELAYER_L2_SECRET_KEY` is read in `src/relay-claim.ts`, and
  `CIRCLE_API_KEY` in the relayer Worker. The plan said "scripts"; the guard scans both.
- `redactSecrets` replaces the longest value first, so a value containing another is matched whole.
- Control: the 9 990-character case prints the key prefix with `inspect(err, { depth: 8 })` and not with
  `maxStringLength: null`.
