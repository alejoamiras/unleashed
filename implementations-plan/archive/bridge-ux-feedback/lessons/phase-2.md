# P2 — card UI (lessons)

## P2 COMPLETE
- Headers are journeys: `ETHEREUM → AZTEC` / `AZTEC → ETHEREUM` (D4).
- Live narration: `journalStep` line (pulsing dot + step copy map + dim detail) rendered from the engine's `step`/`stepDetail`; soft notes (the 30-min still-confirming) render through the note block WITHOUT an attention attr (pinned).
- Explorer links (D6): per-hash links — deposit/finish txs → sepolia etherscan, claim/exit txs → aztecscan — through the strict-hash helpers (`etherscanTxUrl` new; both reject non-`0x[0-9a-f]{64}` shapes, pinned incl. a `javascript:` injection probe); `rel="noopener noreferrer"`.
- Completion toast (D3): `BridgeJournal` watches `lastCompleted` → `useToast().push({kind:"ok", …, link:"view tx"})`; the list renders `visibleRecords` (the hide filter).
- The smoke's old "done card shows CLEAR" assertion FAILED because the new auto-hide worked — rewritten to pin the better contract: in-session claim ⇒ card leaves the list AND the record survives in storage with `completedAt` (hide-never-destroy, observable at the storage level).

Gate: faucet 190 ✓ · smoke 9 ✓ · typecheck ✓ · root lint ✓.

LESSONS_FILE=implementations-plan/archive/bridge-ux-feedback/lessons/phase-2.md
