# Status: sdk-reads-1

- 2026-10-30 recon: one Sonnet sweep plus a viem 2.57.1 reproducer; recon.md written.
- 2026-10-30 draft: plan.md drafted; D1 picks "only the token's own failure reads 0n" over the issue's CallExecutionError walk.
- 2026-10-30 consult 1: Codex conditional approve; D5 is not a pure refactor under D1.
- 2026-10-30 decision: ship D1 = the app's CallExecutionError rule moved into the SDK (no visible change); the stricter rule B goes to OWNER-ASKS ask-1; owner validated before the call.
- 2026-10-30 consult 2: Opus conditional approve; inputs validated, non-bigint success rejects; ledger in plan.md.
- 2026-10-30 consult 3: Codex final pass conditional approve → owner check moved to ask-1 → resumed: approve. Gate reached.
