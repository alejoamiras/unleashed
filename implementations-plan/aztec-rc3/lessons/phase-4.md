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

## Arc 1 quality loop (step 1)

Codex `gpt-6.1-sol` at high, read-only, over PR A's diff without this plan folder.

| Round | Verdict | Findings and disposition |
|---|---|---|
| 1 | material | (1) Node RPC errors kept the server's text, and an unguarded body read carried the URL: one shared `readNodeRpcBody`, and the mainnet canary's raw fetch moved onto it. (2) The key guard missed the `dkey=` query form, escaped slashes, an uppercase host and an explicit port: matcher widened, one synthetic case each. (3) `drpc-node.ts`'s doc-comment implied it checks provenance: shortened. All adopted |
| 2 | material | (1) Redacting the URL's last path segment misses a query-string key: errors now keep no server text, only the method and an integer JSON-RPC code. (2) dRPC also documents `lb.drpc.org/<path>/<key>`: host widened. Both adopted. Percent-encoded paths stay out: no evidence dRPC accepts them |
| 3 | no new material findings | converged |

The aztec.js node clients still receive the keyed URL and may print it on a failed call; that is the residual in § Security, covered by env-exec's log masking.

## Notes

- A commit, or any change to the working tree, voids a pending keyed request: env-exec pins HEAD, requires a clean tree, and requires HEAD to be the tip of a pushed branch. Review fixes made while a request waits belong in another worktree, fast-forwarded in afterwards.
- Resuming a worktree-isolated subagent with SendMessage moved this session's own worktree isolation onto that agent's worktree until the agent stopped. Spawn a fresh agent instead of resuming an isolated one.
