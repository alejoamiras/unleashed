# Phase 2: the Worker-safe fill core

- The move kept every old import path: `scripts/sandbox/relayer.ts` and `scripts/fill-testnet.ts` re-export what they
  exported; `retried`'s two importers point at `src` directly (no other importer existed).
- `lifi-decode.ts` turned out viem-only already (F8 was corrected): only `crosschain-route.ts` reaches Aztec, through
  `private-fuel.ts`.
- The pre-simulation needs the fakes to answer one simulated result per call; the `fill-testnet.test.ts` fake had
  answered only the first call. That was the only test change the move forced.
- The Worker-safety test walks import statements, not string literals: a first regex matched `eq("…from", …)`.
- Gate: bridge-core 675 tests (four new), `typecheck:all`, `lint`, `test:ci-gating`, all exit 0.

# Phase 3

- Adding a workspace that reaches the Aztec 6.0.0 pins re-gated them under the 7-day release age, so the install
  failed. As `bunfig.toml` prescribes, the excludes went in locally for one install and came straight out; the
  committed `bun.lock` gained only the new workspace, and `bun install --frozen-lockfile` passes on the committed
  `bunfig.toml` (a frozen install never re-gates).

# Phase 4

- `relayOnce` takes its route rather than a bare filler: the Worker builds it from the bundled manifest, the tests
  from the same file, so the route under test is the production one.
- Two mutations prove the run tests bite: ending the run on any `FillRefused` fails the pass-over and dust cases;
  matching fills by `depositId` fails the forged-fill case.
- `wrangler deploy --dry-run` bundles the Worker in about 2 s: 786 KiB (161 KiB gzipped), viem and its crypto, no
  Aztec module and no `node:` import.
- Gate: lint, `typecheck:all` (five workspaces), `test:ci-gating`, `test:all` (relayer 19 tests), all exit 0.
