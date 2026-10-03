# Dead Channel A′ "Quiet broadcast" — implementation spec

The visual source of truth is the private Claude Design canvas, page **"Dead Channel A′ — System"**. That page has the Type, Foundations, Components, Motion and Tone dial boards, plus 10 screens. This file distills those boards into values an implementation can use without opening them.

**Layout, flow, copy structure, `data-testid`s and behaviour do not change.** Only the look and feel does.

## Principles

1. **Fill, not line.** No 1px hairline boxes. Depth comes from fill steps.
2. **Sentence case** in a humanist face. There is no tracked uppercase anywhere. Mono is only for machine data.
3. **Pixel-notched corners** (a stepped clip-path), kept small.
4. **Reverse video** for selection: the whole row or cell inverts.
5. **Static means encryption, and nothing else.** It is used only for the private-amount veil and modal scrims.
6. **Pixel budget:** at most two pixel-type moments on a screen, the wordmark and an amount as it arrives.
7. **Stepped motion** (`steps()`), never smooth easing. Reduced motion shows the end frame.

## Type

| Role | Face | Setting | Where |
|---|---|---|---|
| Wordmark | Sixtyfour Convergence | 12–24px, axes at rest | Brand lockup only |
| Arrival | Sixtyfour Convergence | 44–56px; XELA/YELA converge to 0 in 640 ms | Receipt hero amount, once per flow |
| Heading | Atkinson Hyperlegible Next 700 | 28 page / 20 card / 16 label, letter-spacing −0.015em | h1, card and dialog titles, field labels |
| Amount | Atkinson Hyperlegible Next 600 | 34 input / 30 review, `font-variant-numeric: tabular-nums` | Inputs, review rows, balances |
| Lede | Atkinson Hyperlegible Next 500 | 18 / 1.45 | Intro lines |
| Body | Atkinson Hyperlegible Next 400 | 15 / 1.5 | All reading text |
| Label | Atkinson Hyperlegible Next 700 | 15 | Field labels, row titles |
| Caption | Atkinson Hyperlegible Next 400 | 13, ink-2 | Hints |
| Data | Atkinson Hyperlegible Mono 500 | 15 / 12.5 | Addresses, hashes, fingerprints, times, token symbols |

