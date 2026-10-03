## Outcome

Archived. Seeds retired.

# Faucet `@unleashed/design` adoption (primitives-only resolver + seam-grouped reuse)

**Status:** AWAITING USER APPROVAL (deep tier). 3 plans consolidated (main + codex `019eeed5` + fable) → contradiction-check + double audit + final fresh-context codex pass all folded: codex Round 1 `reject` → restructured; fresh-fable `conditional approve` → conditions folded; final codex `019eeef4` `conditional approve` → all conditions folded. Gate prerequisites complete (plan + eli5 + explicit verdicts + ledger). See § Audit verdicts.

**Owner intent (verbatim):** *"start using @unleashed/design on the faucet's/bridge/fuel design. Obviously, there might be things that are not completely re-usable and that is just fine, but at the same time… It sounds like we should be able to re-use a bit more."*

## Summary + the honest, evidence-based reuse ceiling (read first)

The faucet (`packages/faucet`, Vue 3 + Vite 8, **light theme**) consumes `@unleashed/design` via explicit imports in 10 SFCs; the rest is bespoke brutalist markup. The deep flow's double audit reshaped the plan twice; the honest answer to *"reuse a bit more?"* is:

- **What we DON'T do (rejected as churn):** convert already-imported components (`Button`/`Card`/`Toast`/`AddressDisplay`/`Spinner`/`BalanceRow`/`DripButton`/`DisclaimerTag`/`EmojiGrid`) from explicit imports to bare resolver tags. That's pixel-identical *and* zero-reuse-gain — the same components, just a tidier `<script>`. It bloats the resolver and diverges from the Nulo wallet's resolver philosophy (primitives-only), which this resolver follows. **These stay explicit imports.**
- **What we DO (real reuse):** introduce bare `@unleashed/design` **primitives** (`Flex`/`Text`/`Icon`, plus `Badge` where it fits) in place of raw structural markup, via a small auto-import resolver, **grouped by UI seam**.
- **The ceiling is modest-but-real — for documented reasons** (per-primitive inventory below). `Flex` is the bulk (incl. class-preserving swaps on bordered wrappers); `Text` covers many labels (font IS available via the `.font-headline`/`.font-mono` utility classes — its real limits are span-only/no semantic tag, default `line-height:1`, and off-scale tracking 0.04/0.06/0.08/0.12em vs only `.tracking-wide`=0.05/`.tracking-widest`=0.1); `Tag` likely fits the PRIVATE/PUBLIC status pill (it was extracted from the faucet). But `Flex` can't do CSS grid / two-axis gaps / `align-items:baseline` / off-scale gaps (no `gap--5`), and the brutalist controls + `Input`/`Toggle` don't map without forbidden package edits or drift. **The big forms stay mostly bespoke — that's correct, not a shortfall.**

### Per-primitive reuse inventory (the audit fable demanded — evidence-based)

