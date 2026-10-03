# Phase 2 — Wallet + verification seam

**Status:** ✓ green. Gate: typecheck 0 · test 403/403 (38 files) · build ✓ · lint 0 · no dts churn.

## What shipped
- **Coverage (Step 0, closes codex final's High):** new `L1WalletPanel.test.ts` (3) + `BridgeWalletPanel.test.ts` (3) — both were untested AND stubbed out of the smokes (`bridge-smoke.test.ts:108`), so a swap there was otherwise unguarded. Tests mount with mocked composables and assert connected/disconnected testids + handler wiring.
- **3 class-preserving `Flex` swaps** (the only rubric-clean wins in this seam): `WalletPanel` `.capability` + `.no-wallet`, `BridgeWalletPanel` `.capability` → `<Flex direction="column" gap="12" align="start" class="…">`. Each kept its class (for `max-width:56ch` + descendant rules `.capability h3/p/.hint`) and deleted only the 4 layout decls. The `data-testid` (capabilityApproval) stayed on the node (Flex forwards `$attrs`).

## Kept local (documented non-fits — the honest low yield of this seam)
- `.l1-chip`, `.panel`, `.l2-panel`, `.chip`, `.setting-up` — all `display:inline-flex`; `<Flex>` is `display:flex` → swapping would drift. Kept.
- `.chip .label` and the other mono labels — off-scale tracking (`0.12em`; only `.tracking-wide`=0.05/`.tracking-widest`=0.1 exist) → `<Text>` non-fit. Kept.
- `VerificationModal` `.overlay`/`.modal`, `AppToastRegion` `.toast-region` — `display:flex` but their identity is position/border/bg (the flex is incidental); class-preserving swap would leave the class carrying ~all the styling → churn. Kept local.
- `L1WalletPanel` — no clean swap (all inline-flex/off-scale/bespoke buttons). Its test is pure coverage (no swap to guard).

## Learnings
- **Edit gotcha:** several faucet templates use unicode apostrophes (`'` U+2019 in "faucet's"/"We're"/"bridge's"). A multi-line `old_string` copied through them silently fails to match. Anchor edits on apostrophe-free lines (the tag lines), and mind the indentation: `v-if`/`v-else-if` block `<div>`s sit at 2 tabs, their closings at 2, child `<Button>`/`</Button>` at 3.
- The wallet seam confirms the inventory's "low ceiling" empirically: 3 modest swaps out of ~8 candidate wrappers; the rest are inline-flex or position/border-dominant.

LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-2.md
