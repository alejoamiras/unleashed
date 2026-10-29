# Phase 0: planning consults

## Consult 1: Codex plan audit (gpt-6.1-sol, high, fresh session)

Verdict: conditional approve. Conditions: correct the factual and completeness claims; document and test the work
that continues after discovery's deadline; add the endpoint-restart control; record D5's missing prerequisite and
reopening condition.

- F1 (Medium, demonstrated): "a partial list never reaches discovery" overclaims; PublicNode's retention gap is a
  successful short answer. Adopted: the claim now covers failed requests only, and D5 names the trust kept.
  Follow-up probe by the planner: Sepolia PublicNode refuses logs past about 12,000 blocks (`4444`), so a record old
  enough for Base's gap fails closed on the Ethereum side first (`incomplete`). D5 is a known limit that needs an
  Ethereum reader with longer retention than the source reader.
- F2 (Low, demonstrated): fact 5's SDK reconcile client is the wallet's provider, not PublicNode; fact 7 lacked the
  46,500,000 refusal boundary; cap units conflicted with D4; "full history" was one sample. Adopted, all four.
- F3 (Medium, demonstrated on `budgetedReads`): the deadline does not cancel a read, so a split keeps sending after
  `incomplete`. Adopted as documented, bounded work (A2, D6), pinned by the request counts in tests 1 and 2. Rejected:
  a cancellation path (a lifecycle and a cross-layer contract) and a dedicated deadline test (the deadline is the SDK's,
  unchanged).
- F4 (Low): tests. Adopted: the partial-then-backup case, invalid constructor caps, exact live refusal codes,
  ordered identities with `logIndex` over a fixed non-empty interval.
- D1: wrapper kept; the ledger now separates the availability objective from "never send an unsupported range".
  D3's rationale corrected.

## Consult 2: final fresh Codex pass (gpt-6.1-sol, high, new session)

Verdict: approve. It re-measured both caps independently and judged D1–D6, I2 and A1–A2 proportionate.

- F1 (Low, demonstrated): fact 4's list of retryable errors was too narrow. Adopted: named as examples, with the
  source line.
- F2 (Low, plausible): a wrapper that returned the prefix on a `null` answer would pass the tests. Adopted: test 2
  runs twice, with an RPC error and with `result: null`. Also adopted its note: the wrapper replaces only `request`
  and adds no retry layer, which D6's bound needs.
