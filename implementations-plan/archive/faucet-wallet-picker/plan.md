## Outcome

Archived. Seeds retired.

# faucet-wallet-picker

Kill the wallet-connection race in the faucet. Today `createAztecWalletSession.connect()` takes
the FIRST provider the wallet-sdk discovery stream yields (`for await … break`) — with two
wallet-sdk-compatible wallets installed, which one the faucet connects to is a timing lottery.
This plan (v2, post-audit) replaces first-wins with a **progressive wallet picker**: every
discovered wallet is listed as it announces, the user explicitly chooses (always — even for a
single wallet), and the choice is **remembered** — with the audit-driven caveat that wallet
identity is CLAIMED, not proven, so the remembered path fail-closes to the picker whenever the
claim is ambiguous.

**Tier**: `light`. Plan-time codex audit: v1 `reject` → all blocking findings folded into this v2
→ re-verdict recorded below. The user's standing multi-round codex post-impl cadence applies
after implementation.
**User decisions (Phase 0)**: always show the picker on a fresh choice; progressive streaming UX;
remember + reconnect; **faucet only**.
**Status: APPROVED** — asks resolved: A1 confirmed (Cancel → idle, never `no-wallet`);
A2 confirmed (switch affordance in idle state AND connected chip menu); **UI pre-approved from
the mockup: Option B — MODAL OVERLAY** ("closer to the EVM experience"), one picker
modal at app root reusing the verification-modal pattern.

## Threat framing (audit-corrected — load-bearing for the design)

