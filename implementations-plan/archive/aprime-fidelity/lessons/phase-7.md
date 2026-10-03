# Phase 7 — Rail and header chips

## What was done

- **G30 + G110:** the rail's Activity count is a magenta chip: `--ul-fill: var(--ul-signal)`, notch-2, `--ul-on-signal` text, min 24×24, padding 0 6, Mono 13/700, `margin-left: auto`. It stays magenta on the reverse-video current row and on hover, as the boards draw it. At ≤760 it is 22×22, Mono 12. The number is `aria-hidden`; an sr-only ", N needs you" follows it inside the tab, replacing the old `aria-label` on a plain span that named nothing. The "a count, not a call" comments are gone. Nav gap 2 → 4px.
- **G108 + G107 shell half:** the brand is a `<button aria-label="Unleashed home">` (`TESTIDS.brandHome` = `tl-brand-home`) calling `shell.goTo("send")`. The shell root is a `div` keeping `tl-app` and `data-section`; `<main>` wraps only the header, body and footer; the rail `aside` is named "Unleashed". The dock, toasts and dialogs stay siblings of `<main>` inside the shell.
- **G28 + G109 + G111:** new `--ul-ink-caption` (dark `var(--ul-ink-3)`, light `var(--ul-ink-2)`) colours the Ethereum and Aztec chip captions and the Aztec chevron (the chevron drops `color="tertiary"`). The alias renders inline in the caption, not bold. Identity gap 4 → 1px. Ethereum chip padding 0 6 0 14, Aztec 0 12 0 14. Aztec chip `aria-label` is `Aztec account <alias>, <0x1234…abcd>, switch account` (the alias segment dropped when empty); the Ethereum × is `aria-label="Disconnect Ethereum wallet"`, `title="Disconnect"`. The account menu marks the active account by inverting the whole line (row, name, address and copy button); the carrier tick and its rules are deleted. On the inverted line a focused row or copy button drops the line fill and takes a `--ul-bg` ring (the pinned reverse-video ring pair). Connect Ethereum is `variant="secondary"` in every state.
- **G29 + G27 chrome half:** Connect Aztec, plain and split, leads with `wallet` 24 at 15px with 0 16 padding, through a local `.cta` class (Button's `.large` also sizes Back and Continue). The waiting button's 1.6s pulse and its dead `.waiting` hook are removed; the picker's scanning dot is a static 6×6 `--ul-attention` square with a 10px gap, its 2.4s pulse and reduced-motion override deleted.
- **Docs:** `packages/design/README.md` names `--ul-ink-caption` beside the other role tokens.

## Tests

- `RailNav.test.ts`: the count case now asserts the chip reads "2", is `aria-hidden`, and the sr-only text is ", 2 needs you"; at 0 there is neither.
- `AppShell.test.ts` +2: the brand is a button named "Unleashed home" and returns to send from Activity; the root is a `div`, the named rail `aside` is outside `<main>`, and `<main>` holds the header and the send view but not the tabs. `:120` (the tab text contains the count) holds unchanged.
- `AccountSwitcher.test.ts` +2: the chip's accessible name with alias and short address, and without the alias; the active line carries `.on` and the menu has no `.check`.
- `L1WalletPanel.test.ts`: the disconnected connect button is secondary; the × has the new label and title.
- `AztecWalletPanel.test.ts`: the idle Connect Aztec is primary and carries a 24px glyph.
- `theme-contrast.test.ts`: new row `--ul-ink-caption` on `--ul-raised` ≥ 4.5 (dark 5.02, light 7.30).

## Attempts and notes

1. Dark `--ul-ink-caption` on `--ul-line` is 3.37:1, under AA. The Aztec chip fills with `--ul-line` on hover and while its menu is open, so the caption takes `--ul-ink-2` in those two states (5.41 dark, 5.62 light); the resting pair is the pinned one.

## Deviations from the plan

- **"Connect Ethereum is secondary" lives in `L1WalletPanel.test.ts`, not `AppShell.test.ts`.** `AppShell.test.ts` replaces `L1WalletPanel` with a marker at module level, so it cannot see the real button. AppShell gains two cases (brand, landmarks, the landmark case also pinning the rail's name) instead of three.
- **Hover caption colour** (above): not in the plan; needed so the new token never sits on a fill it fails on.
- **Brand geometry:** the button is 36px tall with 0 10 padding and a 14px bottom margin, so the mark keeps its x and the nav keeps its y (68px). The board draws 0 12 padding and a 28px rail gap; moving the nav was not asked for.
- **Wallet glyph on every state of the plain Connect Aztec button,** including "Searching for wallets" (with the busy pixels) and the red "Retry connection". The board draws only the idle state.
- **The picker's scanning square changed here,** with the other pulse (G27 chrome half); the rest of the picker is phase 9.
- `AztecWalletPanel.test.ts` gained one assertion the plan does not name, the only test proving the glyph and the primary variant.

## Validation gate

Run (`impl/pg7.sh` and `impl/e2e7.sh` concurrently; each command's exit code logged):
- PG: `bun run lint` exit 0 (complexity-baseline OK; the one warning and two infos are the pre-existing ones). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 219, bridge-core 447 + 1 skipped, tools 1482 in 105 files). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.
- `bash apps/tools/scripts/e2e/agent.sh specs/accounts.spec.ts` exit 0: `5 passed (5.4m)`, sandbox reaped by its own pgid.

## Flags for owner sign-off

- The rail chip stays magenta on the reverse-video current row (the board does the same); on a light theme its digits are ink on magenta (5.81:1).
- Connect Ethereum becomes the raised secondary button in every state, including while connecting.
- The account menu's active line is fully inverted, copy button included; the cyan tick is gone.
- The Aztec chip's caption lightens to ink-2 on hover and while its menu is open (a contrast fix the board does not draw).
- No capture in this phase; the arc 3 tour runs in phase 9.
