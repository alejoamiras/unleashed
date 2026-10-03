# Lessons — Phase 3 (ChooseAccountModal)

## Outcome
Green: typecheck ✓ · lint exit 0 · test:faucet 563/563. `ChooseAccountModal.vue` (radiogroup rows, roving tabindex, WalletPickerModal's focus-trap pattern, truncation disclosure row), app-level mount in App.vue, `choosing-account` swept into both panels' label/disabled branches. Session gained a persistent `hiddenAccountsCount` ref (the one-shot notice only covers the toast; the modal/menu disclosure rows need standing state).

## Gotchas worth remembering

1. **Component tests drive the REAL session, not spies.** The singleton's methods are destructured at import time, so spying is awkward — instead the test file replicates the SDK mock harness and walks the genuine connect flow to `choosing-account`. Clicking Continue therefore exercises the actual single-use token; the test would catch a broken pause/resume, not just a broken template.
2. **`vi.waitFor` over counted microtask flushes** for flows with real multi-await tails: the singleton's `registerAllContracts` chains 7 registrations + Promise.all rebuilds — `for (i<6) await Promise.resolve()` was not enough (status stuck at "setting-up"). Counted flushes are fine for the factory tests with stub registrars; the moment the real wiring is in the loop, poll for the terminal state instead.
3. **Teleport + jsdom**: stub `teleport` (`global.stubs.teleport: true`) so the dialog renders inside the wrapper and `wrapper.find()` works; querying `document.body` also works but leaks between tests.
4. **The disclosure row needed session state, not the notice queue**: the one-shot `selectionNotices` would be drained by the Phase 4 toast owner before the modal could read it. Disclosure that must PERSIST (modal + menu rows) reads `hiddenAccountsCount`; disclosure that must fire ONCE (toast) consumes the notice. Two mechanisms, deliberately.
