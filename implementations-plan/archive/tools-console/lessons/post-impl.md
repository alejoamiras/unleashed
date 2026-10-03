# Post-implementation — the codex fix loop

`code_review: off` — `/code-review` was not run. Codex xhigh (gpt-6-astra), fresh session over the net diff, plan.md, the ledger, the two rules, an explicit adversarial ask.

## Round 1 — session `01a07273-63f8-7c92-bc4e-bf91007c0ff6`

VERDICT: request changes. 0 HIGH · 5 MED · 6 LOW · 1 NIT. Every claim verified against the repo before acting; all twelve held.

| # | Finding | Action |
|---|---|---|
| 1 | MED — the CLAIM GAS dedup lived in the dock; unmount (open Activity, switch section) drops it and `claimFuelStandalone` has no record lock | **Fixed.** The join moved to the entry point: `fuel-recovery.ts` keeps a per-id in-flight promise; a second call from any surface returns it. The dock's set only drives the CLAIMING… label. Test: a second call joins the first, one send. |
| 2 | MED — the overlay's window keydown handler treats focus inside a wallet dialog as "outside": Tab redirected behind the modal, Escape closing both | **Fixed.** The handler yields when the active element sits inside an `[aria-modal="true"]` that is not the dock (the picker, chooser and verification modals all carry it). Test: a modal on top keeps Tab and Escape. |
| 3 | MED — persisted amounts have no bound before `BigInt`; the feed recomputes every tick | **Fixed.** `formatStoredAmount(raw, decimals)` in `lib/format.ts` (`/^\d{1,78}$/`, a uint256's width; otherwise `—`), used by the row strings, the card amount and the card's fuel line. Tests in `format.test.ts` and the card display suite. |
| 4 | MED — the recipient reaches the card's text and tooltip raw | **Fixed.** `safeAddressText` (the same strip, capped at 80) on `shortAddr` and the `title`; matching keeps the raw string. Test: a bidi-carrying recipient renders without it. |
| 5 | MED — header chips cannot fit phone widths | **Fixed.** Under 760px the header wraps, the wallet row takes its own line and wraps, padding drops to 12/16. |
| 6 | LOW — reduced-motion block declared before the stamp rules it cancels; dock rows pulse beside the stepper | **Fixed.** The media block is last in `BridgePhaseRail`; the dock's running dot is static ink. |
| 7 | LOW — `hide()` prunes the seen set against this tab's possibly stale record list | **Fixed.** `writeSeen` also keeps ids the stored journal holds at write time (`JOURNAL_KEY` read directly, shape-checked). Test: an id only in storage survives. |
| 8 | LOW — the strip badge shows beside an open overlay; its label says "Show" while it hides | **Fixed.** `DockStrip` takes `open`: no badge, `›`, "Hide activity". Tested in the overlay case. |
| 9 | LOW — the rail keeps `aria-orientation="vertical"` as a top row | **Fixed.** Bound to `useMediaQuery("(max-width: 760px)")`. Test with a stubbed `matchMedia`. |
| 10 | LOW — needs-you rows omit the age criterion 4 lists | **Fixed.** Every row carries `· age`; the mock's omission was a space concern the ellipsis handles. |
| 11 | LOW — dock tests cleared the DOM without unmounting | **Fixed.** `enableAutoUnmount(afterEach)`. |
| 12 | NIT — stale 48px comments on the chips, a plan reference in `AccountSwitcher`, narration on `SectionHeader`/`ActivityRow` | **Fixed.** Deleted or cut to one sentence. |

Gate after the round: lint 0 · typecheck 0 · unit 96 files / 1234 · smoke 3 files / 28 · frozen diff exit 0.

### Between rounds — the preview walk

Screenshots of the branch preview (build `0.1.0`) at 1280 / 1000 / 700px, with a seeded journal. Two defects only the pixels showed: `RailNav`'s root class `.rail` matched the shell's scoped `.rail` rule (a child's root inherits its parent's scope attribute) and drew a border and padding on the nav — renamed `.nav`; and the row's meta line lived inside the body button in column 2, so `· 26m ago` truncated at 300px — the row is a grid again with the meta spanning under the side slot, the amount as the keyboard's button and the whole row the mouse's, and a button in the side slot drops the age (the mock's rule; criterion 4's age holds on every row that has the room).

## Round 2 — resumed

VERDICT: request changes. 0 HIGH · 5 MED · 0 LOW · 1 NIT — every one a sibling site of a round-1 fix. All verified.

| # | Finding | Action |
|---|---|---|
| 1 | MED — the claim lane's automatic `launchStandaloneFuelClaim` sends outside the new join, so a manual CLAIM GAS while it runs sends twice | **Fixed.** One `joinStandalone(id, start)` around both paths. Test: an automatic start joined by a manual one sends once. |
| 2 | MED — `VerificationModal` does not take focus, so the activeElement guard misses it | **Fixed.** The handler stands down while any other `[aria-modal="true"]` is in the document, focused or not. Test: an unfocused modal keeps Escape. |
| 3 | MED — the recipient reaches the mismatch note and the gas-claim error raw | **Fixed.** `safeAddressText` in both messages; comparisons keep the raw string. Test on the fuel path. |
| 4 | MED — the stepper headline and the restore toast still parse amounts unbounded | **Fixed.** `formatStoredAmount` at both. |
| 5 | MED — the stepper headline renders the stored symbol raw | **Fixed.** `safeDisplay`. Test: a bidi symbol and a 120-digit amount in the headline. |
| 6 | NIT — `formatBigInt` lost its JSDoc to the inserted helper; the rail's media-query comment narrates | **Fixed.** |

Gate after the round: lint 0 · typecheck 0 · unit 96 files / 1237 · smoke 3 files / 28 · frozen diff exit 0.

## Round 3 — resumed

VERDICT: request changes. 0 HIGH · 3 MED · 1 LOW · 1 NIT. All verified; the three MEDs are the same persisted-text class at sites round 2 did not name, so this round also swept the whole app for the pattern (`formatBigInt(BigInt(`, `\${…recipient`, `assetSymbol(`/`displaySymbol` interpolations, `.blocked` reads) and fixed the two the sweep found on top.

| # | Finding | Action |
|---|---|---|
| 1 | MED — `guardBlocked` copies the raw `blocked` reason into `runtime.note`, which the phase rail renders | **Fixed.** `safeSentence` at the copy. |
| 2 | MED — the completion toast formats `lastCompleted.amount` unbounded | **Fixed.** `formatStoredAmount`. |
| 3 | MED — the permission phase interpolates the stored symbol raw ("Allow reading …") | **Fixed.** `safeDisplay` in `bridge-steps.ts`; the stepper headline test now also renders the prompt (`runtime: { step: "granting" }`). |
| — | Sweep: the receipt's amount (`toDecimalString(BigInt(…))`) and symbol, and the wizard's `ADD <symbol> TO WALLET` label | **Fixed.** `isStoredAmount` (exported from `format.ts`, the same width rule) gates the receipt's parse; `safeDisplay` on both symbols. |
| 4 | LOW — moving the meta out of the button left two same-amount rows announcing alike | **Fixed.** The amount button carries `aria-label="Open <amount> <symbol>, <route>, <visibility>, <age>"`. Tested. |
| 5 | NIT — a CSS comment narrating the grid; the click comment too long | **Fixed.** |

Gate after the round: lint 0 · typecheck 0 · unit 96 files / 1237 · smoke 3 files / 28 · frozen diff exit 0.

## Round 4 — resumed

VERDICT: request changes. 0 HIGH · 2 MED · 1 LOW · 0 NIT; no regression in the fixes. The plan's "still material after 3 rounds → surface to the owner" clause is noted: every finding since round 2 has been the one persisted-text class at a further site, each a one-line guard, so the loop continues one more round and the class is recorded for the owner below rather than each site.

| # | Finding | Action |
|---|---|---|
| 1 | MED — the receipt's Gas ready / Gas used parse `fuelReceived` / `fuelUsed` unbounded | **Fixed.** `isStoredAmount` gates both; an impossible string reads `—`. Test added. |
| 2 | MED — the two sealer mismatch notes interpolate `sealerL1` raw | **Fixed.** `safeAddressText` on both; comparisons keep the raw string. Test: a bidi-carrying sealer is named without it. |
| 3 | LOW — the remembered wallet name is capped but not stripped | **Fixed.** The alias filter runs before the cap. Test added. |

Gate after the round: lint 0 · typecheck 0 · unit 96 files / 1240 · smoke 3 files / 28 · frozen diff exit 0.

**For the owner — the class behind rounds 2–4.** Every string a journal record or restore file carries (`amount`, `fuel.received`, `fuel.used`, `recipient`, `sealerL1`, `blocked`, `token.displaySymbol`) is validated for shape at load but not for width or character class, and the app has many display sites that read them. This branch guards each site it touched or that a sweep found; the durable fix is to bound and strip at the loader (bridge-core's record validator) so no display site can be missed. That is a bridge-core change outside this plan's scope and is left as a follow-up.

## Round 5 — resumed — converged

Codex: "No remaining HIGH or MED findings verified in the net diff. The fixes address the reported scenarios without a material regression. Remaining validator hardening belongs to the documented bridge-core follow-up. Typecheck and 13 targeted suites (250 tests) passed. No e2e commands ran; no files changed. VERDICT: approve".

Five rounds, one session (`01a07273-63f8-7c92-bc4e-bf91007c0ff6`); 26 findings verified and fixed, 0 rejected; the PR opens now.


## The private-gas fence (owner's round-3 finding) — its own codex pass

Reviewed alone, at the owner's direction, fresh session `01a0747f-166e-7880-aca0-a1df70fb60cf`,
`high`, read-only, over that one commit's diff plus the surrounding code.

> No actionable findings … Private token claims cannot select public Fee Juice through the changed
> helper. Both production callers pass `privateBridge`; no `preferPrivate` call sites remain.
> Fueled private records resolve before `fjwc` or `userOverride`; consumed-fuel recovery stays on
> PrivateFPC credit, and standalone recovery rejects private records. Registration fees also retain
> the private payer. … VERDICT: approve

Informational, for a follow-up: private EXITS are wallet-paid (`useHubExit.ts:76` supplies no
fee), so a private exit can name a public payer — the same leak class in the other direction; not
in this PR's scope.
