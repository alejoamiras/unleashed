# rpc-floor-1 status

- 2026-10-29: homed (adopted worktree), registered; recon done (1 Sonnet explorer + live probes).
- 2026-10-29: plan drafted: route through the fallback, keptLogs + receiptOrNext, ethPandaOps as second Sepolia reader.
- 2026-10-29: codex plan audit round 1 started (gpt-6.1-sol, high).
- 2026-10-29: codex round 1 conditional approve; 7 findings adopted (receipt freshness, trust model, retention 3,000,000, guard on blockHash/earliest).
- 2026-10-29: final fresh codex pass conditional approve (2 findings adopted); resumed verification: approve. Plan at the approval gate.
- 2026-10-29: orchestrator approved the plan; A1 and A3 accepted (quoted in plan). Merged origin/main b8c2289.
- 2026-10-29: phase 1 gate green: lint, typecheck:all, touched tests, RPC_CAPS_LIVE runs, 5 mutations red, test:all, audit:tools, verify:build-target mainnet and testnet.
- 2026-10-29: codex fix round 1 clean; opus review 4 Low fixed (last-endpoint pin, earliest test, comments).
