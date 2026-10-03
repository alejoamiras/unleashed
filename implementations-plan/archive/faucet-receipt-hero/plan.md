## Outcome

Archived. Seeds retired.

# Faucet Receipt — hero the bridged tokens (port of a draft PR + Fuel adaptation)

**Tier:** `light` · **Supersedes:** a draft PR.

## Summary

Port a draft PR's `BridgeReceipt` rework onto the current base branch and extend it to the Fuel-only variant that landed after the draft was authored. The receipt demotes Fee Juice and heroes the bridged asset:

- the `.ledger` gets a **mint left-rule** (`border-left: 2px solid var(--mint)`) — the single success accent;
- an **uppercase eyebrow** (`route · privacy · elapsed`) with a small **mint `✓`** at its right edge as the explicit "completed" mark;
- a **large cream hero row** (`.row.primary`, 19px) for the bridged / released / fueled amount;
- **dim secondary rows** for gas (`Gas ready`, `Gas used`) — the gross "Gas bought" line and the separate `.reserve` "available" box are dropped.

The draft is 52 commits stale, pre-restructure (it targets `packages/faucet/…`; the file now lives at `apps/faucet/…`) and predates the `isFuel` variant. We re-author its intent on the current base branch rather than rebase the draft.

## Why `light` (Phase 0.5 rubric)

All six dimensions LOW: novelty 0 (the design already exists in the draft), blast radius 0 (one faucet component), irreversibility 0 (presentational, trivially reversible), migration 0, external coupling 0, security 0 (no trust boundary, no new data path). 0 HIGH → `light`, bounded, single-package (`apps/faucet`).

## Scope

**In:** `apps/faucet/src/components/BridgeReceipt.vue` + `apps/faucet/src/components/BridgeReceipt.test.ts` (the 2 files the draft touched, at their post-restructure paths).

**Out:** every other faucet component; the bridge flow / stepper that builds the `ReceiptSnapshot`; the consumed libs (`@/lib/asset-label`, `format`, `explorer`, `phase-clock`, `testids`) — used unchanged; the e2e harness; deps (none added). The `ReceiptSnapshot` interface and all `data-testid`s are preserved verbatim.

## Design (the target, all three variants)

Shared shell (unchanged): the `.confetti` burst, the `.links` row, the `.action` CTA button. Removed: `.rhead` + `.stamp` (+ `stamp-in` keyframes), `.route`, `.reserve`, the `boughtDisplay` and `stampWord` computeds.

**Eyebrow (all variants):** `{{ route }} · {{ privacyWord }}` (+ ` · {{ totalElapsed }}` when known) on the left; a mint `✓` flush right, marked `role="img" aria-label="completed"` — a bare `aria-label` on a generic `<span>` is inconsistently announced by assistive tech (codex M).

**Hero row `.row.primary`** (`heroLabel` computed = `isFuel ? "Fueled" : isDeposit ? "Bridged" : "Released"`):

| Variant | Hero `.k` | Hero `.v` | Dim rows |
|---|---|---|---|
| Token deposit (`isDeposit && !isFuel`) | `Bridged` | `{{ amountDisplay }} {{ amountSymbol }}` (e.g. `100.00 AZLO`) | when `hasFuel`: `Gas ready` = `availableDisplay`, then `Gas used` = `− usedDisplay` (when known) |
| Withdraw (`!isDeposit`) | `Released` | `{{ amountDisplay }} {{ amountSymbol }}` | none (a withdraw never carries gas) |
| Fuel (`isFuel`) | `Fueled` | `{{ amountDisplay }} {{ amountSymbol }}` (e.g. `20.00 Private FJ`) | none — Fee Juice IS the hero, not a demoted side-line |

**`receiptFuel` testid placement** (exactly one in the tree): on the **hero row** for `isFuel`; on the **`Gas ready` row** for a fueled token deposit. **Harden `hasFuel` to `isDeposit && !isFuel && !!fuelReceived`** so the two are PROVABLY mutually exclusive — today they're exclusive only by caller convention, but a `{ direction: "deposit", assetKind: "fee-juice", fuelReceived }` shape is valid-by-interface and would otherwise emit a DUPLICATE `receiptFuel`, silently breaking an e2e selector (codex HIGH). Then bind `:data-testid="isFuel ? TESTIDS.receiptFuel : undefined"` on `.row.primary` and `:data-testid="TESTIDS.receiptFuel"` on the `Gas ready` row.

