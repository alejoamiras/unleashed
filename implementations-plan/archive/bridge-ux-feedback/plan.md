## Outcome

Archived. Seeds retired.

# Bridge UX feedback round (post-journal amendment)

Blueprint tier: `mid`. Parent arc: [bridge-ux-trust](../bridge-ux-trust/plan.md) — its journal engine, envelope, and verified-only completion are the substrate this round polishes.

Driving feedback (user, testnet session):
1. The Aztec private balance is invisible until the PRIVATE toggle flips — picking Aztec→Ethereum is blind.
2. Clicking CLAIM on a rediscovered card gives no live status — "it just submits and I'm left for good."
3. A completed card sits in the list until manually discarded ("just make it done"), and a reload mid-bridge produced the alarming dead-end note "The claim's outcome couldn't be confirmed yet — Retry checks again" with no sense of where the flow stood or whether funds were safe.
4. Card headers ("→ AZTEC") don't read as a direction.
5. (Accepted add-on) Explorer links for every tx hash a card knows.

## Design decisions

### D1 — The engine narrates: a `step` runtime field
`RecordRuntime` gains `step?: "unsealing" | "syncing" | "sending" | "confirming" | "verifying"` plus `stepDetail?: string` (e.g. poll counts). The engine sets it at each transition inside `runDepositClaim` / `finishDepositByReceipt` / `runWithdrawConsume` (and clears it on exit), so the card renders a live one-line status with a spinner — the user watches the claim move instead of staring at a disabled button. Stages stay DERIVED from milestone facts (parent-arc D1 unchanged); `step` is ephemeral runtime narration, never persisted.

