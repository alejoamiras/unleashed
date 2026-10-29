# keyed-logs-1: phase 0 (planning consults)

## Codex round 1 (plan audit, gpt-6.1-sol, high): reject

- Findings: (1) High, live-intent runs verify-l1's `fail` in-process and prints viem messages with the keyed L1 URL;
  (2) `RunError` truncates stderr before redaction; (3) a presence guard is not protection (alias, dummy call,
  exported composer); (4) three source-RPC names missing from the keyed list; (5) I1 and fact 8 overreach.
- Verified: (1) reproduced with a refused loopback RPC (26 prints of a synthetic key, 36 s) and with a local
  JSON-RPC error server (26 prints, 1.8 s; the regression shape). (2)-(5) confirmed by reading the code.
- Decision: all adopted. For (3), the import-graph fix Codex sketched would flag constant-only importers of
  live-intent (ten importers, the relayer Worker among them), so the guard became `keyedNodeUrl` refusing outside
  `runKeyed` plus a mention-based static rule (D2). Resumed for round 2 to argue D2.

## Codex round 2 (resumed): conditional approve

- D2 (runtime refusal + one allowed mention) judged proportionate; Codex confirmed with a Bun 1.4.2 probe that a
  workspace subpath and a relative import share one module instance (`wallet-store`).
- Findings: the suffix pin would force two public `AZTEC_*_ADMIN_API_KEY` switches into the list; the static
  guarantee was overstated. Both adopted. The planner's bare-token scan was too noisy (constants such as
  `SWAPPER_FJ_PER_WHOLE_TOKEN`), so the pin scans env reads, `process.env` destructuring and quoted names only.

## Final fresh Codex pass (new session): conditional approve

- Findings: the default `inspect` truncates strings at 10 000 characters before redaction (reproduced in Bun 1.4.2:
  a key past that point prints as a prefix); `lint:actions` is required for CI-script changes; the Outcome must
  carry no date (AGENTS.md). All adopted; the inherited-stdio children of `live-intent` promote were checked and
  hold no unredacted keyed path.

## Final pass confirmation (resumed)

- First resume failed: "Selected model is at capacity". Waited a minute and retried once: approve.
