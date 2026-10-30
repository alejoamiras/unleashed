# Status: sdk-reads-1

- 2026-10-30 recon: one Sonnet sweep plus a viem 2.57.1 reproducer; recon.md written.
- 2026-10-30 draft: plan.md drafted; D1 picks "only the token's own failure reads 0n" over the issue's CallExecutionError walk.
- 2026-10-30 consult 1: Codex conditional approve; D5 is not a pure refactor under D1.
- 2026-10-30 decision: ship D1 = the app's CallExecutionError rule moved into the SDK (no visible change); the stricter rule B goes to OWNER-ASKS ask-1; owner validated before the call.
- 2026-10-30 consult 2: Opus conditional approve; inputs validated, non-bigint success rejects; ledger in plan.md.
- 2026-10-30 consult 3: Codex final pass conditional approve → owner check moved to ask-1 → resumed: approve. Gate reached.
- 2026-10-30 a1 start: plan approved by the orchestrator; merged origin/main (b69462a, #88) cleanly.
- 2026-10-30 a1 step 1: 7 new cases red on the old code (5 balance, 2 reconcile), each for the expected reason.
- 2026-10-30 a1 gate: lint pass; typecheck:all pass; sdk vitest (erc20, deposit-reconcile) 55/55; tools vitest (useRowBalances, useEthereumReader) pass; test:all pass; audit:tools pass. e2e running.
- 2026-10-30 a1 gate: e2e:tools specs/tokens-hostile.spec.ts --retries=0 pass (test 24.2 s, run 1.1 m). Phase 1 ✓.
- 2026-10-30 a1 codex: round 1 findings 0 (2 optional adopted); opus review 1 Low adopted (5794361); round 2 findings 0. Converged.
- 2026-10-30 a1 final gates: lint, typecheck:all, test:all, audit:tools pass; e2e tokens-hostile --retries=0 pass (18.8 s test, 43.3 s run).
