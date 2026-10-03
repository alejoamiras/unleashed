# Phase 4 — wizard card, in-flight stepper, glow budget, responsive

The wizard becomes the card from the mock; the in-flight rail goes quiet; the accent is rationed; two breakpoints.

## What landed

- `StepStrip` — `orientation?: "horizontal" | "vertical"` (default horizontal, so nothing else moves) and an optional per-step `hint`. Vertical: `aria-orientation="vertical"`, ↑/↓ mapped onto the existing `move` (←/→ still work), no rules, the hint under each label, done markers in ink — only the active marker carries the accent.
- `WizardShell` — the card: a head with the two directions as underline tabs plus `Step N of 3` (aria-hidden; the live caption keeps the full sentence for assistive tech and is visually hidden with `.sr-only`), then a `168px | 1fr` body: the vertical rail on the left, the step panel on the right. Slots, `sendStepPanel`, `sendStepAnnounce`, the focus watcher and every direction pin are unchanged; the rail stacks above the panel under 760px.
- `BridgePhaseRail` — full rail restyled as a timeline down one hairline spine (no per-phase boxes), elapsed on done phases in secondary, the pulse `2.4s` and on the full rail alone (the compact rail's active cell is static ink; `prefers-reduced-motion` stops the pulse and the stamps), block bar in ink. `BridgeStepper` — the card frame (border, card background, `22px 24px 24px`), RUN IN BACKGROUND at the mock's size, the hint names Activity.
- Glow budget on the journal card: the PRIVATE tag is a 10% ink fill (no accent outline), the fuel add-on secondary, link and button hovers in ink; a dead `.pulse` rule removed. The rail's focus ring is ink.
- Responsive: `useMediaQuery` (a `matchMedia` ref, false where it is missing). Under 1100px an open dock leaves the grid: the strip stays in its column and the same `ActivityDock` renders as a fixed `role="dialog"` overlay beside it, with Escape closing it (focus back to the strip) and Tab cycling inside; the strip's chevron toggles. Focus moves into the overlay only on an explicit open — an auto-open never takes the keyboard away from a form. Under 760px the overlay is full-width and the rail becomes a top row (brand, three tabs, theme toggle), the body padding shrinks.

## Findings while doing it

- The card head's `Step N of 3` and the live caption would double-announce, so the head's copy is `aria-hidden` and the caption is off-screen: sighted users read the rail's hints, assistive tech hears the sentence once.
- jsdom has no `matchMedia`, which is exactly the "missing" branch `useMediaQuery` guards; the overlay cases stub it per test and `vi.unstubAllGlobals()` in `afterEach`-equivalent cleanup keeps the wide cases honest.
- Tab trapping is done on `window` rather than on the panel so an overlay opened by auto-open (focus still on the page) also wraps into the dialog on the first Tab.

## Gate

`bun run lint` exit 0 · `bun run --cwd apps/tools typecheck` exit 0 · `bun run --cwd apps/tools test` 96 files / 1229 tests passed · `bun run --cwd apps/tools test:e2e` 3 files / 28 passed · **frozen:** `git diff --quiet <rev> -- apps/tools/src/components/send/{TokenStep,TokenList,TokenTile,MintStrip,AmountStep,ChoiceCards,GasBreakdown,ReviewStep,ReviewDetails}.vue` exit 0, and `git diff --stat` over the same nine files prints nothing.
