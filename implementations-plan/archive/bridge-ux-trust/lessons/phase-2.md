# P2 — faucet journal + flow rewiring (lessons)

## P2 COMPLETE
Commits (journal+infra first, flows second, per the phase's commit-ordering rule):
- `useL1Usdc` singleton (balance poll / fixed mint / allowance) + 6 tests. Gotcha: a background poll's success was clearing action errors (`null` reads as object to `.toMatch`) — refresh is now SET-ONLY on errors.
- `useBridgeJournal` engine + 17 tests — guards (deployment binding w/ distinct `stale-deployment`, aztec-recipient + `sealerL1` pre-click mismatches), v2-only envelope resolution w/ tamper-resync, trust revocation gated on connected===sealerL1, per-record `inFlight` dedup, `promptLanes` (per-prompt acquisition), `sessionLive` auto-continue + prompt-free receipt waits, receipt-anchored completion with the dropped-debounce + the still-claimable identity probe, consume identity verification hook, write-and-verify, provisional-withdraw `unknown-outcome`. Chain deps are INJECTED (`connectJournalDeps`) so the proof set runs on plain fakes — no vi.mock of `@aztec/*` needed.
- Flow rewrites: `useDeposit` → `useDepositFlow` (seal-before-anything w/ trust cache + provider fingerprint, `cacheSecret` killing the same-session third signature, write-and-verify before the first L1 tx, allowance-skip, `depositTxHash` persisted the moment writeContract returns, finalized-envelope re-seal with the retained key = zero extra signatures, engine hand-off) and `useWithdraw` → `useWithdrawFlow` (provisional record → authwit+exit branches unchanged → rekey to exitTxHash → engine consume; `verifyConsumeIdentity` binds a rediscovered consume to THIS exit's recomputed witness epoch+leafIndex; clean wallet rejections drop the provisional, ambiguous failures keep the `unknown-outcome` card). TEMPORARY compat veneers keep DepositCard/WithdrawCard compiling until P3 (they die together with the old `hasPending` button pin).
- preBalance/isCredited machinery, the single-pending keys, the auto-resume watchers, and the second-deposit guard are GONE from the flows; `clearLegacyKeys` runs at journal init (L15 — no migration).

Gate: faucet 166 tests ✓ (18 files), faucet+bridge-core typecheck ✓, root lint ✓.

Deviation noted: the runtime `claimable` indicator is leafIndex-based for both privacies (the public prompt-free pre-gate from the plan is an optimization the cards can add later — the claim itself still gates on simulate, so honesty is preserved at the send boundary).

LESSONS_FILE=implementations-plan/archive/bridge-ux-trust/lessons/phase-2.md