- **Axes:** Sixtyfour Convergence has BLED 0..100, SCAN −53..100, XELA −100..100 and YELA −100..100 (verified against Google Fonts metadata).
- **Tabular figures:** Atkinson Hyperlegible Next ships `tnum` (verified in the font's GSUB table). Its default digits are proportional, so amounts must set `tabular-nums`.
- **Licences:** all three fonts are OFL. Self-host them as woff2 (this is a privacy app: no Google Fonts requests). Subset Sixtyfour to digits, `.,` and the wordmark's letters.

## Colour — dark "Channel" (default)

| Token | Value | Note (contrast vs void) |
|---|---|---|
| void (app bg) | #0B0B0D | |
| panel | #141418 | |
| raised | #1D1D23 | |
| well (inputs) | #08080A | |
| ink | #EDEDEA | 16.8 |
| ink-2 | #B4B4AF | 9.5 |
| ink-3 | #8C8C93 | 5.9 |
| disabled text | #5E5E66 | disabled only |
| line (tracks, empty cells) | #3A3A42 | |
| signal (accent) | #FF3DD2 | 6.4 vs void; #0B0B0D on signal is 6.4 |
| signal-tint | #3A1234 | signal text on it 5.2 |
| carrier (done) | #3DE8FF | 13.3; chip bg #0E2A30 |
| attention | #FFC247 | chip bg #33270C |
| lost (error) | #FF6159 | chip bg #361513 |
| other (lilac) | #B9A6FF | chip bg #241E3A |

## Colour — light "Printout"

| Token | Value | Note |
|---|---|---|
| paper (app bg) | #F4F1E8 | |
| sheet (panel) | #FBF9F3 | |
| band / raised | #E9E4D6 | ink-3 on it is 4.64 |
| ink | #18171C | 15.8 vs paper |
| ink-2 | #48464F | |
| ink-3 | #65636E | 5.22 vs paper, 5.60 vs sheet, 4.64 vs band |
| ribbon (accent text, focus) | #B3118E | 5.5; fluoro #FF3DD2 on paper is only 2.7, so focus uses ribbon |
| signal fill | #FF3DD2 | fills only; ink on it is 5.8 |
| signal-tint | #F9D6F0 | |
| carrier | #00707F | chip bg #D9ECEC |
| attention | #8A5700 | chip bg: derive, must pass the contrast test |
| lost | #C12A22 | chip bg: derive, must pass the contrast test |
| lilac | #5B45C2 | chip bg: derive, must pass the contrast test |
| perforation rule | #CFC9BA, dotted | section divider only |

## Role tokens (both themes)

The light theme separates the fluorescent fill from text and focus, so the accent has three roles. Components pick the role, never the raw colour.

| Role | Dark | Light | Use |
|---|---|---|---|
| `--ul-signal` | #FF3DD2 | #FF3DD2 | fills only (primary button, toggle on, phase bar, current step) |
| `--ul-accent-text` | #FF3DD2 (6.4 vs void) | #B3118E ribbon (5.49 vs paper) | accent-coloured text and links |
| `--ul-on-signal` | #0B0B0D void (6.41) | #18171C ink (5.81) | text and icons on a signal fill |
| `--ul-focus` | #FF3DD2 | #B3118E | the 2px focus outline |

Contrast is enforced over an explicit list of permitted (text, surface) pairs, not every text × every surface.

No sprocket margins (that was A, now dropped).

## Shape and depth

- **Notch sizes:** px2 on controls (buttons, chips, inputs, toggles), px4 on cards and panels, px6 on dialogs.
- **Notch polygon:** for notch `n` and step `s = n/2`, a 20-point stepped polygon:

  `polygon(n 0, calc(100% - n) 0, calc(100% - n) s, calc(100% - s) s, calc(100% - s) n, 100% n, 100% calc(100% - n), calc(100% - s) calc(100% - n), calc(100% - s) calc(100% - s), calc(100% - n) calc(100% - s), calc(100% - n) 100%, n 100%, n calc(100% - s), s calc(100% - s), s calc(100% - n), 0 calc(100% - n), 0 n, s n, s s, n s)`
- **Clip a `::before` fill, not the element**, so `:focus-visible` outlines are not clipped.
- **Depth is a fill step, never a shadow:** well < void < panel < raised.
- **Inputs and toggles** keep a 2px ink-3 bottom or inset edge (5.9:1), so a fill never carries a boundary alone.
- **Focus:** a 2px outline in signal (dark) or ribbon (light), offset 2px.
- **Attention notes:** a 4px attention-colour left edge on a panel fill. This replaces the earlier dashed boxes.
- **Grid:** 4px. The character cell is 8 × 16. Controls are at least 44px tall.

## Static

- **Recipe:** an SVG `feTurbulence` (fractalNoise, baseFrequency 0.92, 1 octave), then saturate 0, then a discrete RGB table `0.04 0.2 0.55 0.93`, with alpha forced opaque. Render it as a background image or an inline SVG. It is `aria-hidden`, and the element carrying it has a text alternative.
- **Uses:**
  - Private veil at 0.95 opacity, over the amount others would see.
  - Modal scrim: void at 0.85, then static at 0.3.
- **Never** use static for progress, loading or transitions.

## Motion

| Token | Duration | Use |
|---|---|---|
| tick | 90 ms, steps(3) | hover, press, view swap (a plain cut on one tick) |
| tune | 180 ms, steps(4) | veil sweep (left → right), scrim in |
| decode | 480 ms | a network-returned figure (gas quote, "you get") scrambles into its value, left → right; the scramble is `aria-hidden` and the value is announced once |
| converge | 640 ms, steps(8) | receipt hero: XELA/YELA/SCAN/BLED from (85, −70, 70, 60) to 0 |
| cursor | 1060 ms | block cursor in the focused amount input only |

`prefers-reduced-motion: reduce` sets every token to its end frame and stops the cursor.

## Icons

Pixelarticons (MIT; 24 grid, 2px pixels), shown at 24px or 12px with `shape-rendering: crispEdges` and `fill: currentColor`. They replace Material Symbols and the Unicode glyph icons. The mapping is in plan.md.

**Exception:** the verification **emoji grid stays emoji**, because the wallet shows the same grid. Only its frame is restyled.

## Component recipes (dark values; light maps token-for-token)

| Component | Recipe |
|---|---|
| Primary button | 48px tall (compact 36), padding 0 18px, signal fill, void text, 16px/700, px2 |
| Secondary button | raised fill, ink text, 600 |
| Quiet button | transparent, ink-2, dotted underline offset 5px |
| Destructive button | lost-colour fill (or a lost edge on raised), void/ink text as contrast allows |
| Disabled | raised fill, disabled text; say why inline, never tooltip-only |
| Busy | label plus the pixel loader icon stepping |
| Amount field | 72px tall (64 compact), well fill, inset bottom 2px ink-3 → signal on focus → lost on invalid; value in Next 600 34 tnum; symbol in Mono |
| Toggle | 56×30 track. Off: raised fill with 2px inset ink-3 and a 20px ink-3 knob on the left. On: signal track with a void knob on the right. px2 |
| Chip / status | 28px tall, padding 0 10px, 13px/700, px2, 12px icon plus a word (never colour alone); tinted bg per status table |
| Selection (lists, radio cards) | reverse video: ink bg with void text; selected radio cards get a signal edge |
| Tabs / segmented (direction) | raised track; the selected segment is reverse video |
| Rail item | icon plus label; the current item is reverse video |
| Theme picker | 3-option radiogroup, stacked vertically in the 200px rail |
| Wizard step strip | 28px square index (Next 800 13) with px2; done is a carrier check, current is a signal fill, upcoming is raised with ink-3 |
| Phase progress bar | signal fill + 3px ink front edge + line (#3A3A42) remainder; turns carrier when done; `role="progressbar"` |
| Toast | panel fill, px4, a 4px status left edge, icon plus text |
| Error strip | lost chip-bg fill, lost text, icon, a "what to do next" sentence |
| Modal | px6 panel over the static scrim; focus trapped; Esc closes |
| Tooltip | ink fill, void text, 13px, px2; shows on focus too |
| Skeleton | flat raised bars (never static) |
| Empty state | pixel icon plus one sentence, e.g. "Nothing on this channel yet" |
| Dock row | exactly 2 lines (unchanged); status chip plus amount plus age in Mono |
| Receipt | Arrival hero (Sixtyfour) with a single 2px signal scanline at 0.4 beneath; details in Next and Mono |

## Brand mark

An 8×8 pixel grid, a dither-to-solid gradient. Rows, where `#` is ink and columns 6–7 are signal:

```
#..#.###
..#.####
....#.##
.#.#.###
#...####
..#.#.##
.....###
#.#.####
```

## Screen notes (from the A′ boards)

- **Private veil:** the line reads "Others on Aztec see ▒▒▒ · you see 247.60 USDC". The 2.40 USDC gas slice arrives as public gas, so "you see" is net of gas. It shows only for deposits onto Aztec with Private on and some token arriving (not for gas-only sends, not on exit). The app prints the full-precision remainder.
- **Pasted-address token lookup** hides the token list, as the app already does. The design shows the Add row as an inset below the card for the board only.
- **Sign and send** stays disabled while the app shows "Confirm the request in your wallet."
- **Mobile (≤760):** the top band has brand plus theme button, then text-only tabs; the step count appears only in the step list's aria-label.
- **Wallet rows in the picker** show the wallet's own name and icon from the wallet SDK, never an app-supplied name.
