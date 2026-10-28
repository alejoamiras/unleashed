# Arc a3 — restock through Circle's faucet API

- The branch carried PR #29's thirteen commits; after its squash, merging `origin/main` was clean with identical
  trees, so a3 continues on the same branch.
- The Worker passes `fetch` to `restock` as an arrow over the global: workerd's `fetch` throws "Illegal invocation"
  when called with a foreign `this`, which `r.fetch(...)` on a plain object would be.
- Mutation checks (each removed, `bun run --cwd packages/testnet-relayer test`): the slot check, the threshold, the key
  check, the Worker's outcome gate, the key-segment redaction and the 200-character cut each fail a test. The cut
  needed a long Circle message in the `400` case before it did.
- `JSON.stringify` cannot label a table row that holds a bigint: name the rows.
