# Phase 3 — design primitives reskinned

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **BG:** both targets verified, no `data:font`, `_headers` unchanged, `verify:deployments` OK.
- **Grep:** `text-transform: uppercase` and `1px solid|dashed` return nothing in `packages/design/src/**/*.vue` and `base.css`.

## What changed
- **Button** has the variants `primary`, `secondary`, `quiet` and `destructive`. A `reason` slot renders on the button only while it is disabled. Busy keeps the variant's colours and shows the pixel loader. The control is px2-notched.
  - Minimum heights are 36, 44 and 48 (small, medium, large); they were 32, 40 and 48.
  - Primary hover mixes the signal 15% toward white. The text on signal is dark in both themes (void and ink), so this only raises its contrast.
- **Spinner** is a ring of eight 4-unit blocks. One lit block steps round per 90 ms tick (`steps(1, start)`, negative delays). Each block ends lit, so the reduced-motion end frame is the full ring. Its own reduced-motion block went; the central rule covers it.
- **Card** is a px4 panel. **Tag** is a 28px px2 chip with a status icon for `test` and `warn`, so tone is never colour alone. **Toast** is a px4 panel whose 4px status edge is an inset shadow on the clipped fill, so the edge follows the notch. It has a kind icon and a pixel `close`.
- **EmojiGrid:** the frame and cells are a well and raised notched fills. The emoji are untouched.
- **AddressDisplay and BalanceRow:** Mono for data, body font for labels. BalanceRow's hairlines became 2px dotted `--ul-line` dividers (the spec's perforation rule).

## Test and copy edits (sentence case)
- `BalanceRow`: "balance · private/public" → "Balance · private/public"; `BalanceRow.test.ts` updated.
- `AddressDisplay`: "copied" → "Copied"; `AddressDisplay.test.ts` updated.
- `primary_outline` → `secondary`, in `Button.test.ts`, `DripButton.test.ts`, `DripButton.vue`, `VerificationModal.vue` and `WalletPickerModal.vue` (2 sites). Only the prop value changes in the app files; their own styles wait for arc 2.
- `theme-contrast.test.ts` gains ink on `--ul-line`, the hover fill of secondary buttons and the address chip.

## Attempts
- **Tag typecheck.** `ICON[tone]` in the template does not narrow `IconName | undefined`. Moved to a computed and bound once.

## Arc 1 codex loop

### Round 1 (GPT-6 Astra, `high`; session `01a0eb26…`)
The verdict was "request changes": 1 material finding, 7 minor. All were checked against the repo and all accepted.
1. **Material.** AztecWalletPanel's `.denied` overrode `background`, but the notch fill is now the `::before`, so the button showed red text on magenta (1.04:1). I had found this independently. Both error states now use `variant="destructive"` and keep the `denied` class for the tests; the overrides are deleted.
2. The "Copied" hint was carrier on the light hover fill (`--ul-line`), which computes to 3.51:1. It is now ink while the chip is hovered.
3. The wallet-picker chevron used `color="inverse"`, which is light panel-white on signal (2.92:1). It now inherits `--ul-on-signal`.
4. **Nested notch hosts.** `--ul-notch` inherits, so a Tag inside a Card took the Card's px4. Every host now declares both `--ul-fill` and `--ul-notch`, and the invariant is stated once at `.ul-notch`. The EmojiGrid cells and AddressDisplay had the same gap.
5. **vendor-icons.** The attribute parser skipped single-quoted attributes silently. It now consumes the whole attribute text and rejects repeats; fixtures cover single quotes and a repeated `d`. Re-vendoring gives a byte-identical `icons.ts` after Biome formats it.
6. **Reduced motion.** Delays survived, so a delayed animation showed its start frame first. `animation-delay` and `transition-delay` are now reset too, and the test checks both.
7. L1WalletPanel's embedded address kept its fill. The override now clears `--ul-fill`, including on hover, where AddressDisplay's own rule has equal specificity.
8. EmojiGrid's comment was trimmed to its one constraint.

### Round 2 (resumed session): converged
Codex, verbatim: "No **NEW MATERIAL** finding remains; all eight previous findings are resolved. Confidence: high. Findings: **none**." It re-checked the fixes in a browser in both themes: the colours, nested notches, embedded-address hover and reduced-motion end frames.

### Arc boundary mechanics
- `gh stack` v0.1.1 has no `--adopt`; `gh stack init <existing-branch>` adopts the branch.
