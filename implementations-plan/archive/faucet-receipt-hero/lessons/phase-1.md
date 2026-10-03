# Phase 1 ✓ — rework BridgeReceipt.vue + test

## What shipped
- `BridgeReceipt.vue` rewritten to the hero design: mint left-rule `.ledger`, uppercase `.eyebrow` (route · privacy · elapsed) with a flush-right mint `✓` (`role="img" aria-label="completed"`), cream 19px `.row.primary` hero, dim `Gas ready`/`Gas used` rows. Dropped `.rhead`/`.stamp`/`stamp-in`/`.route`/`.reserve`, the `boughtDisplay`/`stampWord` computeds, the gross "Gas bought" line, the "available / Ready to power…" panel. Added `heroLabel` (`Fueled`/`Bridged`/`Released`). `gap` 12 → 14.
- **All 3 variants in the new frame:** token deposit (`Bridged` + AZLO, dim gas when fueled), withdraw (`Released` + AZLO, no gas), Fuel (`Fueled` + the FJ amount as the hero — the user's "adapt Fuel to the same design" ask).
- **Codex conditions folded:** `hasFuel = isDeposit && !isFuel && !!fuelReceived` (HIGH dup-testid guard); `role="img" aria-label="completed"` on the `✓` (MED a11y); test keeps the `usedDisplay`-absent branch; new test "never renders two receiptFuel nodes" pins the HIGH fix directly.
- Preserved verbatim: `ReceiptSnapshot` interface, every `data-testid`, `new-bridge` emit, `amountSymbol`/`isFuel`/`links`/`totalElapsed`, confetti/links/action shell.

## Gates (all green)
- `bun run --cwd apps/faucet test BridgeReceipt` → 9/9.
- `bun run test:faucet` → 43 files / **423 passed** (was 422; +1 net test).
- `bun run typecheck:all` → exit 0.
- `bun run lint` → exit 0; targeted `biome check` on the 2 files → clean (the repo's 55 warnings are pre-existing, non-failing).

## Notes
- The `✓` is asserted via `[aria-label="completed"]` (not text-grep) — the confetti also emits "✓" glyphs, so a bare `toContain("✓")` would be ambiguous. Component test, so a non-testid selector is allowed (the e2e-only-testid rule doesn't apply here).
- Withdraw test asserts `not.toContain("FJ")` — the eyebrow/hero/CTA carry no "FJ" for a withdraw, so it still holds.
- `amountSymbol`/`assetDecimals` for `assetKind: undefined` resolve to AZLO/18 (relied on, matches the pre-existing no-fuel test).
