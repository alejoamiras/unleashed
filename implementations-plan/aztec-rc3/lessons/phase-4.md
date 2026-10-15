# Phase 4: the keyless endpoint and the script key

## Keyless endpoint probes (step 3)

Read-only, from this host, as the browser calls it (`content-type: application/json`, an `Origin` header, no
redirect followed):

| Probe | Production Origin | Preview-shaped Origin |
|---|---|---|
| `POST node_getNodeInfo` | 200, `access-control-allow-origin: *`, nodeVersion `6.0.0-rc.3`, rollupVersion `3409706519` | the same |
| `OPTIONS` with `Access-Control-Request-Method: POST` and `-Headers: content-type` | 204, ACAO echoes the Origin, `allow-headers: content-type`, `allow-methods: POST` | the same |

The heaviest reads the app makes, against the production Origin:

| Read | Result |
|---|---|
| `node_getBlocks(start, 20, { includeTransactions: true })` (exit recovery) | 200, 20 blocks, about 41 KB, 60 ms |
| `node_getTxReceipt` on a hash from those blocks | 200, `finalized` |
| `node_getNullifierMembershipWitness` at `latest` and `checkpointed` | 200, witness present |

The POST answers `access-control-allow-origin: *`, which suffices because the app sends no credentials. The public
tier's per-IP rate limits and the lack of an SLA are accepted for testnet (A0).
