# Phase 3 — Activity dock

The collapsible dock beside Send and Faucet: grouped two-line rows, one badge when hidden.

## What landed

- `ActivityDock.vue` — takes the shell's ONE `useActivityFeed()` as a prop (the shell builds it for the rail count; a second feed would have been a second computed over the same data). Open: header with `Hide ›`, groups Needs you / Running / Done with counts, a foot with `All activity →` and the record count; empty state one line. Hidden: `DockStrip`. `AppShell` mounts it `v-if="feed && section !== 'activity'"` — no feed on a placeholder network, no dock on the page that IS the dock; the grid's third column is `auto` so the dock sizes itself (300 / 44).
- `ActivityRow.vue` — grid `12px | 1fr | auto`: dot, a body button (amount + `route · visibility · age`) that opens Activity on the record, and the side slot: the action button, the phase word, `blocked`, or `Bridged ✓`. Needs-you buttons are the accent fill; a done row's CLAIM GAS is an outline so a screen never carries two filled calls. SWITCH disabled with the card's reason while `opsBusy`; an acting CLAIM GAS reads `CLAIMING…` and is inert.
- `DockStrip.vue` — chevron button (exposes `focus()`; the dock moves focus there on hide), vertical label, the badge only while `count > 0`.
- Dispatch: claim / finish / retry → `runDepositClaim` / `runWithdrawConsume` by the row's direction (the engine's record lock dedups); switch → `switchActiveAccount(row.switchTarget)` unless `opsBusy`; claim-gas → `claimFuelStandalone` behind a dock-local in-flight set, a failure surfacing as an error toast (the dock has no room for a sentence). The feed's row model gained `switchTarget` so the dock never re-derives policy.
- Auto-open: `watch(feed.autoOpenIds, ids => dock.autoOpenFor(ids, feed.liveIds), { immediate: true })` — blocked rows are already excluded by the feed; a boot with an unseen needs-you record opens once, then the seen set holds across reloads and tabs.
- Testids: `dock`, `dockHide`, `dockStrip`, `dockOpen`, `dockBadge`, `dockGroup`, `dockAll`, `activityRow`, `activityRowOpen`, `activityRowAction`. A shared `src/test/activity-row.ts` row-model factory feeds the row and dock tests.
- Shell smoke gained the two dock cases: (6) hidden by default with no badge → a claimable record opens it once with one CLAIM and no preference written → hide → badge `1` → on Activity exactly one `journalClaim` and no strip → back on Send still hidden, badge `1`; (7) a record under `claimForeground` is absent from the dock (no badge either) and appears the moment it is released.

## Findings while doing it

- Biome's `useImportType` rewrote `import DockStrip` to `import type` because the script only referenced it inside `InstanceType<typeof DockStrip>` — Biome does not see the template, and a type-only import erases the component at runtime. Typing the ref as `{ focus(): void }` keeps the value import. Worth remembering for any SFC that references a child only through a template ref type.
- The dock test hands the component a hand-driven `ActivityFeed` (refs + the real `groupRecords`/`needsYouCount`), which is what made every dock rule testable without the journal.

## Gate

`bun run lint` exit 0 · `bun run --cwd apps/tools typecheck` exit 0 · `bun run --cwd apps/tools test` 96 files / 1224 tests passed · `bun run --cwd apps/tools test:e2e` 3 files / 28 passed (`shell-smoke.test.ts` 7/7 with the dock cases 6 and 7 green) · `git diff --quiet <rev> -- <nine frozen step files>` exit 0.