- **`provider.id` is wallet-CONTROLLED** (the SDK's `walletId` config), not a browser-enforced
  extension id; the SDK neither authenticates nor dedups it. Any extension can claim any id/name/
  icon. Therefore: identity claims select UI rows, never trust.
- **Emoji verification proves channel integrity with the SELECTED endpoint** — it does not prove
  the endpoint is who it claims. It stays mandatory and unchanged, but the plan makes no
  impersonation-resolution claims for it.
- **Consequences for the design**: (a) rows are keyed by opaque per-announcement keys, not
  claimed ids; (b) the remembered path runs ONLY on an unambiguous match — if two announcements
  claim the remembered id, auto-reconnect is DISABLED for the session and the picker is forced;
  (c) persistence is best-effort (localStorage reads/writes wrapped; failures never affect an
  established session).

## Design (v2)

### Session composable (`apps/faucet/src/composables/createAztecWalletSession.ts`)

- `ConnectStatus` gains `"choosing"`.
- **Flow epoch with token ownership**: a monotonically increasing `epoch`; every async
  continuation (discovery loop iterations, establish/confirm/capability continuations) captures
  the epoch it belongs to. Cancel, disconnect, and picker-dismiss bump it. A continuation
  observing a stale epoch (a) discards its RESULT, and (b) **cleans up its SDK side effects**
  (audit round 2): a stale `establishSecureChannel` resolution calls `pending.cancel()`; a stale
  resolved `confirm()` disconnects the provider; late capability/setup completions disconnect
  and never persist the preference. The `activeFlow` guard is the OWNING TOKEN (the epoch), not
  a boolean — a stale flow's `finally` clears the guard only if it still owns it, so it can
  never release a newer flow's lock.
- Reactive surface: `discoveredWallets: Ref<DiscoveredWallet[]>`,
  `DiscoveredWallet = { key, id, name, type, icon? }` where `key` is an opaque per-announcement
  key (monotonic counter). Provider OBJECTS live in a non-reactive `Map<key, WalletProvider>`.
  Claimed-id collisions are NOT deduped away — each announcement is its own row (the UI shows
  the type badge; two rows claiming one name/id is itself the signal the user needs).
- `connect()`:
  - Re-entrancy: a single `activeFlow` guard (not status-name checks) — `connect()` is a no-op
    while any flow (discovering/choosing/verifying/capability/setup) is live.
  - Start discovery → `"discovering"`. Announcements append rows (epoch-checked).
  - **Remembered path (v3 — bounded ambiguity window)**: stored id (best-effort read of
    the preferred-wallet storage key). On the FIRST announcement claiming the stored id, do NOT
    select yet — open a bounded ambiguity window (1s) during which discovery keeps being
    consumed. Window closes with exactly one claimant → proceed automatically (cancel discovery,
    then the unchanged downstream chain). A second claimant during the window → abort the auto
    path, disable auto-reconnect for this session, force the picker with all rows. (v2's
    "exactly one so far" was self-defeating — the immediate cancel discarded the very buffered
    yields needed to detect the collision; audit round 2. The window applies ONLY to the
    remembered path — the fresh-choice stream stays waitless per the user's Phase 0 decision.)
    **The window is BEST-EFFORT collision detection, not proof of uniqueness** (audit round 3):
    a claimant arriving after 1s is not detected — the layered posture (announcement-keyed rows,
    mandatory emoji verification, persist-on-success-only) bounds the residual, and the plan
    claims no more. The window TIMER is itself epoch-owned: manual selection, cancel, and
    disconnect render it inert.
  - **Fresh path**: first announcement flips to `"choosing"`; the picker live-appends. Discovery
    ending naturally: with zero rows → the existing `no-wallet` error; with rows → stay in
    `"choosing"`, scanning hint off.
- `selectWallet(key)`: valid only in `"choosing"`; transitions SYNCHRONOUSLY (before its first
  await) so a double click / second panel's click is a no-op; cancels discovery; runs the
  unchanged chain (`establishSecureChannel` → `"verifying"` → emoji confirm → capabilities →
  `"setting-up"` → `"connected"`). Manual selection always wins over a late remembered match
  (the synchronous transition closes that race). A stale provider (announced, then its extension
  reloaded) fails at establish → epoch-guarded cleanup discards ALL provider objects and returns
  to `"error"` with retry = fresh discovery (never re-uses a stale object).
- **Persistence**: written (best-effort, try/catch) only when status reaches `"connected"`.
  Remembered-path failures at ANY stage (establish, emoji cancel/mismatch, confirm,
  capabilities, setup) clear the stored id (best-effort) and land in the EXISTING `"error"`
  status (the UI already renders errors there — audit: idle+error conflicts with current
  rendering); retry starts fresh discovery.
- `forgetPreferredWallet()`: best-effort clear; exposed for the switch affordances.
- `cancelChoice()`: bump epoch, cancel discovery, wipe rows/map, → `"idle"` (intentional cancel
  is NEVER `no-wallet`).
- **Pre-existing bug fixed in passing (audit finding)**: the `onDisconnect` subscription is
  currently registered BEFORE `confirm()`, when the SDK returns a no-op (no `extensionWallet`
  yet) — the wallet-side-disconnect cleanup never fires today. Move the subscription to after
  `confirm()` succeeds.

### UI (`apps/faucet/src/components/`)

- `WalletPickerList.vue`: rows keyed by opaque `key` — icon as `<img>` with FIXED dimensions,
  `referrerpolicy="no-referrer"`, protocol allowlist (`https:`, `data:image/*`, AND
  `chrome-extension:` — extension wallets, Nulo included, serve their icon from their own
  extension origin; audit round 2 caught that excluding it would fallback EVERY extension icon),
  icon URL/data length-capped (~4 KB — fixed dimensions bound rendering, not source size);
  anything else → generic fallback glyph. Name TRUNCATED by string length (hard cap ~48 chars,
  not CSS-only) and rendered as text; `type` badge; per-row Connect; "Scanning for more
  wallets…" while live; Cancel. Testids from `TESTIDS` (new: `walletPicker`, `walletPickerRow` + `data-wallet-key`,
  `walletPickerConnect`, `walletPickerCancel`, `walletPickerScanning`, `btnSwitchWallet`).
- **Presentation (user-approved: Option B, modal overlay)**: ONE `WalletPickerModal` instance at
  the app root (like the existing emoji-verification modal), backdrop-dimmed, rendered whenever
  the session is in `"choosing"`. This dissolves most of the three-panel concern (the panels only
  trigger `connect()`; the single modal owns selection), and `selectWallet`'s synchronous guard
  covers any residual double-trigger. Overlay hygiene per audit: Escape = `cancelChoice()`,
  backdrop click = `cancelChoice()`, focus moves into the modal on open and returns to the
  trigger on close. The collision warning renders as a strip INSIDE the modal above the rows.
- Switch affordance in BOTH places (audit-adopted A2): idle state ("Use a different wallet" next
  to Connect when a preference exists) AND the connected chip menu (disconnect + forget in one
  action, so switching doesn't require a manual disconnect first).

## Phases

### Phase 1 ✓ — Session composable: epoch-guarded progressive discovery + choosing + persistence
Implement the v3 design. Inline unit tests (mocked manager/async-iterator), REQUIRED cases (from
both audit rounds): progressive accumulation with per-announcement keys; claimed-id collision
renders two rows; first-arrival → `choosing`; `selectWallet` synchronous re-entrancy (double
call = one flow); remembered match survives the 1s ambiguity window alone → auto path + discovery
cancel; SECOND claimant inside the window (incl. one arriving as a buffered yield) → forced
picker, auto-reconnect disabled; buffered yields delivered AFTER cancel are discarded (epoch);
stale-epoch SDK cleanup asserted as CALLS (stale establish resolution → `pending.cancel()`;
stale confirm → `provider.disconnect()`; late capability/setup → disconnect, no persist); a
stale flow's `finally` cannot release a newer flow's `activeFlow` token; the ambiguity-window
timer firing after manual selection / cancel / disconnect is inert (epoch-owned);
remembered-path failure at each stage → stored id cleared + `"error"` + retry restarts fresh;
manual selection beats a late remembered match; natural zero-result end → `no-wallet`; end after
results → `choosing` with scanning off; `cancelChoice` → `idle`; stale-provider establish
failure → full provider discard + fresh rediscovery on retry; localStorage read/write THROWING
never corrupts a session (all best-effort paths); persist only at `connected`; `onDisconnect`
subscribed after `confirm()` (test that the pre-confirm registration bug stays fixed).

**Validation gate** — commands: `bun run lint && bun run --cwd apps/faucet typecheck &&
bun run test:faucet`. Pass: exit 0, all required cases present + green.
Layers: lint/typecheck/unit.

### Phase 2 ✓ — Picker modal + wiring + testids
`WalletPickerModal.vue` (app-root overlay per the approved Option B mockup), both switch
affordances (idle link + connected chip menu), `TESTIDS` additions. Component tests: rows render
(name as text — HTML-bearing name inert; 48-char cap enforced on the STRING), icon protocol
allowlist (javascript:/http: URL → fallback glyph; chrome-extension:/https/data:image pass),
progressive append, per-row connect emits the key, scanning hint tracks liveness, collision
warning strip renders when rows share a claimed id, Escape/backdrop → cancel, focus enters the
modal on open, switch affordance visibility rules, collision rows both render.

**Validation gate** — commands: `bun run lint && bun run --cwd apps/faucet typecheck &&
bun run test:faucet`. Pass: exit 0. Layers: lint/typecheck/unit/component.

### Phase 3 ✓ — Faucet e2e + full gates + docs
- Faucet e2e (jsdom-style smoke with the mocked wallet yielding one provider — audit-verified
  harness shape): add the picker click to the connect path, CLEAR localStorage per test (the
  remembered path would otherwise skip the picker for test 2+), scope all selectors beneath the
  visible panel (three panels are mounted). New e2e case: remembered path skips the picker.
- Gates: `bun run lint && bun run typecheck:all && bun run test:faucet &&
  bun run --cwd apps/faucet test:e2e && bun run --cwd apps/faucet build` — note `test:faucet`
  EXCLUDES `tests/e2e/**` (audit-verified), so the e2e script is named explicitly.
- Docs: connection-flow note, `implementations-plan/index.md`, lessons. Follow-ups recorded:
  upstream SDK issue for unauthenticated `walletId` (worth filing).

**Validation gate** — commands above, all exit 0. Layers: lint/typecheck(all)/unit/e2e/build.

## Security & Adversarial Considerations

- **Spoofable identity — fail-closed remembered path**: ids/names/icons are attacker-claimable
  (see Threat framing). The remembered path requires an UNAMBIGUOUS claimant and disables itself
  on collision; rows are announcement-keyed so a spoofer coexists visibly rather than replacing
  the real wallet; nothing in the picker weakens the mandatory emoji verification + capability
  approval — and the plan claims no more for them than channel integrity with the selected
  endpoint.
- **Provider-supplied strings/URLs**: name = text-rendered + hard length cap; icon = `<img>` with
  fixed dimensions, `referrerpolicy="no-referrer"`, protocol allowlist (https / data:image),
  fallback glyph. No app-side fetch/navigation of provider URLs.
- **Preference poisoning**: persist only after full success; ambiguity disables the auto path;
  localStorage is same-origin and best-effort (throwing storage never breaks a session).
- **Resource hygiene**: discovery is cancelled the moment a wallet is chosen (remembered or
  manual) — leaving it open lets every other wallet allocate ports/pending sessions
  (audit-verified SDK behavior); the epoch guard neutralizes the SDK's post-cancel buffered
  yields.
- **No supply-chain / workflow / permission changes. No new dependencies.**

## Assumptions

**Facts** (verified; v1 items corrected per audit):
1. `createAztecWalletSession.ts:71-74` — the first-wins race; downstream chain hangs off the
   single provider.
2. `WalletProvider` = `{ id, type: 'extension'|'web', name, icon?, metadata? }`
   (`@aztec/wallet-sdk/dest/manager/types.d.ts:61-80`); `id` is the wallet's OWN `walletId`
   config — claimed, unauthenticated, un-deduped (audit-verified in SDK source).
3. The SDK BUFFERS discovered providers (`pendingProviders`); `cancel()` aborts discovery but
   does not clear the buffer — yields can arrive post-cancel; cancel does not affect an already-
   established channel; re-entry (new request id) re-announces the same providers, and Nulo
   auto-approves discovery when a dApp session exists (audit-verified).
4. The session singleton is consumed by THREE always-mounted `v-show` views (one WalletPanel,
   two BridgeWalletPanel instances) in the same document — not separate tabs.
5. `WalletPanel.vue` renders per-status via `data-status` + central `TESTIDS`
   (`apps/faucet/src/lib/testids.ts`); faucet e2e is a mocked-wallet smoke yielding one provider;
   `test:faucet` excludes `tests/e2e/**`.
6. The current `onDisconnect` registration is a NO-OP (subscribed before `confirm()`, before
   `extensionWallet` exists) — pre-existing bug, fixed by this plan (audit-verified).

**Inferences** (attackable):
- I1: The discovery iterator yields 0..n providers over time and terminates at
  timeout/exhaustion (audit-confirmed correct).
- I2 (REPLACED — v1's keep-stream-open was audit-refuted): cancelling discovery immediately on
  selection, combined with the epoch guard for buffered yields, is sufficient for correctness;
  the switch affordance re-runs a fresh discovery.
- I3: Independent providers hold independent ports for WELL-BEHAVED wallets; for hostile ones
  this is not a guarantee — which is why nothing security-relevant depends on it.

**Asks** (none silent):
- A1 (audit-refined): picker Cancel → `idle`; intentional cancel can never surface `no-wallet`.
  Confirm.
- A2 (audit-adopted): switch affordance in BOTH idle state and the connected chip
  (disconnect+forget in one action). Confirm.

## Post-implementation hardening

None scheduled beyond the standing multi-round codex post-impl cadence (user-requested).

## Codex audit (light tier)

- **v1 verdict**: `reject (with blocking findings: spoofable identity is treated as trusted, SDK
  cancellation semantics are mishandled, and the state machine/gates are incomplete)`.
  Every finding adopted; the three blocking classes drove the v2
  Threat framing, the epoch/cancel-immediately design, and the corrected gates (`test:e2e` named
  explicitly; per-test localStorage clearing; panel-scoped selectors). Notable adoption detail:
  claimed-id collisions force the picker and disable auto-reconnect; `onDisconnect` no-op bug
  fixed in scope.
- **v2 re-verdict**: `reject (remembered-claim ambiguity is not actually enforced)` — four
  findings, all adopted into v3: (1) the remembered path's collision detection was self-defeating
  (immediate cancel discarded the buffered yields that would reveal a second claimant) → bounded
  1s ambiguity window on the remembered path only; (2) stale-epoch continuations must clean up
  SDK side effects (pending.cancel / provider.disconnect), not just discard state — tests assert
  the calls; (3) `activeFlow` as an owning token, not a boolean; (4) icon allowlist admits
  `chrome-extension:` (Nulo's own icon scheme) + source-length cap. Codex confirmed everything
  else from round 1 "resolved in substance".
- **v3 re-verdict**: `conditional approve (with conditions: describe the 1s collision window as
  best-effort detection, not proof of uniqueness)` — both conditions folded: the Threat framing +
  remembered-path text now state the window is best-effort (a post-window claimant is undetected;
  the layered posture bounds the residual), and the window timer is epoch-owned with an explicit
  Phase 1 test. Codex confirmed the window semantics are sound (discovery stays live during it,
  so buffered AND live yields are seen) and that the SDK-cleanup, owning-token, and icon
  hardening all "land substantively".

## Seeds

_FINAL (post-approval; Option B modal UI pre-approved via mockup)._

```
/goal All phases marked ✓ in plan.md (the per-phase headers in the file, not just the chat), each ✓ backed by its phase's validation gate (as defined in plan.md) reported passing in the transcript; for each phase the agent has printed `LESSONS_FILE=implementations-plan/archive/faucet-wallet-picker/lessons/phase-N.md` in the transcript; `/code-review max --fix` complete with findings applied and committed; codex post-impl audit complete with high/critical findings addressed; `bun run lint`, `bun run typecheck:all`, `bun run test:faucet`, `bun run --cwd apps/faucet test:e2e`, and `bun run --cwd apps/faucet build` all report exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/archive/faucet-wallet-picker forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/archive/faucet-wallet-picker/plan.md and lessons/ (authoritative state — not the chat); run `git status` and `git log --oneline -5`. If a PR exists, `gh pr view --json statusCheckRollup` (no --watch).
2. Waiting on CI is fine — confirm it's progressing (`gh run watch <run-id>` up to 10 minutes). Use the wait productively; don't start conflicting work.
3. No task in hand? Pick the next pending step from plan.md and start it. After each meaningful edit run `bun run lint && bun run --cwd apps/faucet typecheck && bun run test:faucet`. Then commit → push.
4. Stuck, or facing a decision you'd normally bring to me? Call /codex xhigh with full context, reach a defensible decision, act on it, log the consult in lessons/phase-N.md. Hard limits stay hard: never merge, never publish, never expand scope beyond plan.md.
5. Same step failed 5 times? Stop retrying; reassess with codex, then continue down the agreed path.
6. Phase green? "Green" = the phase's validation gate as written in plan.md. Run it, paste the result, mark ✓ in plan.md, file lessons, print LESSONS_FILE=..., advance.
7. All phases ✓? Post-impl sequence: /code-review max --fix → commit separately → codex post-impl audit (net diff + code-review summary + adversarial ask) → address high/critical → wrap-up report. Surface and stop.
```