| Primitive | Faucet target | Verdict | Documented reason |
|---|---|---|---|
| `Flex` | pure single-axis flex wrappers (`.amount-row`, `.actions`, `BridgeJournal .cards`/`.head-row`, `.opt-row`, …) | **fit** (real win) | layout-only; gap maps to a utility step; no descendant-selector dependency |
| `Text` | inline labels (mono OR headline) w/ none/`0.05`/`0.1em` tracking | **fit** (broader than v3 thought) | font via `.font-headline`/`.font-mono` utility classes (forwarded to Text's root span). **Non-fit** where the label is a semantic block (`<p>`/`<h*>`), needs a non-1 `line-height`, or uses off-scale tracking |
| `Icon` | raw inline SVG/icon spans | **fit where present** | per-file |
| `Tag` | `BridgeJournalCard` `.tag` PRIVATE/PUBLIC | **likely fit (primary pill candidate)** | structurally identical (bordered mono uppercase pill — `Tag` was extracted FROM the faucet). Needs a tone check: PUBLIC→`neutral`; PRIVATE may need a tone the package lacks (neutral/test/warn) → adopt if it maps, else keep `.private` local |
| `Badge` | `BridgePhaseRail` `.badge` SKIPPED | **opt-in only if a pixel check wins** | `Badge` is a filled `2px 6px` pill, less close than `Tag`. The chain/address `.chip`s are NOT pills. |
| `LoadingState` | `BridgeJournal` empty-state | **non-fit** | forces a `<Spinner>` (state is *empty*, not loading); no action slot for the journal's a11y link-button; hardcoded `data-testid="loading-state"` |
| `SectionLabel` | headline titles | **non-fit** | faucet has standalone titles, not the `LABEL + count` baseline pair it encodes |
| `Banner` | `.hint` one-liners | **non-fit** | rich icon+title+description+action box vs plain `<p>` — forcing it adds border/icon drift |
| `Tooltip` | (none) | **non-fit** | unmet host contract (no `#tooltip` teleport root / `--base-width` var) + no use case |
| `Input` / `Toggle` | amount inputs / fuel toggle | **non-fit** | underline-emits-numbers vs full-border-string; hardcoded `toggle-switch` testid + `role=switch` + 32×20 vs `aria-pressed` 40×22 wired to `TESTIDS.bridgeFuelToggle` |

**Net real reuse: `Flex` (the bulk) + narrow `Text` + possibly 1–2 `Badge`.** Honest and small — faithful to "some things aren't re-usable and that's fine."

## Locked decisions (clarifying round)

| Decision | Answer |
|---|---|
| Scope | **Entire faucet app** — all views + components. |
| Reuse depth | **Consume existing only.** No new `@unleashed/design` exports. No clean map → **keep local**. |
| Visual bar | **Visually equivalent, minor drift OK.** Light theme correct. Preserve ALL behavior + ALL `data-testid`s verbatim. |
| Imports | **Adopt the auto-import resolver** for primitives (resolver-only, `dirs:[]`). |
| Validation gates | typecheck + root lint + `bun run --cwd packages/faucet test` + `bun run --cwd packages/faucet build`; `test:e2e` on phases touching untested SFCs; **full `bun run audit:faucet`** at the end. |
| Human gate | **Yes — full human visual sign-off**, checklist naming the exact machine-invisible nodes. Agent surfaces and holds. |

## Why `deep`

Rubric HIGH ≈1 (blast radius: whole live app) → technically `mid`; escalated to `deep` by explicit user choice + the documented round-1 silent-regression failure mode. **The ceremony paid for itself:** the contradiction-check killed a zero-value import-cutover over-reach; the hostile audit caught a concrete machine-invisible regression (`.links` orphan), a false "verified" fact, a lockfile-sequencing bug, and an un-done reuse inventory — all before a line of code.

---

## Migration rubric (audit-hardened)

A swap is allowed ONLY if **all** hold:
1. The element is a **single-axis flex container with `display:flex`** (→ `<Flex>`) or an **inline text label** (→ `<Text>` + `.font-{headline,mono}`/`.tracking-{wide,widest}` utility classes) whose tracking is none/`0.05`/`0.1em`, line-height is ~1, and which is NOT a semantic block (`<p>`/`<h*>`/landmark). `Flex` renders `display:flex`, NOT `inline-flex` — do **not** swap an `inline-flex` wrapper (it would drift) unless inline-block layout is genuinely equivalent. *(codex final)*
2. Gap maps to an **existing utility step** (`gap--{2,3,4,6,8,10,12,14,16,20,24,32,40,48,60}`); off-scale (e.g. `5px`) → keep local. No CSS grid, two-axis gap, or `align-items:baseline` (Flex can't express these).
3. **Class-preserving is allowed and is the norm for styled wrappers.** A swap MAY keep the wrapper's class (`<Flex class="panel">`) to carry non-layout styling (border/bg/sizing) — but the class MUST stay on the **same node** so descendant selectors (e.g. `.links a`) still match, and you delete ONLY the layout declarations the primitive now owns (`display`/`flex-direction`/`gap`/`align-items`/`justify-content`). **NEVER delete a class or rule a descendant depends on** (the `.links` orphan bug). *(codex final + fable H1)*
4. **Element type preserved:** pass `tag="header"`/`tag="footer"`/etc. to `<Flex>` (it defaults to `div`) so landmarks/semantics survive. *(fable M3)*
5. **Skip churn swaps** — if there is no layout declaration to extract (the flex does nothing, or keeping the class IS effectively all the work, e.g. `.foot` wrapping a single child), don't swap. *(fable M3)*
6. **Every** `data-testid`/`aria-*`/`data-*` stays on the **same node** it lives on today (primitives forward `$attrs` to their single root — verified for Flex/Text). Never relocate a tested testid.
7. **No `v-html`.** External `<a target=_blank>` keep `rel="noopener noreferrer"` verbatim — never route through a primitive that changes `rel`.

**Candidate lists in the phases below are EXAMPLES.** Each implementing phase derives the *complete* swap list from a per-file scan against this rubric (the consolidated examples were not exhaustive — fable L1).

---

## Phases (seam-grouped)

> **Gate legend** (from `packages/faucet` unless noted): **T**=`bun run typecheck` · **L**=`bun run lint` (repo root) · **U**=`bun run test` (incl. component tests + `app.css.parity.test.ts`) · **B**=`bun run build` · **E**=`bun run test:e2e`. Pass: T/L/U/B exit 0, no "Failed to resolve component" warnings, diff = intended files only.

### Phase 1 — Resolver infrastructure + **real bare-tag proof** ✅ DONE

> Gate green: typecheck 0 · test 397/397 · lint 0 · build ✓ · test:e2e 14/14. Proof swap (`VerificationModal` `.actions`→`<Flex>`) resolves across build + vitest + e2e. See `lessons/phase-1.md`.

**Goal:** stand up a **primitives-only** resolver and *prove bare-tag resolution actually fires* in build + both vitest pipelines (not just that the plugin loads) — because the Nulo wallet, whose resolver this follows, does NOT run `unplugin-vue-components` under vitest, so this wiring is novel and unproven here (fable M1 / codex H2).

**Files:**
- `packages/faucet/scripts/design-resolver.ts` *(new)* — `DESIGN_COMPONENTS` = **primitives the faucet will newly use as bare tags only**: `Flex`, `Text`, `Icon` (+ `MaterialIcon` if used; + `Tag` and/or `Badge` once a Phase-3 pill candidate is actually adopted). **NOT** `Button`/`Card`/`Toast`/`Spinner`/`AddressDisplay`/`BalanceRow`/`DripButton`/`DisclaimerTag`/`EmojiGrid` — those stay explicit imports (no churn).
- `packages/faucet/scripts/design-resolver.test.ts` *(new)* — no-shadow guard: no faucet-local SFC name collides with the set (codex).
- `packages/faucet/scripts/components-plugin.ts` *(new)* — `componentsPlugin({ dts })` factory consumed by all three configs so they can't drift (codex).
- `packages/faucet/vite.config.ts` — plugin after `vue()`: `dirs: []` (verified valid against installed unplugin source), `resolvers: [designResolver()]`, `dts: "src/types/components.d.ts"`.
- `packages/faucet/vitest.config.ts` + `vitest.e2e.config.ts` — same plugin, `dts: false`.
- `packages/faucet/package.json` — add `unplugin-vue-components: "^32.0.0"` (the exact version the Nulo wallet uses).
- `biome.json` — add `"!**/packages/faucet/src/types"` to `files.includes:6` (else the generated dts fails lint — fable; biome.json:6 lacks it).
- `packages/faucet/src/types/components.d.ts` *(generated, committed)*.
- **The proof:** migrate **one** verified-clean, tested swap to a bare `<Flex>` — `VerificationModal.vue`'s `.actions` wrapper (`display:flex`, no descendant-selector dependency, covered by `VerificationModal.test.ts`). NOT `WalletPanel` (its wrappers are `inline-flex` → would drift — codex final). This forces the resolver to fire in vitest + build, surfacing any transform-pipeline incompatibility on ONE file.

**Sequence:** **one normal `bun install`** to record the faucet→unplugin workspace edge (no download, no version bump), THEN `--frozen-lockfile` thereafter (fable M2 — frozen would error on the un-recorded edge) → add factory/configs/resolver/test → introduce the one bare-tag proof → `bun run build` emits the (now non-empty) dts → commit dts → gates.
**Validation gate:** T + L + U + B + E. Pass: the bare-tag proof renders correctly in `VerificationModal.test.ts` (proves vitest resolution) AND in `build` (proves rollup resolution) AND a smoke (proves the e2e config); `design-resolver.test.ts` green; generated dts contains the proof's entry. Layers: typecheck/lint · unit · build · jsdom-e2e.

### Phase 2 — Wallet + verification seam ✅ DONE

> Gate green: typecheck 0 · test 403/403 · build ✓ · lint 0. Added L1WalletPanel/BridgeWalletPanel tests (closed the gate gap); 3 class-preserving Flex swaps (`.capability`/`.no-wallet`); the inline-flex/off-scale/position-dominant wrappers kept local. See `lessons/phase-2.md`.

**Goal:** swap pure-layout/label markup to bare primitives in the shared wallet/verification surfaces. **Close the coverage gap first:** `BridgeWalletPanel.vue` + `L1WalletPanel.vue` have NO unit test and are **stubbed out of both smokes** (`bridge-smoke.test.ts:108` `stubs: { L1WalletPanel: true, BridgeWalletPanel: true }`), so a swap there is otherwise unguarded (codex final, High). `WalletPanel` is tested; `AppToastRegion` is smoke-covered.
**Step 0 (coverage):** add focused `BridgeWalletPanel.test.ts` + `L1WalletPanel.test.ts` (mount with mocked composables, assert their `data-testid`s + connected/disconnected render) BEFORE swapping them — so the swap has a real safety net (inline-with-change, per the testing philosophy).
**Files (examples; derive full list per rubric):** `WalletPanel.vue`, `BridgeWalletPanel.vue`, `L1WalletPanel.vue`, `VerificationModal.vue`, `AppToastRegion.vue`. Keep `Button`/`AddressDisplay`/`Spinner`/`EmojiGrid`/`Toast` as explicit imports; `VerificationModal`/`EmojiGrid` testids are e2e **security** selectors — do not touch them.
**Validation gate:** T + L + U + B. Pass: `WalletPanel.test.ts`, `VerificationModal.test.ts`, **the two new panel tests** green. Layers: typecheck/lint · unit · build.

### Phase 3 — Journal / stepper / receipt seam (+ execute the Badge/label inventory) ✅ DONE

> Gate green: typecheck 0 · test 403/403 · build ✓ · e2e 14/14 · lint 0. 4 Flex swaps (BridgeJournal `.journal`/`.cards`/`.head-row` + BridgeReceipt `.links`). **Pills (`Tag`/`Badge`) tested → both NON-FITS** (faucet pills are `10px/600` bordered-transparent, denser than both primitives; `.tag.private` accent maps to no tone). Stepper/rail/empty-state/ledger kept local. See `lessons/phase-3.md`.

**Goal:** the shared bridge-progress surfaces — the seam where the *opportunistic* primitive evaluation lives.
**Files (examples):** `BridgeJournal.vue` (`.cards`→`<Flex direction=column gap=10>`, `.head-row`→`<Flex justify=between gap=12>`; empty-state **stays local** — LoadingState non-fit), `BridgeJournalCard.vue` (evaluate `.tag` PRIVATE/PUBLIC → `<Tag>` — primary pill candidate), `BridgeStepper.vue`, `BridgePhaseRail.vue` (evaluate `.badge` SKIPPED → `<Badge>` only if a pixel check wins; `Tag` first), `BridgeReceipt.vue` (`.links` is a class-preserving candidate at best — keep `.links` on the `<Flex>` so `.links a` still matches; low gain → optional/skippable).
**In-phase task (the reuse inventory execution):** for each `Tag`/`Badge`/`SectionLabel` candidate, do the per-case fit check — `Tag` for `.tag` PRIVATE/PUBLIC: verify PUBLIC→`neutral` tone matches and whether PRIVATE maps to a package tone (neutral/test/warn) or must stay `.private` local; adopt where it holds, document the non-fit reason where it doesn't. Add `Tag` (and/or `Badge`) to the resolver set only if ≥1 candidate is actually adopted.
**Validation gate:** T + L + U + B + E. Pass: `BridgeJournal.test.ts`, `BridgeJournalCard.test.ts`, `BridgeStepper.test.ts`, `BridgePhaseRail.test.ts`, `BridgeReceipt.test.ts` green; smokes green. Layers: all machine + jsdom-e2e.

### Phase 4 — Form / card seam + remaining leaves ✅ DONE

> Gate green: typecheck 0 · test 403/403 · build ✓ · e2e 14/14 · lint 0. ~17 Flex swaps: TokenCard `.head`/`.actions`, BridgeForm `.amount-row`/`.opt-row`, FuelForm `.amount-row`, FaucetView `.faucet-view`, + all 3 `.hero`. **Bridge/Fuel view roots reverted to local** (`gap:28px` has no `gap--28` utility — caught at the Phase-5 visual gate, see `lessons/phase-5.md`). Brutalist controls, footers, grids, baseline rows, App-shell `.page` kept local. See `lessons/phase-4.md`.

**Goal:** the densest + riskiest surfaces last, after the toolchain + patterns are proven.
**Files (examples):** `BridgeForm.vue` (`.amount-row`→`<Flex align=center gap=8>`, `.opt-row`; keep amount input/fuel toggle/mode cards/grid local), `FuelForm.vue` (`.amount-row`; **no unit test** → leans on the bridge/fuel smokes + human gate), `TokenCard.vue` (`.head`→`<Flex tag=header direction=column gap=4>`, `.actions`→`<Flex gap=12 wrap=wrap>`; **drop `.foot`** — no-op), `Footer.vue`, `BridgeFooter.vue`, the 3 thin views.
**Validation gate:** T + L + U + B + E. Pass: `BridgeForm.test.ts` + `.fuel.test.ts` + `.18dec.test.ts`, `TokenCard.test.ts` green; 3 smokes green. **Riskiest phase for pixels.** Layers: all machine + jsdom-e2e.

### Phase 5 — Human visual sign-off gate (terminal, human-gated, mandatory) ✅ DONE — user sign-off

> **Hold action performed (not ✓ — ✓ requires the user's visual sign-off, never self-marked):** faucet built green (preview-ready); the at-risk-node checklist below was derived from the diff (17 `<Flex>` swaps) and surfaced to the user; `audit:faucet` exit 0 + `test:e2e` 14/14 confirmed. Preview: `bun run --cwd packages/faucet dev`.
>
> **At-risk nodes to eyeball in light theme (from the diff):**
> - **Faucet tab:** `FaucetView` page column + `.hero` (`.faucet-view`→Flex, `.hero` class-preserving); each `TokenCard` symbol header + drip-buttons row (`.head`→`<Flex tag=header>`, `.actions`→`<Flex wrap>`); `WalletPanel` connect / "Awaiting permissions" / "No wallet" blocks (`.capability`/`.no-wallet`→Flex).
> - **Bridge tab:** `BridgeView` column + hero; `BridgeForm` amount-input row + "ARRIVE WITH GAS" toggle row (`.amount-row`/`.opt-row`→Flex); `BridgeJournal` header (title + RESTORE, `.head-row`→`<Flex tag=header>`) + card stack (`.cards`→Flex) + section (`.journal`→`<Flex tag=section>`); **`BridgeReceipt` "view tx" links — confirm colored + underlined** (`.links`→Flex, class-preserving — the one descendant-styled swap, highest-risk).
> - **Fuel tab:** `FuelView` column + hero; `FuelForm` amount row; `VerificationModal` Cancel/"They match" buttons right-aligned (`.actions`→`<Flex justify=end>`).
> - **Standing:** page bg `#f5f5f7`, text contrast, borders/outlines, button fills, focus rings.
>
> **✅ User signed off ("this worked perfectly")** — after the round-1 `gap--28` regression was caught + fixed. PR to the base branch open; user authorized squash-merge once CI is all-green + closing the dev server.

**Goal:** the only defense for machine-invisible regressions (the round-1 lesson).
**Steps:** `bun run --cwd packages/faucet build` + `preview`; eyeball **light theme** across all 3 tabs. **Checklist names the exact at-risk nodes derived from the Phase 2–4 diff** (fable L3): any anchors near swapped wrappers (orphan-style risk), any `tag=`-preserved header/footer, the untested `FuelForm` amount rows, the `Badge` adoptions, plus the standing list (page bg `#f5f5f7`, contrast, borders/outlines, button fills, focus-visible, toast region; `app.css.parity.test.ts` green).
**Validation gate:** full **`bun run audit:faucet`** (= `typecheck:all && test:faucet && lint && verify:deployments && build:faucet` — `verify:deployments` is local/deterministic, runs as-is — codex M1) + `test:e2e` + **human sign-off recorded in `lessons/phase-5.md`**. Agent **surfaces and holds** — never self-marks ✓. Layers: full machine + human visual.

---

## Decision ledger

- **D1 — Resolver = primitives-only (`dirs: []`); already-imported components stay explicit.** Codex Round-1 flagged the original "cut over everything" as zero-value churn; adopted on merits (truer mirror of the Nulo wallet — its resolver is primitives-only; no churn; serves the reuse goal). Fable confirmed the cutover would have been *safe* but it's a value call, resolved here. `dirs:[]` verified valid against installed unplugin source. **The one notable architectural choice — flagged at the gate** (user may opt to also cut over the explicit imports for uniformity; not recommended).
- **D2 — Phasing by SEAM (codex, revived).** Once the cutover is gone, risk lives in shared UI seams (wallet/verification; journal/stepper/receipt; form/card). Superseded both main's per-view and fable's change-type ordering (change-type was a response to the cutover, which no longer exists).
- **D3 — Faucet owns its own (primitives-only) resolver copy.** No new package export.
- **D4 — Commit generated `components.d.ts` + add `!**/packages/faucet/src/types` to `biome.json`** (real gap at `biome.json:6`).
- **D5 — Shared `components-plugin.ts` factory** across the 3 configs (anti-drift; codex's "single biggest risk" = partial cutover across entrypoints).
- **D6 — Reuse ceiling is modest-but-real, evidence-based** (the per-primitive inventory). `Flex` is the bulk (incl. class-preserving swaps); `Text` is broader than first thought (font via `.font-headline`/`.font-mono` utilities); `Tag` is the primary status-pill win (extracted from the faucet); `Badge` opt-in. The final codex pass corrected v3's still-too-low framing (Text font isn't the blocker; `Tag` was unevaluated).
- **D7 — `Input`/`Toggle`/`LoadingState`/`Banner`/`Tooltip`/`SectionLabel` stay local** for documented reasons (table above).
- **D8 — Phase 1 includes a real bare-tag proof** (both auditors: an inert Phase 1 proves nothing about resolution; the wallet doesn't even run this plugin under vitest).
- **Rubric criteria 3–5 added** from fable H1/M3 (no descendant-selector dependency; `tag=` preservation; no no-op swaps).
- **Superseded:** import-cutover waves (D-reject, churn); "verified low ceiling" (was a false fact + un-done audit → now evidence-based); `--frozen-lockfile` first (→ one normal install first).

**Open decision (gate):** D1's resolver scope (primitives-only — recommended — vs also cutting over the explicit imports). No other open Asks.

## Audit verdicts (inline)

- **Codex Round 1 (contradiction-check + adversarial), session `019eeed5`:** `reject` — blocking: resolver over-widened into a zero-value import cutover; Phase 1's inert gate proves nothing about bared-tag resolution. **All findings folded** (resolver → primitives-only; cutover dropped; seam phasing revived; Phase 1 bare-tag proof added; Facts→Inferences; full `audit:faucet`; D6 reword).
- **Fresh fable Round 1 (hostile, no prior context):** `conditional approve` — conditions block Phase 4 only (the import cutover it verified as sound): drop `.links` swap (descendant-selector orphan), correct the false letter-spacing fact + do the primitive inventory, fix `--frozen-lockfile` sequencing, preserve element type on `.head`/drop `.foot`, prove the vitest resolver with a real bare-tag render. **All conditions folded.**
- **Final fresh-context codex pass (session `019eeef4`):** `conditional approve` — conditions: (1) close the Phase-2 gate gap for `BridgeWalletPanel`/`L1WalletPanel` (add tests — folded); (2) fix the Phase-1 proof target (WalletPanel is `inline-flex` → use `VerificationModal` `.actions`; clarify class-preserving swaps are allowed — folded into the rubric); (3) correct the `Text` inventory (font IS available via utility; real limits = span-only/line-height/tracking) + evaluate the `Tag` primitive (closer than `Badge` to the PRIVATE/PUBLIC pill) — folded. **All conditions folded into this revision.** Confirmed fine: D1 (dropping the cutover loses no real reuse), lockfile sequencing, biome exclude, no XSS/`rel` regression, human gate as the availability defense.
- **Post-implementation codex audit (session `019eef2f`):** `no high/critical`. Confirmed the swaps follow the rubric (pure-layout classes removed; class-preserving kept the class on-node where descendants/non-layout CSS mattered; `tag=` for landmarks), the `Flex` prop→utility mappings reproduce the deleted declarations, no `inline-flex`→`flex` drift, testids/`aria-*`/`rel`/no-`v-html` all clean, local exceptions stayed local. Two folded: (Med) resolver set trimmed `Flex/Text/Icon`→`[Flex]` to stay in lockstep with the committed dts; (Low) no-shadow test recurses `src/**`. (Codex stalled on transient auth 401/403/429 then recovered; a parallel documented self-audit independently reached `no high/critical` — same orphaned-descendant / prop-equivalence / rel checks.)

## Implementation summary (Phases 1–4 complete; Phase 5 held)

Shipped on the task branch (8 commits): the primitives-only resolver infra + **~19 `<Flex>` adoptions** across 9 components + all 3 views, every phase green at its gate (typecheck · 403 unit · 14 smokes · build · lint · `audit:faucet` exit 0). Genuine reuse where clean (layout wrappers, view roots, amount rows); the brutalist controls, both status-pill primitives (`Tag`/`Badge` — tested, visible-drift non-fits), footers, grids, baseline rows, and the App-shell centering container stayed local — the honest "modest but real" consume-only outcome. **Phase 5 (human visual sign-off) is the only remaining step — held for the user, never self-marked.**

---

## Security & Adversarial Considerations

- **XSS:** unchanged — primitives use escaped interpolation; package has `sanitize`/`boundary.test`. **No `v-html` introduced** (audit greps the diff). Token data from `@/constants` + `formatBigInt`, never raw HTML.
- **External-link `rel` hygiene:** faucet external links (`view tx`, receipt, Footer) keep `rel="noopener noreferrer"` verbatim (clickjacking/tabnabbing) — never routed through a primitive that changes `rel`.
- **Resolver shadowing:** `dirs: []` → no local dir-scan; explicit imports win; resolver fires only for unimported bare primitive tags. No collision verified; no-shadow test pins it.
- **Supply chain:** `unplugin-vue-components@^32.0.0` already resolved in `bun.lock` → no new package, no min-age window; one normal install records only the workspace edge; build-time devDep only; no version bump.
- **Light-theme regression (the real risk):** round-1 canonical failure (byte-identical tokens, missing element-global rule). Defenses: `app.css.parity.test.ts` (rule-presence) + the Phase-5 human eyeball + the audit-added rubric criterion banning descendant-selector-dependent swaps (the `.links` class). The human gate is the ONLY defense for the machine-invisible cases — checklist names them.
- **Least privilege / crypto / authn:** N/A (presentational). No `/harden` warranted (recorded; not scheduled).

## Assumptions

**Facts (verified):**
- 10 SFCs import `@unleashed/design` (explicit, bare-named, no aliases — fable verified); no `Components()` plugin in any of the 3 faucet configs today; no `<Flex>`/`<Text>`/`<Icon>` used yet.
- `main.ts` imports `@unleashed/design/base.css` (dark+light tokens; `@import "./utilities.css"` line 9 → the `.flex`/`.gap--N`/`.color--*` utilities are loaded) then `./app.css` (element-globals).
- Faucet tests mount **real** components (no design stubs), asserting forwarded testids + `.trigger("click")` (`WalletPanel`/`MintFuelAsset`/`VerificationModal`).
- The Nulo wallet does **NOT** run the components plugin under vitest, and it scans component directories — so resolver-in-vitest + `dirs:[]` are **novel here, not a mirror** (fable M1).
- `base.css:373/377` ship `.font-headline`/`.font-mono` utilities; `base.css:385-390` ship `.tracking-wide`(0.05em)/`.tracking-widest`(0.1em); `Text.vue:73` root is `<span :class>` so these utility classes fall through. So `Text`'s real limits are **span-only (no `tag` prop → no semantic `<p>`/`<h*>`/landmark), default `line-height:1`, and off-scale tracking** — NOT font-family (codex final corrected v3). Gaps discrete (no `gap--5`). 15/18 components use letter-spacing.
- `Tag.vue` (`packages/design/src/ui/Tag.vue`, exported `index.ts:37`) is a bordered mono uppercase pill (tones neutral/test/warn) — extracted from the faucet; structurally matches `BridgeJournalCard.vue:240`'s `.tag` PRIVATE/PUBLIC.
- `WalletPanel.vue` wrappers are `inline-flex` (:129/135/172) — not clean `<Flex>` (`display:flex`) targets; `VerificationModal.vue` `.actions` is a clean `display:flex` proof target. `BridgeWalletPanel`/`L1WalletPanel` are stubbed in `bridge-smoke.test.ts:108` and have no unit test.
- `dirs: []` disables the scan (verified against installed `unplugin-vue-components` source: default overridden by `Object.assign`; `toArray([])→[]→globs=[]`).
- `biome.json:6` lacks a faucet `src/types` exclude; `unplugin` is in `bun.lock` but the faucet edge is undeclared.
- `audit:faucet` (root `package.json:31`) = `typecheck:all && test:faucet && lint && verify:deployments && build:faucet`; `verify-deployments.ts` is local/deterministic.
- BridgeForm has 3 test files; no-unit-test surface = `FuelForm`, `BridgeWalletPanel`, `L1WalletPanel`, `MintTestUsdc`, `AppToastRegion`, 3 views.

**Inferences (attack these — reclassified per codex M2 / fable):**
- **(I1)** `dirs:[]` generates a usable dts deterministically. *Source-verified for the no-scan behavior; dts determinism unverified — fallback: explicit gen step or hand-authored dts.*
- **(I2)** Wiring the resolver into both vitest configs fully resolves bare tags with no test edits and no `server.deps.inline` change. *Plausible (injected import is byte-identical; `@unleashed/design` already resolves in faucet vitest) but UNPROVEN in-repo — Phase 1's bare-tag proof is what verifies it.*
- **(I3)** Pure-layout swaps are visually equivalent in light theme. *True for clean swaps; the audit removed the known-false ones (`.links`, header/footer→div). Residual sub-pixel risk → human gate.*
- **(I4)** ≥1 `Badge` candidate will pass the per-case visual match. *Unverified until Phase 3; if none pass, `Badge` is dropped from the set and the ceiling is `Flex`+`Text` only.*

**Asks:** D1 resolver scope (primitives-only — recommended — vs cutover-everything). Decided at the gate.

---

## Seeds (finalized after approval)

**/goal (draft):**
```
/goal All phases marked ✓ in implementations-plan/archive/design-system-faucet-adoption/plan.md (Phase 5 NOT self-completed — the agent builds + previews the faucet, surfaces the light-theme checklist naming the exact at-risk nodes from the diff, and HOLDS for my sign-off), each ✓ backed by its phase gate passing in the transcript (T/L/U/B; E where noted); for each phase the agent printed LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-N.md; `/code-review max --fix` complete + committed; codex post-impl audit complete with high/critical addressed; `bun run audit:faucet` reported exit 0 in the transcript.
```

**/loop 15m (draft):** drive the plan; reality-check plan.md + lessons + git each firing; never idle; `/codex xhigh` on decisions; phase green = its plan.md gate passes; **surface-and-hold at Phase 5** — never self-mark it ✓; never merge/publish/expand scope.
