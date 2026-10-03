# Phase 1 — tokens (expand), contrast, fonts

## Result
Gate passed.
- **PG:** lint, typecheck:all, test:all and the jsdom smoke all pass.
- **BG:** both targets built and verified, with no `data:font`. `_headers` is byte-identical to the base for testnet and mainnet, and `verify:deployments` is OK.
- **SOURCES.md:** Next lists `tnum`, and Sixtyfour keeps SCAN, BLED, XELA and YELA.

## Decisions and deviations
- **Token names are semantic, not per-theme.** The set is `--ul-bg / --ul-panel / --ul-raised / --ul-well` in both themes. The plan's "`--ul-sheet`" means light `--ul-panel`, and "`--ul-void`" means dark `--ul-bg`.
- **Interim aliases:**
  - light: the earlier `accent` token → `--ul-accent-text` (ribbon), with `--txt-inverse` → `--ul-panel`;
  - dark: the earlier `accent` token → `--ul-signal`, with `--txt-inverse` → `--ul-bg`.
  - `--sand` → `--ul-other` (it marks "other" in the journal and Tag).
  - `--txt-white` stays a fixed `#fbf9f3`: it only sits on the fixed-colour token discs.
- **Derived light values** (the spec left them open; all are enforced by the contrast test):
  - well `#f9f7f0` (ink-3 at 5.5:1);
  - chip backgrounds: attention `#f6e7c8`, lost `#f9e4e1`, other `#e6e0f8`, carrier `#d9ecec`;
  - disabled `#9a97a0`, which is exempt from contrast.
- **Old fonts removed early.** Inter, Space Grotesk and JetBrains Mono were deleted in phase 1, not phase 7: once `--font-*` alias the new faces, nothing references them. Material Symbols stays until ThemeToggle drops it in phase 4.
- **No fallback colours in `theme-boot.js`.** It only sets the attribute, so that change-map item was a no-op.
- **`assetsInlineLimit` guard was needed.** The Sixtyfour subset came out at 3956 bytes, under Vite's 4096-byte default. The built `dist/assets` shows it emitted as a file.

## Attempts
- **Tooling.** fonttools and brotli ran in a scratch venv (fonttools 4.66.0, brotli 1.1.0). They are never a project dependency.
