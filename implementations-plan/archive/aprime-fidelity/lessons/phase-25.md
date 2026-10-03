# Phase 25 — One column: band and header

## What was done

- **One column and the top band, G17 layout half and G113.** At ≤760 the shell grid is `minmax(0, 1fr)`: the `auto` column the dock used has been empty since phase 11 unmounted the dock, and the rail no longer needs `grid-column: 1 / -1`. The band takes the board's insets: padding 8 16, row gap 6, brand padding 0. The brand row stays 36 tall with the theme control pushed right (`margin-left: auto`), and the tabs stay 40 tall.
- **The phone page header, G70.** At ≤760 the header stacks titles over wallets (`flex-direction: column`, `align-items: stretch`, gap 12, padding 14 16). The titles are a column with gap 4. The h1 is 26/1.2, and the subline wraps (`white-space: normal`, margin 0) instead of ending in "…". Desktop rules are untouched.
- **The 22px phone chip (phase 7)** is still in `RailNav.vue`'s ≤760 rule: `min-width` and `height` 22, Mono 12/700. It was not re-captured because the verification run had no needs-you record (see below).

## Tests

None new, as the plan says: jsdom does not lay out. `AppShell.test.ts`'s phone case and `spike.spec.ts`'s 390 and 1024 cases stay green.

## Attempts and notes

1. **A throwaway layout check (`zz-p25.spec.ts`, deleted before the gate, never committed).** At 390 wide, with a persisted "open" dock preference, it measured the shell on the landing page, the disconnected Bridge tab and the connected Bridge tab. It also captured each one, dark and light.
   - The shell's computed columns are `390px`. `.main` spans x 0–390, so nothing sits at x ≥ 346.
   - The band is 98 tall, as the board draws it. The brand is at y 8 (36 tall), the tabs at x 16–374 and y 50–90, and the h1 at y 112, which is 98 + 14.
   - The subline wraps to two lines with no clipping (`scrollWidth ≤ clientWidth`). The page never scrolls sideways.
   - The 1440 capture is unchanged: the header row, the wallet chips on the right and the docked panel.
2. No failures in this phase.

## Deviations

None.

## Validation gate

- **PG:**
  - `bun run lint` exit 0 (the known warning and two infos; complexity-baseline OK)
  - `bun run typecheck:all` exit 0
  - `bun run test:all` exit 0: design 242, bridge-core 451 + 1 skipped, tools 1610
  - `bun run --cwd apps/tools test:e2e` exit 0 (30)
  - `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0
- **Browser:** `agent.sh specs/spike.spec.ts` exit 0, **7 passed** (6.3m). This includes the 1024 tablet case and the 390 phone case (no dock with a persisted open; connects and deposits).

## Board comparison (non-decision differences, 390)

1. **Theme control.** The board draws a 36×36 icon-only button on the raised fill. The app keeps the cycling button with its label ("System") and no fill. Q1 A keeps the cycling button, and no phase restyles it for phones. **Flagged for sign-off**; a phone-only `.label` hide plus the raised fill would be a small follow-up if wanted.
2. **Header perforation.** The app keeps the dotted perforation under the header at 390; the Mobile board draws none. It is a shared desktop rule, left as is.
3. **Wallet chips** still render as inline tiles, not the board's stacked 44px one-line rows. That is phase 26 (G69).
