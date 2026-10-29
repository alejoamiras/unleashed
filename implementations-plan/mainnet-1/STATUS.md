# mainnet-1 status

- 2026-10-28 phase 0.75: adopted worktree `mainnet-1` (branch worktree-mainnet-1, base fb90e36); registered; tier mid; Phase 0 answers from the program brief.
- 2026-10-28 verify-first (3): mainnet registry `0x35b2…e298` names rollup `0xE37A…402f` (version 2070860440, node 6.0.0, Fee Juice portal `0x5343…f3b3`) canonical; the repo pins the 5.0.1 rollup (4248422647, portal `0xaf73…691c`). P3-04 holds; sdk-1 §3 premise does not.
- 2026-10-28 phase 0.4: recon started (2 Sonnet Explore agents).
- 2026-10-28 phase 0.4: recon done (2 Sonnet explorers + driver checks); recon.md written.
- 2026-10-28 mid step 1: plan.md, OWNER-ASKS.md (M1–M7) and Outline B drafted.
- 2026-10-28 mid step 2: dual audit started (Codex gpt-6.1-sol high, fresh; Opus 5.5 Plan agent); both see Outline B.
- 2026-10-28 mid step 2: dual audit done: Codex conditional approve (3 High, 5 Medium), Opus conditional approve (9 Medium, 6 Low); all verified; dispositions in plan.md; plan rewritten (D3 mainnet profile, D7 L1 funding ledger, C1–C3 coordination asks); sdk-1 already re-pinned mainnet (45f73f6).
- 2026-10-28 mid step 4: final fresh Codex pass started.
- 2026-10-28 mid step 4: final fresh Codex pass conditional approve (5 findings, all accepted) → verification conditional approve (2, accepted) → verification approve.
- 2026-10-28 approval gate: plan committed on worktree-mainnet-1; awaiting the orchestrator's approval and the owner's answers (OWNER-ASKS M1–M7).
- 2026-10-28 a2: orchestrator approved the plan as committed (ec09fe8); P5-07 Option B (a single-purpose funding key; the cap is a required run input, no default). Merged origin/main (#29, #32, #33) at f6f6a47.
- 2026-10-28 a2 preconditions: C1 holds (MAINNET_ROLLUP_VERSION 2070860440, wallet id 2070860441, portal 0x5343…f3b3, PrivateFPC 6.0.0 mainnet descriptor, aztecLineOf(1) supported); C2 holds (fuelRoute.fuel has fjPerTx; branch F step 5 calibrates it).
- 2026-10-28 a2 2.1 gate: lint ok; typecheck:all ok; test:all exit 0; audit:tools exit 0; deployer-funding integration test 1/1 on an attached sandbox (59 s); full test:integration running
- 2026-10-28 a2 2.2 gate: doc-links 3/3; node-keys 2/2; lint ok
- 2026-10-29 a2 round 1: Codex reject (2 High, 1 Low) and the Opus review (1 Medium, 5 Low) verified and fixed in 411b10d; lint, typecheck:all, touched unit tests, deployer-funding integration 1/1 (66 s) green; Codex round 2 running
- 2026-10-29 a2 Codex loop: round 2 conditional approve (1 Medium, 1 Low; fixed in be4b79a), round 3 approve; loop closed at three rounds
- 2026-10-29 a2 final gates on ae75d32 (origin/main with #41 merged): lint ok; typecheck:all ok; test:all exit 0; audit:tools exit 0; test:integration 52/52 (10 files) exit 0; doc-links/node-keys/published-packages 7/7; dry run = deployments.json
