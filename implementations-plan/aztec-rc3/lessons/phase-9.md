# Phase 9 — chain cascade and the local rehearsal

Stream F, in its own worktree on the L line, before the cherry-pick.

- Sandbox smoke: `✅ sandbox deploy + smoke OK (10.5m)`, all 32 steps green, the PrivateFPC credit flows included.
  The last step reports that the node has no contract at `0x2e189d0c…6db4`.
- `test:integration`: 6 files, 35 tests passed (1229 s).
- `bun run e2e:tools`: `70 passed (1.2h)`, wall-clock 4465 s, with `.vite` cleared first.
- Forge: `forge build` exit 0; `forge test --no-match-contract Fork` 157 passed; `forge snapshot --check
  --tolerance 2` exit 0.
- Both builds pass `verify:build-target`: testnet chainId 3415328944, mainnet 4248422646.
- Fast layers: the one expected red is the testnet-manifest case in `bridge-generation.test.ts`.
- The identity search hits only `apps/tools/public/testnet-bridge.json` and the rc.1 journal, which was later
  retired.

The first e2e run failed all 70 tests at `browserType.launch`, a machine problem rather than a code one. The
shell exports a `PLAYWRIGHT_BROWSERS_PATH` system directory that holds only headless shell 1148/1234, while
Playwright 1.63.0 needs 1243. The re-run used `~/.cache/ms-playwright`, which has 1243, and went green.

`registerPrivateFpc` now lets a `registerContract` error propagate; the old `fuel-testnet` copy swallowed it.
