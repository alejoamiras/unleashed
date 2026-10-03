# Lessons — Phase 4 (AccountSwitcher + toasts)

## Outcome
Green: typecheck ✓ · lint exit 0 · test:faucet 573/573. `AccountSwitcher.vue` (single-button chip, local Popover-recipe dropdown, menuitemradio rows + sibling copy buttons, busy-disabled rows with hint, Disconnect footer, always-rendered menu) wired into both panels via `addressTestid`/`disconnectTestid` props; selection-notice → toast watcher single-owned in `useWalletConnection.ts`. 9 switcher tests + exactly-once toast test + both panel suites updated.

## Gotchas worth remembering

1. **Module-init side effects break hoisted test mocks.** Calling `useToast()` at `useWalletConnection.ts` module scope blew up `BridgeJournal.test.ts`: its `vi.mock("@/composables/useToast", () => ({ useToast: () => ({ push }) }))` factory closes over a `const push` that is still in TDZ while modules import (vi.mock hoists above everything; module init of the composable runs during import, before test-file consts). Fix on the PRODUCTION side: resolve `useToast()` lazily inside the watcher callback. Rule of thumb: composables that other suites mock must not be CALLED at module initialization — only inside callbacks/functions.
2. **Testid continuity beats testid purity**: the menu's Disconnect reuses the panels' existing `fa-btn-disconnect`/`fa-bridge-l2-disconnect` ids (passed as props) instead of a new shared id — zero churn for anything already selecting them; the chip's address span likewise keeps `fa-account`/`fa-bridge-l2-account`.
3. **BridgeWalletPanel's suite mocks `useBridgeWallet`, but the embedded AccountSwitcher reads `useWalletConnection`** — in prod they're one singleton; in the test they diverge. Mirror the mock for BOTH module names (same object shape) or the chip renders empty.
4. **Biome formatting is part of `bun run lint`** — a default-param object literal I hand-wrapped was re-wrapped by the formatter and failed the gate as a format ERROR (not a warning). `biome check --write <file>` then re-verify; don't hand-guess the wrap style.
5. jsdom + `document.addEventListener` click-outside: register at setup, remove in `onBeforeUnmount` — @vue/test-utils triggers with `element.trigger()` which bubbles to document, so outside-click behavior is naturally testable, and NOT removing the listener leaks across mounts.
