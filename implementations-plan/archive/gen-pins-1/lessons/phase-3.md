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

`bun run audit:tools` and `bun run test:all` exit 0 (tools 1705 before the `main` merge, 1716 after).

`bun run e2e:tools`, retry 0 (`UNLEASHED_E2E_RETRIES` unset), `.vite` cleared first. Both runs started together on one
host, so they share its load: "after" is this branch merged with `main` at `565cdb1`, "before" a `git archive` of
`565cdb1` with the forge libraries copied in.

| | result | wall-clock |
|---|---|---|
| before (`565cdb1`) | 82 passed (1.4h) | 5201 s |
| after (merged branch) | 82 passed (1.4h) | 5262 s |

The 61 s difference is within the run-to-run spread of one load window. No e2e scenario was added. The commits after
the run's build touch the SDK's record-integrity checks, which the browser app never calls, and comments: the app's
runtime paths are the ones the suite ran. A first pair, started before the `main` merge, was stopped at 12 passed each when `main` moved
under the app's send and claim paths.
