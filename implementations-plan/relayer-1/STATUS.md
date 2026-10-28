# relayer-1 status

- 2026-10-28 phase 0: briefs read; worktree adopted and registered; Phase 0 answers from the common brief.
- 2026-10-28 phase 0.4: recon done (3 Sonnet agents); Across testnet repays and refunds nothing (docs, checked by the parent).
- 2026-10-28 phase 1: plan drafted (architecture A, Bun process under a keyed run); competing outline B (Workers-first) written.
- 2026-10-28 phase 2: dual audit started (Codex gpt-6.1-sol high; Opus Plan agent).
- 2026-10-28 phase 2: round 1 Codex reject (7 findings), Opus conditional approve (9); plan revised, all dispositions recorded.
- 2026-10-28 phase 3: final fresh Codex pass conditional approve → plan revised → resumed: approve. Plan gate passed.
- 2026-10-28 arc a1: auto-continue gate passed (no OWNER-ASKS entry on a surface arc a1 touches); implementation started.
- 2026-10-28 lane brief changed on disk: ask13 (always-on Cloudflare Worker, key as Worker secret, dedicated relayer key unless the panel keeps the canary key). Implementation paused after Phase 1; plan revision and re-audit for ask13.
- 2026-10-28 ORCHY-STEER: commit arc a1 to a clean point; revise plan.md to a hosted Worker (defaults: 1-min cron, stateless bounded window scan, Worker-safe fill core in bridge-core src keeping the promised exports, testnet-only wrangler config, dedicated relayer key as the new exclusive filler, canary kept for canaries and manual fills, two-anvil test drives the scheduled handler); one Codex pass; continue on approve; stop on state beyond a cursor or a credential in Actions.
