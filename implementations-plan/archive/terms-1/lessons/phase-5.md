# Phase 5: review, screenshots, draft PR

## Code fix loop

**Round 1, Codex** (gpt-6.1-sol, high, fresh session): no material finding, three minor.

| # | Finding | Disposition |
|---|---|---|
| 1 | `page.replace(slot, value)` expands `$&`, `$$` and `` $` `` in rendered text (`vite.config.ts:51`); reproduced in memory | demonstrated, fixed: `fillSlot` replaces with a function; regression case in `markup.test.ts` |
| 2 | The guards check document ids, so prose copied without its id would pass | rejected: any import of a document keeps its whole object literal, id included (the bundler does not split object literals); only a hand copy evades it, which review catches |
| 3 | The `LINKS` comment no longer lists every allowed link; a narrating comment in `legal-markup.ts`; `App.vue`'s comment too long | fixed |

## Screenshots

`implementations-plan/terms-1/design/` (gitignored): `landing-footer`, `terms`, `privacy` (full page)
from the built landing served by `tests/server/static-server.ts`, and `mainnet-placeholder` from
`vite --config vite.mainnet.config.mts` on a claimed port, each at 1280 and 390 px, dark and light (16
files). The run checked that each page loaded, the placeholder rendered its legal row, and the landing
pages logged no console error; the dev server's only console errors were Vite's
"504 Outdated Optimize Dep" on its first load. The dev server was stopped by its process group and the
port released.

## e2e:tools

Not run to completion locally. The sandbox needs `contracts/bridge/evm/lib`, which this worktree does
not have, and its install procedure (`contracts/bridge/evm/README.md`) deletes upstream `.env` files by
a `find -name .env` search, which this lane's rules forbid an agent to run. CI's `tools-e2e-status`
(six sandbox shards, triggered by `apps/tools/**` and `packages/legal/**`) is the e2e gate for this PR.
The tools runtime change on the testnet path is limited to `App.vue`'s mainnet branch, which
`App.test.ts` and the testnet dist rule cover.

**Round 1, Opus** (general-purpose, same family, beside Codex's round 1): 1 material, 5 minor, 1 note.

| # | Finding | Disposition |
|---|---|---|
| 1 | `$&` and its kin in the slot fill (material, latent) | already fixed in round 1 (`fillSlot`) |
| 2 | One allowlist for every page: `index.html` now accepts the legal URLs and policy links | fixed: an allowlist per page; regression cases for both directions |
| 3 | The test server returns 200 where the Worker 307s (`/x.html`, `/x/`) | docblock now says so; no test depends on it |
| 4 | The provider pin dropped host-only, `http:` and scheme-only CSP sources | fixed: only keywords, `data:` and `blob:` are dropped; anything `URL` cannot parse throws (control added) |
| 5 | The new testid ships in the testnet bundle | recorded in D11: no legal text, so D10's reason does not apply |
| 6 | `lockup` exported but unused | fixed |
| 7 | CI never runs `verify:build-target local` | recorded in D11 |