### D2 — Receipt waits never dead-end; `unknown-outcome` means REFUSED, not SLOW
Today `finishDepositByReceipt` dumps to `unknown-outcome` after a silent ~3-minute budget even when the claim is merely slow. Rework:
- While the receipt is `pending`: `step: "confirming"` with elapsed/attempt detail — the poll CONTINUES past the old budget (overall ~30 min like the sync gate), **in chunked rounds (~3-min slices): the record lock is RELEASED between rounds and the engine self-re-enters with `step` preserved** (fable MEDIUM-1 — a 30-min lock would make RETRY and DISCARD unreachable for the whole window, regressing today's 3-min hold). **Re-entry is owned by a per-record generation token** (final-codex condition): each round captures the record's generation; discard/RETRY/sweep bumps it; a stale-generation round exits silently — no duplicate waiters racing `claimTxHash`-clearing vs `completedAt`, no double-toast, no runtime resurrection after discard.
- `unknown-outcome` is reserved for VERIFICATION refusals (probe false/null, consume-identity mismatch) — the cases where the engine genuinely cannot vouch.
- **Transport failures are not "pending"** (codex MEDIUM): `claimReceiptStatus` currently maps every lookup exception to `pending`; it gains an `unreachable` outcome, surfaced as `stepDetail: "node unreachable — retrying"` with its own counter, so a dead RPC reads as a connectivity problem, not a slow claim. The chunked rounds make the "RETRY checks now" copy TRUE (the lock is free between rounds).
- Every attention note gains a **funds-safety line** (D7) so a refusal is informative, not terrifying.

### D3 — Verified done self-resolves by HIDING, never destroying (fable HIGH-1 fold)
The parent arc retained done cards until manual Clear (ledger L2). The first draft claimed verified-only completion "moots" that insurance — **fable proved that false**: probe===true is adversarially reachable (tampered `leafIndex` + a forged `claimTxHash` to any successful tx; same-session the `secretCache` short-circuits `envelopeMatchesRecord`; the crash-before-reseal window exists on rediscovery). So the self-resolve must not delete. New behavior: on `completedAt`, the card shows its ✓ state (~8s, explorer link, toast "Bridged 100 USDC to Aztec ✓") and is then **auto-HIDDEN — filtered out of the rendered list, with the record (and blob) retained in storage for the existing 7-day `pruneCompleted`**. No `discard` call anywhere in the happy path; reload-mid-grace works for free (the filter re-applies). The L2 suspenders stay on; the user just stops seeing finished cards.
**Scope (codex HIGH fold — consumed vs not-yet-synced share a revert wording, so the probe is a heuristic):** auto-hide applies to (i) withdraws (their completion is witness-decode-verified — strong) and (ii) deposits carrying the **local claim-send provenance bit** — an engine-private, in-memory marker set ONLY at the moment THIS process passed the sync gate and dispatched the claim send (final-codex condition: NOT the broad `sessionLive` set, which is populated at flow start and proves nothing about the claimable→sent→gone ordering). A deposit completion WITHOUT that bit (receipt-wait resumed after reload) keeps the ✓ card with a manual CLEAR — weaker evidence, human eyes on it. The parent L2 retention question stays formally OPEN for that rediscovered class.

### D4 — Direction reads as a journey
Card header becomes `ETHEREUM → AZTEC` / `AZTEC → ETHEREUM` (chain chips at both ends, mono, matching the form's chips), with the privacy tag and amount unchanged. `data-direction` attr unchanged (e2e stability).

### D5 — Both Aztec balances visible (codex arbitrates between)
Candidate options (exactly one ships):
- **(a) Stacked dual balance on the Aztec panel** ← **ARBITRATED: (a) wins** (codex pick; fable dissent FOR (a); main's lean — unanimous. fable additionally ruled (c) semantically wrong: the toggle governs flow privacy in BOTH directions, not which Aztec balance displays). The panel always shows BOTH lines — `Public: 200.00` / `Private: 50.00` — with the ACTIVE one (per the toggle) highlighted and the inactive one dimmed. The toggle keeps selecting which balance funds/receives the bridge; visibility no longer depends on it.
- **(b) Single line + secondary hint**: keep one primary balance (per toggle) and render the other as a dimmed suffix — `Balance: 200.00 USDC · private: 50.00`. Minimal layout change, less scannable.
- **(c) Toggle-as-segmented-control with balances inline**: replace the switch with two segments `PUBLIC 200.00 | PRIVATE 50.00` — selection and visibility merge into one control. Boldest change; makes the toggle's meaning unmissable but restyles a shipped control.
(b) and (c) are retained above only as the rejected-alternatives record — the arbitration is SETTLED on (a).

### D6 — Explorer links on cards
Every tx hash a record holds becomes a link: `depositTxHash`/`consumeTxHash` → Sepolia etherscan (`https://sepolia.etherscan.io/tx/<hash>`, new tiny helper); `claimTxHash`/`exitTxHash` → aztecscan via the existing `lib/explorer.ts` helper. Rendered in the card's status line and ✓ state. External links open `target="_blank" rel="noopener noreferrer"`.

### D7 — Reassurance copy: a PER-STATE truth table, not a blanket line (fable MEDIUM-2 fold)
Each attention state gets copy that is TRUE for that state — pinned by tests against the engine's actual guarantees:
| State | Funds line |
|---|---|
| unknown-outcome (deposit) | "Your funds are not lost — the claim either landed or the deposit remains claimable from this card." |
| unseal-failed | "The sealed secret is intact; nothing was deleted. Retry with the wallet app used at deposit time." |
| mismatch (either kind) | "Nothing was sent. Connect the named account and claim again." |
| tampered | "The sealed copy is authoritative and intact — review the corrected details and claim again." |
| stale (no secret) | "This record has no usable secret — if it ever held funds, they are NOT recoverable from here." (honest, no false comfort) |
| unknown-outcome (provisional withdraw) | "If the exit never reached Aztec, nothing left your balance; check your wallet activity before discarding." |
| stale-deployment | "This record belongs to an older deployment and can't be resumed here." |
The mid-flow reload case is covered by the step/stage narration ("Claim submitted — confirming on Aztec…"). Copy is part of the review surface (frontend addendum).

## Phases

### P1 — Engine narration + receipt-wait rework ✓
Files: `packages/faucet/src/composables/useBridgeJournal.ts` (+test).
- `RecordRuntime.step`/`stepDetail`; transitions set/cleared in `resolvePrivateSecret` (unsealing), the sync gate (syncing w/ poll count), send (sending), `finishDepositByReceipt` (confirming w/ attempt count → verifying), `runWithdrawConsume` (confirming).
- Receipt poll: pending continues to a ~30-min cap with `step` detail; `unknown-outcome` only on probe false/null, reverted handling unchanged; budget-exhaustion note rewritten ("Still confirming on Aztec — slow testnet. This card keeps checking; RETRY forces a check now. Funds are safe.") and is NOT `unknown-outcome` (a new soft note via `stepDetail`).
- Auto-HIDE on `completedAt` for the F9-scoped classes (a ~8s grace, then the record is excluded from the RENDERED list — never a `discard`; storage + the 7-day prune untouched), behind a small engine helper (`isHidden(rec)`) so the card stays dumb. The provenance bit + generation token live here (engine-private). Toast hook exposed for P2 (the faucet has `useToast`) — P1 ships NO UI.
Smallest proof: step transitions observable in runtime during a fake claim (unsealing→syncing→sending→confirming→verifying→done); pending past the OLD budget keeps polling and never sets `unknown-outcome`; probe-refusal still does; transport exception ⇒ `unreachable` stepDetail, never `pending`; the lock is FREE between chunked rounds (an explicit discard lands mid-wait); in-session completion auto-hides after the grace (fake timers) while a REDISCOVERED completion and every attention record never auto-hide; auto-hide never calls `discard` (record persists for prune); `step` cleared on the error path (withRecordLock finally); `discard` clears the runtime entry.
Validate: `bun run --cwd packages/faucet test && bun run --cwd packages/faucet typecheck && bun run lint`.

### P2 — Card UI: direction, live status, links, done state, copy ✓
Files: `BridgeJournalCard.vue` (+test), `lib/explorer.ts` (+ etherscan helper +test), `testids.ts` (add `journalStep`, `journalTxLink`).
- Header: both-end chips (D4). Status line: spinner + step narration (D1) above the stage label; attention notes with funds-safety lines (D7); explorer links (D6); ✓ state with link + auto-HIDE after the grace (D3 — render filter, never deletion); toast on completion.
Smallest proof: header renders both chains per direction; step narration renders from runtime (each step → expected copy); tx links carry the right href per hash field; done card shows ✓ + link, then HIDES via the engine filter (mocked) while the record stays in storage; attention note includes the funds-safety sentence.
Validate: same as P1 + `bun run --cwd packages/faucet test:e2e` (smoke still green — selectors unchanged except additions).

### P3 — Form balance visibility (codex-arbitrated option) + gates ✓
Files: `BridgeForm.vue` (+test); `testids.ts` if the option adds nodes (e.g. `bridgeBalanceL2Public` / `bridgeBalanceL2Private` for option (a)).
- Implement the arbitrated D5 option; copy reviewed; over-balance validation reads the ACTIVE balance only.
Smallest proof: both balances visible without toggling; the active one switches with the toggle (or segment); validation still binds to the active source; flip keeps both visible on the Aztec side only.
Gates: `bun run audit:faucet` + `bun run audit:vue` → `/code-review max --fix` (separate commit) → codex post-impl audit → address high/critical → manual checklist hand-off.

### NEEDS MANUAL TEST (testnet, signature-gated)
1. Private deposit end-to-end watching the card narrate: unsealing → syncing (poll count) → sending → confirming (attempts) → verifying → ✓ → the card hides itself + toast (record retained until the 7-day prune).
2. Reload mid-sync, click CLAIM: the card states exactly where the flow stands at every step; no dead-end notes; funds-safety line present on any attention state.
3. Reload right after the wallet confirm (claimTxHash persisted): card resumes at "confirming" prompt-free and completes (no 3-minute false alarm).
4. Withdraw: proving countdown → FINISH → confirming with the Sepolia link → ✓ → the card hides itself.
5. Both Aztec balances visible before any toggle; toggling switches which is active; Aztec→Ethereum private withdraw picked with full knowledge of the private balance.
6. Every tx link opens the right explorer page.

## Decision ledger
| # | Decision | Source | Rejected / notes |
|---|---|---|---|
| F1 | Engine narrates via runtime `step` (cards stay dumb) | main | competing outline's card-side polling — rejected pending audits: duplicates engine knowledge, drifts |
| F2 | Receipt pending ≠ unknown-outcome; 30-min soft cap with live detail | main + user pain | the 3-min dump — removed; `unknown-outcome` reserved for verification refusals |
| F3 | Done cards auto-HIDE (filter + 7-day prune retention), never auto-discard; main's "insurance mooted" claim was FALSE (probe adversarially reachable) | fable HIGH-1 (overruling main's draft) | auto-`discard` — rejected: destroys the L2 suspenders |
| F4 | Both-end direction chips | user + main | single-arrow header |
| F5 | Balance visibility = **(a) stacked dual** — SETTLED (codex arbitration + fable dissent-for-(a) + main's lean, unanimous; fable ruled (c) semantically wrong) | user (delegated) → codex | (b) re-creates the scannability complaint; (c) miscommunicates the toggle's both-direction semantics |
| F6 | Explorer links — strict `/^0x[0-9a-f]{64}$/i` hash validation, https-only fixed hosts, non-hex renders no anchor | user (gate add-on) + codex/fable LOW | naive interpolation |
| F7 | Funds-safety copy = per-state TRUTH TABLE with test pins (stale + provisional get honest no-comfort copy) | fable MEDIUM-2 + codex MEDIUM | main's blanket "every note gains a safety line" |
| F8 | Receipt waits: chunked ~3-min lock rounds to a ~30-min soft cap; transport failures classified `unreachable`, never `pending` | fable MEDIUM-1 + codex MEDIUM | one 30-min lock hold (RETRY/DISCARD unreachable); exception→pending mapping |
| F9 | Auto-hide SCOPE: withdraws + in-session deposit completions; rediscovered deposit completions keep ✓ + manual CLEAR (consumed/not-synced ambiguity) | codex HIGH + main synthesis | unscoped auto-hide; "no deposit auto-resolve at all" — over-broad, the in-session ordering is forge-resistant |
| F10 | Engine hygiene pins: `step` cleared in `withRecordLock`'s finally (all exits); `discard` clears the runtime entry | fable LOWs | — |
| F11 | Per-record generation token owns chunked-round re-entry (discard/RETRY/sweep bump it; stale rounds exit silently) | final codex | unowned self-re-entry — duplicate-waiter races |
| F12 | Deposit auto-hide gated on the local claim-send provenance bit (gate-passed→sent in THIS process), not `sessionLive` | final codex | `sessionLive` as the scope — set at flow start, proves nothing about the claimable→sent→gone ordering |

## Security & Adversarial Considerations
- No new trust surface: `step` is ephemeral display state (never persisted, never an input to completion logic); auto-HIDE is a render filter gated on `completedAt` + the F9 provenance scope — it deletes NOTHING, so even a forged completion (the probe is a heuristic — both auditors) cannot be weaponized to destroy a live blob; deletion still requires a human click or the 7-day prune.
- Explorer links: hash-only URLs to fixed hosts; `rel="noopener noreferrer"`; no user-controlled URL parts beyond the hex hash (validated shape before interpolation).
- Copy: funds-safety lines must be TRUE per state (reviewed against the engine's actual guarantees — e.g. never claim "funds are safe" on a `tampered` record; phrase as "the sealed secret is intact").
- Longer receipt polling: bounded (~30 min) + per-record, no unbounded timer leak; polls are read-only node calls.
- No new deps.

## Assumptions
**Facts (verified):** the 3-min budget + note live in `finishDepositByReceipt` (`useBridgeJournal.ts`, 45×4s loop); done cards persist until Clear (`BridgeJournalCard.vue` stage matrix); the Aztec panel renders ONE balance keyed off `isPrivate` (`BridgeForm.vue` `l2Balance`); `lib/explorer.ts` exists with an aztecscan tx helper; completion is verified-only (probe === true); `useToast` exists (faucet composables); the smoke + unit suites were green when drafted (re-verified at each phase gate, not assumed).
**Inferences (attackable):** a pending Aztec claim receipt usually terminalizes within ~30 min on testnet (if not, the soft cap re-arms RETRY — no dead-end either way); the ~8s grace + auto-HIDE cannot race anything destructive (it is a render filter — fable-corrected from the draft's discard); ~~"verified done ⇒ secret worthless"~~ REJECTED by both auditors — the probe shares the consumed/not-synced wording, hence F3 (hide) + F9 (scope).
**Asks:** all resolved — stuck card ⇒ auto-hide (user "just make it done", hardened per F3/F9); explorer links in scope; balance option SETTLED = (a) stacked dual (F5).

## Out of scope
Swap (next arc); CSP/hardening pass (unchanged); Playwright real-browser flows; any engine trust-model change.

## Approval
**USER VERDICT: APPROVE** (gate, this session) — scope as written, no conditions. Seeds finalized; implementation begins at P1.

## Audit verdicts
- Dual audit (parallel, both outlines):
  - **fable: conditional approve** (conditions: auto-hide not discard; chunked lock rounds; per-state copy table + hash/step/runtime pins) — ALL folded (F3, F7, F8, F10).
  - **codex: conditional approve** (conditions: scope deposit auto-resolve until consumed/not-synced distinguishable; classify transport failure ≠ pending + truthful retry copy; strict hash validation + provable-state copy) — ALL folded (F9, F8, F6, F7). D5 arbitration: **(a) stacked dual** — settled unanimously (F5). Outline: engine-narration, unanimous.
- Final fresh-context codex pass (new session): **conditional approve** — 3 conditions, ALL folded same-round: F9 narrowed to a local claim-send provenance bit (not `sessionLive`); chunked rounds gain a per-record generation token (F11); every leftover auto-clear/discard phrasing rewritten to hide-only. No F1–F10 reversal; phases confirmed executable (P1 engine-only, UI strictly in P2).

## Seeds
**`/goal` recommended** (completion is transcript-observable: three ✓ phases + gates + the 6-item manual checklist); `/loop 15m` as the interval fallback. Finalized post-approval.

---

## Competing outline (alternative angle: card-first, minimal engine change)
Instead of the engine narrating, keep `useBridgeJournal` untouched except the receipt-budget fix, and make the CARD smart:
- The card derives a synthetic status from what it can observe: busy + missing claimTxHash ⇒ "working…"; claimTxHash present ⇒ its own lightweight receipt poll via a read-only node client for display; done ⇒ ✓.
- Auto-clear implemented as a card-local timer calling `discard`.
- Pros: zero engine churn; UI iterates freely. Cons: duplicates engine knowledge in the view layer (two receipt polls, drift risk), can't narrate engine-internal steps (unsealing/sync-gate polls are invisible to the card), violates the parent arc's "cards stay dumb, engine owns truth" altitude, and the display poll could disagree with the engine's verdict (a false "done ✓" display while the engine refused verification — exactly the class of lie this repo's plans keep killing).
Both outlines go to the auditors; main recommends the primary (engine-narration) plan.
