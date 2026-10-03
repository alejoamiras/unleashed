# swap-fuel — phase 3 lessons (bridge-core fuel plumbing)

## pulled AHEAD of P2 — the live broadcast waits on the deployer top-up; balance probe read 0.165 ETH vs the ~0.45+ needed

- `route.ts` — `buildFuelRoute(cfg)`: the fixed two-hop with ordering/directions DERIVED (token<WETH ⇒ currency0=token ⇒ zeroForOne; native ETH is always currency0 on the FJ hop). Per-pool fee/tickSpacing from config — the P1 outcome (azloWeth fee 500/10, ethFj fee 987/10) flows through config, nothing assumes the conventional 3000/60.
- `quote.ts` — chained `quoteExactInputSingle` eth_calls (the V4 quoter is nonpayable BY DESIGN; readContract simulation is the off-chain pattern). `QuoteUnavailableError` wraps per-hop failures with the failing hop + preserved cause; `minOutputForSlippage` floors at 1n (a zero floor signs the slice away — the fork tests' minFuelOutput:1 convenience must never reach production paths).
- `journal.ts` — per-record `schema: 1 | 2`; `DepositFuelBlock` documents every field's trust class inline (received = event-sourced content-hash amount; claimAttempt = the L14 journal-first latch; secret = recipient-bound trigger gate, plaintext like public deposit secrets). The journal CONTAINER stays `{schema:1}` — only records carry 2; the shallow parse filter passes both.
- `backup.ts` — strict schema-2 branch: schema 2 ⟺ fuel present (either-direction contradiction rejects), decimal-string/boolean field guards, withdraws pinned to schema 1. Foreign input keeps the never-guess-through posture.
- Pin subtlety: `upsertRecord` stamps `updatedAt` — "schema-1 loads byte-identically" is asserted modulo that stamp (the test diff was exactly the stamp, nothing else).
- Gate: bridge-core 97/97, typecheck 0, lint clean.

NEXT: P4 (manifest scope + the wallet's scope-list field-diff re-consent). P2 fires as soon as the deployer holds ~0.5 ETH.
