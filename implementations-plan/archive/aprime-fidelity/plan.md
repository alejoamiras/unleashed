---
plan: aprime-fidelity
tier: mid
driver: claude-code
eli5_mode: artifact
code_review: off
claude_model: opus
budget: "recon 3 agents; codex high; /code-review off"
status: closed — merged
base: main
---

## Outcome

- **Status:** closed. All 28 phases are ✓ (1–27 plus 24b). Each of the six layer loops converged, and so did the final cross-arc Codex pass over the whole stack (3 rounds, the last with no findings).
- **Shipped:** the stack was squash-merged atomically into `main`, together with this close-out, on the owner's written authorization (in the session): "So: let's flip to review + babysit merging the stack. You are authorized to merge."
  - srgb static, pixel icons on the 12/24 grid, capital wordmark, tag tones, busy and destructive buttons.
  - the board token step, the truthful step rail, the wallet picker and the shared dialog shell.
  - activity status chips, lost-signal edges, "Arrived", the tap-only dock, bottom-left toasts.
  - the board receipt with its from and visibility rows, one amount display rule.
  - the board faucet cards, amount and review steps, and the form-step-only footer.
  - the in-flight phase bar, session log and locked direction, and the one-column phone layout.
- **Bugs fixed:** G02, G03, G14, G58, G67, G68, R5-1, the "TOKEN" toast, and the stuck exit after a direction switch. Also fixed, though they predate this plan: PROVE progress read near-full from its first reading, and wallet or RPC error text rendered unbounded in toasts, cards, the token step and the mint strip.
- **Flags:** each PR body lists its deviations from the boards for sign-off; the merge authorization accepts them as shipped. Those still worth changing are in [`follow-ups.md`](../../follow-ups.md). The first is the record surfaces' two-decimal rounding (0.005 reads "0.00"). Next come the toast overlaps at short heights, and G121's undismissable recovery toast.
- **Dropped and why:** arc 10 is deferred (G11's stored log, G39, G47, G77, G78, G122); G04 (Q1 A), G63, G117 and G104–G106 were dropped with the reasons in Scope.
- **Deploy:** Workers Builds deploys from `main`.
- **Seeds retired:** the `/goal` and `/loop` seeds in Seeds are spent. Never paste them again.

# aprime-fidelity — bring the app to the Dead Channel A′ boards

The previous plan (`archive/unleashed-reskin/`) repainted `apps/tools` in the A′ "Quiet broadcast" palette but kept the earlier anatomy. After the merge the owner said:

> "there are a lot of things missing from the claude design that you actually showed me … for example changing the logo, the icons on the navbar. Like, in general it doesn't seem like a good representation of what the "Dead Channel A'" mockups for the UX / UI look like. For example the token list / icons, wallet modal over static, etc."

A verified audit compared every board with the shipped app and produced 153 gaps (G01–G153), 18 workstreams and 35 open questions. This plan implements arcs 1–9 of that inventory under the owner's answers, in 28 phases (1–27 plus 24b) and a target of 6 stacked PRs (Delivery splits one that proves too large). The owner's four named complaints (wordmark, navbar icons, token list and icons, wallet modal over static) all land in the first two PRs.

**Inputs:**
- [`recon.md`](recon.md): the reuse map, test impact and stored-data surface (top), then the gap inventory, the "Already matching (do not touch)" list and the original phasing.
- [`decisions.md`](decisions.md): the owner's answers. They override every "Recommend" line in recon.md.
- Local reference only, never committed: `boards/DCQ*.png`, `board-src/DCQ*.dc.html`, `app/`, `work/`, `oq/`, and the tour spec `zz-fidelity.spec.ts`.

## Scope

**In (arcs 1–9):**
1. Foundation tokens and glyphs: static filter, light recess roles, focus ring, heading tracking, 12 new icons, the 12/24 icon grid, the capital-U wordmark, tag tones, busy and destructive buttons.
2. Token step and step rail: the mint-strip leak, transparent rows with an address on every row, brand/grey token marks, the truthful step rail.
3. Chrome and wallet modal: the magenta rail chip, header chips, one magenta Connect, a shared dialog shell (fixing the verification modal's focus), the picker rows.
4. Activity, dock and done vocabulary: one status reading, status chips, amber/red edges, "Arrived", gas-only amounts in FJ, the "this send" dock row, the tap-only tablet overlay over static, no dock at ≤760, toasts.
5. Receipt: one number rule across the send flow, the sender recorded at send time, the receipt layout.
6. Faucet: card anatomy, stacked balances, full-width drips, an honest proving panel, a one-row footer.
7. Amount and review: radiogroup choice cards with in-place reasons, gas panel, review rows, fee figure/note split, the form-step-only bridge footer.
8. In-flight: locked direction row, overall phase bar, board phase list, footer band, a session-only Log panel.
9. Mobile (≤760px): one column (the dock is already unmounted by arc 4), horizontal step strip, full-width chips, the phone amount step.

**Out:**
- **Arc 10, deferred:** G11's stored event log (OQ26 A's session-only Log panel is built, phase 24b; Ask A1), G39 proof print (OQ4 A), G47 sign-on-review (OQ22 A), G77 decode motion (OQ29 B), G78 tooltip primitive, G122 loading skeleton. recon.md's arc-10 line "remaining semantics swaps (OD30)" names G104–G106; OQ30 A keeps those controls as tablists, so this plan builds none of them.
- **G04 dropped (Q1 = A):** the theme control stays the single cycling button. `ThemeToggle.vue` changes only its icon size (G26).
- **Dropped with reason:** G63 (OQ28: explorer links stay on in-flight cards), G117 (OQ18 A: list balances stay 2dp), G104/G105/G106 (OQ30 A). The no-change closures (G54, G112, G116, G124 desktop, G127, G142, G144, G147, G153) are in the traceability table.
- **No protocol changes:** storage keys (`unleashed:tools-dock*`, `unleashed-bridge:*`), `APP_ID`, backup format and KDF labels stay byte-identical. No schema bump.
- **No signing-flow change** (OQ22 A) and no total remaining-time prediction anywhere (OQ26); the short per-phase estimates on pending in-flight rows restate etas the code already shows (phase 22).
- **"Already matching (do not touch)"** in recon.md is binding: a phase that finds itself editing one of those values stops and records why in its lessons file before continuing.

## Owner decisions

Owner, verbatim, on the decision page: **"basically, my only pick different from your recs was on Q1, I said "A""**.

| Q | Choice | Effect in this plan |
|---|---|---|
| Q1 · theme control (OQ1) | **A** | Cycling button kept; G04 dropped. |
| Q2 · token icons (OQ16, OQ17) | **A** | Flat brand tiles only for tokens the repository commits; plain grey for everything else; every row shows its address (arc 2, phase 5). |
| Q3 · phone/tablet Activity (OQ12, OQ35) | **A** | No dock or strip at ≤760 (arc 4, phase 11; the one-column grid is arc 9, phase 25); 761–1100 opens only on tap over the static scrim, never by itself (arc 4, phase 11). |
| Q4 · receipt rows (OQ5) | **B** | Visibility and From rows; From is the sender recorded at send time, never the connected account; older records show no From row (arc 5, phases 14–15). |
| Q5 · footer (OQ24) | **B** | One-line footer on Token/Amount/Review only; testnet drops the tagline; mainnet keeps "Real funds — keep it small" as line 2; none on in-flight, receipt or Activity (arc 7, phase 21). |
| Q6 · failures (OQ34) | **B** | Red "Lost signal" chip and red edge on failed cards; amber edge + "Needs you" on claimable ones; dead ends show their note with no button (arc 4, phase 10). |

The 28 delegated calls (OQ2–OQ33 minus the six above) are applied exactly as [`decisions.md`](decisions.md) lists them; each phase cites the one it applies.

**These answers approve direction, not pixels.** Per `AGENTS.md`, every PR still needs the owner's written sign-off on its screenshots, quoted in the PR. A passing test or a reviewer's approval is not a sign-off.

## Outcome & Quality Bar

**For whom:** a person bridging tokens between Ethereum and Aztec (or dripping test tokens) on a laptop or a phone, in either theme, often mid-transaction; and the owner, who compares the running app with the boards they approved.

**What excellent looks like:**
1. **Board parity, except by decision.** Side by side with each board at 1440 and 390 (1100 where the board has a tablet frame), every surface matches the board's anatomy, icons, type and colour. Each remaining difference is named in this plan (a decision, a delegated call, or a flagged deviation) and shown in the PR.
2. **The pixel grid holds.** No icon renders at a size the 24-unit grid disallows (vue-tsc proves only 12 and 24 remain); static appears only on the veil and scrims; the Sixtyfour face only on the wordmark and the arrival hero.
3. **No stored-data regression.** Every existing record and backup file still loads in the new bundle; a record written by the new bundle still loads in the old one; a non-string `sender` quarantines its record, and a string that fails the address-format check is simply not rendered.
4. **Behaviour is kept.** Every state reachable in the e2e suite keeps passing; every changed assertion is named in the commit that changes it. No `data-testid` is removed; new ones are registered in `lib/testids.ts` and `testid-coverage.test.ts`. Colour never carries status alone.

**Good enough stops at:**
- Pixel-exact spacing is not required where a board contradicts itself; the screen board beats the Components/Dial specimens (OQ32).
- Motion is reviewed as code (screenshots show end frames).
- Copy that is new (fee notes, short phone hints, Details hint, visibility wording, session-log phrases) is signed off at the screenshot review, not up front.

## Assumptions

### Facts (verified)
1. **Mainnet renders only the placeholder** (`apps/tools/src/App.vue:16`), and `apps/tools/public/mainnet-bridge.json` has `bridge: null`. Every visible change here renders on testnet and local builds; the mainnet "Real funds" footer line is dormant code, tested by unit only.
2. **Manifest tokens** live at `.bridge.tokens` (testnet: USDC, USDT, EURC, GBPC, all `permissionless-mint`); the manifest is strictly parsed at boot (`contracts/bridge-generation.ts:26`), catalog rows carry `source: "manifest" | "list" | "pasted"` (`lib/send-model.ts:14`, `useTokenCatalog.ts:62`), and a manifest row wins an address collision (`useTokenCatalog.ts:105-121`). The reuse and data recons read only top-level keys and wrongly reported "no tokens".
3. **The sprite sheet holds only five chain-1 keys** (`assets/token-sprite.svg:8-28`), keyed by exact `chainId:address` (`send-model.ts:33`), so no testnet or local token ever matched; recon's "sprite needs zero change" is wrong.
4. **G14's cause:** `StepStrip.vue:31-38` maps every reachable inactive step to done, and `SendWizard.vue:423` sets `completed = 2` as soon as the amount is valid.
5. **Icons:** every `<Icon>` sets its size (11 at 12, 38 at 16, 5 at 24); `Spinner` is used only by `Button.vue:2`; `Button`'s `.loading` sets `pointer-events: none` (`Button.vue:133-135`; destructive rules `:108-115`), which stops the mouse only: a focused loading button still activates from the keyboard. The guards that hold are the call sites' `disabled` bindings and operation guards (`ReviewStep.vue:86,164`); `AztecWalletPanel.vue:114` sets `loading` with a live `@click` and no `disabled`.
6. **No sender is stored today** (`useSend.ts:164-194`, `useHubExit.ts:392-409`). `sealerL1` is private-only and written at seal time (`deposit-flow.ts:964`). `buildSendRecord` runs at `useSend.ts:711` and again at the rekey (`:810`); the L1 legs are sent with `account: actors.from` (`useSend.ts:948`).
7. **Stored records pass the backup validators on every load** (`journal.ts:278-313`; `assertDepositFacts` `backup.ts:106`, `assertWithdrawFacts` `:159`). They type-check each listed optional and ignore unknown keys, so an additive optional field loads in an old bundle; an unlisted field is never checked.
8. **Failure sets:** `FAILED_ATTENTIONS` is the whole `Attention` union (`bridge-steps.ts:53-63`); `TERMINAL_ATTENTIONS` is stale-deployment, receipt-mismatch, malformed-record (`:47`). recon's dead-end list (stale, tampered…) does not match the code. `blockTokenRecords` (`useBridgeJournal.ts:559-566`) sets the persisted `blocked` on every matching send record, completed ones included, yet `classify` (`lib/activity.ts:38-42`) files a completed record under done and a busy one under running before it looks at `blocked`.
9. **The dock:** `visibleRecords` omits the foreground send (`useBridgeJournal.ts:2012-2014`, pinned by `tests/e2e/shell-smoke.test.ts:170-182`); the persisted "open" restores at any width (`useDockState.ts:75`); auto-open ignores width (`ActivityDock.vue:105`) and skips needs-you rows with no dock action (`useActivityFeed.ts:76`); the dock is not mounted on Activity (`AppShell.vue:104`); its Tab trap's set is `button:not([disabled]), a[href], [tabindex="0"]` (`ActivityDock.vue:71`).
10. **Dialogs:** the verification modal's `role=dialog` sits on the scrim and nothing focuses it (`VerificationModal.vue:19-28`); the picker restores focus to the page behind (`WalletPickerModal.vue:102-104`). Tab traps are hand-copied (`WalletPickerModal.vue:66-91`, `ChooseAccountModal.vue:89-113`, `ActivityDock.vue:73-93`).
11. **The picker renders a wallet's claimed `type` raw and unbounded** (`WalletPickerModal.vue:150,155`).
12. **CSP** is `img-src 'self' data:` and `font-src 'self'` (`vite.config.ts:103-104`); `.woff2` is never inlined (`:179-181`), and the Sixtyfour subset is 3,956 B.
13. **R5-1 (new bug):** a gas-only record stores the paid input-token amount (`useSend.ts:142,173`), and every surface formats `rec.amount` at 18 decimals as FJ (`asset-label.ts:29-31`): the receipt hero (`SendWizard.vue:956-978`), the card (`BridgeJournalCard.vue:247`), dock rows (`lib/activity.ts:85-92`) and the completion toast (`useCompletionToasts.ts:12-17`). The toast also names every token send "TOKEN" at 18 decimals, because `lastCompleted` carries no token block (`useBridgeJournal.ts:755-765`; pinned as a "generic fallback" in `useCompletionToasts.test.ts:59`). `fuelUsed` is never set, so the "Gas used" row is dead code.
14. **Test layers:** `test:e2e` (the Node/jsdom smoke) is in no root script but CI runs it (`.github/workflows/_build-tools.yml:44`). e2e selectors rely on `pages/connect.ts:29-31,118` (connect testid inside the row), `pages/send.ts:66` (`aria-selected` on choice cards) and `pages/send.ts:136-142` (`data-phase`/`data-state`).
15. **Sixtyfour on the boards** draws only "Unleashed" and digits; the COLRv1 palette fixes its colour (lessons.md). fonttools is not installed on this host.
16. **Timing sources:** `useNow()` is one shared 1s heartbeat (`lib/clock.ts:8-19`); `useDrip` exposes no proof progress (`useDrip.ts:108-111`); the permit record's `createdAt` is the prompt time (`SendWizard.vue:897-904`).
17. **Failure notes and the rail:** the card suppresses its own note whenever runtime attention exists (`BridgeJournalCard.vue:228`), because the compact rail's failed phase prints `rt.note` (`BridgePhaseRail.vue:43-48`, `bridge-steps.ts:296`). In `stageLabel` the claimed-by-other branch returns "Press Claim…" before any ownership check (`BridgeJournalCard.vue:199-201`). The receipt drops its elapsed time when `completedAt ≤ startedAt` (`BridgeReceipt.vue:94-97`).
18. **Session narration:** every flow narrates through `setStep` (`useBridgeJournal.ts:767`, reached via `setRecordStep`), and every journal write, tx-hash patches included, ends in `reload()` (`:302`).
19. **Exit visibility:** a withdraw record's `isPrivate` is the balance the burn spent (`useHubExit.ts:398,440`); the L2→L1 message and the Ethereum release are public either way.
20. **Tooling and fixtures:** `audit:tools` builds only the default target (`package.json:26` → `vite build`, which is testnet); BG builds both. The `github/gh-stack` extension v0.1.1 is installed.

### Inferences (unverified; each has a check)
- I1. Playwright's `toBeDisabled` honours `aria-disabled="true"` on a `role=radio` button (phase 19's browser run proves it).
- I3. `overallProgress` is non-decreasing when phases are inserted mid-run (phase 23's table test). If smoothing is needed, its high-water mark is scoped to the current attempt: it resets when a retry returns to an earlier phase (`phase-clock.ts:33` already resets phase timing then) or a supporting tx fact disappears, so a retried send never keeps a near-full bar. The fact-derived fraction is preferred over any clamp.
- I4. The harness can hold the dripping, busy-drip and background states long enough to capture (fallbacks named in each tour).
- I6. The collision strip cannot be produced by the test wallet profiles; its sign-off rests on the OQ20 mockup plus the unit test.

I2 (dialog focus beats the picker's restore) is now a tested `useFocusTrap` requirement (phase 8); I5 is gone (Fact 12).

### Asks — resolved by the lead under the owner's delegation; A1 and A4 flipped in audit round 1

The owner delegated the remaining calls ("decide with Codex back-and-forth until you are on agreement and move forward"; see Approval). Each resolution is the conservative reading of a written owner decision, and each is re-tested by the audit.
- **A1 · OQ26's session Log panel. Resolved: build the session-only log** (phase 24b). decisions.md OQ26 A explicitly includes "a Log panel built from this session's events and tx hashes"; its Scope defers only the stored event log (G11), which stays in arc 10. The log is runtime-only: nothing persisted, no new stored data.
- **A2 · What "our list" means for brand tiles (Q2 A).** **Default:** repository-committed identity only: the exact `chainId:address` table plus rows whose `source` is the bundled generation manifest. So testnet's test USDC/USDT render in brand colours (as the testnet BridgeToken frame draws them), and so do the local sandbox manifest's USDC/USDT fixtures (chain 31337, phase 5's test); EURC, GBPC and any unknown, list or pasted sandbox token stay grey. The stricter reading (exact mainnet addresses only, so every testnet tile is grey) is one table edit; the testnet branding is flagged at sign-off. A mainnet-only gate was considered and rejected (D27).
- **A3 · Desktop dock above 1100px.** Q3 covered phones and tablets. **Default:** above 1100 the dock keeps today's once-per-record auto-open for a new counted record (needs-you or lost, own account). The alternative (never auto-open anywhere) is a one-line change in phase 11.
- **A4 · Where the phone gas breakdown opens (OQ14 B). Resolved: faithfully, from the row hint.** At ≤760 the selected gas row's hint is a `<button>` that is a DOM sibling of that row's radio (never inside it), laid into the visual row by CSS grid, with `aria-expanded`/`aria-controls` pointing at the breakdown; forced open on an error or cap note (phase 27, D22).

## Architecture & Implementation

### Proposed architecture

**Where things live.** `packages/design` gains a primitive only when it carries no domain copy and at least one arc 1–9 screen consumes it (the guardrail from the competing outline). Domain mapping stays in `apps/tools`.

| Layer | Adds or changes |
|---|---|
| `packages/design` tokens (`base.css`) | static filter in sRGB; `--ul-field`, `--ul-track` (light recess roles; light `--ul-well` → sheet); `--ul-perforation`; `--ul-ring`; `--ul-tracking-heading`; `--ul-ink-caption`; `--ul-notch-4-bottom` |
| `packages/design` core | 12 vendored Pixelarticons; `Icon.size` typed `12 \| 24`; Sixtyfour re-subset with U+0055 |
| `packages/design` ui/composite | `Tag` tone table + `size="small"` + `icon` override; `BusyPixels` (replaces `Spinner`); destructive `Button`, and a `Button` that emits no `click` while `loading`; `Dialog` + `useFocusTrap`; `Toast` anatomy + countdown; `ProgressBar` (determinate and indeterminate); `BalanceRow` stacked; `DripButton` icon; `Card` as `<article>` |
| `packages/bridge-core` | optional `sender` on deposit and withdraw records, shape-checked in both assert functions |
| `apps/tools` lib | `classify` grown into the one record reading + `runningWord` (`lib/activity.ts`); `displayAmountOf` (`lib/asset-label.ts`); `formatDisplayAmount` (`lib/format.ts`); `formatClock`/`formatStamp` (`lib/phase-clock.ts`); `overallProgress` + phase `estimate` + the session-log phrase table (`lib/bridge-steps.ts`); `walletTypeLabel`/`walletIdLine` (`lib/wallet-name.ts`); runtime-only `log` on `RecordRuntime` (`composables/useBridgeJournal.ts`); `hintOf` (`lib/send-model.ts`); `PHONE_QUERY` (`composables/useMediaQuery.ts`); `bridgeForm` (`composables/useShell.ts`) |
| `apps/tools` components | `token-mark.ts` + `TokenMark.vue` (sprite pipeline deleted); `RecordChips.vue`; `EmptyChannel.vue`; `DirectionSegment.vue` (extracted from `WizardShell`) |

**Reuse, per the reuse map** (recon.md): the icon registry, `.ul-veil`/`.ul-scrim`, `Button`, `StepStrip`, `useMediaQuery`, `useDockState`, `record-policy`'s single `RecordState`, and `BridgePhaseRail`'s progress markup are reused as they are. Three pieces of duplication are removed rather than repainted: four ad-hoc chips become one `Tag` tone table read through `RecordChips`; three Tab traps become one `useFocusTrap` (the dock keeps only its "yield to another `aria-modal`" rule as an option); the direction switch exists once in `DirectionSegment`.

### Key interfaces

```ts
// packages/design/src/core/Icon.vue
type IconSize = 12 | 24 | "12" | "24"          // default 12; vue-tsc rejects 16
// packages/design/src/ui/Tag.vue
type Tone = "neutral" | "ink" | "testnet" | "warn" | "lost" | "carrier" | "private" | "other"
// props: { tone?: Tone; icon?: IconName | null; size?: "default" | "small" }
// packages/design/src/ui/Button.vue — declares "click" and re-emits it only when !loading && !disabled
// (a native button turns Enter/Space into click, so this also stops keyboard activation); aria-busy while loading
// packages/design/src/ui/Dialog.vue — emits "cancel" on backdrop, Escape and ×; never "confirm"
// props: { open: boolean; title: string; describedby?: string; overlayTestid?: string; closeTestid?: string }
export function useFocusTrap(panel: Ref<HTMLElement | null>, opts: {
  enabled: Ref<boolean>        // true adds the document keydown; false and scope disposal remove it
  onEscape: () => void
  shouldYield?: () => boolean  // another [aria-modal=true] owns the keyboard (the dock)
}): void
// Tab cycles candidates "button, a[href], input, select, textarea, [tabindex]" filtered by ONE predicate:
// enabled, effective tabIndex >= 0, isConnected, no `hidden`/`inert`/`display:none` ancestor, visibility visible
// minus hidden elements ([hidden]/[inert] ancestors, computed display:none or visibility:hidden);
// initial focus is queued on nextTick and skipped when enabled went false or the panel left the DOM meanwhile
// packages/design/src/ui/ProgressBar.vue — value absent ⇒ indeterminate (no aria-valuenow)
// props: { label: string; value?: number /* 0..1 */; height?: number; tone?: "signal" | "lost" | "carrier" }

// packages/bridge-core/src/journal.ts — display-only; never read by claim, exit or recovery
interface DepositJournalRecord { /* … */ sender?: string }   // L1 account that signs the deposit
interface WithdrawJournalRecord { /* … */ sender?: string }  // Aztec account that sends the exit

// apps/tools/src/components/send/token-mark.ts
export interface Brand { readonly fill: string; readonly ink: string; readonly letters: string }
export type MarkSubject = Pick<SelectableToken, "logoKey" | "symbol" | "source">   // logoKey = "chainId:address"
export function markOf(t: MarkSubject):
  { brand: Brand | null; letters: string }   // brand only from BY_KEY[logoKey] or a source === "manifest" row

// apps/tools/src/lib/activity.ts — the ONE reading of a record; card, dock row, counts and page order all consume it
export type RecordStatus = "lost" | "running" | "done" | "needs-you"             // chip word and edge colour
export type ActivityGroup = "needs-you" | "running" | "done" | "other-account"
export interface Classified {
  status: RecordStatus   // lost (rec.blocked || any runtime attention) > running (busy, not completed) > done > needs-you
  group: ActivityGroup   // lost → needs-you on any account; needs-you + ownedByOther → other-account; else = status
  rank: number           // page order: lost 0, needs-you 1, running 2, done 3, other-account 4; newest first within
  counts: boolean        // rail chip, dock badge, auto-open: (lost || needs-you) && !ownedByOther
  action: ActivityAction // today's RecordState gates, plus: token-claim overrides (showClaimWithoutFuel) require `actionable`
}
export function classify(rec: BridgeJournalRecord, s: RecordState): Classified
// ownership (RecordState.ownedByOther) is its own axis: it moves group and counts, never status

// apps/tools/src/lib/asset-label.ts — the amount every record surface shows (card, dock row, "this send", toast, receipt)
export function displayAmountOf(rec: BridgeJournalRecord): { raw: string; decimals: number; atLeast: boolean; symbol: string; gross: boolean }
export function amountQualifier(d: DisplayAmount): string | null   // "before claim fees" when gross, else null
// gas-only send: fuel.received, else fuel.minOutput with atLeast (shown "≥ "), 18 decimals, "FJ"/"Private FJ", gross;
// GROSS Fee Juice bridged, before claim fees (public: received − fee; private: the PrivateFPC keeps its ceiling) —
// every surface shows amountQualifier with it, never calls it spendable gas left;
// no fuel block ⇒ raw "" (renders "—"); any other record: rec.amount at assetDecimals; symbol through safeDisplay

// apps/tools/src/lib/format.ts — grouped, fraction padded to min(2, decimals), never truncated or rounded
export function formatDisplayAmount(value: bigint, decimals: number): string
// apps/tools/src/lib/phase-clock.ts
export function formatClock(ms: number): string            // "0:04", "2:40", "1:02:05"
export function formatStamp(ms: number, now: number): string // "today 14:22", "yesterday 09:10", "29 Sep 14:22"
// apps/tools/src/lib/bridge-steps.ts
export function overallProgress(phases: readonly BridgePhase[]):
  { fraction: number; index: number; total: number; state: "running" | "failed" | "done" } // 1 only when every phase is done
// apps/tools/src/lib/wallet-name.ts — the chip never prints the claimed type
export function walletTypeLabel(type: unknown): { label: "Extension" | "Web app" | "Unknown type"; title?: string }
// title = "Self-reported: " + sanitizeWalletName(type, 16), only for an unknown type

// apps/tools/src/composables/useBridgeJournal.ts — runtime only, never persisted
interface RecordRuntime { /* … */ log?: readonly { at: number; text: string }[] } // ≤ 50 entries; text from fixed phrases
```

### Data and control flow

**Sender (the one stored-data change).**
1. At record build: deposit `sender = actors.from` in `buildSendRecord` at both call sites (`useSend.ts:711`, `:810`); exit `sender = from` passed into `exitRecord(id, plan, sender)` from `performExit` (`useHubExit.ts:530`). The rekey's `renamed` spreads a fresh `named = buildSendRecord({...})` built from explicit fields, not the provisional row, so omitting `sender` at `:810` would silently drop it from every re-keyed (public) deposit.
2. Persist: the record goes to localStorage under the unchanged `unleashed-bridge:journal:v1` key and, on backup, inside the AES-GCM blob (never the plaintext header).
3. Load: `partitionStored` → `validateAnyBackupRecord` → `assertDepositFacts`/`assertWithdrawFacts` now include `isOptionalString(sender)`; a non-string quarantines the record, exactly as any other bad optional field does.
4. Render: `SendWizard.snapshotOf` copies `sender` into `ReceiptSnapshot`; `BridgeReceipt` renders From only when the value is address-shaped for its direction (`/^0x[0-9a-f]{40}$/i` deposit, `{64}` exit), through `checksumAddress`/`safeAddressText` + `trimAddress`, full value in `title`. Absent or malformed ⇒ no row.
5. Compatibility: no schema bump (the additive precedent is `journal.ts:41-46`). An old bundle ignores the key; a new bundle reading an old record shows no From row.

**Status derivation (one reading, four outputs).** `recordState` (`record-policy.ts`, unchanged) → `classify(rec, s)` → `Classified`, read by every surface so none can drift:
- **Visual status** (card chip + `data-status` edge, dock row word and dot): lost > running > done > needs-you. A persisted `blocked` or any runtime attention is lost even on a completed or busy record (Fact 8); running means busy and not completed, so the pinned "completed + stale busy → done" row holds.
- **Grouping and order** (dock groups, `rank` for the Activity page): lost records lead on every account; a needs-you record owned by another account moves to the trailing "Other account" group. A lost other-account record stays with lost: under the done records it would be quieter than a claim, which Q6 B rules out.
- **Count eligibility** (`counts`: rail chip, dock badge, auto-open): lost and needs-you records of the active account. Lost records count and auto-open (a failure is owed a decision); other-account records never do (OQ28). The dock's "Needs you · N" heading counts its rows, so it can exceed the badge only by lost other-account rows.
- **Actions**: today's `RecordState` gates, with one tightening: `showClaimWithoutFuel` (`record-policy.ts:159`) now also requires `actionable`, so a blocked or terminal record offers no token-claim path. **Standalone fuel recovery is a deliberate exception:** `fuelRecoverable` (`:158`) and `fuel-recovery.ts:101` stay independent of `blocked`, because the Fee Juice is the user's and its claim runs through the protocol's Fee Juice portal, not the token bridge a block distrusts; recovery was built to outlive bridge generations. A blocked card offering it says what it recovers ("Recover your gas") and never that the tokens arrived. **Every completion claim is qualified when blocked:** the main arrival line (G25), the `claimedByOther` line (`BridgeJournalCard.vue:131`, "your tokens arrived") and the private-fuel-unknown note (`:349`, "Your tokens arrived") read "previously recorded as arrived" on a lost record.

Ownership never changes the status. An other-account card hides its compact rail (G64), so it prints the sanitised failure note itself (Fact 17). `data-attention` stays on the card for the e2e specs but drives no CSS.

**Record amounts (R5-1).** `displayAmountOf(rec)` is the only way a surface reads a record's amount and symbol: the card (phase 10), the completion toast (phase 10; `lastCompleted` carries it, written at `useBridgeJournal.ts:831,854`, which also fixes the toast's "TOKEN at 18 decimals"), the in-flight stepper headline (`BridgeStepper.vue:71`, phase 10; phase 23 restyles it), the restore-success toast (`BridgeJournal.vue:54`, phase 10, which also stops restored token records toasting "TOKEN" at 18 decimals), dock rows and the "this send" row through `rowStrings` (phase 11), and the receipt snapshot (phase 14). Each surface keeps its own formatter.

**Session log (phase 24b).** `setStep` appends the step's fixed phrase to the record's runtime `log`; the `reload()` funnel appends one row when a record that already has a log gains a tx hash (`depositTxHash`, `approveTxHash`, `registerTxHash`, `claimTxHash`, `exitTxHash`, `consumeTxHash`), naming the leg and the trimmed hash. `reload()` also sees other tabs' writes and hashes are unauthenticated optional strings (`backup.ts:113`), so a storage-derived row is worded neutrally ("Deposit hash observed · 0x12ab…cdef") and only a hash that passes the 32-byte hex format check is logged; claims of submission or confirmation come only from `setStep` phrases the running flow emits. The boot `reload()` and restored files log nothing; a page reload starts every log empty. Notes, `stepDetail`, error text and secrets never enter it. `BridgeStepper` renders the last 8 rows beside a 330px phase list (stacked at ≤760).

**Footer (Q5 B).** `SendWizard` computes one `view` (`permit | stepper | receipt | form`) that drives both its template and `useShell().bridgeForm`; `AppShell` mounts `BridgeFooter` only when `section === 'send' && bridgeForm`. The faucet mounts its own `Footer` inside `DripView`.

**Narrow dock (Q3 A).** ≤760: `ActivityDock` is not mounted (phase 11); the rail chip is the signal. 761–1100: an in-memory `overlayOpen`, set only by a tap, over `.ul-scrim`; the persisted "open" and auto-open are ignored at that width. >1100: unchanged (Ask A3).

### File-level change map

- **packages/design:** `src/base.css`, `src/base-css.test.ts`, `src/theme-contrast.ts` (+test), `scripts/vendor-icons.ts` → regenerated `src/core/icons.ts`, `src/core/Icon.vue` (+test), `src/mount-all.test.ts`, `src/fonts/SixtyfourConvergence-subset.woff2` + `src/fonts/SOURCES.md`, `src/ui/{Tag,Button,Toast,Card}.vue` (+tests), new `src/ui/{BusyPixels,Dialog,ProgressBar}.vue` + `src/ui/useFocusTrap.ts` (+tests), deleted `src/ui/Spinner.vue` (+test), `src/composite/{DisclaimerTag,BalanceRow,DripButton}.vue` (+tests), `src/index.ts`, `README.md`.
- **packages/bridge-core:** `src/journal.ts`, `src/backup.ts`, `src/backup.pins.test.ts`, `src/backup.test.ts`, `src/journal.test.ts`.
- **apps/tools shell and chrome:** `index.html` (title), `src/AppShell.vue`, `RailNav.vue`, `SectionHeader.vue`, `L1WalletPanel.vue`, `AccountSwitcher.vue`, `AztecWalletPanel.vue`, `ConnectionErrorStrip.vue`, `WalletPickerModal.vue`, `VerificationModal.vue`, `ChooseAccountModal.vue`, `Footer.vue`, `BridgeFooter.vue` (+ new test), `AppToastRegion.vue`.
- **apps/tools send flow:** `send/{SendWizard,WizardShell,StepStrip,TokenStep,TokenList,TokenTile,MintStrip,AmountStep,ChoiceCards,GasBreakdown,ReviewStep,ReviewDetails}.vue`, new `send/{TokenMark,DirectionSegment}.vue` + `send/token-mark.ts`, deleted `send/{token-sprite.ts,token-sprite.test.ts,SpriteSheet.vue}` and `assets/token-sprite.svg`.
- **apps/tools progress, activity, receipt, faucet:** `BridgeStepper.vue`, `BridgePhaseRail.vue`, `BridgeReceipt.vue`, `BridgeJournal.vue`, `BridgeJournalCard.vue`, `ActivityDock.vue`, `ActivityRow.vue`, `DockStrip.vue`, new `RecordChips.vue`, `EmptyChannel.vue`, `TokenCard.vue`, `views/DripView.vue`, `views/ActivityView.vue`.
- **apps/tools logic:** `lib/{activity,asset-label,bridge-steps,format,phase-clock,send-model,wallet-name,testids}.ts`, `composables/{useSend,useHubExit,useBridgeJournal,useActivityFeed,useDockState,useToast,useCompletionToasts,useBridgeBackup,useDrip,useShell,useMediaQuery}.ts`, co-located tests.
- **apps/tools tests:** `tests/e2e/shell-smoke.test.ts` (test 7), `tests/e2e/send-smoke.test.ts`; `tests/browser/pages/{send,connect}.ts`; specs `tokens-hostile`, `accounts`, `fee-states`, `spike`, `deposit-token-gas`, `exits` (assertions named per phase).
- **implementations-plan/aprime-fidelity/:** `plan.md`, `recon.md`, `lessons/phase-N.md`.

### Non-obvious mechanics

- **Static in sRGB.** The boards' `feTurbulence` filter declares `color-interpolation-filters='sRGB'`; without it the browser interpolates in linearRGB and the static reads as pale haze. The data URI must stay percent-encoded and free of `;`, because `theme-contrast.ts` splits custom-property values on it.
- **Pixel grid.** The boards draw icons at 12 and 24 only (odd path coordinates still land on half pixels at 12px, DPR 1; `crispEdges` does not fix that). Typing `size` as `12 | 24` lets vue-tsc prove the 38 sites at 16 are gone.
- **Font subset.** `pyftsubset` re-run from the blob-verified upstream TTF, adding only U+0055 (`--layout-features='*' --flavor=woff2`); COLR, CPAL and the four `fvar` axes must survive. fonttools 4.66.0 + brotli 1.1.0 installed with `pip install --require-hashes` in a scratch venv, never in CI; the wheel hashes and the output hash are pinned in `SOURCES.md`, the output re-checked by `fonts.test.ts`.
- **Scoped-style leak (G03).** Slot content carries the parent's scope id, so `SendWizard`'s scoped `.strip` styled `MintStrip`'s root. Renaming the wizard's classes is the fix; no `:deep` needed.
- **Notch hosts.** Every host declares both `--ul-fill` and `--ul-notch`, and a notch host cannot scroll its content (lessons.md). The in-flight footer band is its own host with a bottom-corners-only polygon (`--ul-notch-4-bottom`), or it would square the card's corners.
- **Reduced motion.** Component `animation` beats a zero-specificity global rule, so each new animation's reduced-motion override uses `!important` (lessons.md).
- **`aria-disabled` over `disabled`.** A disabled-but-selected choice card must stay the radiogroup's tab stop; native `disabled` removes it. `choose()` already refuses a disabled card, and `canContinue` is a second barrier.
- **jsdom is desktop.** `useMediaQuery` returns false without `matchMedia` (`useMediaQuery.ts:6`), so existing unit tests stay on the desktop path; phone cases stub `matchMedia` explicitly.
- **Dialog focus lifecycle (a tested requirement).** Picker-close and verify-open land in one flush; the shell focuses on `nextTick`, after the picker's synchronous restore, and only if `enabled` is still true and the panel is still connected, so a dialog closed or unmounted in that tick never steals focus. `enabled` is reactive: the dock's trap follows its overlay across a desktop↔tablet resize, and `shouldYield` hands Escape and Tab to another open `aria-modal`.
- **Busy is not a guard in CSS.** `pointer-events: none` stops the mouse only; a focused button still activates from the keyboard. The guards are `Button`'s own refusal to emit `click` while `loading` and the call sites' `disabled` bindings and operation guards (`ReviewStep.vue:86,164`).
- **Receipt fit.** The hero's `--n` fit variable now counts grouping commas.

### Trade-offs and alternatives not taken

| Alternative | Why not |
|---|---|
| Primitives-first with a gallery and a screenshot-diff CI gate (the competing outline) | See the next section. Its dedup ideas are grafted; the gate and the up-front library PR are not. |
| Reuse `sealerL1` as the sender | Private-only and written after the record exists; public deposits and exits would have no sender. |
| Read the sender from the connected account at render | Q4 B forbids it: after an account switch it names the wrong account. |
| Format-check `sender` in `backup.ts` | A strict EVM/Aztec format check would quarantine a live funds record over a cosmetic field; shape-check on load, format-check at render. |
| Separate `senderL1`/`senderL2` fields | One `sender` per direction-typed record is enough; the direction fixes its format. |
| Keep the sprite sheet and add testnet symbols | The sheet is an SVG adoption path with its own allowlist for five colours; a TypeScript table is smaller and cannot parse markup. |
| Hashed-hue grey fallback (Q2 option C) | The owner chose A; the address on every row is the look-alike defence. |
| `Teleport` the footer into `.foot` from the wizard | Depends on target mount order and complicates unit mounting; one flag from one computed cannot drift. |
| A fourth amount formatter avoided by reusing `formatStoredAmount` | It truncates; OQ3 A forbids cutting digits. `formatDisplayAmount` replaces `toDecimalString` on display sites, so the count of display formatters stays three. |
| Board's `cursor: progress` on busy buttons | A cursor needs pointer events, and `pointer-events: none` stays as the mouse-side belt (no press feedback on a busy button). It is not the double-sign guard: `Button`'s loading refusal and the call sites' `disabled`/operation guards are. The cursor is a recorded deviation. |
| A "Gas breakdown" disclosure under the rows (the draft's A4 default) | OQ14 B says the breakdown opens from the row hint. A hint button that is a DOM sibling of the radio, laid into the row by CSS grid, keeps the radio valid ARIA, so the faithful form costs one row wrapper. A button *inside* `role=radio` stays out (invalid ARIA). |
| Unknown wallet types passed through (OQ19 A literal), sanitised and capped (the draft) | The type is attacker-chosen: even sanitised, "Verified wallet" would print in the chip. Unknown types read "Unknown type" with the claim only in `title` (flagged deviation, D25). |
| A lost other-account record in the trailing "Other account" group | Below the done records a failure is quieter than a claim (Q6 B). It sorts with lost records and stays out of the count (OQ28), D26. |
| A persisted event log (G11) now | New stored data; OQ26 A asks only for this session's log, which is runtime state (phase 24b). |

## Competing outline (to be audited)

**Outline B: primitives first, driven by the boards.** Its diagnosis: the reskin repainted anatomy screen by screen, so chips, edges, busy states and focus traps each exist several times; fixing screens one at a time risks recreating that. It proposes 6 stacked PRs: F foundations (= arc 1); P a primitive library in `packages/design` (tag tones, count chip, busy/compact buttons, list row, mark tile, radio choice cards, edge card, progress bar, detail list, dialog shell with one focus trap, dock strip, footer, empty state) plus a dev-only gallery page; D the sender field (parallel to P); then three screen PRs (frame + send form; in-flight + receipt + faucet; activity + dock), each landing desktop, tablet and phone together. It gates the gallery, not the app, with Playwright screenshot baselines inside `quality-status`, advisory in P and required from S1. It rejects Storybook and keeps every owner decision.

**Why the surface plan is proposed instead.**
- **Visible wins first.** The owner's complaint is about what they see. Here PR 1 fixes the wordmark, icons and static; PR 2 the token list and wallet modal. Outline B spends PR 2 on library work before any screen changes.
- **Reviewable diffs.** Outline B's S1 and S3 are 40–60 files each; here no PR exceeds two arcs, and a layer that still proves too large splits at a phase boundary (Delivery).
- **No new CI surface.** A screenshot gate adds workflow edits, `test:ci-gating`/`behavior-gating.test.ts` changes, a Linux-only baseline routine and re-baselining on every font or Playwright bump. The previous plan declined screenshot baselines (its D10); the owner's written sign-off on screenshots remains the visual gate.
- **Primitives proven by a consumer.** Each primitive is built in the arc that first uses it, so it is shaped by a real screen.

**Grafted from outline B:** the guardrail (no primitive without a board and an arc 1–9 consumer); one `useFocusTrap` behind a `Dialog` shell, adopted by the dock too (phases 8 and 11); one tone table for every status chip (phases 3 and 10); one `ProgressBar` for faucet and in-flight (phases 18 and 23); one `DirectionSegment` (phase 23); its responsive acceptance (every arc's tour captures 390, and each arc's review checks the phone capture of its own surfaces, tour step 6). Outline B's "no mobile rework" argument is answered by keeping arc 9 to ≤760 rules and three template hooks, and by shipping arcs 8 and 9 in one PR.

## Security & Adversarial Considerations

**Threat model.** A static SPA on two assets-only Cloudflare Workers, talking to a user-chosen `@aztec/wallet-sdk` wallet and an injected EIP-1193 wallet, moving real funds on mainnet once a mainnet generation ships. Attackers: a hostile or look-alike wallet (announces name, type, id, icon), a hostile token (pasted address or remote list entry with a spoofed symbol), a tampered restore file or localStorage entry (XSS elsewhere on the origin, a malicious extension), and a supply-chain compromise of vendored assets. No endpoint, network destination, credential or CI permission changes.

- **Spoofing through token tiles.** A brand fill is granted only by repository-committed identity (exact `chainId:address` table or a `source === "manifest"` row); a list or pasted token claiming "USDC" renders grey. Unknown tiles drop the hashed hue, so the address on every row (manifest rows included, full checksum in `title`) is the look-alike defence. Phase 5 adds an e2e case to `tokens-hostile.spec.ts` proving a fake USDC renders grey through the real UI.
- **Spoofing through wallet metadata.** Name, type, id and icon are untrusted. The type chip stops printing the claimed string: "Extension", "Web app", or a neutral "Unknown type" with the sanitised claim only in `title` ("Self-reported: …"), so a wallet cannot label itself "Verified wallet" (a flagged deviation from OQ19 A, D25). Sanitising the name and id line bounds spoofing (no invisible, bidi or stacked characters, capped length); it cannot stop a look-alike name, so the collision check stays keyed on exact id and the emoji check stays the trust anchor. The fallback tile is a generic glyph that cannot pass for a brand mark. `safeIcon`'s allowlist, 4096-character cap and `@error` fallback are unchanged. A second claimant's strip or a newly answering wallet can shift rows under a pointer, so the picker ignores row activation for 500 ms after either changes (tested); the emoji check still gates the connection.
- **XSS.** Every new string (chip text, aliases, account line, From, hints, session-log rows) renders through Vue interpolation or attribute binding; symbols through `safeDisplay`, addresses through `safeAddressText`/`checksumAddress`. No `v-html`; bold segments are template spans. Token-mark `:style` values are constant hex from the table, never token data. Retiring the sprite sheet removes a DOMParser/`importNode` path. Vendored icons stay path-data only (`vendor-icons.ts` rejects anything but `<path d>`).
- **Stored-data integrity.** `sender` is display-only and never read by a claim, exit or recovery path; it is shape-checked on every load (quarantine on failure), format-checked at render, and travels only inside the encrypted backup blob. A forged or blocked record renders red ("Lost signal") from its first render because `blocked` counts as failed even when runtime attention is empty after a reload, and even on a completed or busy record (today `blockTokenRecords` can block a completed record that then reads as done, Fact 8); lost records count toward needs-you. For private exits the local record now links the Aztec sender to `recipientL1`; only someone who can already read the tab's storage sees that, and the connected wallet already knows it. Other-account records leave the needs-you count (OQ28) but keep their status chip and edge, the lilac chip, lost-first order and, with the rail hidden, their failure note; who can claim does not change. The session log is runtime-only: fixed step phrases and trimmed tx hashes, never a note, error text, `stepDetail`, secret or envelope.
- **Honest status on a real-funds bridge.** No percentage on the faucet's proving bar, no "on this device", no remaining-time prediction on in-flight; a gas-only record shows the Fee Juice it bought (or "≥" its floor before arrival) on every surface, never the paid token amount relabelled FJ (R5-1); an exit's Visibility row says its arrival on Ethereum is public; the in-flight bar reaches 100% only on `completedAt` and turns red with the word "failed" on a failed phase. The "this send" dock row has no actions, so no second claim path races the stepper. Collapsing the phone gas breakdown never hides an error or a cap note (forced open, unit-pinned). The review keeps the full Portal address and its mismatch block (OQ23).
- **UI integrity.** Dialog × maps only to `cancel`; the document-level Escape listener is removed on close and unmount (unit-pinned), or a stale listener could cancel a later connect; a focus queued for a dialog that closed meanwhile is dropped. A loading `Button` emits no `click` from mouse or keyboard (unit-pinned); the call sites' `disabled` bindings and operation guards remain the authority, and `pointer-events: none` is only cosmetic. The locked direction segment refuses in `pick()`, not only in CSS.
- **CSP and `_headers`.** No new host, asset type or inline script. Static stays a same-origin CSS `data:` image (allowed by `img-src`); fonts stay same-origin and never inlined. The build gate diffs each target's `dist/_headers` against a baseline taken from the untouched base before phase 1; any diff fails the gate.
- **Supply chain.** No new npm dependency. The 12 icons come through `vendor-icons.ts` at the pinned Pixelarticons commit (MIT, license file already vendored), with a git-blob check per file; `icons.ts` is never hand-edited. The font re-subset starts from the blob- and sha256-verified upstream TTF; its tools install with `pip install --require-hashes`, and tool versions, wheel hashes and the output hash are recorded in `SOURCES.md`. The already-installed `gh-stack` extension is used as is (a host without it installs a pinned tag). `bun install --frozen-lockfile` and the 7-day minimum release age are untouched.
- **Least privilege.** No workflow, secret, aggregator or branch-protection change; no deploy, no key. A branch push creates a public testnet preview, so branches are pushed only at a PR boundary after that layer's loop converges.
- **Private boards.** Board renders and sources are the owner's private canvas: never committed, never embedded in a public PR body, never quoted as file paths into the repository.

## Phases

Each phase ends when its **validation gate** passes exactly as written. Within a phase, run `bun run lint` plus the touched package's tests after every meaningful edit. Commit per step (conventional, lower-case subject, signed). Never push mid-layer (see Delivery). Log every meaningful attempt in `lessons/phase-N.md`.

**Phase gate (PG)**, the base of every phase's gate:

```
bun run lint && bun run typecheck:all && bun run test:all && bun run --cwd apps/tools test:e2e
```
`lint` covers Biome and the complexity baseline; `test:all` covers every `@unleashed/*` unit suite; `test:e2e` is the Node/jsdom smoke CI runs but no root script calls.

**Build gate (BG)**, run in phase 2 (font), at every PR boundary and before delivery. Each target is built, verified and diffed before the next build overwrites `dist`:

```
for t in testnet mainnet; do
  bun run --cwd apps/tools build:$t \
    && bun run --cwd apps/tools verify:build-target $t \
    && ! grep -rq 'data:font' apps/tools/dist \
    && diff "$SCRATCH/headers-$t" apps/tools/dist/_headers || exit 1
done
bun run --cwd apps/tools verify:deployments
```
`$SCRATCH/headers-<target>` are copied from builds of the untouched base before phase 1 starts.

**Browser runs.** A targeted run is `bash apps/tools/scripts/e2e/agent.sh specs/<a>.spec.ts [specs/<b>.spec.ts …]` from the repository root; the full suite is `bun run e2e:tools`. Both boot and reap their own sandbox (parallel-safe). A serial full run takes ~1.7 h locally (`workers: 1`), so gates run it as CI does: six concurrent `bun run e2e:tools -- --shard=i/6` runs, each with its own sandbox, passing only when all six exit 0. Precondition, once per checkout: the gitignored `contracts/bridge/evm/{lib,out,cache}` are present (copy them in, or `forge install --no-git`; lessons.md).

**Layer gate (LG)**, the last phase of every PR layer: PG + BG + `bun run audit:tools` + `bun run e2e:tools`, then the tour. `audit:tools` builds only the default (testnet) target (Fact 20); BG is what builds and checks both.

**Layers each gate exercises**, read off its components: PG = lint (Biome, complexity) · typecheck · unit (all three packages) · integration (the jsdom smoke); BG = production build of both targets + `_headers`/font guards; `audit:tools` = typecheck, tools unit tests, lint, deployment check and one testnet build; a targeted `agent.sh` run = e2e on the local sandbox for the named specs; `e2e:tools` = the whole e2e suite. No gate touches a live network. Pass means every listed command exits 0 plus the gate's named criteria.

**Baselines.** The complexity manifest never grows: every gate includes `git diff --exit-code scripts/complexity-baseline/manifest.json` unless the diff only removes entries.

**Screenshot tour (T)**, per arc, never gating a CI check but required for the PR:
1. Copy the local reference's tour spec `zz-fidelity.spec.ts` to `apps/tools/tests/browser/specs/zz-arcN.spec.ts`; trim and extend it to the arc's surfaces (listed per arc). Output goes to a scratch directory, never to an absolute path in the repository.
2. Hide the wallet iframe with `style: "iframe { visibility: hidden !important; }"`; capture dark and light at the widths the arc lists.
3. Run it alone: `bash apps/tools/scripts/e2e/agent.sh specs/zz-arcN.spec.ts`.
4. Convert to compressed JPEG. Review each capture: one that shows a board image is not used.
5. Delete the spec before any full run. It is never committed.
6. Compare each capture with its board locally; note every visible difference that is not a recorded decision in `lessons/phase-N.md`, then fix it or flag it for sign-off. Every arc's review includes the 390 capture of each of its own surfaces (outline B's responsive acceptance): a phone regression is fixed in the arc that caused it, not deferred to arc 9.

### Arc 1 — Foundation tokens and glyphs (PR 1)

The design-system layer every screen reads from. No flow or stored-data change. Dark surfaces change only in static, icons, wordmark, busy, destructive and focus; light gains visible fields, tracks and the header perforation.

**Visible surfaces (owner signs off; dark and light at 1440 and 390, plus 1100 where the rail matters):**
1. Every screen: the rail wordmark reads `Unleashed` (top bar at 390); the tab title is `Unleashed · Aztec tools`; icons snap to 12 or 24 (step-rail checks, wallet-chip × and chevron, review notes 24, receipt check 24, dock chevron 24, toasts, account-menu copy 24 in a 32px target).
2. Scrims (picker 01, verification 02, choose-account) and the private veil (04) show dark TV static instead of pale haze.
3. Light only: recessed token search, amount field, gas count slot, direction track, review Send band, faucet wells and dripping panel, emoji grid, account avatars, picker no-icon tile, rail/dock/page placeholders; a dotted perforation under every page header.
4. Tags: the mint strip "Testnet" chip turns amber with no icon; the faucet "Test token · no real value" turns neutral grey with the info icon.
5. Busy buttons: three stepping pixels after the label instead of the ring; primary takes the magenta tint; busy labels lose their ellipsis ("Sending", "Adding", "Restoring", "Claiming gas", "Setting up session").
6. Destructive buttons ("Confirm discard" with a × icon, "Permissions denied — try again", the connect error): dark-red fill, no underline edge.
7. Keyboard focus: a 2px ink ring 3px off on every button and link, both themes (was magenta).
8. Dialog, dock and first-visit headings at −0.015em; a locked direction pick keeps reverse video.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G02 | Static filter gains `color-interpolation-filters='sRGB'`; feFuncB `0.05 0.22 0.56 0.92` | `D:base.css:179` | Confirmed on all 15 board filters; URI stays percent-encoded with no `;`. |
| G72 | Light recess split: keep `--ul-well` for page-level recess, light value → #fbf9f3 (sheet); add `--ul-field` (light #f4f1e8) and `--ul-track` (light #e9e4d6), both #08080a in dark | `D:base.css:43-44,76`; field: `AmountStep.vue:292`, `GasBreakdown.vue:194`, `TokenStep.vue:113`, `ReviewStep.vue:193`, `MintStrip.vue:116`, `TokenCard.vue:310`, `D:composite/BalanceRow.vue:41`, `D:composite/EmojiGrid.vue:23`, `ChooseAccountModal.vue:266`, `WalletPickerModal.vue:256`; track: `WizardShell.vue:145`; well: `AppShell.vue:126`, `DockStrip.vue:42`, `SendView.vue:37`, `ActivityView.vue:61`, `BridgeJournal.vue:135` | Deviates from recon's three new tokens: placeholders sit on bg, so paper would erase them. Dark unchanged by construction. Fix the false depth comment at `:43`. |
| G98 | Replace the `.seg.sel:disabled` raised override with `.seg.sel:disabled { color: var(--ul-bg); cursor: not-allowed }` | `send/WizardShell.vue:175-183` | Pulled from arc 2: without it G72 hides the locked pick in light. Deleting the override outright would let `.seg:disabled` paint disabled text on the ink fill. |
| G73 | `--ul-perforation` (dark transparent, light `--ul-line`); `border-bottom: 2px dotted` | `D:base.css`, `SectionHeader.vue:18-25` | A token, so theme logic stays in base.css. |
| G85 | `--ul-ring: var(--ul-ink)`, `outline-offset: 3px` on `a/button:focus-visible`; hard-coded `--ul-focus` outlines point at `--ul-ring` | `D:base.css:226-230`, `BridgeJournalCard.vue:588`, `ChooseAccountModal.vue:251`, `views/ActivityView.vue:148` | `--ul-focus` stays for field edges; the −2px inset overrides and `TokenTile.vue:101-103` stay. |
| G123 | `--ul-tracking-heading: -0.015em` on the three dialog titles, the dock h2, the first-visit h2, SectionHeader | `WalletPickerModal.vue:204`, `VerificationModal.vue:78`, `ChooseAccountModal.vue:207`, `ActivityDock.vue:200`, `views/ActivityView.vue:100`, `SectionHeader.vue:34` | The journal heading waits for G61 (arc 4); the dialog titles move into `Dialog.vue` in phase 8. |
| G01 | Vendor 12 Pixelarticons: `search plus minus wallet eye eye-off zap key save reload repeat tv` | `D:../scripts/vendor-icons.ts` NAMES → generated `D:core/icons.ts` | Recon correction: Retry is upstream `reload`; `repeat` is the receipt's "New send" loop. `receipt` is dropped (no screen board uses it). Each path equals the board path byte for byte at the pinned commit. chevron-left/right stay unvendored (a rotated chevron-down is pixel-identical). |
| G26 | `Icon.size` typed `12 \| 24` (number or string), default 12; resize all 38 sites | `D:core/Icon.vue:21,29`; 12: `StepStrip.vue:98`, `BridgePhaseRail.vue:137`, `L1WalletPanel.vue:23`, `AccountSwitcher.vue:145,179`, `AztecWalletPanel.vue:128`, `ChooseAccountModal.vue:157`, `BridgeJournal.vue:86`, `BridgeJournalCard.vue:279,304,315,347,355,363,418`, `ThemeToggle.vue:26`, `TokenCard.vue:233,254`, `ReviewDetails.vue:94`, `BridgeStepper.vue:94`, `ConnectionErrorStrip.vue:39`, `GasBreakdown.vue:75`, `AmountStep.vue:213,253,260`, `D:ui/Toast.vue:33`; 24: `AccountSwitcher.vue:192`, `ReviewStep.vue:118,122,128,132,148,159`, `SendWizard.vue:1192`, `BridgeReceipt.vue:125`, `WalletPickerModal.vue:121`, `D:ui/Toast.vue:23`, `DockStrip.vue:26` | Components rule: field errors, dismiss × and chevrons 12; notes, strips and toast leads 24. |
| G145 | Account-menu copy icon 24 in a 32×32 hit area | `AccountSwitcher.vue:192,389-396` | OQ33. The standalone `AddressDisplay` variant is dropped: nothing renders it. |
| G05 | Re-subset Sixtyfour adding U+0055 only; wordmark and title `Unleashed` | `D:fonts/SixtyfourConvergence-subset.woff2`, `D:fonts/SOURCES.md`, `D:base.css:26`, `AppShell.vue:63`, `index.html:8` | Boards draw only "Unleashed" and digits in Sixtyfour. `APP_ID`/capability `unleashed` is protocol and untouched. |
| G34 | Tag tones `neutral ink testnet warn lost carrier private other`, `icon` override (`IconName \| null`), `size="small"` (24px, padding 0 8, 12px); `test` removed | `D:ui/Tag.vue`, `D:composite/DisclaimerTag.vue:6`, `send/MintStrip.vue:91` | OQ31 A. Default icons: warn → warning-diamond, lost → square-alert, carrier → check, private → eye-off, other → wallet; public = neutral + `eye`; disclaimer = neutral + `info-box`. Card adoption is arc 4. |
| G35 (Button) | New `BusyPixels` (three 6px squares, gap 3, opacity 1/.55/.2, a 270ms cycle of three 90ms holds, `role=status`, `aria-hidden` inside `Button`) after the label; primary loading takes signal-tint and accent-text; drop ellipses on Button-`loading` labels; delete `Spinner` | `D:ui/Button.vue:34,77`, new `D:ui/BusyPixels.vue`, `D:index.ts:14`; labels `ReviewStep.vue:165`, `BridgeReceipt.vue:163`, `BridgeJournal.vue:86`, `BridgeJournalCard.vue:341`, `TokenCard.vue:232`, `AztecWalletPanel.vue:107`; loading guard `D:ui/Button.vue:21-37`, `AztecWalletPanel.vue:114`, `D:composite/DripButton.vue:22-23` (comment) | `Button` emits no `click` while `loading` (Fact 5: CSS stops only the mouse); `AztecWalletPanel.vue:114`'s waiting button gains `disabled`. `pointer-events: none` stays as cosmetics; the board's `cursor: progress` is a recorded deviation. MintStrip's and ActivityRow's hand-rolled busy controls are arcs 2 and 4. |
| G36 | Destructive: fill `--ul-lost-bg`, no inset edge; `close` 12 on "Confirm discard" | `D:ui/Button.vue:108-115`, `BridgeJournalCard.vue:406-414` | Light #c12a22 on #f9e4e1 is already a pinned contrast pair. |

Closed here with no change: G142 (keep #65636e, OQ33: the board value fails 4.5:1), G144 (wallet-neutral no-wallet error, OQ33), G124 desktop reading scale (OQ32 A). G04 dropped (Q1 A).

#### Phase 1 — Static, recess roles, focus ring, tracking ✓
- **Before any change:** build both targets from the untouched base and copy each `dist/_headers` to `$SCRATCH/headers-<target>`.
- **Steps:**
  1. `base.css`: G02 filter; `--ul-field` and `--ul-track` in both theme blocks; light `--ul-well` → #fbf9f3 with a corrected comment; `--ul-perforation`, `--ul-ring`, `--ul-tracking-heading`; the focus rule on `--ul-ring` at offset 3px.
  2. Move the G72 consumers to their role; apply G98.
  3. SectionHeader border (G73); the three hard-coded focus outlines → `--ul-ring`; the tracking token at the six heading sites.
- **Tests:** `D:base-css.test.ts` asserts `color-interpolation-filters='sRGB'` and the feFuncB table; `D:theme-contrast.test.ts` adds `--ul-field`/`--ul-track` to FILLS (ink/ink-2/ink-3 ≥ 4.5) and `--ul-ring` on bg/panel/raised ≥ 3.
- **Validation gate:** PG exits 0 with the new contrast pairs and the filter pin passing; baselines unchanged. T (01, 02, 03, 04 private on, 05, 09; dark and light at 1440 and 390, plus a Tab-focus capture): the scrim reads as dark static, light fields and the direction track are distinct from the panel, and dark captures differ from the local reference's `app/` captures only in static, focus and heading tracking.

#### Phase 2 — Glyph set, icon sizes, wordmark ✓
- **Steps:**
  1. Add the 12 names to NAMES; run `bun packages/design/scripts/vendor-icons.ts` (network plus a logged-in `gh`), then `bunx biome check --write packages/design/src/core/icons.ts`. Expect "wrote 31 icons" and an add-only diff.
  2. Type `Icon.size`, default 12; resize the 38 sites; G145's 32×32 centring.
  3. Font: fetch the pinned TTF; verify blob `1617be9f…` and sha256 `aa8c653e…` against `SOURCES.md`; in a scratch venv, `pip install --require-hashes -r` a scratch requirements file pinning `fonttools==4.66.0` and `brotli==1.1.0` by the sha256 PyPI lists for the wheels this host installs (recorded in `SOURCES.md`); run `pyftsubset … --unicodes=U+0020,U+002C,U+002E,U+0030-0039,U+0055,U+0061-007A --layout-features='*' --flavor=woff2`; assert COLR, CPAL, `fvar` (4 axes) survive and cmap has U+0055; update the `SOURCES.md` row (sha256, bytes, 40 code points, glyph count), its tool line (versions and wheel hashes) and the `base.css:26` comment.
  4. `AppShell.vue:63` text and the `index.html` title.
- **Tests:** `D:core/Icon.test.ts:8-12` size "20" → 24 plus one default-renders-12 assertion; `D:mount-all.test.ts:17` "16" → "24" (the file is at the package root). `fonts.test.ts` re-hashes against `SOURCES.md` with no edit.
- **Validation gate:** PG (vue-tsc passes with no size 16 anywhere) + BG (`ls apps/tools/dist/assets/*.woff2` lists the subset; no `data:font`). T on every surface 00–10, dark and light at 1440 and 390, plus 00 at 1100: the wordmark renders the COLR "Unleashed" with no fallback U, no icon at 16, hit areas still 32–48px.

#### Phase 3 — Tags, busy and destructive primitives ✓
- **Steps:**
  1. `Tag.vue` tone table, `icon` override and `small`; `DisclaimerTag` → `tone="neutral" icon="info-box"`; MintStrip → `tone="testnet"`.
  2. `BusyPixels.vue` (reduced-motion end frame = the static 1/.55/.2 frame); Button renders slot then `<BusyPixels v-if="loading">` and the `.primary.loading` tint; export it, delete `Spinner` and its test, fix the stale mention in the `theme-contrast.ts:62` comment; strip the six ellipses.
  3. Busy guard (Fact 5): `Button` declares `click` and re-emits it only while neither `loading` nor `disabled` (a native button turns Enter and Space into `click`, so this covers the keyboard); `aria-busy` stays. `AztecWalletPanel.vue:114`'s waiting button gains `disabled` (its `@click` could fire only from the keyboard); every other `loading` site already binds `disabled` or passes through `DripButton`, whose comment at `:22-23` is updated.
  4. Destructive fill and the × on "Confirm discard".
  5. Document icon sizes, `BusyPixels`, the loading guard and the tone table in `packages/design/README.md`.
- **Tests:** `Tag.test.ts` (one `test.each` over tone → class/default icon, one icon override/null, one small); `DisclaimerTag.test.ts:11-14` `.tag--test` → `.tag--neutral` + info icon; `BusyPixels.test.ts` replaces `Spinner.test.ts` (three squares, `role=status` with a label); `Button.test.ts:18-20` (status follows the slot text, no spinner), plus one case: a loading button sent repeated clicks (what Enter/Space produce) and Enter/Space keydowns emits no `click`, and emits again once `loading` clears; `AztecWalletPanel.test.ts:77-84` adds `disabled` on the waiting button; `mount-all.test.ts` Spinner → BusyPixels. Unchanged and must stay green: `DripButton.test.ts:30-34,76-79`, `AztecWalletPanel.test.ts:65`, `ReviewStep.test.ts:259`.
- **Validation gate (LG for PR 1):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` (Button's DOM changes on every flow) exit 0. T adds the Tab-focused Continue, a busy drip (shot right after the click) and an armed "Confirm discard" (arm, shoot, reload without confirming). Flag for sign-off: non-primary busy buttons keep their variant fill (the board draws only primary), and the `cursor: progress` deviation.

### Arc 2 — Token step and step rail (PR 2)

The token step looks like BridgeToken and the step rail tells the truth. Depends on arc 1 (`search`, `plus`; `download` is already vendored; 12/24 sizes; `testnet` tone; `--ul-track`/`--ul-field`; `BusyPixels`).

**Visible surfaces (dark and light at 1440, 1100 and 390):**
1. Token step, deposit (testnet/local): the mint strip at well fill, 48px, left-aligned, download icon on each button, busy state; pixel search icon with no native clear ×; rows transparent at rest, raised on hover, reverse video when selected; symbol and name on one line, the address under them on every row, a bare balance; brand or grey marks.
2. A pasted address (lookup): grey tile, `+ Add`, meta in ink-2.
3. Token step, exit: the same list without the mint strip.
4. Step rail on Token/Amount/Review: done steps raised with caption over value and a 12px check, no hint; todo steps ink-2 with a square marker; lower-case hints; tighter rhythm.
5. Direction segment 428px wide.
6. Background-activity strip: the dot is ink while running and amber when failed.
7. Screen reader only: "Step 1 of 3, Token: what are you sending?"; focus lands on a hidden step heading.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G03 | Rename `SendWizard`'s scoped `.strip`/`.strip-text`/`.strip-link` to `.bg-strip*`; drop MintStrip's `.buttons { margin-left: auto }` | `send/SendWizard.vue`, `send/MintStrip.vue` | MintStrip is slot content (`SendWizard.vue:1173`) and carries the wizard's scope id; the other child roots do not collide. |
| G152 | Background-strip dot `--ul-ink` running, `--ul-attention` failed, via `data-tone` | `SendWizard.vue:1082-1095,1157,1259-1264` | `backgroundLine` returns `{ text, failed }`; cognitive complexity ≤ 15. |
| G08 | Rows `--ul-fill: transparent` at rest, `--ul-raised` on hover, selected rule kept | `send/TokenTile.vue:81-83,105-107` | |
| G81 | Symbol and name on one baseline (name 13 ink-2, ellipsis); address line on every row incl. manifest; ident gap 3; row 60; padding 0 16 0 12; balance without symbol; full checksum in `title` on every row | `TokenTile.vue:32,34,47,69-75,132-149` | OQ17 A; reverses `TokenTile.test.ts:92-97`. |
| G07 | Flat brand tiles only for repository-committed identity; flat `--ul-raised`/`--ul-ink` tile otherwise; initials Next 800 11; retire the sprite sheet | new `send/token-mark.ts` + `send/TokenMark.vue`; `TokenTile.vue`, `TokenStep.vue`, `TokenList.vue`; delete `send/token-sprite.ts` (+test), `send/SpriteSheet.vue`, `assets/token-sprite.svg` | Q2 A, Ask A2. Recon cites `lib/token-sprite.ts`; the file is `components/send/token-sprite.ts`. |
| G115 | Brand table carries board letters (USDC "US", USDT "UT", WETH "WE"); unknown tokens use the first two characters of `safeDisplay(symbol)`, "??" if none | `token-mark.ts` | Two grey tiles sharing initials claim nothing. |
| G35 (MintStrip) + G79 | Mint buttons: `download` 12, inline-flex, gap 8, 14px; busy keeps "+100 USDC", adds `BusyPixels` and `aria-busy` | `MintStrip.vue:94-105,144-152` | |
| G80 | `<Icon name="search" :size="24"/>` in ink-3 replaces the stroked SVG | `TokenStep.vue:55-58,132-139` | |
| G82 | Lookup: `plus` 12 in Add, Add padding 0 14, meta ink-2, ident gap 3, mark via `TokenMark` | `TokenStep.vue:77,81,85,174-190` | A pasted DAI renders grey, not the board's #F5AC37 (Q2 A). |
| G114 | Step gap 16; mint-strip margin 16; list gap 6; list max-height 356px (5½ rows, so overflow shows) | `TokenStep.vue:106-110`, `MintStrip.vue:121`, `TokenList.vue:82-88` | |
| G118 | `.field::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none }` | `TokenStep.vue` | No board draws a clear button. |
| G14 | `stateOf`: done means `index < completed`; reachable stays `index <= completed`; rewrite the prop doc | `send/StepStrip.vue:20-21,31-38` | No "visited" index needed (walked forward, back, re-pick, direction switch against `SendWizard.vue:423`). |
| G15 | Done step: `--ul-fill: var(--ul-raised)`, caption `label` 12 ink-3 over `value` Mono 700 13 ink, hint hidden, check 12 | `StepStrip.vue:40-47,97-102,162-165,217-225` | `aria-label` stays "Token: USDC". The horizontal strip's styling is arc 9. |
| G95 | Vertical rail: row-gap 2, natural label line-height, todo label ink-2, hint ink-3, square todo markers, lower-case hints | `StepStrip.vue:127,135-138,145-160,210-215`; `WizardShell.vue:29-33` | |
| G96 | Live caption `${position}, ${label}: ${CAPTION[key]}` | `WizardShell.vue:49-53` | |
| G97 | `.segment { flex: 0 1 428px }` | `WizardShell.vue:148` | |
| G143 | A hidden `<h2 tabindex="-1">` holding the step label is the focus target on a step change; the panel loses `tabindex` | `WizardShell.vue:57-63,120`; `lib/testids.ts` (`sendStepHeading`) | OQ33 A. |

Closed: G116 (keep the 8…6 trim, OQ17 A). Dropped: G117 (OQ18 A), G104/G105 (OQ30 A).

#### Phase 4 — Token step bugs and row layout ✓
- **Steps:** G03 rename and MintStrip margin; G152 `{ text, failed }` and the dot tone; MintStrip download icon and busy state (G79, G35); TokenTile restyle (G81, G08); search icon, UA clear, lookup plus/meta/gap, rhythm (G80, G118, G82 minus the mark, G114).
- **Tests:** `MintStrip.test.ts:67` (busy keeps "+100 USDC", `aria-busy="true"`); `TokenTile.test.ts:92-97` → "every row shows its trimmed address, manifest included", `:71` balance text has no symbol; `SendWizard.test.ts` background-strip dot `data-tone` running then failed. `specs/activity.spec.ts:103` stays unchanged and proves the testid survived the rename.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/tokens.spec.ts specs/tokens-hostile.spec.ts specs/activity.spec.ts` exit 0; baselines unchanged.

#### Phase 5 — Token marks (Q2 A) ✓
- **Steps:**
  1. `token-mark.ts`: `BY_KEY` (the five exact `1:<address>` entries from the sprite, same colours); `BY_MANIFEST_SYMBOL` (USDC, USDT, WETH, WBTC, cbBTC → the same `Brand` objects); `markOf` grants a brand only from `BY_KEY[logoKey]` or from `BY_MANIFEST_SYMBOL[symbol]` when `source === "manifest"`. The file's one comment states that invariant.
  2. `TokenMark.vue`: 32px notch-2 span; brand fill/ink as constant hex, else `--ul-raised`/`--ul-ink`; emits `sendTokenLogo` when branded, `sendTokenMonogram` otherwise; replaces the TokenTile mark and the duplicated lookup mark (`TokenStep.vue:48-49,77,162-172`).
  3. Delete the sprite pipeline; remove `<SpriteSheet/>` (`TokenList.vue:45`) and its entries in `testid-coverage.test.ts:37,154,195`.
- **Tests:** new `token-mark.test.ts` (exact chain-1 key → brand; manifest USDC on 31337/11155111 → brand; a `list` or `pasted` "USDC" at another address → none; manifest EURC/PXO → none; letters "UT", sanitized first two, "??"); `TokenTile.test.ts:29-51` → one branded and one grey render; `specs/tokens-hostile.spec.ts` after `:38`: the manifest USDC tile contains `sendTokenLogo`, the fake "USDC" at `0x6666…` contains `sendTokenMonogram`.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/tokens-hostile.spec.ts specs/tokens.spec.ts` exit 0; `git grep -n -e token-sprite -e SpriteSheet -e monogramHue -- apps/tools/src` prints nothing. The hostile spec proves a list token claiming a manifest symbol renders grey through the real UI.

#### Phase 6 — Step rail and direction segment ✓
- **Steps:** StepStrip separates `stateOf` from `reachable` (reachable todo keeps `cursor: pointer`); done markup `.caption` + `.value`, check 12, hint only when not done; vertical CSS (G95); WizardShell lower-case HINT, caption format (G96), segment basis (G97), the sr-only `h2` focus target (G143).
- **Tests:** `StepStrip.test.ts`: new case active 1 / completed 2 → `["done","active","todo"]` and clicking index 2 still emits `select` (the G14 regression); `:32-38` caption + value; `:110` hints only on steps not done. `WizardShell.test.ts:121` expects "Step 1 of 3, Token: what are you sending?"; `:104-114` focus lands on `sendStepHeading` reading "Amount". Register `sendStepHeading` in `testid-coverage.test.ts`.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/fee-states.spec.ts` exit 0. T for arc 2: 03, 03c, 04, 05, the exit-direction token step and the background strip (reach it as `activity.spec.ts:103` does), dark and light at 1440, 1100 and 390. If the harness cannot hold the locked segment or a failed background send, the PR says so; unit tests cover both.

### Arc 3 — Chrome and wallet modal (PR 2)

The rail, header chips and connect dialogs read as the boards; the verification modal takes focus; three hand-rolled traps become one shell. The theme control is untouched (Q1 A). Depends on arc 1 (`wallet` icon, 12/24, `Tag small`, busy, ring, tracking).

**Visible surfaces (dark and light):**
- Rail (1440, 1100): the Activity count is a magenta 24px chip; nav items 4px apart; the brand is a focusable home button. At 390 the tab chip is 22px (arc 9 wires the phone layout).
- Header chips: Ethereum × 12, grey label (ink-2 in light), tighter gap, right padding 6; Aztec line in one colour with no bold alias, 12px chevron, padding 0 12 0 14; the faucet header shows only the Aztec chip.
- Disconnected (00, 00b): "Connect Aztec" stays magenta with a 24px wallet icon at 15px, padding 0 16; "Connect Ethereum" becomes the raised secondary (also on the split button); "Approve in your wallet" stops pulsing.
- Account menu (03b): the selected account in reverse video, no cyan tick.
- Wallet picker (01, 1440 and 390): header × and description line; whole-row buttons with a 40px tile (real icon or the pixel wallet glyph on grey), 15px name, "Extension"/"Web app" chip ("Unknown type" for any other claim), id line, magenta "Connect ›"; a static 6px amber scanning square; the amber collision strip with a 24px diamond and today's words; right-aligned auto-width Cancel; 358px wide at 390.
- Verification modal (02): header ×, 24px padding, 358px at 390, focus visibly inside. Choose-account: 480px, header ×, right-aligned Continue.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G30 | `.count` → magenta chip (`--ul-fill: var(--ul-signal)`, notch-2, `--ul-on-signal`, min 24×24, padding 0 6, Mono 13/700; phone 22×22 Mono 12); visible number `aria-hidden` plus sr-only ", N needs you" | `RailNav.vue:12-16,66,105-110,127-129` | OQ10 A. Delete the "a count, not a call" comments. Today's `aria-label` sits on a plain span and names nothing. |
| G110 | Nav gap 2 → 4px | `RailNav.vue:75` | |
| G108 | Brand div → `<button type="button" aria-label="Unleashed home">` calling `shell.goTo("send")` | `AppShell.vue:58-64,129-134` | A button, not a link: routing is internal state. |
| G107 (shell half) | `.shell` a `div` keeping `tl-app`; `.main` a `<main>`; rail aside `aria-label="Unleashed"` | `AppShell.vue:56-57,71,110` | The dock half is phase 11. |
| G28 | Close and chevron 12 (verify arc 1); new `--ul-ink-caption` (dark ink-3, light ink-2) for chip labels and the light chevron; drop `.net .name` bold; identity gap 1px; paddings as above | `L1WalletPanel.vue:23,45,56-66`; `AccountSwitcher.vue:142,145,242,259-274,374-377`; `D:base.css` | One new contrast row. |
| G109 | Aztec chip label `Aztec account ${alias}, ${short}, switch account` (alias dropped when empty); Ethereum × `aria-label="Disconnect Ethereum wallet"`, `title="Disconnect"` | `AccountSwitcher.vue:136`; `L1WalletPanel.vue:22` | The alias is sanitized at parse (`createAztecWalletSession.ts:1095`) and bound as an attribute only. |
| G29 | Connect Aztec (plain and split): leading `wallet` 24, padding 0 16, 15px via a local class on `size="large"`; Connect Ethereum `variant="secondary"` in every state | `AztecWalletPanel.vue:126,131-142`; `L1WalletPanel.vue:27-29` | OQ21 A. Local override, since `Button`'s `.large` is shared with Back/Continue. Testids `tl-l1-connect`, `tl-bridge-l2-connect` kept. |
| G27 (chrome half) | Delete `.waiting`'s 1.6s pulse and the picker's 2.4s dot pulse; the dot becomes a static 6×6 `--ul-attention` square, gap 10 | `AztecWalletPanel.vue:175-187`; `WalletPickerModal.vue:283-309` | The rows' `<ul>` is already `aria-live`. The phase-rail pulse goes with G55 (phase 22). |
| G111 | Checked account row in reverse video (row, text, copy button inverted); check icon dropped | `AccountSwitcher.vue:179,319-326,349-356` | OQ33 A. |
| G141 + G67 + G140 | New `D:ui/Dialog.vue` + `D:ui/useFocusTrap.ts`: Teleport, `.ul-scrim`, notch-6 panel (480 max, padding 24), h2 20/700 −0.015em, 36×36 × (close 24, ink-2), default slot, right-aligned footer slot; backdrop, Escape and × emit `cancel`; focus on `nextTick`, dropped if the dialog closed or unmounted meanwhile; document `keydown` added while the reactive `enabled` is true, removed when it turns false and on unmount; Tab trap on the panel over the Key-interfaces set (the dock's set, Fact 9, plus `:not([tabindex='-1'])` so roving radios work and `input:not([disabled])`), hidden elements filtered; restore focus only if `el.isConnected`; `aria-labelledby` via `useId()`; overlay padding 16 at ≤760 (`min(480px, 100% − 32px)`) | `packages/design/src/ui/`, `D:index.ts`; `WalletPickerModal.vue`, `VerificationModal.vue:19-51`, `ChooseAccountModal.vue` | OQ33 A (× means cancel). `tl-verification-modal` stays on the scrim; `role=dialog`/`aria-modal` move to the panel, so ActivityDock's `[aria-modal=true]` yield still matches. |
| G65 | Header ×; description `<p>` "Aztec wallets that answered on this page. Your keys stay in the wallet you pick." via `aria-describedby`; name 700 15; id line Mono 12.5 ink-3 `id head…tail`; right-aligned Cancel | `WalletPickerModal.vue:117-118,149,168-174,262-267` | The id is sanitized (`sanitizeWalletName(id, 64)`) before the cut. `tl-wallet-picker-cancel` kept. |
| G06 | `li` (keeps `tl-wallet-picker-row`, `data-wallet-*`) wraps one full-width `<button>` carrying `tl-wallet-picker-connect` and the aria-label: 40×40 notch-2 tile (well behind a real 24px icon; `--ul-line` tile with `wallet` 24 ink-2 as fallback), name + chip column, id line, "Connect" 14/700 accent + `chevron` 12 at −90°; rows padding 12 14, gap 14, list gap 6, hover `--ul-line` | `WalletPickerModal.vue:130-161,227-258` | OQ19 A. Keeps `connect.ts`'s descendant locator and the `.name` hook; `safeIcon`/`onIconError` unchanged. |
| G66 | Type chip: `extension` → "Extension", `web` → "Web app", anything else a neutral "Unknown type" chip with `title="Self-reported: {sanitizeWalletName(type, 16)}"`; `Tag size="small"` panel fill, 12/700 ink-2; the chip's label in the row's aria-label | `WalletPickerModal.vue:150,155`; `lib/wallet-name.ts` | OQ19 A for known types. **Deviation (flag, security):** OQ19 A says unknown types "pass through as sent"; the claimed string is attacker-chosen and unbounded (Fact 11), and even sanitised it could read "Verified wallet", so it appears only in the tooltip (D25). |
| G139 | Collision strip gap 12, padding 12 14, `warning-diamond` 24, 14/1.45; copy byte-identical; the strip keeps the board's position. Row activation is ignored for 500 ms after the collision state or the wallet list changes, so a row cannot shift under a click | `WalletPickerModal.vue:120-123,208-223` | OQ20 A. |

Closed: G106 (OQ30 A), G112 and G144 (OQ33 A). G04 dropped.

#### Phase 7 — Rail and header chips ✓
- **Steps:** RailNav chip, phone chip under `@media (max-width: 760px)`, gap, comment deletions (G30, G110); AppShell brand button, `<main>`, rail label (G108, G107); `--ul-ink-caption` and the chip metrics, labels and reverse-video row (G28, G109, G111); connect icons, secondary Ethereum, pulse removed (G29, G27); `TESTIDS.brandHome`.
- **Tests:** `RailNav.test.ts:34-43` → chip with sr-only ", 2 needs you", nothing at 0; `AppShell.test.ts` +3 (brand click returns to send; `main` does not contain the rail; Connect Ethereum is secondary), `:120` still holds; `AccountSwitcher.test.ts` +2 (aria-label has alias and short address; checked row inverted with no `.check`); `L1WalletPanel.test.ts` × label and title; `theme-contrast.test.ts` new row.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/accounts.spec.ts` exit 0; baselines unchanged.

#### Phase 8 — Shared dialog shell and verification focus ✓
- **Steps:** build `Dialog.vue` and `useFocusTrap` to the Key-interfaces contract (reactive `enabled`, the full focusable set filtered for hidden elements, the guarded `nextTick` focus; Dialog props `open`, `title`, `describedby?`, `overlayTestid`, `closeTestid`); migrate the three modals keeping every testid; add `walletPickerClose`, `verificationClose`, `accountChoiceClose` to `testids.ts`.
- **Tests:** `useFocusTrap.test.ts` (Tab and Shift+Tab wrap over buttons, links, inputs, selects, textareas and `[tabindex="0"]`; the predicate's counterexamples are skipped: a disabled button, `a[href][tabindex="-1"]`, an input with `tabindex="-1"`, a `[tabindex="0"][disabled]` button, a control inside a `display:none` ancestor, inside `[hidden]`, inside `[inert]`, and a detached node; `enabled` false removes the listener; unmount before the queued `nextTick` focuses nothing and throws nothing; `shouldYield` true leaves Escape and Tab alone while another `aria-modal` owns focus). `Dialog.test.ts` (focus inside on open; Escape/×/backdrop each emit `cancel` once; listener gone after close; no restore to a detached element; the picker → verification handoff in one flush ends with focus inside the verification panel). `mount-all.test.ts` entry; `VerificationModal.test.ts` (focus lands inside `[role=dialog]` from an outside button; Escape cancels); `ChooseAccountModal.test.ts` (× cancels). e2e: `tests/browser/pages/connect.ts` `connectAztec` asserts, before confirming, `await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="tl-verification-modal"] [role=dialog]'))).toBe(true)`, never a single `evaluate` (focus lands a tick later).
- **Validation gate:** PG + `bun run e2e:tools` exit 0 (every spec connects); `spike.spec.ts:139-172` unchanged and green.

#### Phase 9 — Picker rows ✓
- **Steps:** picker row markup and styles (G06, G65, G66, G139, the static scanning square); pure `walletTypeLabel(type)` and `walletIdLine(id)` in `lib/wallet-name.ts` (keeps the SFC under the complexity budget); fallback tile via `Icon name="wallet"`; the 500 ms activation guard (a timestamp reset whenever `hasCollision` or the row keys change; `selectWallet` returns while inside it).
- **Tests:** `wallet-name.test.ts` (both mappings; "Verified wallet" → label "Unknown type", title "Self-reported: Verified wallet"; a non-string or bidi-laden type → "Unknown type" with the title bounded to 16 graphemes and invisible characters stripped; an id with bidi characters cut after sanitizing; a short id whole); `WalletPickerModal.test.ts:97` still reads `.name`, `:113-118` keeps the `img` checks and asserts the fallback `svg` on rejected icons, the row `button` is the connect testid with aria-label "Connect ‹name› (Extension)", a wallet typed "Verified wallet" shows the "Unknown type" chip and never that text outside `title`, the collision copy equals today's string; with fake timers, a row click within 500 ms of a second wallet answering (or the collision strip appearing) connects nothing and one after it connects (`:86` advances past the window first). `pages/connect.ts:31` wraps its row click in `expect(…).toPass()` until the verification modal shows, since an early click is ignored by design (`answerStop` already re-looks).
- **Validation gate (LG for PR 2):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` exit 0. T for arc 3: 00 (also 1100), 00b, 01, 02 with focus visible, choose-account (pause before `chooseAccountIfAsked` answers), 03 with connected chips, 03b, and a rail with a needs-you count (start a deposit, press `tl-stepper-background`, wait for `tl-dock-badge`); dark and light at 1440 and 390. The collision strip is signed off from the OQ20 mockup plus the unit test (I6).

### Arc 4 — Activity, dock and done vocabulary (PR 3)

Cards and the dock speak the board's status language: icon-and-word chips, amber means "you have to act", red means "lost signal", a finished transfer says "Arrived". One `classify` reading drives every card, row, count and order, and a blocked record is lost even when completed. The dock lists the running send as a read-only row; between 761 and 1100px it opens only on a tap, over static, and at ≤760 it is not mounted. Gas-only records show the Fee Juice they bought (R5-1). Toasts and Retry take the board's anatomy. Depends on arc 1 (icons `eye`, `eye-off`, `zap`, `wallet`, `save`, `reload`, `tv`; 12/24; Tag tones, `small`, `icon`; `BusyPixels`) and arc 3 (the rail chip renders `feed.count`, which this arc redefines).

**Visible surfaces (dark and light at 1440, 1100 and 390 unless named):**
1. Activity page (08): card header amount first, short route, chips, age right; chips Private/Public with an eye, "+ N FJ" gas with `zap`, a status chip (Needs you / Proving or the running word / Arrived / Lost signal); amber 4px edge on needs-you, red on every failure (retryable ones keep Retry; a blocked record is red even when completed), none on done; no stamp or flash; done cards "Arrived in 3m 41s" with links right and Clear in the actions row; other-account cards a lilac "Other account · alias" chip, board guidance, an ink "Switch to …" button with a wallet icon and no rail, their failure note printed on the card; a gas-only card's amount in FJ; Backup a save-24 button at the end of the actions row; Retry secondary with the `reload` icon; guidance 14px with a bold verb; a running withdraw adds "You can leave this page."; the compact rail's live segment carries its own fill (no bar, count or clock) and a failed phase shows square-alert; "Your bridges" 17px h2 with "N records", attention-first order, a "Records live in this browser…" note, a 40px Restore.
2. Dock collapsed: a transparent 44×72 strip, 24px chevron, un-notched Mono 11 corner badge, 400-weight label.
3. Dock open: "Needs you · 1" headings, lost rows (red "Lost signal") first in Needs you; one bold amount run; done rows not dimmed; "Arrived" + check; a magenta "this send" row while a send runs (06b); a trailing "Other account" group; the board's TV empty row; "All activity" without the arrow.
4. 761–1100 (03, 07 at 1100): opens only from the strip, over `.ul-scrim`; scrim click or Esc closes; never auto-opens, never restores open on reload. At 390 no dock or strip is mounted, even with a persisted "open"; the rail's magenta count is the signal (arc 9 finishes the one-column layout).
5. Receipt hero word "Arrived" (arc 5 restyles around it).
6. In-flight failure: square-alert glyph, Retry secondary with `reload`, no 1.5× check pop.
7. Toasts: raised, no edge stripe, 24px icon, bold lead, "View tx" on its own line, 12px dismiss in a 28px target, a 2px countdown bar; the recovery toast gets a save icon and no dismiss.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G16 | "Arrived" on the receipt hero, dock rows and card chip; delete `.stamp`, the carrier done edge, `done-flash`, `stamp-in` | `BridgeReceipt.vue:56`, `ActivityRow.vue:54`, `BridgeJournalCard.vue:278-280,447-475` | OQ2 A; toast sentences stay (`useCompletionToasts.ts:12-17`), now with the record's own amount and symbol from `displayAmountOf` (Fact 13). |
| G151 | Delete `@keyframes stamp`, its rules and reduced-motion entries | `BridgePhaseRail.vue:187-192,306-310,395-397,447-453` | OQ2 A. |
| G12 | Chip row: privacy (eye/eye-off), gas "+ N FJ" (`zap`, label "Private FJ"/"FJ" per OQ7), status chip from `classify(…).status`; the header amount from `displayAmountOf` (R5-1) | new `RecordChips.vue`; `BridgeJournalCard.vue:103-109,284-285` | OQ8 A. |
| G13 | `data-status="needs-you"` drives the amber edge and amber live cell | `BridgeJournalCard.vue:443-445,513-515` | Q6 B. `data-attention` stays as an attribute for `recovery.spec`/`l1-wallet.spec` but drives no CSS; the dead `[data-attention] .cell.active .seg` rule goes. |
| G148 | "Lost signal" chip (lost tone, square-alert 12) and a red 4px edge (`data-status="lost"`) on failed cards | same + `lib/activity.ts` | **Q6 B, literal.** Failed = any runtime attention or a persisted `blocked`, overriding completion and busy (Fact 8). Retryable failures (a declined wallet prompt) are red too and keep Retry; dead ends (`TERMINAL_ATTENTIONS`, `blocked`) show their note and no button. Flag: "Lost signal" beside "Your funds are not lost" (`useBridgeJournal.ts:887`), Disputed M2. |
| G150 | Failed glyph `close` → `square-alert` (compact and full rail) | `BridgePhaseRail.vue:50-55` | |
| G24 | Header: amount Mono 15/700, `routeWords()`, chips, age ink-3 `margin-left: auto`; gap 8 | `BridgeJournalCard.vue:281-318,477-511,561-564` | |
| G25 | Done body, only when `classify(…).status === "done"`: "Arrived in {formatElapsed(completedAt − createdAt)}", just "Arrived" when `completedAt ≤ createdAt` (the receipt's guard, Fact 17), links right. A completed record that is now lost (blocked) shows "Previously recorded as arrived" beside its Lost signal chip and note instead, keeping its timestamps and explorer links, never implying the block reversed a transfer; Clear moves into the actions row as a quiet button | `BridgeJournalCard.vue:296-305,366-375` | OQ28; `tl-journal-clear` kept. **Deviation:** cards drop "review said / you got" (a card stores one amount; the receipt keeps the comparison). |
| G57 | Account chip only when `ownedByOther`: wallet icon + "Other account · {alias ?? short}", full address in `title` | `BridgeJournalCard.vue:286-292,547-550` | OQ8 A; `tl-journal-account` and `.other` kept. |
| G58 | `offerSwitch` guidance "Waiting to be claimed by your **{alias}** account. Switch to it in your wallet, then claim here."; ink Switch button with wallet 12, right-aligned. In `stageLabel` the other-account case comes first: today the `claimedByOther` branch returns "Press Claim…" before any ownership check (Fact 17), pointing at a button an other-account card does not show | `BridgeJournalCard.vue:195-203,379-389,553-559` | Bold via template spans, never `v-html`. |
| G59 | Live compact segment holds a fill sized to `progress.fraction`; progress goes into the cell's `aria-label`; compact `.bar-line` and count removed | `BridgePhaseRail.vue:88-122,382-384` | A `role=img` cell cannot host a progressbar. |
| G60 | Backup: 36×36 transparent, save 24, end of the actions row, `aria-label="Back up this bridge"` | `BridgeJournalCard.vue:306-316` | `tl-card-backup` kept. |
| G61 | h2 17/700 + Mono "N record(s)"; after-list info note; heading tracking token | `BridgeJournal.vue:76,113-132` | |
| G62 | Board empty row (tv 24, "Nothing on this channel yet" + sub) in the dock and the journal's default slot | new `EmptyChannel.vue`; `ActivityDock.vue:156`; `BridgeJournal.vue:97-111` | OQ28. First-visit hero stays; `tl-journal-empty`, `tl-journal-restore-link` kept. |
| G64 | `ownedByOther` hides the compact rail and leaves the needs-you count; Backup and Discard stay. With the rail hidden the card prints the failure note itself: `note = blocked ?? (railShown && attention ? null : rt.note && safeSentence(rt.note))` (today it defers to the rail whenever attention exists, Fact 17) | `BridgeJournalCard.vue:228,358`; `lib/activity.ts:31,41,57-59` | OQ28 (flag: the count drops other-account records). |
| G129 (part) | Drop the compact clock; done labels ink-3; keep the marks | `BridgePhaseRail.vue:105,407-409,428-432` | OQ28. |
| G130 | Needs-you guidance 14px ink with a bold verb; other lines ink-2; private copy kept | `BridgeJournalCard.vue:171-218,642-645` | OQ33. |
| G131 | A busy withdraw in the prove phase appends "You can leave this page." | `BridgeJournalCard.vue:195-198` | OQ33; no time claim, no "on this device". |
| G132 | Restore 40px, padding 0 14, gap 8, upload 12; title kept | `BridgeJournal.vue:77-87` | |
| G133 + G90 (journal half) | Card padding 18 20, list gap 12, heading → list 16, card buttons 36 / 0 14; card links 14/700, gap 18 | `BridgeJournalCard.vue:436,650,657`, `BridgeJournal.vue:74,113` | G90's receipt half is phase 15. |
| G134 | Page order by `classify(…).rank` (lost on any account, needs-you, running, done, other-account), then newest first | `BridgeJournal.vue:66-70`, `lib/activity.ts` | OQ28; lost other-account placement is D26. |
| G135 | `ul role=list` of `li` for cards and dock rows | `BridgeJournal.vue:113-122`, `ActivityDock.vue:157-167`, `ActivityRow.vue:66` | Testids and `data-*` stay on the card article and row root. |
| G31 + G107 (dock half) | Strip variant A: 24px chevron ink-2, 16px un-notched Mono 11 badge at 10/4, label 400 ink-3; strip and Hide get `aria-expanded`/`aria-controls`; the dock aside gets `aria-label="Activity"` | `DockStrip.vue:18-85`, `ActivityDock.vue` | OQ11 A; `tl-dock-strip`, `tl-dock-open`, `tl-dock-badge` kept. |
| G32 | The foreground record joins the feed as `foreground: true`: group running, no action, not counted, never auto-opens; line 2 "{route} · this send"; `aria-current`; a click goes to Send; its amount, like every row's, from `displayAmountOf` via `rowStrings` (R5-1) | `composables/useActivityFeed.ts:37-80`, `lib/activity.ts:85-92`, `ActivityRow.vue` | OQ9 A. Rewrites `tests/e2e/shell-smoke.test.ts` test 7. |
| G33 | Amount and symbol one Mono 700 14 ink run; no `.dim`; row-gap 2; running dot ink, word ink-2 400 (foreground: signal/700); prove → "Proving"; `.btn` 14px; dot and side span both lines; line 2 route · visibility · age (route · age beside a button) | `ActivityRow.vue:44-57,83-233` | |
| G86 | `${title} · ${count}` headings; group spacing 18/8/6; "All activity" 13px, no arrow | `ActivityDock.vue:158,171,221-258` | |
| G149 + G68 + G17 (dock half) | 761–1100 overlay: `.ul-scrim` under the panel (click hides); opens only via `toggle()`; session-only state; auto-open suppressed; the dock's Tab trap moves onto `useFocusTrap` (`enabled` = the overlay, `shouldYield` for another `aria-modal`). ≤760: the dock is not mounted (`PHONE_QUERY`), and the unreachable ≤760 overlay rule goes | `ActivityDock.vue:41-43,64-69,73-93,105,140-150,280-294`; `composables/useDockState.ts`; `composables/useMediaQuery.ts`; `AppShell.vue:103-104` | Q3 A / OQ35 A / OQ12 A. `DOCK_KEY`/`DOCK_SEEN_KEY` lines stay byte-identical. The one-column grid is phase 25. |
| G119 | Retry: card button secondary + `reload` 12 (restyled in place); dock button `reload` 12 on `--ul-line`; stepper destructive → secondary + `reload` 12 | `BridgeJournalCard.vue:390-395`, `ActivityRow.vue:213-233`, `BridgePhaseRail.vue:145-154` | Text "Retry" and `tl-stepper-retry` kept. |
| G35 (ActivityRow) | The hand-rolled busy button: idle label ("Claim gas") + `aria-busy` + `BusyPixels` on the tint fill | `ActivityRow.vue:32-37,93,229-233` | |
| G37 | Toast: raised, no edge, flex-start, icon 24, optional `lead` in `<strong>`, link stacked 700 accent + external-link 12, dismiss 12 in 28 | `D:ui/Toast.vue`, `composables/useToast.ts`, `AppToastRegion.vue`, `useCompletionToasts.ts`, `ActivityDock.vue:115` | The completion sentence becomes the lead; the claim-gas error leads with "Could not claim your gas." |
| G120 | 2px countdown bar over `ttlMs`, stepped | `useToast.ts:5-10,36`, `D:ui/Toast.vue` | Reduced motion: no bar animation (`!important`). |
| G121 | Kind `saved`: save 24 in ink, no dismiss | `composables/useBridgeBackup.ts:126`, `D:ui/Toast.vue:5,18` | Copy byte-identical (`activity.spec.ts:60`). |

Dropped: G63 (OQ28: in-flight explorer links stay; they are the Etherscan check).

#### Phase 10 — Status model, cards and the Activity page ✓
- **Steps:**
  1. `lib/bridge-steps.ts` exports `isFailedAttention`. `lib/activity.ts` grows `classify` into the one reading (Key interfaces: `status`, `group`, `rank`, `counts`, `action`) and rewrites its module doc's precedence note; `needsYouCount` and the feed's `autoOpenIds` read `counts`, so lost records count and auto-open and other-account ones never do; `runningWord` (prove → "Proving", else the phase label) is shared with the dock.
  2. `lib/asset-label.ts` `displayAmountOf` (R5-1, tests first); `lastCompleted` carries its result (`useBridgeJournal.ts:755-765`, written at `:831,854`) and `useCompletionToasts.ts` formats it; `BridgeStepper.vue:71`'s headline and `BridgeJournal.vue:54`'s restore-success toast read it too.
  3. `RecordChips.vue` on arc 1's Tag.
  4. `BridgeJournalCard.vue`: G24 (amount from `displayAmountOf`), G13, G148 (`data-status`), G16, G57, G58 (other-account case first), G64 (note printed when the rail is hidden), G25 (with the `completedAt ≤ createdAt` guard), G60, G119 (card), G130, G131, G133/G90; split `stageLabel` if it nears the budget.
     **Two commit groups:** steps 1–4 (status model + cards) land as the first once PG + `bash apps/tools/scripts/e2e/agent.sh specs/accounts.spec.ts specs/recovery.spec.ts` exit 0; steps 5–7 (rail + journal page) as the second, so review and bisection see two halves.
  5. `BridgePhaseRail.vue` compact branch: G59, G129, G150, G151.
  6. `BridgeJournal.vue` + `EmptyChannel.vue`: G61, G62 (journal slot), G132, G134, G135.
  7. `BridgeReceipt.vue:56`: "Arrived".
- **Tests:** `lib/activity.test.ts`: the `classify` table (`:45-94`) gains `status`, `group` and `counts` columns and these rows: any attention → lost; `blocked` alone → lost; completed + `blocked` → lost, not done; busy + `blocked` → lost; busy + error attention → lost; busy → running; completed + stale busy → done (`:48`, kept); idle proving withdraw → needs-you; terminal attention × `ownedByOther` → lost, group needs-you, `counts` false, no action; needs-you × `ownedByOther` → group other-account, `counts` false. The `blocked` and terminal rows (`:65-73`) move from needs-you to lost with the same `null` action; the parity pin (`:96-116`) is unchanged; `needsYouCount` counts a lost row and skips an other-account one (`:120`); one `rank` case. `useActivityFeed.test.ts`: `autoOpenIds` holds a lost own-account record and never an other-account one. `asset-label.test.ts` `displayAmountOf`: gas-only with `fuel.received` → FJ at 18 decimals; before arrival → `atLeast` over `fuel.minOutput`; no fuel block → raw ""; a token send and a legacy fee-juice record unchanged; a hostile `displaySymbol` comes back through `safeDisplay`. `useCompletionToasts.test.ts:59,72` → the record's own symbol and decimals (a 6-decimal send toasts its token, not "TOKEN"), a gas-only completion toasts its FJ. `BridgeStepper.test.ts`: a gas-only headline reads FJ from `displayAmountOf`. `BridgeJournal.test.ts`: restoring a gas-only record toasts its FJ; restoring a 6-decimal token record toasts its own symbol and decimals. `useTokenCatalog.test.ts`: a remote list entry that claims `source: "manifest"` still comes back `source: "list"` and gets no brand. `BridgeJournalCard.test.ts`: `:117,123` short route; `:137-142` → "Arrived" chip + "Arrived in" line, no stamp, plain "Arrived" when `completedAt ≤ createdAt`; `data-status` for needs-you and lost, a completed + `blocked` card included, which shows "Previously recorded as arrived" and no "Arrived in"; blocked + completed + recoverable public fuel → the "Recover your gas" control still renders and no copy says the tokens arrived; blocked + incomplete private fuel → the private-fuel-unknown note is qualified; blocked + `claimedByOther` (completed and not) → the line is qualified and no "Claim without gas" renders; `record-policy.test.ts`: `showClaimWithoutFuel` false whenever `actionable` is false; `:388-397` chip absent for the active account; G58 copy, and `claimedByOther` + `ownedByOther` shows the G58 guidance, never "Press Claim"; no rail when owned by another; other-account + `receipt-mismatch` → `tl-journal-attention` shows the sanitised note and no Claim or Retry renders; a gas-only card's amount in FJ; `:154,264,227-240,270` stay. `BridgePhaseRail.test.ts:103-113` no visible clock, label carries progress. `BridgeJournal.test.ts` order (a lost other-account card ranks with lost) and count. `BridgeReceipt.test.ts:39,64,85,155,256` "Arrived". `accounts.spec.ts`: after switching to the owning account, `tl-journal-account` has count 0.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/accounts.spec.ts specs/recovery.spec.ts specs/l1-wallet.spec.ts specs/exits.spec.ts specs/activity.spec.ts` exit 0; every R5-1 and completed + `blocked` test failed on main before its fix; baselines unchanged.

#### Phase 11 — Dock ✓
- **Steps:**
  1. `useActivityFeed.ts`: append the foreground record from `journal.records` by `activeFlowId` (G32), excluded from `count` and `autoOpenIds`; `ActivityRowModel` gains `foreground` and `status`; `rowStrings` reads `displayAmountOf` (R5-1).
  2. `ActivityRow.vue`: G33, G16, G119 (dock), G35, `li` root; the foreground row renders no button and a click goes to `shell.goTo('send')`; a lost row with no action shows red "Lost signal"; "Blocked" becomes "Needs you".
  3. `DockStrip.vue`: G31, `aria-expanded`/`aria-controls`.
  4. `ActivityDock.vue`: G86, the trailing lilac "Other account" group, G62 via `EmptyChannel`, `ul` lists, `aria-label="Activity"` on the aside.
  5. G149: a local `overlayOpen`, set only in `toggle()`; `shown = narrow ? overlayOpen : dock.open`; a `.ul-scrim` with `data-testid=TESTIDS.dockScrim` (z 19 under the panel's 20) hides on click; the `autoOpenFor` watch also watches `narrow` and skips while narrow without marking anything seen; `useDockState` gains `markSeen(ids, liveIds)` so a narrow hide records seen ids without writing "hidden". The Tab trap moves onto `useFocusTrap` (`enabled` = the overlay is shown, plus `shouldYield`).
  6. ≤760 (G17 dock half, G68): export `PHONE_QUERY = "(max-width: 760px)"` from `useMediaQuery.ts` (`RailNav.vue:21` already uses the string; CSS keeps the literal); `AppShell.vue` `const phone = useMediaQuery(PHONE_QUERY)` and the dock `v-if="feed && section !== 'activity' && !phone"` with the `:103` comment extended; delete `ActivityDock.vue:289-294`.
- **Tests:** `useActivityFeed.test.ts` (foreground row: running, no action, not counted, not in `autoOpenIds`; other-account group; a gas-only foreground "this send" row shows its FJ). `lib/activity.test.ts` `rowStrings` of a gas-only record reads its FJ (test first). `ActivityDock.test.ts:132` → `["Needs you · 1","Running · 1","Done · 1"]`; a lost row sits first in Needs you; narrow mode: a persisted "open" is ignored, auto-open suppressed, an explicit open shows the scrim, a scrim click hides and leaves `unleashed:tools-dock` unwritten; a desktop↔tablet resize (stubbed `matchMedia`) turns the trap's listener on only while the overlay shows and leaks none; Escape while another `aria-modal` is open leaves the dock open; `:77` stays; `:165` "Claim gas" + `aria-busy`. `ActivityRow.test.ts` `:16-18,26-27` meta, `:29` "Arrived", `:50` "Retry" stays, `:74` busy, a foreground case (`aria-current`, "this send", no `activityRowAction`). `DockStrip` `aria-expanded`. `useDockState.test.ts` `markSeen`. `AppShell.test.ts` +1 (phone `matchMedia` ⇒ no `tl-dock`, the rail still gets the count; the desktop cases prove >760 unchanged). `tests/e2e/shell-smoke.test.ts` test 7 rewritten: the foreground record never auto-opens or badges, the opened dock shows it without an action, after release it auto-opens as needs-you. `spike.spec.ts:140-172` split by width: at 1024 `tl-dock-scrim` is visible after the open and hidden after Esc; at 390 seed `localStorage["unleashed:tools-dock"]="open"` before the reload, then assert `tl-dock-strip` and `tl-dock` have count 0 through review, confirm and receipt (keeping the deposit and receipt assertions), in a test renamed to say the phone has no dock.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/spike.spec.ts specs/activity.spec.ts specs/accounts-single.spec.ts` exit 0; `spike.spec` passes at 390 and 1024.

#### Phase 12 — Toasts and stepper Retry ✓
- **Steps:** `D:ui/Toast.vue` anatomy, `lead` prop, a local kind `saved`, the countdown bar from a `ttlMs` prop; `useToast.ts` entries carry `ttlMs` and `lead`; `AppToastRegion.vue` passes them; callers `useCompletionToasts.ts` (lead), `ActivityDock.vue:115` (lead + detail), `useBridgeBackup.ts:126` (`saved`); `BridgePhaseRail.vue:145-154` Retry secondary + `reload` 12.
- **Tests:** `Toast.test.ts` (lead in `<strong>`; `saved` has no dismiss; bar duration equals the TTL); `useToast.test.ts` keeps `ttlMs`; `useCompletionToasts.test.ts` phase 10's sentence, unchanged, as the lead; `useBridgeBackup.test.ts` kind `saved` (only if it pins the kind); `tests/e2e/tools-smoke.test.ts` toast assertions stay green.
- **Validation gate (LG for PR 3):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` exit 0. T for arc 4 (copy `depositWithHeldClaim` from `accounts.spec.ts:38`): a needs-you card and dock; after switching accounts, the other-account card and dock group; a lost card (a copy of the held record with `blocked` set, written into the stored journal by `page.evaluate` before a reload, so it passes `partitionStored` like any record); a retryable-error card (retry the held claim with the test wallet's `failNext` on its `sendTx`, so the card shows red "Lost signal" and Retry beside whatever note the run surfaces, such as the run-failure note ending "Your funds are not lost - retry from this card.", `useBridgeJournal.ts:887`); a running withdraw; a done card with the completion toast; the in-flight dock with its "this send" row; the collapsed strip with its corner badge at 1440; 1100 before and after the strip tap; the empty dock; the recovery toast; `07-receipt` for the "Arrived" hero; a failed in-flight phase (square-alert, secondary Retry) if the harness can reach one, else the PR says so and cites the G150/G119 unit tests; dark and light at 1440, 1100 and 390. Flag: the trailing "Other account" dock group (no board draws it); retryable failures red rather than amber, and the "Lost signal" chip beside "Your funds are not lost" (Q6 B literal, Disputed M2).

### Arc 5 — Receipt (PR 4)

The finished-send screen reads like DCQReceipt, amounts across the send flow follow one rule, and the sending address is recorded when the send starts. Depends on arc 1 (`plus`, `repeat`, 12/24) and arc 4 ("Arrived").

**Visible surfaces (dark and light at 1440 and 390; 1100 as a regression check):**
1. Receipt, private token + gas deposit (the board case): header row (route, elapsed, "today 14:22"), 24px check + 17px h2 "Arrived", 56px pixel hero, a bleeding scanline with one cyan pass, "In your Aztec account ‹alias› · 0x2b8e…91d0", a `<dl>` (Gas ready "≈ 0.84 Private FJ · 2 transactions", Review said "250.00 · you got 250.00", From "Ethereum · 0x71C4…3A9F", Visibility "Private — others on Aztec see static"), links 14/700, 48px "New send" (`repeat`) and "Add to wallet" (`plus`), and an info note under the card.
2. Public token-only deposit: no Gas ready row; Visibility "Public — visible on Aztec".
3. Gas-only send: the hero shows the Fee Juice that arrived (R5-1), as its card, dock row and toast already do (arc 4).
4. Exit: account line "On Ethereum · 0x…", From "Aztec · 0x…", Visibility "Sent from your private Aztec balance · arrives publicly on Ethereum" (private exit) or "Public — visible on Aztec and Ethereum" (public exit).
5. 390: padding 20, one-column `dl` (no dock at that width since phase 11).
6. Numbers elsewhere (copy only): review "Send 1,000.00 USDC", "Arrives 247.60 USDC"; amount step "Balance 1,204.55" and the veil "you see 247.60 USDC"; gas breakdown; step-rail amount value; background strip.
7. A record written before this PR shows no From row.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G38 | `formatDisplayAmount(value, decimals)`: grouped thousands, fraction padded to `min(2, decimals)`, never truncated or rounded; replaces `toDecimalString` on every display site | `lib/format.ts` (+test); `BridgeReceipt.vue:62`; `send/ReviewStep.vue:56,63`; `send/AmountStep.vue:134,138`; `send/GasBreakdown.vue:28,30`; `send/SendWizard.vue:260,544` | OQ3 A. `toDecimalString` stays only for the value typed into the field (`AmountStep.vue:147`). `formatCompact` stays on every "≈" quote. Update the comments at `AmountStep.vue:137` and `BridgeReceipt.vue:58-59`. |
| G40 | Detail rows as a `<dl>` (130px + 1fr, row-gap 10, 14/1.45); Visibility on every receipt (exits say their arrival on Ethereum is public and, from `isPrivate`, whether the burn spent a private balance; Fact 19, D20) and From (`sender`; absent ⇒ no row); no Network fee row | `BridgeReceipt.vue`; `SendWizard.vue:956-978`; `bridge-core/src/journal.ts:114-166`; `backup.ts:106-124,159-171`; `useSend.ts:154-194,711,810`; `useHubExit.ts:392-409` | Q4 B (OQ5 A). The proof-print column is gone (G39 deferred), so the `dl` is one column. |
| G41 | "In your Aztec account ‹alias› · 0x…" under the scanline; exits "On Ethereum · 0x…" | `BridgeReceipt.vue`; `SendWizard.vue`; reuses `lib/record-policy.ts:62-75` `accountOf` | The recipient is already stored; the alias is resolved at snapshot time and passed through `safeDisplay`; no alias ⇒ address alone. |
| G42 | Check 24 with a 17/700 `<h2 id>`, gap 10; hero capped at 56, lh 1; symbol Mono 600 ink; gaps 18/14 | `BridgeReceipt.vue:124-127,216-254` | OQ6 A. The `--n` fit floor (20px) stays and now counts commas. |
| G43 | "Review said" a `dl` row of bare figures; Gas ready "≈ {formatCompact} {Private FJ\|FJ} · N transactions"; the "Gas used" row and `fuelUsed` deleted | `BridgeReceipt.vue:28-32,70-80,88-92,129-141`; `SendWizard.vue:876-885,956-978` | OQ7 A. A structured `receiptReview` captured at `onConfirm` holds amount, decimals, gas quote and `txCovered`; `promisedLine` stays for the background strip (`:1055`). |
| G44 | Info note below the card: info-box 24, 14/1.45 ink-2, `--ul-raised`, notch-2 | `BridgeReceipt.vue` (a column wrapper, gap 16) | "…with both transactions." only when both tx links exist; one link ⇒ "Its record stays in Activity." |
| G45 | Both CTAs `size="large"`: New send `repeat` 24, Add to wallet `plus` 24, gap 10 | `BridgeReceipt.vue:153-165` | OQ6 A; `repeat` is vendored in phase 2; icon hidden while `addTokenBusy`. Testids kept. |
| G87 | Header row: route + elapsed (Mono span) left, stamp Mono 12.5 ink-3 right | `BridgeReceipt.vue:121-123,185-189`; `lib/phase-clock.ts` | `formatStamp`, 24-hour clock; omitted without `completedAt`. |
| G88 | Scanline bleeds to the card edges (margin 14px −32px 0; 12px band, 2px line at top 5); one cyan 3px @ .5 translate pass after `--ul-converge` (delay 640ms) | `BridgeReceipt.vue:128,266-272` | Reduced motion: end frame only, `!important`. |
| G89 | Convergence keyframes 0/37.5/75/100% (XELA 90/45/12/0, YELA −80/−38/−10/0, SCAN 70/40/10/0, BLED 60/30/6/0), stepped 3/3/2 | `BridgeReceipt.vue:257-264` | Motion only. |
| G90 (receipt half) | Card padding 32 (20 at ≤760), section margins 18/14/14/12/28/24/28; links 14/700 gap 18; `<section aria-labelledby>` | `BridgeReceipt.vue:119,143,170-177,279-286` | Journal half is phase 10. |
| G124 (receipt slice) | dt/dd 14/1.45, note 14 | covered by G40/G90 | OQ32. |
| R5-1 (new) | Gas-only hero shows `displayAmountOf(rec)` (its gross `fuel.received` as FJ) with the caption "bridged · before claim fees"; its Review said compares the quote with that gross figure; the receipt never calls it "Gas ready" or "you got" (public spendable = received − claim fee, `deposit-gas-only.spec.ts:51`; private = received − the PrivateFPC's kept ceiling, `:93`, `deposit-token-gas.spec.ts:146`, `deposit-flow.ts:601`), and no balance subtraction across unrelated transactions is attempted | `SendWizard.vue:956-978`; `BridgeReceipt.vue:60-68` | Fact 13. The card, dock rows, "this send" row and toast take the same helper in phases 10–11. |

Deferred: G39 proof print (OQ4 A).

#### Phase 13 — One number display rule ✓
- **Steps:** add `formatDisplayAmount` (whole part via `toLocaleString("en-US")`; fraction = `toDecimalString`'s full fraction, trailing zeros stripped, padded to `min(2, decimals)`; 0 decimals ⇒ no fraction); swap the G38 display sites; keep `onUseAll` on `toDecimalString`; update the two comments.
- **Tests:** `format.test.ts` one table (`250_000_000n,6` → `250.00`; `1_000_000_000n,6` → `1,000.00`; `5_000n,6` → `0.005`; `1n,18` → `0.000000000000000001`; `0n,6` → `0.00`; `1000n,0` → `1,000`; `125n,1` → `12.5`). Pins: `ReviewStep.test.ts:81,193`; `AmountStep.test.ts:286,334` (`:284-288` "Balance 0.005 USDC" unchanged); `GasBreakdown.test.ts:67-69`; `BridgeReceipt.test.ts:40,199,223`; `SendWizard.test.ts:1376` "1 WBTC" → "1.00 WBTC". No e2e change (hero assertions use `toContain`).
- **Validation gate:** PG exits 0; `git grep -n 'toDecimalString(' -- 'apps/tools/src/**/*.vue'` (call sites, not imports) prints exactly three lines: `AmountStep.vue`'s `onUseAll` (the typed field, `:147` today) and `BridgeReceipt.vue`'s `usedDisplay` and `availableDisplay` (`:73,79` today: the dead Gas used row and the Gas ready figure, both rewritten by phases 14–15); baselines unchanged.

#### Phase 14 — Record the sender; restructure the snapshot ✓
- **Steps:**
  1. `journal.ts`: optional `sender?: string` on `DepositJournalRecord` and `WithdrawJournalRecord`, TSDoc "display-only; never read by a claim, exit or recovery path". No schema bump.
  2. `backup.ts`: `!isOptionalString(d.sender)` in `assertDepositFacts`, `!isOptionalString(w.sender)` in `assertWithdrawFacts` (schema-3 records reach both through `validateSendSharedFacts`, `:230-240`).
  3. Writers: `useSend.ts` `RecordInputs.sender` from `actors.from`, passed at **both** `buildSendRecord` calls (`:711`, `:810`; the rekey rebuilds from `named`); `useHubExit.ts` `exitRecord(id, plan, sender)` with `from` from `performExit` (`:530`). Never `sealerL1`, never the current connection.
  4. `SendWizard.vue`: a `receiptReview` ref at `onConfirm`; `snapshotOf` split per direction to stay under the budget; `ReceiptSnapshot` gains `sender?`, `recipient`, `recipientAlias?`, `reviewedAmount?`, `gasQuote?`, `txCovered?` and loses `fuelUsed`; R5-1 (`intent === "gas"` ⇒ hero from `displayAmountOf(rec)`, i.e. the gross `fuel.received`, captioned "bridged · before claim fees", no Gas ready row). The token + gas receipt's gas row (G43, OQ7 A) keeps the board's "≈ {quote} {Private FJ|FJ} · N transactions" figure but its label reads "Gas bridged" with "before claim fees" in the value, a flagged, honesty-motivated deviation from the board's "Gas ready" (the quote is gross; the PrivateFPC keeps its ceiling out of it).
- **Tests (write the R5-1 test first and watch it fail on main):** `backup.pins.test.ts` two rejection rows (`sender` a number on a deposit and a withdraw) + one full-shape row; `backup.test.ts` seal/open round trip keeps `sender`, a backup sealed from a pre-field record (no `sender` key) opens and validates, and a record carrying an unlisted key (`futureField: 1`) still validates (the property that lets an old bundle load a `sender` record, since that bundle's validator treats `sender` as unlisted); `journal.test.ts` a stored schema-3 record with `sender: 7` lands in quarantine, and a stored pre-field record loads unquarantined; `useSend.test.ts` both records (before and after the rekey) carry `sender === actors.from`; `useHubExit.test.ts` the exit record carries the Aztec `from`; `SendWizard.test.ts` gas-only snapshot hero is the FJ `fuel.received`, captioned "bridged · before claim fees". Browser: `deposit-gas-only.spec.ts` public (`:51`) and private (`:93`) cases, and `deposit-token-gas.spec.ts:146`, each additionally assert the receipt's gas wording says "before claim fees" and never "Gas ready" or "you got", alongside their existing fee postconditions (received − fee; received − kept); phase 14's gate adds `specs/deposit-gas-only.spec.ts specs/deposit-token-gas.spec.ts` to its `agent.sh` run if absent.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token-gas.spec.ts specs/exits.spec.ts` exit 0 (records written by a real deposit and a real exit still claim and finish); the R5-1 test failed before its fix; the pre-field, unlisted-key and quarantine cases above are green (Outcome criterion 3).

#### Phase 15 — Receipt layout ✓
- **Steps:**
  1. Restructure `BridgeReceipt.vue` in board order: header row, check + h2, hero (keeps `heroTestid` on the element holding digits and symbol), scanline band, account line (`TESTIDS.sendReceiptAccount`), `dl` (Gas ready keeps `gasTestid`; Review said `sendReceiptReviewSaid`; From `sendReceiptFrom`; Visibility), links, CTAs; the note outside the card. Addresses as `trimAddress(checksumAddress|safeAddressText(x), 6, 4)` with the full value in `title`; From only when address-shaped for its direction.
  2. `formatStamp` in `phase-clock.ts`.
  3. Scanline pass and convergence keyframes, each with a reduced-motion `!important` block.
  4. ≤760: padding 20, one-column `dl`, wrapping CTAs.
  5. Register the three testids.
- **Tests:** `BridgeReceipt.test.ts` rewrites the dense pins (`:39-42,64,85-90,136,155-158,199-205,223-224,256`) and asserts: From renders with `sender` and is absent without it or when malformed; Visibility on every direction (private and public deposits; a private exit reads "Sent from your private Aztec balance · arrives publicly on Ethereum", a public exit "Public — visible on Aztec and Ethereum"; neither ever calls the Ethereum side private); the account line uses the alias when present, else the address, and a bidi character is stripped; no "Gas used" row; one-link vs two-link note. `phase-clock.test.ts` three `formatStamp` cases. `pages/send.ts` `waitForReceipt` returns `from`; `specs/deposit-token-gas.spec.ts` asserts From contains the trimmed checksummed `l1.address`; `specs/exits.spec.ts` asserts From contains the actor's trimmed address.
- **Validation gate (LG for PR 4):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` exit 0. T for arc 5: receipts (private deposit with gas, public deposit, gas-only, exit) dark and light at 1440 and 390, plus review, amount (with the private veil on), breakdown, a done step-rail value and the background strip at 1440 dark for G38. The phase-13 grep now prints only `AmountStep.vue`'s `onUseAll`. Flag: the exit Visibility wording (both kinds); the public wording; R5-1's changed gas-only hero.

### Arc 6 — Faucet (PR 5)

The Faucet cards match DCQFaucet, with an honest proving panel and a one-row footer. Behaviour is unchanged: one drip at a time, and the other card now says why. Depends on arc 1 (`eye`, `eye-off`, `plus`; 12/24; neutral disclaimer; busy; light recess).

**Visible surfaces (dark and light at 1440, 1100 and 390 unless named):**
1. Disconnected: heading, header-row chip, "-" balances, disabled full-width buttons with icons, "Connect a wallet to drip." at the card bottom, intro copy, footer.
2. Connected idle: live balances; "Add SIGNAL to wallet" with a plus icon.
3. Dripping (1440, 390): busy drip button, the other button disabled, the proving panel pinned to the card bottom (label, `m:ss` timer, a moving bar with no percentage, "waiting for your wallet to prove and send_"); the other card's locked buttons with "One drip at a time: the SIGNAL drip is still running."
4. Dripped (1440, 390): "Sent **1,000 SIGNAL** to public · View tx"; the error strip in the new type sizes.
5. Add to wallet idle (plus 12), "Adding…", "Added" (check 12).
6. The faucet footer: one row under the cards, no tagline; credits stay links.

Mainnet renders only the placeholder (Fact 1), so `DripView`'s `IS_MAINNET` intro branch stays untouched. `Footer.vue`'s mainnet tagline ("Play tokens on Aztec mainnet · … · No real value") goes with the testnet one (G76); it is not the bridge's "Real funds" warning that Q5 B keeps.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G21 | Card heading an `h2`, body font 700 26, `--ul-tracking-heading` | `TokenCard.vue:191,267-270` | |
| G22 | Disclaimer chip in the header row opposite the h2; `.foot` and its comment deleted | `TokenCard.vue:190-193,237-245,351-354` | OQ31 A via G34 (tone from phase 3). |
| G136 | Header row, "Fixed drip:" line (14 ink-2, amount Mono 700 14 ink) as its own child at gap 16, status slot `margin-top: auto`; grid gap 20 → 24 | `TokenCard.vue:190-193,272-280,297-307`; `views/DripView.vue:70-74` | Grid `align-items: stretch` keeps both panels on one baseline. |
| G138 | Card root `<article aria-labelledby>` (h2 id via `useId()`); status panels `role="status"` | `D:ui/Card.vue:5`; `TokenCard.vue` | Card has one consumer; no `as` prop. |
| G137 | Intro "…mint fixed test tokens into a public or private balance. Internal drip. No real value.", max-width 640px, lh 1.5 | `views/DripView.vue:30-33,63-68` | OQ25 A; the dormant mainnet branch is left alone. |
| G20 | BalanceRow: a column of two 40px raised notch-2 rows, public first; eye 12 (public ink-2; private `--ul-accent-text` with eye-off), label 14 ink-2, value Mono 400 15 right | `D:composite/BalanceRow.vue:15-53` | OQ25 A. Value testids stay. |
| G19 | Drip buttons in a column, gap 8, full width, `size="large"` (48px, 16px, gap 10), leading 24px icon (eye-off private, eye public) except while loading | `TokenCard.vue:200-219`; `D:composite/DripButton.vue` (`icon?: IconName`, fixed large) | Private first, as the board orders them. |
| G83 | Add to wallet padding 0 4, gap 8, plus 12, Added check 12; success strip `role="status"`, 14px, gap 10: carrier check 12, "Sent `<strong>` amount `</strong>` to {target}", "View tx" 14/700 + external-link 12 | `TokenCard.vue:87-101,220-235,254-261,297-344` | `tl-drip-status`/`data-drip-status` stay on the same element in every state. |
| G84 | The global lock stays; the other card shows "One drip at a time: the {SYMBOL} drip is still running." and both its buttons point to it via `aria-describedby` | `TokenCard.vue:76`; `lib/testids.ts` (`dripLockReason`) | OQ25 A. `useDrip.ts:57-59` keeps its guard. |
| G23 | Proving panel (fill `--ul-field`, moved there by G72 in phase 1): label left + Mono 12.5 `m:ss` right (`aria-hidden`); an indeterminate 14px `ProgressBar`; Mono 12.5 log "waiting for your wallet to prove and send" + a static signal "_" | `TokenCard.vue:247-262`; `useDrip.ts:28,64` (`startedAt` on the lock); `lib/phase-clock.ts` (`formatClock`); new `D:ui/ProgressBar.vue` | OQ25 A: no percentage, never "on this device"; the timer uses `useNow()`. |
| G76 | `Footer.vue` one flex-wrap row (space-between, gap 12, 13 ink-3): "Contracts:" + SIGNAL/NOISE Mono accent links (dotted, offset 4) + "Dripper", credits right; no tagline on either network; mounted in `DripView` after `.cards`; `AppShell.vue:97-99` keeps only the bridge footer | `Footer.vue`; `views/DripView.vue`; `AppShell.vue:97-99` | The faucet board draws its own one-row footer, so the faucet keeps one; Q5 B's form-step rule is for the bridge footer (phase 21). Credits stay links (flag). |

#### Phase 16 — Card anatomy, intro and footer ✓
- **Steps:** `Card.vue` root `<article>`; `TokenCard.vue` header row with `<h2 :id>` + `DisclaimerTag`, `aria-labelledby`, the drip line as its own row, `.foot` deleted, the bottom slot pinned; `DripView.vue` intro, grid gap 24, `<Footer />` after `.cards`; `Footer.vue` rewritten (keeps `rel="noopener noreferrer"` and the plain-text fallback); `AppShell.vue` drops `<Footer>`.
- **Tests:** `Card.test.ts:11-14` expects `ARTICLE`; `TokenCard.test.ts` h2 text SIGNAL and `aria-labelledby` equals its id (`:85-95` still passes); `Footer.test.ts:29-32` inverted to "no tagline", `:34-40` and `:46-55` unchanged.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/drip.spec.ts` exit 0 (the card root, its heading and the footer's mount all move); baselines unchanged; `git diff --stat -- scripts/` empty.

#### Phase 17 — Balances, buttons, add-to-wallet, success strip, lock reason ✓
- **Steps:** BalanceRow rewrite (delete the "wallet convention" comment); DripButton `icon` prop, pinned large; TokenCard buttons in a column with `eye-off`/`eye`, add-to-wallet icon and spacing via a scoped class (beats the module's `.small`); the ok strip as markup with `role="status"` (`statusLabel` kept for dripping and error); `lockedBy` computed from `drip.inflight` and the reason `<p>` with `aria-describedby`; `dripLockReason: "tl-drip-lock-reason"`.
- **Tests:** `BalanceRow.test.ts:12-16` labels "Public"/"Private", `:47-53` public first, public row renders one svg; `DripButton.test.ts` icon idle, absent loading; `TokenCard.test.ts` NOISE in flight ⇒ SIGNAL card shows the reason and both buttons reference it, null ⇒ absent; `:151-160` extended to `role="status"` and "Sent 1,000 SIGNAL to public". `specs/drip.spec.ts` needs no edit.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/drip.spec.ts` exit 0 (plain, selfpay and full profiles; add-to-wallet still fails open to `unsupported`).

#### Phase 18 — Honest proving panel and the shared progress bar ✓
- **Steps:** `useDrip.ts` `inflight.startedAt = Date.now()` when the lock is taken (on the global lock, so it survives the card's account-keyed remount); `formatClock(ms)` in `phase-clock.ts` (arc 8 reuses it); `D:ui/ProgressBar.vue` exported (props `label`, `height` = 14, optional `value` 0–1, `tone`; indeterminate = `role="progressbar"` with no `aria-valuenow`, a 25% signal block with a 3px ink leading edge travelling a `--ul-line` track at `1.6s steps(8) infinite`, `animation: none` under reduced motion; determinate sets `aria-valuenow`; a notch-2 host declaring both vars); TokenCard's dripping branch becomes the panel with the timer `aria-hidden`.
- **Tests:** `phase-clock.test.ts` `formatClock` 0 → "0:00", 14 000 → "0:14", 160 000 → "2:40", 3 725 000 → "1:02:05"; `ProgressBar.test.ts` (indeterminate has no `aria-valuenow` and takes its name from `label`; `value` 0.45 ⇒ "45"); `useDrip.test.ts` `startedAt` is a number inside a pending `sendTx` (`:258-276` unchanged); `TokenCard.test.ts:217-237` the panel has `[role=progressbar]` without `aria-valuenow`, "waiting for your wallet", `.clock[aria-hidden]`; `mount-all.test.ts` entry.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/drip.spec.ts` exit 0. T for arc 6: disconnected and idle at 1440/1100/390, dripping (shoot on `data-drip-status="dripping"`, or on the drip button's `data-loading="true"` if proving is too fast) and dripped at 1440/390, add-to-wallet idle and after its click ("Added", or the `unsupported` fallback the test wallet answers with), dark and light. The arc's LG runs at phase 21 with arc 7.

### Arc 7 — Amount and review (PR 5)

The amount and review steps follow BridgeAmount and BridgeReview (the dark board is canonical; light supplies only the palette, OQ32 A) without changing what the user can do. The bridge footer becomes one line on the three form steps only (Q5 B). No stored-data or signing-flow change (OQ22 A). Depends on arc 1 (`key`, `eye`, `eye-off`, `zap`, `plus`, `minus`; 12/24; busy), arc 5 (G38's formatter) and arc 6 (the faucet footer already lives in `DripView`).

**Visible surfaces (dark and light at 1440, 1100 and 390):**
1. Amount, deposit: a disabled choice card states its reason in place of its caption ("unavailable" gets its own reason); the separate amber route and no-gas lines are no longer drawn (screen readers still hear them); balance line right-aligned at 13px; field cursor spacing; the private panel's off state reads "Public — visible on Aztec" with no raised card; the veil line with its spacing, a grey dot, a notch and a 90ms delay; the gas panel ("Token + gas" and "Gas") with a `zap` eyebrow, pixel −/+, an un-notched count well and the breakdown on an inset panel; Continue with a 24px chevron.
2. Amount, exit: the switch label, panel, veil and Continue changes.
3. The stale-review banner: 24px diamond, em-dash copy.
4. Review (private/public/first-time deposit, token-only, exit): the row grid, the Send symbol in ink, the gas note at 15px, eye/eye-off on Visibility, the Fee row as a Mono figure over an ink-3 prose note (table below), notes without their left edge, the Details summary with a leading chevron and a right-hand hint, the Details panel grid, a `key` icon on "Sign and send", the status-line spacing.
5. The connection error strip (every section): notch-2 and a 12px close.
6. The bridge footer on Token, Amount and Review only: one row, no "·" separators, regular-weight labels; testnet has no tagline; mainnet shows "Real funds — keep it small" as line 2 (dormant until a mainnet generation ships; unit-tested). Removed from the permit stepper, in-flight, the receipt, Activity and the bridge placeholder.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G53 | The reason is the card's caption; `aria-disabled` replaces native `disabled`; disabled edge `--ul-line`; no `title`; `noRoute: boolean` → `gasReason: string \| null`, so "unavailable" says "Gas options can't be checked right now." | `send/ChoiceCards.vue`, `send/AmountStep.vue` | OQ32 A. The `.route` lines (`AmountStep.vue:167-178`) become `sr-only` live regions keeping `tl-send-route-status`, `data-route` and `tl-send-token-only-blocked`; `aria-describedby` points at the in-card reason, which `accounts.spec.ts:172-174` and `fee-states.spec.ts:24-26` read. |
| G103 | `radiogroup` / `radio` / `aria-checked`; roving arrows kept | `send/ChoiceCards.vue:82-96` | OQ30 A: the only role swap. |
| G51 | `zap` 12 ink-2 with the label in ink; `.nudge` on `--ul-panel` with pixel `minus`/`plus` 24; stepper gap 4; count loses `ul-notch`, gap 8, 15px ink, input Mono 15/700 centred at 3ch; the `<hr>` and `.line` rows become a `<dl>` on an inset `--ul-panel` block; card gap 12 | `send/GasBreakdown.vue` | OQ32 A. Testids move onto `<div>` groups inside the `dl`. |
| G52 | `.balance-btn` align-self flex-end; value Mono 13 ink-2 | `send/AmountStep.vue:369-383` | Grouping from phase 13; `onUseAll` still types the ungrouped value. |
| G99 | Continue chevron 24 (`chevron`, rotate −90), padding 0 14 0 18 | `send/AmountStep.vue:258-261` | The alias `chevron` (`Icon.vue:7`). |
| G100 | Field gap 12 (10 at ≤760); unit Mono 14 at ≤760; `caret-color: transparent` inside the `@supports` block | `send/AmountStep.vue:297,321,336-367,485-499` | The native caret stays where `field-sizing` is unsupported. |
| G101 | Panel padding 14 16, gap 12; row gap 14; veil line gap 12; "·" in its own `aria-hidden` span in `--ul-disabled`; nav padding-top 4 | `send/AmountStep.vue:230-250,403-483` | |
| G102 | `animation-delay: 90ms` on the local `.veil`; veil wrapped in a notch-clipped host span | `send/AmountStep.vue:247,468-472` | The only veil; reduced motion already forces delay 0 (`base.css:341`). |
| G146 | Label follows `isPrivate` ("Private — only you can see it" / "Public — visible on Aztec"); raised card only when on; no On/Off sub-line; the switch keeps `aria-label="Private"` with the visible label as its description | `send/AmountStep.vue:230-245` | OQ32 A; wording matches the review's Visibility row. |
| G46 | Leading `key` 24 on "Sign and send", hidden while busy | `send/ReviewStep.vue:164-166` | |
| G48 | Fee `dd` a column: the Mono figure alone, then a 13/1.4 ink-3 prose note; `ReviewEstimate.networkFee` becomes `string \| null` (figure only), `networkFeeNote` the prose | `send/ReviewStep.vue:15-22,107-110,206-243`; `send/SendWizard.vue:474-517` | Prose leaks into the figure today (`SendWizard.vue:476-481,505,511-513`). Copy table below. |
| G49 | Visibility `dd` flex gap 8: eye-off 12 accent (private) or eye 12 ink (public), `<strong>` word, note 15 ink-2 | `send/ReviewStep.vue:103-106` | Colour the wrapper (Icon has no accent colour name); keep the literal space (`ReviewStep.test.ts:126`). |
| G50 | Summary: leading `chevron` 12 at −90 (0 open), gap 10, "Details", right-hand hint 13/400 ink-3 from the rows present, never naming Portal: "Token, route, slippage, account, signature" (token-only drops route and slippage; exit drops slippage); hint hidden at ≤760 | `send/ReviewDetails.vue:92-95,137-160` | OQ23 A; `ReviewStep.test.ts:265-270` guards "no portal in collapsed text". |
| G93 | Panel `dl` 104px + 1fr, gap 8 16, padding 4 14 14, 13px, dt ink-3, dd ink | `send/ReviewDetails.vue:163-213` | OQ23 A: full Portal link, Token link and all four portal states kept. |
| G91 | Rows grid 104px + 1fr, gap 16; Send row baseline; symbol ink; legs gap 6; gas note 15 ink-2; step gap 16; status 14 ink, gap 12, dots gap 3 | `send/ReviewStep.vue:172-297` | Keep literal spaces between spans (`ReviewStep.test.ts:81,101`). |
| G92 | `.soft` without its `::before` edge, padding 12 14; info/warn icons 24; error strip notch-2 with close 12 in its 28×28 box | `send/ReviewStep.vue:258-268`; `send/SendWizard.vue:1191`; `ConnectionErrorStrip.vue:39,47` | The strip is shell-wide. |
| G94 | " - " → " — " in the fee notes (`SendWizard.vue:484,492,507,515`), the stale banner (`:102,106`), the gas errors (`:322,333`) and the exit refusal (`composables/useHubExit.ts:121`) | same | `SendWizard.test.ts:1020` changes. In-flight strings are phase 22. |
| G74 | `BridgeFooter`: one flex-wrap row, gap 6px 14px; labels 400 ink-3; links ink-2 dotted; no separators; "Aztec:" margin-left 10; testnet no tagline; mainnet line 2 "Real funds — keep it small" | `BridgeFooter.vue` | Q5 B. Only `IS_MAINNET` from `@/lib/network` decides line 2. |
| G75 | Footer only while the wizard shows its form | `AppShell.vue:97-100`; `composables/useShell.ts`; `send/SendWizard.vue:1133-1160` | Q5 B; see phase 21. |

Closed with no change: G147 (one structure for both themes; no theme-conditioned metrics in touched files), G153 (placeholder stays "0"), G54 (OQ15 A: default stays Token), G124 desktop (OQ32 A).

**Fee copy (G48 + G94).** The figure is Mono; "—" means no figure. The phrases e2e reads (`deposit-token.spec.ts:210,241`) survive.

| Case | Figure | Note |
|---|---|---|
| gas leg, public | ≈ X FJ | taken from the gas that arrives |
| gas leg, private | ≈ X FJ, or — when unpriced | (unpriced: "priced from network fees at claim time, ") taken from the gas that arrives — a private claim sets aside its fee ceiling, not its exact cost |
| token-only, public FJ held | up to ≈ X FJ | from the Fee Juice you already hold — paid by your account as its own fee: your wallet shows the exact fee before you confirm |
| token-only, private held | ≈ X FJ, or — | from (unpriced: "paid from") the private gas you already hold — set aside in full from your gas at the fee contract: the claim's fee ceiling, not its exact cost |
| exit, public | — | your Aztec wallet's own fee, then Ethereum gas to finish |
| exit, private | ≈ X FJ, or — | from the private gas you already hold, then Ethereum gas to finish — set aside in full from your gas at the fee contract: the withdrawal's fee ceiling, not its exact cost |

#### Phase 19 — Amount step ✓
- **Steps:** `ChoiceCards.vue` roles, `aria-disabled` (CSS moves to `[aria-disabled="true"]`, so a blocked but selected card stays the tab stop), `gasReason`, `reasonOf(choice)` as the caption with an `id` for `aria-describedby`, the two sr-only spans and `title` deleted; `AmountStep.vue` passes `ROUTE_LABEL[routeKind]` as `gasReason`, makes both `.route` lines `sr-only`, and applies G52, G99–G102, G146; `GasBreakdown.vue` G51.
- **Tests:** `ChoiceCards.test.ts:21,48,52-80` roles, `aria-checked`, `aria-disabled`, reason as caption and describedby target, a new "unavailable" case, a disabled choice emits nothing on click; `AmountStep.test.ts` the G146 label flips while the switch's name stays "Private", `:86-98` and `:303-307` lines exist as sr-only; `GasBreakdown.test.ts` structure only; `tests/e2e/send-smoke.test.ts:629-630` (`aria-disabled`), `:699` (`aria-checked`); browser `pages/send.ts:66`, `fee-states.spec.ts:28`, `accounts.spec.ts:179` move to `aria-checked`; `tokens.spec.ts:97-99` unchanged (I1).
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/tokens.spec.ts specs/fee-states.spec.ts specs/accounts.spec.ts specs/deposit-token-gas.spec.ts` exit 0; baselines unchanged.

#### Phase 20 — Review step ✓
- **Steps:** `SendWizard.vue` rebuilds `networkFeeOf`/`heldGasFeeOf` to return `{ networkFee: figure | null, networkFeeNote: prose }` per the table (each helper under complexity 15; split per direction if needed; the bigint and every `formatCompact` call unchanged), the G94 sweep, `ReviewEstimate`'s doc; `ReviewStep.vue` G46, G48, G49, G91, G92; `ReviewDetails.vue` G50 and G93 with a `hint` computed from `showsRoute` and `buysGas`; `ConnectionErrorStrip.vue` G92.
- **Tests:** `ReviewStep.test.ts` `:102` keeps "Fee≈ 0.1 FJ taken from…" via a literal space, a figure-less row renders the note alone, the Visibility icon exists and `:126` holds, the hint lists route and slippage only when their rows exist and never matches `/portal/`; `SendWizard.test.ts:636-637,845,861,1002-1003,1018-1020,1039,1280` phrases move to `networkFeeNote`, figure cases assert `≈ …` or null; `testid-coverage.test.ts:136,148` fixture shape.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/deposit-gas-only.spec.ts specs/exits.spec.ts specs/registration-retry.spec.ts` exit 0.

#### Phase 21 — Bridge footer on the form steps ✓
- **Steps:** `SendWizard.vue` replaces its `v-if` chain with one `view` computed (`"permit" | "stepper" | "receipt" | "form"`) and publishes `view === "form"` to `useShell().bridgeForm` (reset by `__resetShellForTests`, false on scope disposal); `AppShell.vue` `<BridgeFooter v-if="section === 'send' && bridgeForm" />` (`SendView` is `v-show`n, so the flag is ANDed with `section`), and the `.foot` wrapper goes once empty; `BridgeFooter.vue` G74.
- **Tests:** new `BridgeFooter.test.ts` (testnet one row, no "·", no tagline; mainnet via a mocked `@/lib/network` renders "Real funds — keep it small"; a missing generation falls back to plain labels); `AppShell.test.ts:70-81` footer on send while the flag is set, absent on Activity and when the flag is off; `SendWizard.test.ts` the flag is true on the form and false once the stepper or receipt takes over.
- **Validation gate (LG for PR 5):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` exit 0. T for arc 7: amount (Token, Token + gas, Gas, private off, a no-route lookup token with disabled cards, and the exit amount step), the stale-review banner (as `fee-states.spec.ts` reaches it), the connection error strip if the harness can raise one (else the unit test), review (private first-time with Details closed and open, public token-only, private exit), the footer on the token step and its absence on in-flight and the receipt; dark and light at 1440, 1100 and 390. The mainnet footer is proved by its unit test (serving `build:mainnet` would show only the placeholder). Flag: the fee-note copy and the Details hint are new copy.

### Arc 8 — In-flight (PR 6)

The in-flight screen reads like DCQInFlight: a locked direction row, an 18px overall bar with "phase n of N · elapsed", the board's phase list beside this session's Log panel (Ask A1) and a raised footer band. No stored data and no remaining-time prediction; the stored event log (G11) stays in arc 10. Depends on arc 4 (edits the same `BridgePhaseRail.vue` first), arc 6 (`ProgressBar`, `formatClock`) and arc 7 (the page footer is already gone from in-flight).

**Visible surfaces (dark and light at 1440, 1100 and 390):**
1. Deposit in flight: a first row with the direction segment locked on "Ethereum → Aztec" (reverse video, disabled) + "Direction is locked while this send runs" (13 ink-3; wraps under a full-width segment on phones); the subline amount and symbol in Mono ink; Backup 40px with the save icon at 12; an 18px notched bar (signal fill, 3px ink leading edge, line-tone remainder) with "Crossing · phase 5 of 7" left and Mono "2:40 elapsed" right; the phase list with no spine, 12px glyphs, a static magenta square for the active phase (carrier once landed, no pulse), m:ss on done rows, a short estimate on time-based pending rows, "0:05" on the active row, no per-phase sub-bar; Crossing's static line "Aztec picks up deposits every few blocks. Nothing for you to do." until the live checkpoint count replaces it; the phase list at 330px beside a "Log · what actually happened" well (m:ss rows of this session's steps and trimmed tx hashes, the last row in ink with a static magenta "_"), stacked under the list at ≤760; a raised full-bleed footer band with "Run in background" (600, dotted underline offset 5) and its hint inline (wrapping on phones).
2. Permission prompt: the same chrome minus Backup, the footer band and the log (no record exists yet).
3. Exit in flight: the locked row shows "Aztec → Ethereum"; PROVE's proven-block fraction drives the bar; the detail keeps "Proven block n of m".
4. Failed phase: the fill turns `--ul-lost` at the failed phase; the caption reads "Crossing failed · phase 5 of 7"; Retry as phase 12 left it.
5. Unchanged: the background strip's prose eta, the receipt. Changed from the approved list (flagged for sign-off): a card's compact Crossing and Prove cells take the same measured fraction as the stepper, so a live cell starts on the line-tone track; a 1px inset outline in the live colour (amber on a needs-you card) keeps it distinct from a pending cell at 0%.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G55 + G27 (rail half) | Full phase list: 12px glyph column and icons; active glyph `<span class="square">` + sr-only "in progress"; `.landed` recolours carrier; done `formatClock(elapsedMs)`, active `formatClock(now − startedAt)` in signal, pending `estimate` ink-3; active li `align-items: flex-start`, label and detail stacked (gap 4, detail 13/1.4); delete the spine (`:249-265`), `.pulse` and its keyframes (`:136,177-185`) and the full-branch sub-bar (`:155-168`) | `BridgePhaseRail.vue` (full branch only); `lib/bridge-steps.ts` (optional `estimate`); `lib/phase-clock.ts` | OQ26 A. Estimates restate existing etas in short form (deposit "~1 min", sync "~1–4 min", confirm "~1–2 min"; withdraw prove "tens of min", confirm "~2 min"); signature-only phases get none; `eta` stays for the background strip. `data-phase`, `data-state`, `stepperPhase`, `sendStepperRegister` kept. |
| G126 | `section aria-labelledby` → `h2` via `useId()`; `ol aria-label="Phases"`; active or failed `li aria-current="step"` | `BridgeStepper.vue:79-82`, `BridgePhaseRail.vue:126-135` | The page h1 is "Bridge". |
| G128 | `prompts.sync` becomes the board sentence; the live checkpoint `stepDetail` still wins | `lib/bridge-steps.ts:159,296` | OQ26. |
| G94 (in-flight half) | " - " → " — " in `deposit-flow.ts:570,690` | `composables/deposit-flow.ts` | Same rule as phase 20. |
| G09 | Overall bar: `ProgressBar` with `value`, height 18, `aria-label="Bridge progress"`, valuetext "62 percent, Crossing", tone lost when failed, carrier when complete, width transition `360ms steps(6)`; caption "phase n of N" + total elapsed `m:ss` | `BridgeStepper.vue`; `lib/bridge-steps.ts` (`overallProgress`); `send/SendWizard.vue` (`startedAt` prop) | OQ26 A: fill = (done + active fraction) / N; no "about N min left". Global reduced motion already jumps per phase. |
| G10 | Locked direction row + caption above the header | new `send/DirectionSegment.vue` (moved from `WizardShell.vue:40-43,64-107,142-183` with its 760px rule), `WizardShell.vue`, `BridgeStepper.vue`, `lib/testids.ts` | OQ27 A. The stepper instance gets a `tl-stepper-direction` root testid and no per-button testids, so `pages/send.ts:45`/`pages/exit.ts:15` clicks never hit a disabled copy. `pick()` refuses when locked. |
| G56 | Raised footer band (`--ul-fill: var(--ul-raised)`, new `--ul-notch-4-bottom`); button 600, offset 5; Backup 40 / padding 0 14 / gap 8 with save 12 as a scoped override | `BridgeStepper.vue`; `D:base.css` | A plain band background would square the card's corners (notch lesson). The shipped Backup tooltip stays. |
| G125 | Subline amount in a Mono ink span (symbol via `safeDisplay`); title/subline gap 8; body rhythm 22 | `BridgeStepper.vue:66-75,113-133` | |

Closed: G127 (OQ27 A: Authorize stays). Deferred: G11's stored event log (arc 10); the board's 330px + log grid ships with the session-only log (phase 24b, OQ26 A). Dropped: "about 3 min left" (OQ26), the caption word "Signal clearing" (the live phase label is used instead), estimates on signature-only phases.

#### Phase 22 — The phase list and its data ✓
- **Steps:** `bridge-steps.ts` `estimate` on `BridgePhase` and its short-form table, attached by `buildPhases` to pending phases only; `prompts.sync` (G128); `BridgePhaseRail.vue` full branch per G55 and G126 (list part); `deposit-flow.ts` dash sweep.
- **Tests:** `bridge-steps.test.ts` (pending time-based phases carry `estimate`, signature phases and the active phase do not; the sync fallback copy at `:160`; `eta` unchanged); `BridgePhaseRail.test.ts` `:54-65` no progressbar in the full rail and "0:0x" instead of "usually 1-4 min", `:78` "14s" → "0:14", `:115-122` `.square.landed` instead of `.pulse`, `:132` → "no element has an animation class", plus `aria-current="step"` and `aria-label="Phases"`.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/exits.spec.ts` exit 0 (the full rail's DOM changes under `stepperPhases()`, which reads `data-phase`/`data-state`); baselines unchanged.

#### Phase 23 — Stepper chrome ✓
- **Order (two sittings):** extract `DirectionSegment.vue` first and commit once PG passes with `WizardShell.test.ts` unchanged (a pure move); then the rest.
- **Steps:** `overallProgress(phases)` (fraction = done + active `progress?.fraction ?? 0` over total; 1 only when every phase is done; `state` failed when one failed); `BridgeStepper.vue` in three regions (locked row padding 20 24 0; body padding 24, gap 22; band), `<section :aria-labelledby>` + `<h2>`, the headline as spans, `ProgressBar` + caption row, Backup override, band; `startedAt?` prop defaulting to `record.createdAt`, with `SendWizard.vue` recording `sendStartedAt` at `runSend`/`runExit` entry (`:887`) and passing it to both stepper mounts (else the clock jumps back at the permit → journal hand-over); extract `DirectionSegment.vue` (props `direction`, `locked`, optional `testids`), consumed by `WizardShell` and `BridgeStepper`; `testids.ts` `stepperDirection`, `stepperProgress`; `base.css` `--ul-notch-4-bottom`.
- **Tests:** `bridge-steps.test.ts` `overallProgress` table over the private-deposit sequence (granting → sealing → approving → signing → depositing → syncing → claim → confirm): non-decreasing fraction, `index`/`total`, failed state, exactly 1 only on `completedAt`; one backward-transition row: a retry that returns from Claim to Crossing lowers the fraction to the current attempt's value (no lifetime high-water mark survives the retry). `BridgeStepper.test.ts`: bar `aria-valuenow` and "phase n of N"; "m:ss elapsed" from a given `startedAt`; the locked row shows the record's direction selected and disabled, a withdraw the exit side; no band when `canBackground` is false; the heading is an `h2` naming the section. New `DirectionSegment.test.ts` (a locked click emits nothing; a `testids` override leaves no send testids) and its `testid-coverage.test.ts` entry. `WizardShell.test.ts` passes unchanged (`:25-27` tablist pin proves the extraction). `D:base-css.test.ts` the new notch token.
- **Validation gate:** PG + `bun run e2e:tools` exit 0 (every deposit and exit spec transits the stepper; `stepperPhases()`, `activity.spec.ts:152-167` and `spike.spec.ts:130-133` read only preserved attributes). T for arc 8: the permit prompt, `06-inflight`, a failed phase if reachable, an exit in PROVE; dark and light at 1440/1100/390; no horizontal scroll at 390.

#### Phase 24 — Checkpoint fraction feeds the bar ✓
- **Steps:** `useBridgeJournal.ts` `awaitCheckpointGate` (`:1290-1307`) also sets runtime-only `checkpointsLeft` and `checkpointSpan = max(previous span, left)` on `RecordRuntime` (`:104-131`) beside its `setStep`; `bridge-steps.ts` `syncProgress` prefers the block snapshot and falls back to `{ current: span − left, target: span }` when `span > 0`. The gate stays the only authority; these fields gate nothing.
- **Tests:** `useBridgeJournal.stages.test.ts` (near `:219`) a shrinking `checkpointsLeft` with a fixed span; `bridge-steps.test.ts` checkpoint fraction, none when the span is 0.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/deposit-token-gas.spec.ts specs/spike.spec.ts` exit 0; the bar advances inside Crossing when the sandbox reports checkpoints; claim timing unchanged. Re-run T for `06-inflight` only.

#### Phase 24b — Session log (OQ26 A, Ask A1) ✓
- **Steps:**
  1. `RecordRuntime` (`useBridgeJournal.ts:104-131`) gains runtime-only `log?: readonly { at: number; text: string }[]`. `setStep` (`:767`) appends the new step's fixed phrase (a `LOG_PHRASE: Record<BridgeStep, string>` table in `lib/bridge-steps.ts`, symbols through `safeDisplay`) when the step changes to a defined value; `reload()` (`:302`) compares each record that already has a log with its previous copy and appends one row per newly present tx hash (`depositTxHash`, `approveTxHash`, `registerTxHash`, `claimTxHash`, `exitTxHash`, `consumeTxHash`) that passes `/^0x[0-9a-f]{64}$/i` (a `wd-pending…` placeholder or malformed value logs nothing), worded neutrally as "{Leg} hash observed · {trimmed}" through `safeAddressText`, never "sent" or "confirmed" (another tab's write reaches the same `reload()`). At most 50 entries per record. Nothing is persisted: no storage key, no backup field, no `lastCompleted` change.
  2. Never logged: `note`, `stepDetail`, error text, secrets, envelopes, addresses beyond a trimmed tx hash.
  3. `BridgeStepper.vue`: the body stacks by the stepper's OWN width, not the viewport: the stepper root is a `container-type: inline-size` container and an `@container (min-width: 640px)` rule turns the body into a grid `330px minmax(0, 1fr)`, gap 24, phase list left; below that the log stacks under the list (at 768px viewport with rail and dock the stepper is ~404px wide, so a viewport rule would leave the log ~50px). Log rows wrap (`overflow-wrap: anywhere`), so a long failure line or hash never overflows. The log: "Log" 13/700 + " · what actually happened" 400 ink-3, then a `role="log"` well (`--ul-field`, notch-2, padding 14 16, gap 6, Mono 12.5/1.5) of the last 8 rows (a notch host cannot scroll), each `formatClock(at − startedAt)` in ink-3 + text in ink-2, the last in ink with a static signal "_". Rendered only by interpolation; hidden on the permission prompt (no record). `TESTIDS.stepperLog`.
- **Tests:** `useBridgeJournal.test.ts`: `setStep` appends one phrase per step change and none for a repeat or `undefined`; a patched `depositTxHash` appends one "observed" row, a second reload none; a hash written by another tab (a `storage` event into `reload()`) logs the same neutral row and never a "sent"/"confirmed" phrase; a malformed hash or a `wd-pending` placeholder logs nothing; a provisional record re-keyed mid-run keeps its log once, with no duplicated or lost hash row; the boot `reload()` and a restored record log nothing; the cap holds at 50; a run whose note, `stepDetail` and record carry sentinel strings (a secret, an error message) never puts them in `log`. `BridgeStepper.test.ts`: the log is `role="log"`, shows at most 8 rows with m:ss offsets from `startedAt`, renders a hostile symbol as text, and is absent on the permission prompt. `testid-coverage.test.ts` `stepperLog`. `deposit-token.spec.ts`: while the stepper shows, `tl-stepper-log` holds at least one row.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/deposit-token.spec.ts specs/deposit-token-gas.spec.ts specs/exits.spec.ts` exit 0; the phase's commits touch nothing under `packages/bridge-core` (`git diff --stat <phase-base> -- packages/bridge-core` is empty: no stored field); baselines unchanged. T: `06-inflight` (deposit, with several log rows) and an exit in PROVE, dark and light at 1440, 1100 and 390 (390 shows the stacked log, no horizontal scroll). The tour spec also asserts, at 761 and 820 wide with the desktop dock open, that the log is stacked or at least 240px wide and that neither the stepper nor the page scrolls horizontally with a long failure note and a full hash row present. Flag: the log phrases are new copy; a page reload starts the log empty.

### Arc 9 — Mobile, ≤760px (PR 6)

At phone width the app is one column, as the Mobile board draws it: no dock or strip (unmounted since phase 11; the Activity tab's magenta count is the signal, Q3 A), a horizontal step strip, full-width chips, and the phone amount step with Back and the gas breakdown kept, opening from the row hint (OQ13 A, OQ14 B). Nothing changes above 760px except shared markup that renders identically on desktop. Depends on arcs 2 (StepStrip states), 3 (the 22px phone chip, chips), 4 (tablet dock and the ≤760 unmount), 7 (radiogroup, in-place reasons, gas panel) and 8 (`DirectionSegment`).

**Visible surfaces (390, dark and light unless noted):**
1. Every screen: the grid column the dock left behind collapses, the card spans x 16–374, and no persisted "open" dock covers the page (the dock itself is gone since phase 11).
2. Top band: insets 8/16, a 36px brand row, 40px tabs; the theme control stays the cycling button (Q1 A); the Activity tab carries the 22px magenta chip.
3. Page header: the subline wraps instead of ending in "…"; h1 26/1.2.
4. Wallet chips: full-width stacked 44px one-line rows, 6px apart (dot, label, address right, trailing icon); Ethereum keeps its ×, Aztec its chevron; the wrong-chain "Switch to …" drops to a second line inside the chip; disconnected Connect buttons full width.
5. Wizard head: the direction switch full width with 36px one-line buttons; "Step N of 3" hidden; a horizontal three-cell strip (done raised with a 12px check and the value in Mono 13, active signal-tint, todo outlined numeral, no hints).
6. Amount step: a visible "What arrives" heading over three 40px one-line rows with short hints; an "Amount" label row with the balance right above a 60px field; the private switch without its panel; full-width Continue over full-width Back; the selected gas row's hint ("gas for **N** transactions" or "all of it as gas", with a 12px chevron) toggles the gas breakdown, which opens by itself on an error or cap note. New short copy: "only the token" / "gas for **N** transactions" / "all of it as gas" / "back to Ethereum"; disabled "not for this token", "can't check right now", "needs gas first".
7. Regression only: 1440 and 1024 captures of token, amount and review.

**Gaps**

| G-id | Change | Files | Decision / notes |
|---|---|---|---|
| G17 (layout half) | One-column shell grid at ≤760 | `AppShell.vue` (grid `:177-181`) | Q3 A (OQ12 A). The dock half (unmount, overlay rule) is phase 11, so the persisted "open" (`useDockState.ts:75`) and auto-open (`ActivityDock.vue:105`) have no surface at ≤760 from PR 3 on. |
| G113 | Band padding 8 16, row gap 6, brand row 36 space-between, brand padding 0 | `AppShell.vue:183-201` | Board. |
| G70 | Subline wraps; h1 lh 1.2; titles gap 4; header padding 14 16; column gap 12 | `SectionHeader.vue:31-44,53-69` | Board. |
| G18 | Horizontal step strip; position hidden; full-width one-line direction toggle | `send/WizardShell.vue:111,119,153-162,205-218`; `send/StepStrip.vue:109-179`; `send/DirectionSegment.vue` | Horizontal mode exists; only its styling and the orientation switch change; roles stay a tablist (OQ30 A). |
| G69 | Wallet chips stacked full-width 44px one-line rows | `SectionHeader.vue:46-51,65-68`; `L1WalletPanel.vue:34-46,56-61`; `AccountSwitcher.vue:230-244,259-265,451-456`; `AztecWalletPanel.vue:150-154` | OQ13 A (keep ×). CSS only; every testid untouched. |
| G71 + G124 (phone half) | Phone amount step as above; field labels 13/700; the breakdown opens from the selected gas row's hint, a button that is a DOM sibling of that row's radio | `send/ChoiceCards.vue:82-110,196-210`; `send/AmountStep.vue:180-260,479-499`; `lib/send-model.ts` (`hintOf`) | OQ14 B, faithfully (Ask A4, D22). The board's "Token + gas enabled, Gas disabled" state cannot occur; no-route disables both gas rows. |

#### Phase 25 — One column: band and header ✓
- **Steps:** `AppShell.vue` ≤760 one-column grid (`grid-template-columns: minmax(0, 1fr)`; the dock's column has been empty since phase 11), band and brand metrics (G113); `SectionHeader.vue` ≤760 rules (G70); verify the 22px phone chip from phase 7.
- **Tests:** none new: jsdom does not lay out, so the tour proves the grid; phase 11's `AppShell.test.ts` phone case and the 390 `spike.spec.ts` case stay green.
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/spike.spec.ts` exit 0 at both widths.

#### Phase 26 — Wizard head and wallet chips ✓
- **Steps:** `WizardShell.vue` `:orientation="phone ? 'horizontal' : 'vertical'"` and its ≤760 head rules (`.position { display: none }`, a CSS hide that keeps `WizardShell.test.ts:85-86` valid); `DirectionSegment.vue` ≤760 (`flex: none`, `.seg { min-height: 36px; padding: 0 8px; white-space: nowrap }`); `StepStrip.vue` horizontal-only rules (ellipsis on long values with `aria-label` keeping the full name; done raised with check 12 and `data-valued` Mono 13; marker 800 11; todo ink-2/ink-3 with the line inset); wallet chip ≤760 rules (column wrap, 44px rows, identity row with the address pushed right, L1 `flex-wrap` with `.wrong-chain { order: 1; flex-basis: 100% }`, Connect buttons `width: 100%`).
- **Tests:** `WizardShell.test.ts:74-78` vertical kept, +1 phone case ⇒ `orientation="horizontal"`; `StepStrip.test.ts` +1 horizontal (a done step with a value renders `data-valued` and a 12px check; without a value it does not). Chip CSS is proved by the tour (jsdom does not lay out).
- **Validation gate:** PG + `bash apps/tools/scripts/e2e/agent.sh specs/spike.spec.ts specs/accounts.spec.ts specs/l1-wallet.spec.ts` exit 0 (390 connects through the stacked chips; 1440 guards the chip and menu DOM).

#### Phase 27 — Phone amount step ✓
- **Steps:**
  1. `ChoiceCards.vue` (on phase 19's radiogroup): a `<div class="choices">` with `<span :id class="heading">What arrives</span>` naming the radiogroup via `aria-labelledby` (sr-only above 760); each choice sits in a `role="none"` row wrapper, a two-cell CSS grid whose radio spans both cells; a `.hint` span shown at ≤760 while `.desc` is `display: none` (only one in the accessibility tree); a `txTarget` prop; a pure `hintOf(choice, state)` in `lib/send-model.ts`; ≤760 rows 40px, label 15, hint 12.5 ink-2.
     **The row-hint button (OQ14 B, A4).** At ≤760 the selected gas row (Token + gas or Gas; only they have a breakdown) renders its hint as a `<button type="button" :aria-expanded :aria-controls>` that is a DOM sibling of that row's radio, never inside it, placed over the radio's hint cell by the grid (`z-index: 1`); its text is the hint + a 12px chevron + an sr-only ", gas breakdown", and that row's in-radio hint is `display: none`. It emits `toggle-gas`; a tap on it never selects, and the arrow keys still walk only the radios (`move()` queries `[data-index]`, and its key handler is bound on the radios, not the group). In tab order it is the stop right after the selected radio, still inside the radiogroup's subtree (valid: a required owned `radio` is a presence rule, not an exclusive-child list; it departs from the APG single-tab-stop pattern by one extra stop). `TESTIDS.sendGasDisclosure` on it.
  2. `AmountStep.vue`: `.amount` as a grid with named areas (desktop keeps field → balance → error; ≤760 `"label balance" "field field" "err err"` with an `aria-hidden` "Amount" label; the balance symbol in a span hidden at ≤760 so the text stays "Balance 0.005 USDC"); `gasOpen` toggled by `toggle-gas` and reset on each token pick; GasBreakdown carries the `id` the hint button controls and, at ≤760, shows (`v-show`, so `aria-controls` always resolves) when `gasOpen || gasError || gas?.capped`, which is also the button's `aria-expanded`; `.privacy` without its panel at ≤760; field labels ("What arrives", "Amount") 13/700 at ≤760 (G124 phone half); `.nav` `column-reverse` with both buttons full width and a 12px chevron.
- **Tests:** `send-model.test.ts` one `hintOf` table (token; token+gas at N = 1 and 2; gas; exit; the three disabled reasons); `ChoiceCards.test.ts` the radiogroup is named by the heading and exposes exactly three `role=radio`, none containing a button; at phone width the selected gas row's hint button has `aria-controls` naming the breakdown; clicking it emits `toggle-gas` and no `update:intent`; ArrowRight from a radio skips it; ArrowRight on the hint button moves nothing; Tab from the selected radio lands on the hint button and Shift+Tab from it returns to that radio; the button's accessible name is the hint text plus ", gas breakdown". `AmountStep.test.ts` with phone `matchMedia`: breakdown hidden and the hint button `aria-expanded="false"`, a click shows it and flips `aria-expanded`; `gasError` or a capped plan shows it without a click, `aria-expanded="true"`; desktop renders the breakdown with no hint button. `testid-coverage.test.ts` `sendGasDisclosure`; `spike.spec.ts` 390: the hint button is visible in the selected gas row and `tl-send-gas-breakdown` hidden until it is clicked.
- **Validation gate (LG for PR 6):** PG + BG + `bun run audit:tools` + `bun run e2e:tools` exit 0; complexity manifest has no new entries. T for arc 9 (`zz-arc9`): surfaces 1–6 at 390 dark and light, the amount step with the breakdown opened from its row hint, a 390 capture with a seeded "open" dock preference, a wrong-chain chip only if the harness can produce one; token/amount/review at 1440 and amount at 1024 as regression shots. Pass: no capture at 390 shows a dock column at x ≥ 346. Flag: the short hints are new copy; the hint button is a separate tab stop after the radio group; `column-reverse` makes Tab order Back → Continue.

## Gap traceability

Every inventory id, G01–G153: built (133), dropped (6), deferred to arc 10 (6), or closed with no change (8). The "Already matching (do not touch)" list in recon.md carries no G-ids; it is binding on every phase. One gap found while drafting has no G-id: **R5-1** (gas-only amounts shown as the paid token), built on every surface in phases 10, 11 and 14. OQ26 A's session log (phase 24b) is not G11, which stays deferred.

| G-id | Where | G-id | Where | G-id | Where |
|---|---|---|---|---|---|
| G01 | arc 1 · phase 2 | G52 | arc 7 · phase 19 | G103 | arc 7 · phase 19 (OQ30 A) |
| G02 | arc 1 · phase 1 | G53 | arc 7 · phase 19 | G104 | **dropped** (OQ30 A) |
| G03 | arc 2 · phase 4 | G54 | no change (OQ15 A: default stays Token) | G105 | **dropped** (OQ30 A) |
| G04 | **dropped** (Q1 A: cycling button kept) | G55 | arc 8 · phase 22 (OQ26 A) | G106 | **dropped** (OQ30 A) |
| G05 | arc 1 · phase 2 | G56 | arc 8 · phase 23 | G107 | arc 3 · phase 7 (shell); arc 4 · phase 11 (dock) |
| G06 | arc 3 · phase 9 | G57 | arc 4 · phase 10 (OQ8 A) | G108 | arc 3 · phase 7 |
| G07 | arc 2 · phase 5 (Q2 A) | G58 | arc 4 · phase 10 | G109 | arc 3 · phase 7 |
| G08 | arc 2 · phase 4 | G59 | arc 4 · phase 10 | G110 | arc 3 · phase 7 |
| G09 | arc 8 · phase 23 | G60 | arc 4 · phase 10 | G111 | arc 3 · phase 7 (OQ33 A) |
| G10 | arc 8 · phase 23 (OQ27 A) | G61 | arc 4 · phase 10 | G112 | no change (OQ33 A) |
| G11 | **deferred to arc 10** (stored event log); OQ26 A's session-only log is arc 8 · phase 24b (Ask A1) | G62 | arc 4 · phases 10–11 (OQ28) | G113 | arc 9 · phase 25 |
| G12 | arc 4 · phase 10 (OQ8 A) | G63 | **dropped** (OQ28: in-flight explorer links stay) | G114 | arc 2 · phase 4 |
| G13 | arc 4 · phase 10 (Q6 B) | G64 | arc 4 · phase 10 (OQ28) | G115 | arc 2 · phase 5 |
| G14 | arc 2 · phase 6 | G65 | arc 3 · phases 8–9 | G116 | no change (OQ17 A) |
| G15 | arc 2 · phase 6 | G66 | arc 3 · phase 9 (OQ19 A; unknown types flagged, D25) | G117 | **dropped** (OQ18 A) |
| G16 | arc 4 · phases 10–11 (OQ2 A) | G67 | arc 3 · phase 8 | G118 | arc 2 · phase 4 |
| G17 | arc 4 · phase 11 (dock unmounted ≤760); arc 9 · phase 25 (one-column grid) (Q3 A) | G68 | arc 4 · phase 11 (761–1100 and ≤760) | G119 | arc 4 · phases 10–12 |
| G18 | arc 9 · phase 26 | G69 | arc 9 · phase 26 (OQ13 A) | G120 | arc 4 · phase 12 |
| G19 | arc 6 · phase 17 | G70 | arc 9 · phase 25 | G121 | arc 4 · phase 12 |
| G20 | arc 6 · phase 17 (OQ25 A) | G71 | arc 9 · phase 27 (OQ14 B, row-hint button) | G122 | **deferred to arc 10** (skeleton) |
| G21 | arc 6 · phase 16 | G72 | arc 1 · phase 1 | G123 | arc 1 · phase 1 |
| G22 | arc 6 · phase 16 | G73 | arc 1 · phase 1 | G124 | arc 5 · phase 15 (receipt); arc 9 · phase 27 (phone); desktop no change (OQ32 A) |
| G23 | arc 6 · phase 18 (OQ25 A) | G74 | arc 7 · phase 21 (Q5 B) | G125 | arc 8 · phase 23 |
| G24 | arc 4 · phase 10 | G75 | arc 7 · phase 21 (Q5 B) | G126 | arc 8 · phases 22–23 |
| G25 | arc 4 · phase 10 (OQ28; card comparison dropped) | G76 | arc 6 · phase 16 | G127 | no change (OQ27 A) |
| G26 | arc 1 · phase 2 | G77 | **deferred to arc 10** (OQ29 B) | G128 | arc 8 · phase 22 |
| G27 | arc 3 · phases 7, 9 (chrome); arc 8 · phase 22 (rail) | G78 | **deferred to arc 10** (tooltip) | G129 | arc 4 · phase 10 (partial, OQ28) |
| G28 | arc 3 · phase 7 | G79 | arc 2 · phase 4 | G130 | arc 4 · phase 10 (OQ33 A) |
| G29 | arc 3 · phase 7 (OQ21 A) | G80 | arc 2 · phase 4 | G131 | arc 4 · phase 10 |
| G30 | arc 3 · phase 7 (OQ10 A) | G81 | arc 2 · phase 4 (OQ17 A) | G132 | arc 4 · phase 10 |
| G31 | arc 4 · phase 11 (OQ11 A) | G82 | arc 2 · phases 4–5 | G133 | arc 4 · phase 10 |
| G32 | arc 4 · phase 11 (OQ9 A) | G83 | arc 6 · phase 17 | G134 | arc 4 · phase 10 (OQ28) |
| G33 | arc 4 · phase 11 | G84 | arc 6 · phase 17 (OQ25 A) | G135 | arc 4 · phases 10–11 |
| G34 | arc 1 · phase 3 (OQ31 A) | G85 | arc 1 · phase 1 | G136 | arc 6 · phase 16 |
| G35 | arc 1 · phase 3 (Button); arc 2 · phase 4 (MintStrip); arc 4 · phase 11 (ActivityRow) | G86 | arc 4 · phase 11 | G137 | arc 6 · phase 16 (OQ25 A) |
| G36 | arc 1 · phase 3 | G87 | arc 5 · phase 15 | G138 | arc 6 · phase 16 |
| G37 | arc 4 · phase 12 | G88 | arc 5 · phase 15 | G139 | arc 3 · phase 9 (OQ20 A) |
| G38 | arc 5 · phase 13 (OQ3 A) | G89 | arc 5 · phase 15 | G140 | arc 3 · phase 8 |
| G39 | **deferred to arc 10** (OQ4 A) | G90 | arc 5 · phase 15 (receipt); arc 4 · phase 10 (card links) | G141 | arc 3 · phase 8 (OQ33 A) |
| G40 | arc 5 · phases 14–15 (Q4 B) | G91 | arc 7 · phase 20 | G142 | no change (OQ33 A) |
| G41 | arc 5 · phases 14–15 | G92 | arc 7 · phase 20 | G143 | arc 2 · phase 6 (OQ33 A) |
| G42 | arc 5 · phase 15 (OQ6 A) | G93 | arc 7 · phase 20 (OQ23 A) | G144 | no change (OQ33 A) |
| G43 | arc 5 · phases 14–15 (OQ7 A) | G94 | arc 7 · phase 20; arc 8 · phase 22 (in-flight strings) | G145 | arc 1 · phase 2 (AddressDisplay half dropped) |
| G44 | arc 5 · phase 15 | G95 | arc 2 · phase 6 | G146 | arc 7 · phase 19 |
| G45 | arc 5 · phase 15 (OQ6 A) | G96 | arc 2 · phase 6 | G147 | no change (OQ32 A) |
| G46 | arc 7 · phase 20 | G97 | arc 2 · phase 6 | G148 | arc 4 · phase 10 (Q6 B) |
| G47 | **deferred to arc 10** (OQ22 A) | G98 | arc 1 · phase 1 (pulled from arc 2) | G149 | arc 4 · phase 11 (Q3 A) |
| G48 | arc 7 · phase 20 | G99 | arc 7 · phase 19 | G150 | arc 4 · phase 10 |
| G49 | arc 7 · phase 20 | G100 | arc 7 · phase 19 | G151 | arc 4 · phase 10 |
| G50 | arc 7 · phase 20 (OQ23 A) | G101 | arc 7 · phase 19 | G152 | arc 2 · phase 4 |
| G51 | arc 7 · phase 19 | G102 | arc 7 · phase 19 | G153 | no change (OQ32 A) |

## Decision ledger

| # | Decision | Chosen | Rejected and why | Source |
|---|---|---|---|---|
| D1 | Plan shape | Surface arcs 1–9 in 6 stacked PRs, visible fixes first, with outline B's dedup grafted (one tone table, one focus trap, one progress bar, one direction segment; no primitive without a board and a consumer) | Outline B's primitive library PR + gallery + screenshot-diff CI gate: later visible wins, 40–60-file PRs, new CI surface and re-baselining | planner; outline B |
| D2 | PR grouping | PR 1 arc 1; PR 2 arcs 2–3; PR 3 arc 4; PR 4 arc 5; PR 5 arcs 6–7; PR 6 arcs 8–9, as a target: a layer whose diff is not reviewable in one sitting splits at a phase boundary (Delivery) | 9 PRs (nine sign-offs); fewer, larger PRs (not reviewable in one sitting); a fixed six regardless of size (Codex M7). Arc 5 stays alone because it carries the stored field. Arcs 6–7 share the footer decision; arcs 8–9 share `DirectionSegment` | planner; audit round 1 |
| D3 | Theme control | Unchanged cycling button (icon size only) | Radiogroup (G04) | owner Q1 A |
| D4 | "Our list" for brand tiles | Exact `chainId:address` table + `source === "manifest"` rows; sprite sheet retired | Committed sprite keys only (testnet all grey); symbol-based brand for list/pasted tokens (spoofable) | owner Q2 A; Ask A2 |
| D5 | Sender | One optional `sender` per record type, written at build (both deposit call sites and the exit), shape-checked on load, format-checked at render, no schema bump | Reuse `sealerL1` (private-only, post-send); read the connected account (Q4 B forbids); strict format check in `backup.ts` (quarantines funds records over a cosmetic field) | owner Q4 B; data recon |
| D6 | Failure vs needs-you | One `classify` reading with four outputs (status, group/rank, `counts`, actions). Status lost > running > done > needs-you; lost = any runtime attention or persisted `blocked`, overriding completion and busy; running = busy and not completed. Ownership is a separate axis. Count and auto-open take lost and needs-you of the active account. `data-attention` kept as an attribute only | Keep amber on every attention (Q6 C); lost without an edge (Q6 A); the draft's done-first precedence (a completed blocked record read as successful, Codex H2); ownership as a status (Codex M3); lost left out of the count (Opus M1) | owner Q6 B; audit round 1 |
| D7 | Narrow dock | ≤760 unmounted (phase 11, beside the tablet overlay); 761–1100 in-memory tap-only overlay over `.ul-scrim`, persisted "open" and auto-open ignored; >1100 unchanged | Phone sheet (Q3 B); status quo (Q3 C) | owner Q3 A; Ask A3 |
| D8 | Footer | One `view` computed drives both the wizard template and `useShell().bridgeForm`; faucet footer lives in `DripView`, one row, no tagline, credits kept as links | Teleport into `.foot` (mount-order coupling); board footer credits as plain text (drops working links) | owner Q5 B; arc 6/7 drafts |
| D9 | Amount display | New `formatDisplayAmount` replaces `toDecimalString` on display sites; `toDecimalString` kept for the typed field; `formatCompact` for "≈" quotes | `formatStoredAmount` (truncates, which OQ3 forbids) | OQ3 A |
| D10 | Icons | 12 vendored names (`reload` = Retry, `repeat` = New send, `receipt` dropped); `Icon.size` typed `12 \| 24` | Hand-edited paths; 16px kept | arc 1 draft; recon correction |
| D11 | Wordmark | Re-subset adding U+0055 only | Full A–Z (dead bytes: boards draw only "Unleashed" and digits) | arc 1 draft |
| D12 | Light recess | `--ul-field` + `--ul-track`; `--ul-well` kept for page recess with light → sheet | recon's three new tokens (paper would erase placeholders on bg) | arc 1 draft |
| D13 | Busy state | `BusyPixels` replaces `Spinner`; `Button` emits no `click` while `loading` (keyboard included); the call sites' `disabled` and operation guards stay the authority; `pointer-events: none` kept as cosmetics | CSS as the double-sign guard (it stops only the mouse, Codex M5); the board's `cursor: progress` (needs pointer events; a recorded deviation) | arc 1 draft; audit round 1 |
| D14 | Dialogs | `Dialog` + `useFocusTrap` in `packages/design` with a reactive `enabled`, the full focusable set minus hidden elements, and a `nextTick` focus dropped if the dialog left meanwhile; the dock adopts the trap with `shouldYield` | Four hand-rolled traps; a fifth for the × shell; a buttons-only trap (skips links and inputs, Codex M4) | arc 3 draft + outline B graft; audit round 1 |
| D15 | OQ30 | Only `ChoiceCards` becomes a radiogroup; G104–G106 dropped | Deferring the swaps to arc 10 (OQ30 A answers them now) | OQ30 A |
| D16 | In-flight log | Session-only log (phase 24b): runtime `log` per record fed by `setStep` and the `reload()` tx-hash diff, fixed phrases and trimmed hashes only, 330px phase list beside it, stacked at ≤760 | Not built (the draft: misread Scope, which defers only the stored log); a persisted event log (G11, new stored data, arc 10) | OQ26 A; Ask A1; Opus H1 |
| D17 | Progress bars | One `ProgressBar` (indeterminate for the faucet, determinate for in-flight); no percentage on the faucet, 100% only on `completedAt` in-flight | Two bars; a fake percentage (OQ25) | arc 6/8 drafts |
| D18 | Card comparison | Cards drop "review said / you got" (G25); the receipt keeps it | Board-exact (a card compares one stored amount with itself) | arc 4 draft |
| D19 | Other-account rows in the dock | A trailing "Other account" group for needs-you records of another account (lost ones stay with lost, D26) | Mixing them into needs-you (OQ28 removes them from the count) | arc 4 draft (flag) |
| D20 | Exit receipt | A Visibility row with honest wording: "Sent from your private Aztec balance · arrives publicly on Ethereum" (private exit) or "Public — visible on Aztec and Ethereum" | No Visibility row (the draft; Q4 B has no exit exception, Codex M9); any wording implying privacy on Ethereum | owner Q4 B; audit round 1 (flag) |
| D21 | R5-1 | One `displayAmountOf(rec)` on every gas-only amount surface: card and toast (phase 10), dock and "this send" rows (11), receipt (14), each test-first; the toast also gets the record's own symbol and decimals | Receipt only (the draft; the card, dock and toast kept the wrong figure, Opus H2); left for a later PR | arc 5 draft; audit round 1 |
| D22 | Phone gas breakdown | The selected gas row's hint is a button, a DOM sibling of its radio laid into the row by CSS grid, `aria-expanded`/`aria-controls` to the breakdown, forced open on error or cap | A disclosure under the rows (the draft; not what OQ14 B says, Codex M8); a button inside the radio (invalid ARIA) | OQ14 B; Ask A4; audit round 1 |
| D23 | Screenshots | App captures as compressed JPEG, embedded in PR bodies; boards never committed or embedded | Attached by hand (the CLI cannot attach images); board side-by-sides in PRs (private canvas in a public repo) | task rule; `AGENTS.md` |
| D24 | Visual gate | None in CI; owner's written sign-off on screenshots | Screenshot baselines (declined in the reskin, D10 there) | previous plan; outline B rejected; Opus M3 |
| D25 | Wallet type chip | "Extension" / "Web app"; any other claim a neutral "Unknown type" chip with the sanitised claim only in `title` ("Self-reported: …"). **Flagged, security-motivated deviation from OQ19 A** | OQ19 A literal ("unknown types pass through as sent"); the draft's sanitised pass-through (still prints "Verified wallet") | Codex M6 |
| D26 | A lost other-account record | Status lost (red chip and edge), ranked and grouped with lost records, not counted | The trailing "Other account" group (below done records a failure is quieter than a claim, against Q6 B) | Codex H2; Opus M1 |
| D27 | Brand tiles by network | Ask A2 unchanged on every network; testnet USDC/USDT branding flagged at sign-off | **Rejected (Opus M4):** gate symbol/manifest brand tiles off on mainnet. Reviewed manifest provenance is what authorizes branding: manifest rows are built internally from the committed manifest's `t.erc20` on the L1 chain (`useTokenCatalog.ts:55`), remote entries are forced to `source: "list"`, and a manifest row wins an address collision, so a mainnet generation's reviewed manifest is exactly "our list". Branding is presentation only, never an attestation or execution permission; a regression pins that a remote entry claiming `source: "manifest"` stays untrusted (phase 10) | audit round 1 |

**Disputed items:**
- **M2 (Opus):** retryable errors red vs amber. Kept red per Q6 B literal ("a failure is never quieter than a claim"); retryable cards keep Retry. Codex agreed in round 2 ("Lost signal" describes the operation, "funds are not lost" the assets). Flagged for the owner's sign-off with a tour capture, including the "Lost signal" chip beside "Your funds are not lost".

### Audit record

**Round 1.**
- **Codex** (GPT-6 Astra, high): `reject` (with blocking findings: hidden failure explanations on other-account cards; blocked completed records classified as successful).
- **Opus:** `conditional approve` (with conditions: H1 build the session-only log or send back; H2 fix R5-1 on every gas-only amount surface; M1 lost records count in needs-you and auto-open; M3 screenshots).

**Adopted**, finding → where it landed:
- Codex H1 → Fact 17, G64, Security, phase 10 (other-account + terminal failure test).
- Codex H2, Codex M3, Opus M1 → Facts 8–9, Key interfaces (`classify`), Status derivation, G13/G148/G134, D6, D26, phases 10–11.
- Opus H1 → Scope, Ask A1, arc 8, phase 24b, D16, G11 row, Delivery PR 6, Seeds.
- Opus H2 → Fact 13, `displayAmountOf`, Record amounts, G12/G16/G32/R5-1 rows, phases 10, 11 and 14, D21.
- Codex M4, Opus L4, Opus L8 → Key interfaces (`useFocusTrap`), Non-obvious mechanics, G141, phases 8 and 11, D14; I2 retired into a tested requirement.
- Codex M5, Opus L2 → Fact 5, Non-obvious mechanics, Trade-offs, G35/G36, phase 3, Security, D13.
- Codex M6 → G66, phase 9, Security, Trade-offs, D25.
- Codex M7 → Delivery split rule, D2, phase 10 commit groups, the ≤760 unmount moved to phase 11 (G149, phase 25), tour step 6.
- Codex M8, Opus L10 → Ask A4, G71, phase 27, Trade-offs, D22.
- Codex M9 → Fact 19, arc 5 surfaces, G40, phase 15, Security, D20.
- Codex L10 → Outcome criterion 3, Scope.
- Codex L11, Opus L3, Opus L5 → LG note, Fact 20, I5 removed, phase 2, Security, Delivery.
- Opus M2 → G148, arc 4 tour, Disputed items.
- Opus M3 → tour steps 1 and 4, Delivery, D24.
- Opus L1 → phase 13 and 15 gates.
- Opus L6 → G58, phase 10. Opus L7 → G25, phase 10. Opus L9 → G139, phase 9, Security.

**Rejected:** Opus M4 → D27.

Also surfaced while verifying: the completion toast names every token send "TOKEN" at 18 decimals (Fact 13), fixed with R5-1 in phase 10.

**Round 2, Codex resumed on the revision:** `conditional approve (with conditions: finish R5-1 coverage; correct the focusability contract; constrain session-log provenance; suppress unqualified arrival copy on blocked cards)`. Both round-1 blockers confirmed resolved. All four conditions adopted:
- R5-1 → `BridgeStepper.vue:71` headline and `BridgeJournal.vue:54` restore toast read `displayAmountOf` (Record amounts, phase 10 steps and tests).
- Focusability → one eligibility predicate over a candidate query (Key interfaces, phase 8 tests with its counterexamples).
- Session-log provenance → only format-checked hashes, worded "… hash observed", never "sent"/"confirmed"; tests for another tab's write, placeholders and a mid-run rekey (Session log, phase 24b).
- Blocked + completed → the arrival line renders only for status done; otherwise "Previously recorded as arrived" (G25, phase 10 tests).
- Also: D27's rationale corrected to reviewed manifest provenance (plus a hostile `source: "manifest"` regression); phase 27's tab-order wording corrected.

Disputed items settled with Codex: M4 keep manifest branding on mainnet; M2 keep retryable failures red (Q6 B); the hint button may sit inside the radiogroup's subtree; blocked arrival copy suppressed as above.

**Final fresh-context Codex pass (new session):** `conditional approve (with conditions: distinguish gross gas from spendable gas; complete the blocked-record presentation and action policy; fix tablet log sizing; scope progress clamping to each attempt)`. No Critical findings. All adopted:
- Gross vs spendable gas → Key interfaces (`displayAmountOf` is gross, labelled as bridged), R5-1 row, phase 14 step 4 ("bridged · before claim fees"; the token + gas row reads "Gas bridged", a flagged deviation from the board's "Gas ready"), browser assertions in the gas-only and token + gas specs.
- Blocked-record actions and copy → Status derivation (`showClaimWithoutFuel` requires `actionable`; standalone fuel recovery kept as a deliberate, documented exception; every completion claim qualified when blocked), phase 10 tests.
- Tablet log sizing → phase 24b stacks by the stepper's own width (container query), with 761/820 checks.
- Progress clamping → I3 scoped to the current attempt; phase 23 backward-transition test.
- A2's sandbox wording corrected.

**Verdict for the owner's delegated gate:** every condition of the final pass is adopted, so per the Approval section the plan is approved for implementation.

## Approval

The owner replaced the plan-approval gate with a Codex agreement. Verbatim: *"decide with Codex back-and-forth until you are on agreement and move forward. Drive this independently. into fruition. Stop at having the PR stack with all its run greens. which includes the bugs you found"*.

- **Plan approval:** the plan is approved when the final fresh Codex pass returns `approve`, or `conditional approve` with every condition adopted. The verdict is recorded under Audit record.
- **Asks A1–A4:** A2 and A3 by their defaults; A1 and A4 flipped in audit round 1 (build the session log; the faithful row-hint button).
- **The bugs** in "the bugs you found" are G02, G03, G14, G58, G67 and G68, plus R5-1 found while drafting, plus three the audit surfaced in existing code: a completed record blocked after the fact reads as done (Fact 8), a loading button activates from the keyboard (Fact 5), and the completion toast names token sends "TOKEN" at 18 decimals (Fact 13). All are built (see Gap traceability and phases 3 and 10).
- **Stop point:** the PR stack (six layers, more if Delivery's split rule applied) is open with every check green. Nothing is merged or deployed.
- **UI sign-off:** plan approval is not UI sign-off. Per `AGENTS.md`, each PR still needs the owner's written sign-off on its screenshots before it merges.

## Post-implementation

`code_review` is `off`: `/code-review` is **not** run at any point in this plan.

**Multi-arc loop placement.** Steps 1–2 run **per PR layer**: after the layer's last phase gate (its LG) passes and **before** `gh stack add` opens the next layer, scoped to that layer's diff while it is the stack tip. After every layer (six, or more after a split) is green and looped, run one **final cross-arc integration pass**. Then Delivery.

1. **Codex audit.**
   - Send `/codex high` (GPT-6 Astra):
     - the layer's diff (`git diff <layer-base>...HEAD`);
     - this plan.md with its decision ledger;
     - the layer map: "PR N of 6 (or more after a split). PR 1 = arc 1 foundation (static, recess tokens, focus ring, 12 icons on a 12/24 grid, capital wordmark, tag tones, busy and destructive buttons); PR 2 = arcs 2–3 (token step, marks, step rail; rail chip, header chips, Dialog shell + useFocusTrap, picker rows); PR 3 = arc 4 (the one classify reading, displayAmountOf, chips and edges, 'Arrived', dock 'this send' row, tap-only 761–1100 overlay, no dock ≤760, toasts); PR 4 = arc 5 (formatDisplayAmount, the send-time `sender` field in bridge-core, receipt layout); PR 5 = arcs 6–7 (faucet cards, ProgressBar, amount and review steps, form-step-only footer); PR 6 = arcs 8–9 (in-flight bar, DirectionSegment, phase list, session-only log; ≤760 one-column layout). Primitives that look unused in a layer are consumed in a later one."
   - Ask for adversarial and security review: what could an attacker target (spoofed tokens, wallet metadata, forged restore files or localStorage, stale dialog listeners, hidden warnings), what are we trusting that we shouldn't, where are the supply-chain, CSP and least-privilege weaknesses, and does any stored-data change break old records or backups.
   - Include verbatim: *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
   - Include verbatim: *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. **Iterative fix loop.**
   - Verify each finding's factual claims against the repo before acting.
   - Apply the accepted fixes, commit them separately, and log the round (consult plus verdict, accepted and rejected with reasons) in `lessons/phase-N.md` for the layer's last phase.
   - **Resume the same codex session** with the fix diff and ask it to re-review under the same two rules.
   - Repeat until a round yields no new material findings (rejected nitpicks don't count). Still producing material findings after 3 rounds? Stop and surface it to the owner.
   - A fix that changes anything visible re-runs that arc's tour for the affected captures.
3. **Final cross-arc integration pass.** A **fresh** codex session (`/codex high`) over the net diff from `main`, asking explicitly for cross-arc issues: seams between layers, duplication across arcs (chips, traps, bars, formatters, segments), drift from this plan and from decisions.md, any 16px icon, glyph or hard-coded status colour left over, and whether every G-id marked built in the traceability table is actually built. Include the same two verbatim rules. Run the same loop until clean.
4. **Delivery** per the section below. This is the first time any PR is opened.

## Delivery

| PR | Branch | Arcs · phases | Stacks on | `/code-review` |
|---|---|---|---|---|
| 1 | the task branch (adopted as layer 1) | arc 1 · 1–3 | `main` | off |
| 2 | a stack branch | arcs 2–3 · 4–9 | PR 1 | off |
| 3 | a stack branch | arc 4 · 10–12 | PR 2 | off |
| 4 | a stack branch | arc 5 · 13–15 | PR 3 | off |
| 5 | a stack branch | arcs 6–7 · 16–21 | PR 4 | off |
| 6 | a stack branch | arcs 8–9 · 22–24, 24b, 25–27 | PR 5 | off |

**Six PRs is a target, not a quota.** After an arc is implemented, a layer whose diff cannot be reviewed in one sitting (as a guide, more than ~40 non-test files) splits at a phase boundary into two layers, the new one on a branch named for what it holds. Each part gets its own LG, tour, codex loop, PR body and sign-off; a split never cuts a phase or a commit group. The split is recorded in this table before the next `gh stack add`.

The owner's four named complaints land in PRs 1–2: the wordmark, icons and static scrim in PR 1; the token list and marks, the rail chip and the wallet picker in PR 2. Each PR is one squash commit that reverts cleanly from the top of the stack down; PR 4's stored field is additive, so reverting it leaves records written in the meantime loadable.

**Titles** (lower-case conventional commits, ≤ 93 characters):
1. `feat(design): pixel icons on the 12/24 grid, srgb static, capital wordmark, tag tones`
2. `feat(tools): board token step, truthful step rail, wallet picker and dialog shell`
3. `feat(tools): activity status chips, lost-signal edges, arrived wording, tap-only dock`
4. `feat(tools): board receipt with from and visibility rows, one amount display rule`
5. `feat(tools): board faucet cards, amount and review steps, form-step-only footer`
6. `feat(tools): in-flight phase bar, session log and locked direction, one-column phones`

**Mechanics:**
- **Start:** the stack adopts the task branch as layer 1, with the `github/gh-stack` extension already installed here (v0.1.1) used as is; a host without it installs a pinned tag (`gh extension install github/gh-stack --pin v0.1.1`).
- **Pushes:** a branch is pushed only at its PR boundary, after its LG passed and its codex loop converged. A push creates a public testnet preview, so no half-layer is published.
- **PR boundary:** `gh stack push`, then `gh stack add <next-branch>`.
- **Delivery:**
  1. After the last layer's loop and the cross-arc pass converge: `bun run audit:tools` and `bun run test:all` (repo rule), plus BG.
  2. Deliver with `gh stack push` and `gh stack submit --auto`, not `gh stack sync` (lessons.md).
  3. `gh pr edit` each PR with a real body: what changed; the visible surfaces (copied from its arcs); the screenshots embedded; the assertion edits by file; the flagged deviations (PR 2: the "Unknown type" chip, D25; PR 3: red retryable failures beside "Your funds are not lost", Disputed M2); the testnet preview URL; an empty "Owner sign-off" section for the quote. PR 4's body adds the stored-field compatibility evidence (old record loads, forged `sender` quarantined, backup round trip). Boards are never embedded.
  4. `gh pr checks --watch` until `quality-status`, `tools-e2e-status` and `bridge-contracts-status` (when triggered) are green.
- **Merging** (`gh stack merge`) and the Workers Builds deploy it triggers are the owner's call, after their written sign-off on each PR's screenshots is quoted in the PR. Never autonomously, never AFK.

**Post-implementation hardening:** `/harden` is not scheduled. The change adds one display-only stored field (covered by validator and round-trip tests) and no trust boundary, auth, secret custody, endpoint or CI surface; each layer's codex loop already runs an adversarial review.

## Seeds

*Final (approved).* No ELI5 companion: the owner replaced the approval gate with the Codex agreement (see Approval), and the session that drafted the plan implements it. A resumed or fresh session uses the `/goal` seed below.

**`/goal` (recommended):** completion is transcript-observable, and it survives `claude --resume`.

```
/goal All 28 phases (1–27 plus 24b) in implementations-plan/aprime-fidelity/plan.md are marked ✓ in plan.md itself (not the chat, not the task list), each ✓ backed by that phase's validation gate, as written in plan.md, reported passing in the transcript; for each phase the agent has printed LESSONS_FILE=implementations-plan/aprime-fidelity/lessons/phase-N.md in the transcript; each arc's screenshot tour wrote JPEGs and its zz-*.spec.ts was deleted uncommitted; /code-review was NOT run (plan.md code_review: off); the codex fix loop converged at every PR boundary (six, or more where Delivery's split rule applied) and in the final fresh cross-arc pass over the net diff from main, each shown by a codex pass reporting no new material findings, quoted in the transcript; the stacked PRs (six, or more after a split) exist on GitHub, created only after every loop converged (gh stack view output in the transcript), each with a real body embedding its captures and with gh pr checks green; bun run lint, bun run typecheck:all, bun run test:all, bun run audit:tools and bun run e2e:tools each report exit 0 in the transcript. Never merge, never deploy, never push a branch except at its PR boundary, never touch or ask for keys, never commit a board image, never expand scope beyond plan.md.
```

**`/loop 15m` (fallback).** Use exactly one per session; they don't compose.

```
/loop 15m Drive implementations-plan/aprime-fidelity forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/aprime-fidelity/plan.md (including Outcome & Quality Bar; every step is judged against it), decisions.md and lessons/. If that path is gone, or plan.md carries an "## Outcome" block directly after its front matter (not "## Outcome & Quality Bar"), the plan is closed: STOP. If the task list is empty, rebuild it from plan.md, one task per remaining phase (24b sits between 24 and 25). Run git status and git log --oneline -5; if PRs exist, gh stack view and gh pr view --json statusCheckRollup (no --watch).
2. Waiting on CI or a sandbox e2e run is fine: confirm it progresses (gh run watch up to 10 minutes; stuck past that → log it as blocked in lessons). Use the wait to review the diff or prep the next phase.
3. No task in hand? Take the next pending phase in plan.md. After each meaningful edit run bun run lint plus the touched package's tests. Commit (signed; conventional, lower-case). Do NOT push mid-layer: a push publishes a public preview.
4. Stuck, or facing a decision you would bring to me? Call /codex high with full context and settle it together, then act. Log every consult and verdict in lessons/phase-N.md. Hard limits stay hard: never merge, never deploy, never touch, print or ask for keys, never rename a protocol string or grow a baseline, never commit a board image or an absolute local path, never expand scope beyond plan.md (arc 10 stays deferred); if a decision needs one of those, surface it and hold.
5. Same step failed 3 times? Stop retrying; reassess with codex, then continue on the agreed path.
6. Phase green means its validation gate in plan.md passes exactly as written. Paste the result, mark ✓ in plan.md, write the lessons entry, print LESSONS_FILE=implementations-plan/aprime-fidelity/lessons/phase-N.md, move on. At a PR boundary (after phases 3, 9, 12, 15, 21 and 27, plus any split Delivery records): run the arc tour(s), then /code-review is off, so run the /codex high loop on the layer diff with the layer map and plan.md's two verbatim rules until a round has nothing material (3 rounds max, then surface). Then gh stack push and, for every layer but the last, gh stack add the next branch (recorded in Delivery's table). A layer whose diff you cannot review in one sitting splits at a phase boundary per Delivery before its push.
7. All phases ✓? Run the final FRESH /codex high cross-arc pass over the net diff from main until clean. Then Delivery per plan.md: bun run audit:tools and bun run test:all, gh stack push, gh stack submit --auto, gh pr edit each body (changes, visible surfaces, captures, assertion edits, flagged deviations, preview URL, empty owner sign-off section), gh pr checks --watch. Then write the wrap-up (what shipped, each contested decision with plain-language context, open items). Surface and stop.
Keep the task list current with TaskUpdate; plan.md stays the source of truth.
```
