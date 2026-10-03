# Phase 19 — Amount step

## What was done

- **`ChoiceCards.vue` is a radio group (G53, G103).**
  - The group is `role="radiogroup"` ("What arrives"). Each card is `role="radio"` with `aria-checked`, and the selected card is the tab stop.
  - `noRoute: boolean` became `gasReason: string | null`. `reasonOf(choice)` returns `tokenReason` for Token and `gasReason` for both gas cards.
  - A blocked card replaces its caption with its reason. The caption span carries the id (`send-choice-{token,token-gas,gas}-reason`) that the card's `aria-describedby` names.
  - `aria-disabled="true"` replaces native `disabled`. A blocked card that is still the selected one therefore stays the group's tab stop, and a click, Enter or Space on it emits nothing.
  - The CSS moved to `[aria-disabled="true"]`, the disabled box edge is `--ul-line`, and the `title` and both sr-only spans are gone.
  - The roving arrows are kept and still step over a blocked card. After review, Up and Down step like Right and Left.
- **`AmountStep.vue` (G52, G99–G102, G146).**
  - `gasReason` is `ROUTE_LABEL[routeKind]`, so "unavailable" reads "Gas options can't be checked right now." in both gas cards.
  - The route line and the token-only line keep their testids and `data-route`, but are now visually hidden. After review they sit inside one always-mounted `sr-only` polite live region.
  - Balance: `.balance-btn` is `flex-end`, and the value is Mono 13 ink-2.
  - Field: gap 12 (10 at ≤760), unit Mono 14 at ≤760, and `caret-color: transparent` inside the `field-sizing` `@supports` block.
  - Privacy panel:
    - It is `.ul-notch`, raised (`--ul-raised`) only while on, with padding 14 16, gap 12 and row gap 14.
    - The label follows the toggle: "Private — only you can see it" or "Public — visible on Aztec".
    - The switch keeps `aria-label="Private"`, and the label is its `aria-describedby`.
  - Veil line: gap 12, with the veil inside a `notch-2` host span. The "·" sits in its own `aria-hidden` span in `--ul-disabled`. The local veil has a 90ms delay, which reduced motion already zeroes.
  - Continue: `chevron` 24 rotated −90, with `padding-right: 14px` on the root. Nav padding-top is 4.
- **`GasBreakdown.vue` (G51).**
  - Header: a `zap` 12 icon (secondary) and "Gas for" in ink.
  - Nudges: pixel `minus`/`plus` 24 on `--ul-panel`, glyph only, in a stepper with gap 4.
  - The count is un-notched on `--ul-field`: gap 8, 15px ink, input Mono 15/700 centred.
  - The `<hr>` and `.line` rows became a `<dl>` of `div` rows on an inset `--ul-panel` block, with padding 12 14 and gap 8. The testids moved onto the `div` groups.
  - Card gap 12.

## Tests

- `ChoiceCards.test.ts`:
  - roles and `aria-checked`;
  - a no-route case, with the reason in place, the describedby target inside the card, and no `title` or `disabled`;
  - a token reason on a blocked selected card that keeps tabindex 0;
  - an "unavailable" case, where a disabled card emits nothing on click or Enter;
  - Down and Up (added after review).
- `AmountStep.test.ts`:
  - the route line and the token-only line exist inside the mounted `sr-only` polite region;
  - a new "unavailable" mapping test;
  - the privacy switch keeps the name "Private" while its described label flips.
- `GasBreakdown.test.ts`: structure only. The rows are `dl > div` carrying the testids and `dt` texts, and the nudges are an svg with no text.
- `tests/e2e/send-smoke.test.ts`: `aria-disabled="true"` on the blocked cards, the reason read through `#${aria-describedby}`, and `aria-checked`.
- Browser:
  - `pages/send.ts`, `fee-states.spec.ts` (with its doc comment) and `accounts.spec.ts` moved from `aria-selected` to `aria-checked`.
  - `tokens.spec.ts:97-101` is unchanged. Playwright's `toBeDisabled` honours `aria-disabled` on `role=radio`.
- `testid-coverage.test.ts`: the fixture passes `gasReason: null`.

## Attempts and notes

