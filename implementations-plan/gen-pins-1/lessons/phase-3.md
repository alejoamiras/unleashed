# Phase 3: the app

## Testnet dist, before and after

`vite build --config vite.testnet.config.mts`; "before" is a `git archive` of the merge base built in a scratch
directory with `WORKERS_CI_COMMIT_SHA` set (an archive has no git checkout to name the build).

| | files | dist bytes | chunks `index.html` fetches | their bytes (gzip) |
|---|---|---|---|---|
| before | 36 | 26,102,438 | 14 | 8,252,755 (3,333,262) |
| after | 36 | 28,684,725 | 13 | 5,685,062 (2,297,241) |

- Before, the hub artifact chunk (2.57 MB) was a static dependency of the entry, so every page load fetched it. After,
  `codeOf(MANIFEST).hubArtifact()` imports the testnet generation's kept artifact on first use (a wallet connection or
  a send), so the load set drops by 2.57 MB (1.04 MB gzip).
- The dist grows by one 2.58 MB chunk: this build's own hub target is still emitted, reachable only from `codeOf`'s
  sandbox branch, which a testnet build never takes (`parseNetwork` accepts only the bundled manifest on 11155111).
  Nothing fetches it.

## Gate
