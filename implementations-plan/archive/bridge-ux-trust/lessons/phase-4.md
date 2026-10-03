# P4 — smoke + polish + gates (lessons)

## P4 COMPLETE
- `tests/e2e/bridge-smoke.test.ts` (jsdom, real journal engine + real localStorage, fake chain deps, testid-only selectors): legacy keys deleted on init; persisted records render as cards with NOTHING auto-claiming (`resumeSessionWork` fired against rediscovered records ⇒ zero claim/sign calls); an explicit CLAIM drives the record to done THROUGH the engine — which required the fake to flip its simulate to message-gone after send, because the tx-identity probe correctly refuses `done` while the message still simulates claimable (the anti-spoof check caught my own lazy fake — good sign); the form flip swaps `data-chain`.
- Logging sweep: no secret/envelope/signature material in any log call (one benign copy-string hit).
- Gates: `bun run audit:faucet` exit=0 · `bun run audit:vue` exit=0 (both in the transcript).

## post-impl: /code-review max --fix
Max-effort self-review of the net diff found 3 real correctness bugs, fixed + pinned:
1. `deploymentMatches` skipped `chainId` (the L4 contract says chainId+portal+bridge).
2. Wallet-reconnect mid-deposit race: `resumeSessionWork` → `runDepositClaim` on a sessionLive record with NO `leafIndex` ⇒ gate-polls on leaf 0 holding the record lock ⇒ the flow's own claim later skipped as a duplicate (claim starved). Fixed with a leafIndex bail in `runDepositClaim`.
3. The same sweep tagged a LIVE provisional withdraw (mid-exit-prompt) `unknown-outcome`. Fixed: the sweep skips mid-flight records (no-leaf deposits, provisional withdraws).
Tests 174 + smoke 9 green after the fixes.

## codex post-impl audit (session `codex-MLB3ytTp`)
Initial verdict: **reject** — 3 blocking findings, all real, all FIXED with pins:
1. **HIGH — false-done on rediscovered private claims**: the probe's `null` (secret unavailable on the prompt-free path) was treated as "proceed to done" — a forged `claimTxHash` + any successful receipt auto-finished, and the prune could then destroy a still-live bearer record. FIX: `completedAt` now requires probe === true; false AND null refuse with `unknown-outcome`; the sweep runs `interactive: false` while an explicit CLAIM unseals first (one signature) so the probe can verify. Pins ⑰b/⑰c; the old test that PINNED the unsafe behavior was reworked (a test suite can encode a bug as confidently as code does — worth remembering).
2. **HIGH — unfinished-junk cap eviction**: `capRecords` sorted unfinished by `updatedAt` and sliced — an attacker flooding >MAX unfinished junk evicted the oldest LIVE record through the cap itself. FIX: unfinished records are never dropped; only completed trim to the remaining budget. Pin added.
3. **HIGH — generic provider fingerprints reused trust**: every unrecognized wallet collapsed to "injected", so switching unrecognized wallet A→B reused the verdict. FIX: `isCacheableProvider` — generic fingerprints can neither mark nor pass trust (those wallets self-test every deposit). Pin added.
Also confirmed by codex: the code-review fixes hold; no ABBA lane violation; `useL1Usdc.mint` flagged as the one promptful call outside a lane (accepted: it's a standalone faucet action, not a bridge-flow prompt).
Verdict-flip resume: **approve** (all three fixes file:line-confirmed).

LESSONS_FILE=implementations-plan/archive/bridge-ux-trust/lessons/phase-4.md
