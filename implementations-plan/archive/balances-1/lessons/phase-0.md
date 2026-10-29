# balances-1 phase 0: planning consults

## Codex plan audit (gpt-6.1-sol, high, read-only)

- First call failed: "Selected model is at capacity". Retried once after a minute: ran.
- Verdict: conditional approve. Five findings: viem chunks a 50-row multicall into two `eth_call`s (28 + 22, reproduced
  offline); the source chain shows no switch prompt (`L1WalletPanel.vue:13-15`); cell 37 would pass on a cached figure
  with the wallet reader still wired, since a chain switch triggers no row read; the key guards were overstated; I1's
  evidence was narrow. Also I2 should be an open issue, not a closed known limit.
- Accepted: the browser check reloads with the wallet on the source chain; guards and I1 restated; the selection test
  covers load and refresh. Rejected with reasons: the SDK `batchSize` change (D2: testnet shows about 9 rows) and the
  open-issue form of I2 (D3: plausible but unverified with a non-local fix is a known limit).

## Final fresh Codex pass (new session, gpt-6.1-sol, high)

- Verdict: conditional approve. It reproduced 28 rows → 1 `eth_call`, 29 and 50 → 2 on viem 2.57.1, and showed an
  app-local adapter (`batchSize: 0`) makes all three one call, so D2's "needs an SDK change" did not hold. Also: the
  plan's resume invocation, `<prompt-file>`, and no calendar date in the Outcome.
- Follow-up on where the fix lives (A: app adapter; B: `batchSize: 0` in the SDK). The driver leaned B (the SDK doc
  says "one batch"). Codex picked A: the SDK takes unbounded lists; unchunked, one failing aggregate zeroes every
  balance for every caller; the bound lives in the app; B changes a published behaviour the owner must approve.
  Decided A on that argument.
- Verification round (resumed): approve, no material findings.