**CSS:** adopt the draft's `.ledger` (mint left-rule + `padding-left: 14px`), `.eyebrow` (10px uppercase mono, `letter-spacing: .14em`) — extended to `display:flex; justify-content:space-between` so the `✓` sits flush-right — `.row` / `.row .k` / `.row .v`, and `.row.primary .v` (19px cream, the hero). Add `.eyebrow .done { color: var(--mint); letter-spacing: 0 }`. The `✓` and the left-rule are both `--mint` → mint stays the *only* green, honoring the draft's thesis while keeping the explicit done-mark.

## Phases

### Phase 1 ✓ — Reconcile + rework the component and its test

1. Rewrite `BridgeReceipt.vue`'s template + `<style>` to the design above; drop `boughtDisplay`/`stampWord`, add `heroLabel`, **harden `hasFuel` with `!isFuel`**, and mark the eyebrow `✓` `role="img" aria-label="completed"`. Preserve the `ReceiptSnapshot` interface, `amountSymbol`/`assetKind`/`isFuel` logic, every `data-testid`, the `new-bridge` emit, and the confetti/links/action shell.
2. Rewrite `BridgeReceipt.test.ts` to assert the new structure: the mint-`✓` done-mark present; `Bridged`/`Released`/`Fueled` hero label + amount per variant; `Gas ready` (net) + `Gas used` for a fueled deposit; **no** `Gas bought`, **no** `available`/`Ready to power…` copy, **no** bold stamp text. Keep the existing variant coverage (deposit, withdraw, private/public fueled, **fueled-without-known-used** — the `usedDisplay`-absent branch, where `Gas ready` = received and no `Gas used` row — no-fuel, fuel-private, fuel-public) and the testid queries; **add an assertion that no shape yields two `receiptFuel` nodes**. Tests stay inline with the component change.

**Validation gate** — Commands: `bun run test:faucet` · `bun run typecheck:all` · `bun run lint`. Pass: `BridgeReceipt` suite green (all variants), vue-tsc exit 0, biome exit 0. Layers: unit · typecheck · lint.

### Phase 2 ✓ — Build + visual smoke + deliver

1. `bun run build:faucet` — production build is unaffected.
2. Manual visual smoke: `bun run dev:faucet`, eyeball all three receipts (token bridge with + without fuel, withdraw, Fuel) — confirm the mint left-rule + flush-right `✓`, the cream hero amount, the dim gas rows, and that confetti/links/CTA still render.
3. Open the superseding PR to the base branch (`fix(faucet): hero the bridged tokens on the receipt, demote Fee Juice`), then close the draft with a pointer to it.

**Validation gate** — Commands: `bun run build:faucet` · manual `bun run dev:faucet` inspection. Pass: build exit 0; all three variants render per the design; PR opens with the three required checks firing. Layers: build · manual visual.

## Assumptions

**Facts** (verified):
1. The target lives at `apps/faucet/src/components/BridgeReceipt.{vue,test.ts}` post-restructure (`git ls-tree` on the base branch).
2. `assetKind` is a `ReceiptSnapshot` interface field (`BridgeReceipt.vue:18`); `isFuel`/`amountSymbol`/`stampWord` are computeds derived from it (`:44,52,49`), and the Fuel-only template branch (`:100`) is present on the base branch — all of which the draft predates.
3. The base branch's receipt body is raw HTML; only the links row is a `<Flex>` (`BridgeReceipt.vue:116`) — the draft's plain-HTML approach still fits, no primitive rewrite.
4. A rename-aware cherry-pick of the draft's commit conflicts in exactly **3 regions of `BridgeReceipt.vue`** and **auto-merges `BridgeReceipt.test.ts` clean** (simulated on a throwaway branch).
5. All dynamic content is text-interpolated (Vue auto-escapes): numeric amounts (`formatBigInt` over `BigInt`), the `ctaLabel` prop (`:126`), and route/privacy/`amountSymbol` (`:45,46,52`); tx-hash hrefs are gated by the `links` computed on a non-empty, strict-hash-validated explorer URL (`explorer.ts:18`). No `v-html` (`:69-84`). Not an XSS surface — but the content is broader than "numeric only" (codex Fact correction).
6. Faucet tooling is real: `test:faucet`, `typecheck:all`, `lint`, `build:faucet` (`package.json` / `apps/faucet/package.json`).

