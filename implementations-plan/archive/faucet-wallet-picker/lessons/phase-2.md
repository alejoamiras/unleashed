# Phase 2 — Picker modal + wiring

## What shipped
- `WalletPickerModal.vue` (approved Option B): app-root overlay mirroring `VerificationModal`'s
  Teleport pattern — announcement-keyed rows (icon/name/type badge/per-row Connect), collision
  warning strip (computed over claimed ids), scanning pulse (reduced-motion-safe), Cancel,
  Escape + backdrop-self-click → `cancelChoice`, focus into the dialog on open + restore on
  close. Hardening in-component: name capped at 48 chars by STRING (then CSS ellipsis), icon
  `safeIcon()` allowlist (`https:` / `chrome-extension:` / `data:image/*`, ≤4096 chars, else a
  glyph), fixed 28px dimensions + `referrerpolicy="no-referrer"`.
- Mounted ONCE in `App.vue` next to `AppToastRegion` — the three always-mounted panels only
  trigger `connect()`; the single modal owns selection. (Noted in passing: the existing
  `VerificationModal` is mounted per-panel and can double-render over the shared session — a
  pre-existing quirk, out of scope, recorded for follow-up.)
- `WalletPanel.vue`: `"choosing"` label + button disable; idle-state preferred hint
  ("Reconnects to {name} · use a different wallet"); connected-chip `switch` action —
  `switchWallet()` = forget + disconnect + reconnect in one action (A2). `BridgeWalletPanel.vue`:
  label/disable parity (it shares the session; the global modal serves it).
- `TESTIDS`: `walletPicker`, `walletPickerRow` (+`data-wallet-key`), `walletPickerConnect`,
  `walletPickerCancel`, `walletPickerScanning`, `walletPickerWarning`, `btnSwitchWallet`,
  `preferredWalletHint`.
- Tests: `WalletPickerModal.test.ts` — 8 cases: render-only-in-choosing + progressive append,
  per-row connect emits the KEY, HTML-bearing name inert + length cap, icon allowlist matrix
  (https/chrome-extension/data:image pass; javascript:/http:/oversized-data fall back),
  collision-warning threshold, scanning liveness, Escape/backdrop/Cancel, focus-on-open.

## Notes
- The connected-chip affordance is a compact `switch` text-button rather than the mockup's
  dropdown menu: the faucet has no menu primitive, and the plan's A2 requirement is the one-action
  semantics (forget + disconnect), which the button delivers exactly.

## Validation gate (plan Phase 2)
- `bun run lint` → exit 0
- `bun run --cwd apps/faucet typecheck` → exit 0
- `bun run test:faucet` → 48 files / 487 tests passed
