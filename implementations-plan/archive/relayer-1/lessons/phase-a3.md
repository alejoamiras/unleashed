# Arc a3 — restock through Circle's faucet API

- The branch carried PR #29's thirteen commits; after its squash, merging `origin/main` was clean with identical
  trees, so a3 continues on the same branch.
- The Worker passes `fetch` to `restock` as an arrow over the global: workerd's `fetch` throws "Illegal invocation"
  when called with a foreign `this`, which `r.fetch(...)` on a plain object would be.
- Mutation checks (each removed, `bun run --cwd packages/testnet-relayer test`): the slot check, the threshold, the key
  check, the Worker's outcome gate, the key-segment redaction and the 200-character cut each fail a test. The cut
  needed a long Circle message in the `400` case before it did.
- `JSON.stringify` cannot label a table row that holds a bigint: name the rows.

## Fix loop, round 1

- workerd rejects `fetch(url, { redirect: "error" })` with a TypeError ("won't be implemented since it does not
  make sense at the edge; use \"manual\""), and Bun accepts it, so a Bun-run unit suite cannot see it. Use
  `"manual"` and treat any 3xx as a refusal; a `wrangler deploy --dry-run` bundle test does not execute the code.
- A test that stubs a rejected `TimeoutError` proves the log path, not the deadline: spy `AbortSignal.timeout` and
  give the stub a fetch that settles only when its signal aborts.
- Read an untrusted error body through its reader with a byte cap and `cancel()` past it; `res.json()` buffers it all.
