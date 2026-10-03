# Phase 5 — Human visual sign-off gate

**Status:** ✅ DONE — user sign-off ("this worked perfectly") after the round-1 `gap--28` fix. Squash-merge to the base branch + dev-server close authorized once CI is all-green.

## Round 1 finding (the human gate did its job — machine-invisible regression)

User reviewing at `localhost:5176` reported: the bottom margin/gap between the **big areas** in the Bridge + Fuel tabs disappeared — specifically below the wallet-connect row, after the main form / "YOUR BRIDGES" / "YOUR FUELS", and around the "Get test AZLO" / "GET $AZTEC" mint cards.

**Root cause:** the Phase-4 loop-pass swapped the `BridgeView` `.bridge-view` and `FuelView` `.fuel-view` roots (both `gap: 28px`) to `<Flex direction="column" gap="28">`. **There is no `gap--28` utility** — the design package's gap scale is `{2,3,4,6,8,10,12,14,16,20,24,32,40,48,60}`. So `gap="28"` emitted a non-existent class and the 28px column gap between the view's direct children silently vanished. FaucetView (`gap: 32` → `gap--32`, valid) was unaffected — which is exactly why the user only flagged Bridge/Fuel.

**Why no machine check caught it:** typecheck/test/build/lint/e2e none validate that an emitted utility class actually exists in the CSS — a missing-class is invisible to them (the round-1-externalization lesson class). The human visual gate is the only thing that sees it. **This is the gate working as designed.**

**Fix:** reverted the two view roots to local `<div>` with `gap: 28px` restored (off-scale gap → keep local, rubric criterion 2). FaucetView root (`gap--32`) + all three `.hero` (`gap--16`) stay Flex. **Audited every remaining `gap=` value (4/8/10/12/14/16/32) → all valid utilities.** Gate green (tc 0 / test 403 / build / e2e 14 / lint 0).

**Process lesson:** rubric criterion 2 ("gap maps to an existing utility step") must be checked against the ACTUAL utility list for EVERY swap — I'd verified `gap--5` was absent earlier but failed to re-check `gap--28` when adding the view roots in the loop pass. Future swaps: grep `gap--N` in `packages/design/src/utilities.css` before using `gap="N"`.

LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-5.md
