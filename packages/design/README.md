# @unleashed/design

The design system of the unleashed tools app: theme tokens and global defaults (`src/base.css`), a
few layout and control primitives, and the composites the tools app renders.

- `import "@unleashed/design/base.css"` once at app entry. `public/theme-boot.js` sets the `theme`
  attribute (`dark` or `light`) on `<html>` before first paint.
- **Tokens** are `--ul-*`. Components pick a role, never a colour: `--ul-accent-text` for accent
  text, `--ul-signal` for fills, `--ul-on-signal` for text on a signal fill, `--ul-ring` for the
  keyboard focus ring, `--ul-focus` for a focused field's edge, `--ul-ink-caption` for a header
  chip's caption (tertiary on dark, secondary on light). A recess is read by role too:
  `--ul-field` for inputs and slots, `--ul-track` for segment tracks, `--ul-well` for page-level
  placeholders and the rail. The retired names (`--txt-*`, `--app-*` and the like) are gone; the undefined-token
  check still scans them, so a leftover reference fails the tests.
- **Shape:** `.ul-notch` gives a host a stepped-corner fill. The host sets `--ul-fill` and
  `--ul-notch` (`--ul-notch-2` on controls, `-4` on cards, `-6` on dialogs, `-4-bottom` on a band
  flush with a card's bottom edge) and paints no background of its own.
- **Static** (`--ul-static`, `.ul-veil`, `.ul-scrim`) means an encrypted value, and nothing else.
- **Motion** is stepped: `--ul-tick`, `--ul-tune`, `--ul-converge`, `--ul-cursor`. Reduced motion
  lands every animation on its end frame.
- **Icons** are Pixelarticons (MIT), vendored into `src/core/icons.ts` by
  `bun scripts/vendor-icons.ts` (needs a logged-in `gh`; run `biome check --write` on the output).
  `<Icon label>` names an icon for assistive tech; without a label it is hidden. Icons render at
  12 or 24 only (`IconSize`): field errors, dismiss × and chevrons at 12; notes, strips and toast
  leads at 24.
- **Tags** take a tone from one table: `neutral`, `ink`, `testnet`, `warn`, `lost`, `carrier`,
  `private`, `other`. Status tones carry a default icon (warn warning-diamond, lost square-alert,
  carrier check, private eye-off, other wallet); `icon` replaces it and `icon: null` drops it (a
  public chip is `neutral` with `eye`). `size="small"` is the 24px chip on cards.
- **Busy:** `<Button loading>` sets `aria-busy` and draws `BusyPixels` (three stepping pixels,
  hidden from assistive tech inside the button) after its label; a busy label is a plain verb, never an ellipsis. A
  loading or disabled `Button` emits no `click`, from the mouse or the keyboard. Callers still
  bind `disabled` and guard the operation itself; `pointer-events: none` is only cosmetic.
- **Progress:** `<ProgressBar label>` is the one bar. Without `value` it is indeterminate: no
  `aria-valuenow`, a block that travels the track and claims no amount (reduced motion holds it
  mid-track). With `value` (0–1) it sets `aria-valuenow` in percent; `tone` recolours the fill.
- **Dialogs:** `<Dialog>` is the one modal shell (static scrim, notched panel, title and ×,
  right-aligned `footer` slot). Backdrop, Escape and × emit `cancel`, never a confirm. Its
  keyboard comes from `useFocusTrap`: initial focus on a `[data-autofocus]` descendant or the
  panel, Tab cycling over the panel's reachable controls only, focus restored on close to an
  element still in the page.
- **Fonts** are self-hosted from `src/fonts` under the SIL Open Font License 1.1: Atkinson
  Hyperlegible Next (body), Atkinson Hyperlegible Mono (data) and a subset of Sixtyfour
  Convergence (wordmark and arrival amounts). `src/fonts/SOURCES.md` records where each came from.

## Tests

`bun run test`: component tests, the WCAG contrast pairs in both themes (`theme-contrast.test.ts`),
the primitives in `base.css` (`base-css.test.ts`), the font hashes against `SOURCES.md`, and a
check that every token the package's components read is declared in `base.css`.
