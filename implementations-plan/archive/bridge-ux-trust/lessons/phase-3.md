# P3 — UI swap (lessons)

## P3 COMPLETE
- `testids.ts`: the deposit*/withdraw* block (incl. the private-arc toggles) replaced with the bridge-form/mint/journal catalog; verified nothing outside the dying components consumed the old ids.
- Born: `BridgeForm.vue` (From/To panels with `data-chain`, flip, live balances — L1 via `useL1Usdc`, L2 via a component-owned `useTokenBalance` handle —, privacy toggle + per-direction notes, seal-note first-time vs trusted via `isSealTrusted` + `providerFingerprint`, over-balance validation, mint hint), `MintTestUsdc.vue` (the load-bearing L1-vs-L2 contrast copy), `BridgeJournal.vue` + `BridgeJournalCard.vue` (derived stages, countdown, CLAIM/FINISH/RETRY per attention, two-step DISCARD→CONFIRM DISCARD with the bearer-destruction warning, CLEAR on done).
- Died: `DepositCard.vue`/`WithdrawCard.vue` (+tests, + the temporary compat veneers in the flow files). `BridgeView` reassembled (original `.wallets` brutalist rule-lines preserved after an overwrite nearly lost them — git diff caught it).
- Tests: BridgeForm 8 cases + BridgeJournalCard 9 cases (incl. the L2-retention pin: a done private card keeps its sealed blob and offers CLEAR, never DISCARD). Suite: 172 passing.

Gotchas: `ref<Handle>` DEEP-UNWRAPS nested refs in types — `shallowRef` for handle-holding state; mocked Aztec accounts must be real 32-byte hex (`AztecAddress.fromString` validates length at mount).

Gate: faucet test 172 ✓ · typecheck ✓ · root lint ✓ · `vite build` ✓ (audit:vue/audit:faucet run at P4, the gates phase).

LESSONS_FILE=implementations-plan/archive/bridge-ux-trust/lessons/phase-3.md
