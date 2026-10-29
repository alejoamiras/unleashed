# balances-1 phase 1 (arc a1)

- Setup: the worktree lacked `contracts/bridge/evm/lib`. Ran the README's pinned `forge install` lines with `--no-git`
  and removed upstream agent instruction files from `lib/`.
- Baseline before any edit: `tokens.spec.ts` 4/4 at retry 0, 3.1 min in Playwright, cell 37 20.4 s.
- Recon missed a second `useTokenSelection` caller (`useCrossChainSend.ts`); `vue-tsc` found it when the dep became
  required.
- `useRowBalances.test.ts` mocked all of `@unleashed/sdk/protocol`; importing `@/lib/network` there pulled modules that
  need the rest of it, so the mock became partial (`importOriginal`).
- Each new test was checked against the old behaviour by a temporary revert: 29 rows without the adapter made 2 calls;
  without the rejection, a refused call replaced the rows' figures.
- Gate on d57e219: lint, typecheck:all, test:all, test:e2e 28/28, audit:tools all exit 0; e2e tokens + drip +
  deposit-token 16/16 at retry 0 (16.8 min); cell 37 29.0 s.
- Codex fix loop: round 1 one Low (doc comment), Opus review one Medium (D4) and smaller items, all fixed in d920977;
  round 2 clean. A `git add -A` staged the throwaway shots spec once; the pre-commit lint failure stopped that commit.
- Merged origin/main (fde40db: #59, #63, #28) cleanly; `bun install --frozen-lockfile` changed nothing.
- After the merge the vitest smoke failed 16 of 30: it mocks `useEthereumReader` whole and lacked `readBalancesOn`,
  added in round 1 after the smoke last ran. Fixed in 425ff8a with the real helper through `importOriginal`; Codex
  round 3 clean. Run the smoke after any change to a module it mocks.
- Final browser gate 16/16 at retry 0 (17.4 min); cell 37 34.1 s against 20.4 s at baseline (the reload check adds
  about 10-14 s); other tokens cells ran 10-40 % slower in the 16-test run on a loaded host, unchanged code.