1. The first AmountStep run failed "the privacy switch takes its name from the row's label". That test asserted the `aria-labelledby` that G146 removes. It was rewritten around the new contract, where the name stays "Private" and the description flips. It was not deleted.
2. Veil notch. `.ul-veil` animates its own `clip-path`, so a notch on the veil itself would be overwritten mid-sweep. The notch sits on a host span with a direct `clip-path: var(--ul-notch-2)` instead of the `.ul-notch` pseudo-element, because the host has no fill of its own to paint.
3. The phase's `agent.sh` build ran from a tree that also held phase 20/21 edits in progress. The built bundle was grepped: it holds the phase 19 amount copy ("Others on Aztec see") and the base review strings (the old hyphenated fee notes, the old "Testnet only" footer). The run therefore tested phase 19 alone. PG ran with the phase 20/21 files copied aside and restored from HEAD, then put back.

## Deviations from the plan

- **The privacy panel keeps its padding when off.** Only the fill changes, so the switch and label do not move when toggled. The board draws only the "on" state.
- **The two announcement lines share one mounted live region** rather than each being an `sr-only` live `p`. A live region inserted with its text already in it is not announced, so the plan's "screen readers still hear them" needed the container. The testids and `data-route` are unchanged.
- **"Unavailable" is tested in both files.** The plan names it for ChoiceCards. The AmountStep mapping test proves that the step passes the reason through.
- **`send-smoke.test.ts:697–698`** also moved to `aria-checked`, beside the plan's `:699`.
- **Up/Down arrows.** The plan keeps "roving arrows". Up/Down were added after review because the cards stack at ≤760 and the APG radio pattern binds them.
- **`[role=radio]` was not added to the tab-order test's INTERACTIVE list.** The cards are still buttons, so they are already covered.

## Validation gate

PG ran on the phase's last code commit, with only committed files in the tree:
- `bun run lint`: exit 0. Biome printed 1 warning and 2 infos; the warning predates this plan, in a file this phase did not touch. The complexity baseline was OK.
- `bun run typecheck:all`: exit 0.
- `bun run test:all`: exit 0.
  - design: 236 tests.
  - bridge-core: 451 passed, 1 skipped.
  - tools: 1563 tests in 106 files.
- `bun run --cwd apps/tools test:e2e`: exit 0 (30 tests in 3 files).
- Baselines: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0.

Browser: `PLAYWRIGHT_BROWSERS_PATH=… bash apps/tools/scripts/e2e/agent.sh specs/tokens.spec.ts specs/fee-states.spec.ts specs/accounts.spec.ts specs/deposit-token-gas.spec.ts`: exit 0, `22 passed (23.9m)`, none flaky. The sandbox was stopped by its own pgid.

The review fixes touch the route line's DOM, which `tokens.spec.ts:98` reads. That spec re-ran with phase 20's gate.

## Verifier review

An independent reviewer read the phase's diff. It found no High and no Medium in the code. It re-ran:
- the unit tests (76);
- `send-smoke` (14);
- `vue-tsc`, Biome and the complexity baseline;
- the specificity and reduced-motion checks.

Fixed:
- **Live regions (Low).** `aria-live` sat on the `v-if`'d element, so it was inserted already holding its text, which most screen readers do not announce. One polite `sr-only` container is now always mounted, and the lines render inside it.
- **Blocked selected card on hover (Low, pre-existing).** `.cell[data-selected]:hover` outranked `[aria-disabled]`, so hovering flipped the card to reverse video. The hover rule now excludes blocked cards.
- **Up/Down arrows (Low).** See Deviations.
- **Eyebrow icon (Low).** The wrapper span that only coloured the icon became `<Icon color="secondary">`.
- **Veil line gap (Nit).** It was `6px 12px`; it is now 12, as G101 says.

Rejected or left:
- **`caret-color: transparent` (Medium, from G100).** The block cursor is a sibling after the input, so it always sits at the end of the text. A user who taps into the middle of the amount sees no insertion point. The code does what G100 says, so this is flagged for the owner rather than changed.
- **The reason is read twice (Low).** The card's name includes its caption, which is also its `aria-describedby` target. Pointing `aria-labelledby` at the label alone would change every card's accessible name, which the plan did not ask for. Left, and flagged.
- **Label in name (Low, from G146).** When off, the visible label reads "Public — visible on Aztec" but the switch's name is "Private". This was chosen deliberately by G146.
- **Process (Low).** This file and the ✓ were pending when the review ran.

## Flags for owner sign-off

- G100's hidden native caret in the amount field (see above).
- The blocked cards' accessible name repeats the reason that their description also gives.
- The privacy panel keeps its padding when off (only the fill changes).