**Inferences** (unverified, attackable):
- The `availableDisplay` (net = received − used, floored at 0) is the right number to surface as the demoted `Gas ready` — the draft's intent. If a user valued the gross "bought" figure, dropping it loses info (accepted per the draft's thesis).
- The faucet e2e (`test:e2e`) does not assert receipt copy/structure, so excluding it from the gate loses no coverage (user-confirmed: e2e not selected).

**Asks** (all resolved — no silent assumptions):
- Success mark → **keep a small mint `✓`** on the eyebrow (user-answered).
- Validation layers → **unit + typecheck + lint + build + manual visual smoke**, no e2e (user-answered).
- Fuel hero framing + dropping gross "Gas bought" → stated defaults, owner-vetoable at the gate.

## Security & Adversarial Considerations

- **Threat surface:** a presentational Vue component rendering a locally-built `ReceiptSnapshot`. No network call, no storage write, no auth, no secret, no new dependency.
- **XSS:** all bindings are mustache text interpolation (auto-escaped); no `v-html`, no dynamic attribute injection. Tx links use `target="_blank"` + `rel="noopener noreferrer"` (preserved) and are gated on a non-empty explorer href.
- **Input validation:** amounts go through `BigInt(...)` (throws on malformed) → `formatBigInt`; the `availableDisplay` subtraction is floored at `0n` so a `used > received` snapshot can't render a negative.
- **Supply chain / least privilege / crypto:** not engaged — no deps, no CI/token/credential surface. `/harden` not warranted.

## Post-implementation hardening

None. Presentational change, no auth / secrets / CI-CD / publishing / repo-wide security surface. No `/harden` pass scheduled.

## Decision ledger (light)

- **Drop the bold stamp, keep a small mint `✓`** (eyebrow, flush-right) — chosen over a full stamp-drop. Rationale: the draft's "mint is the only green / single success mark" thesis is honored (the `✓` is mint, same as the rule), but an explicit "completed" affordance is retained across all three variants (the user's call; the FUELED-stamp variant landed after the draft).
- **Fuel receipt = same hero treatment**, FJ amount as `.row.primary` with a `Fueled` label, no demoted gas rows — Fee Juice is the product on a Fuel bridge, not a side-effect.
- **Drop the gross `Gas bought` line + the `.reserve` box**; surface only net `Gas ready` (+ `Gas used`) — the draft's demotion intent.
- **Re-author on the base branch, not rebase the draft** — 52 commits + a directory restructure make a fresh branch cleaner than untangling the stale draft's conflicts.

### Codex audit — conditional approve (session `019f19c7`)

3 conditions, all folded: **(1)** `hasFuel` hardened with `!isFuel` (kills the latent duplicate-`receiptFuel` footgun — HIGH); **(2)** the eyebrow `✓` marked `role="img" aria-label="completed"` (reliable AT exposure — MED); **(3)** overstated Facts 2 + 5 corrected. Plus: because we deliberately KEEP a small `✓` (deviating from the draft's "left-rule is the *lone* success mark" thesis), **no carried-forward comment will claim the rule is the single success mark** — both the rule and the `✓` are `--mint`, so "mint is the only green" still holds, but it is not the only *mark*. Codex "looks fine": no `v-html`; tx links hash-gated; `boughtDisplay`/`stampWord` local-only; consumers pass no ignored props beyond the intended `ctaLabel`; gate scripts exist.

## Seeds

`/goal` is recommended (completion is transcript-observable via the gates).

```
/goal All phases in implementations-plan/archive/faucet-receipt-hero/plan.md marked ✓ (the per-phase headers in the file), each backed by its validation gate reported passing in the transcript; for each phase the agent printed `LESSONS_FILE=implementations-plan/archive/faucet-receipt-hero/lessons/phase-N.md`; `/code-review max --fix` complete with fixes applied and committed; codex post-impl audit complete with high/critical findings addressed; `bun run test:faucet`, `bun run typecheck:all`, and `bun run lint` all report exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/archive/faucet-receipt-hero forward. Never idle. Each firing: read plan.md + lessons/; `git status`; if a PR exists `gh pr view --json statusCheckRollup`. Pick the next pending phase; after each edit run that phase's gate (test:faucet / typecheck:all / lint, then build:faucet). Phase green (its gate passes) → mark ✓, file lessons/phase-N.md, print LESSONS_FILE=…, advance. Decisions → /codex xhigh, log verdict, act. Hard limits: never merge to main, never publish/deploy, don't expand scope beyond the 2 files. All phases ✓ → /code-review max --fix → commit → codex post-impl audit → address high/critical → open the superseding PR → report + stop.
```
