# Phase 2 — shell: rail, header, sections

The first visible change: the tab bar becomes a left rail, the wallet chips move into a section header, and Activity becomes a page.

## What landed

- `AppShell.vue` rewritten as a `200px | 1fr` grid: rail (brand mark, `RailNav`, `ThemeToggle`) and main (`SectionHeader` with the section's wallet chips, ONE `ConnectionErrorStrip`, `DripView`/`SendView` under `v-show`, `ActivityView` under `v-if`, `Footer`/`BridgeFooter` swap). It owns `useCompletionToasts()` and `useActivityFeed()` once each, neither on a placeholder network; the rail shows the feed's needs-you count.
- `RailNav.vue` — a vertical roving tablist (`aria-orientation="vertical"`, ↑/↓ and ←/→ both move, wrap at the ends) over the shell's `section`. Keeps the `tabs`/`tabSend`/`tabDrip` testids and adds `tabActivity`.
- `SectionHeader.vue` — title + subline, `#wallets` slot, 72px tall.
- `ActivityView.vue` — placeholder note on a bridge-less network; else `BridgeJournal source="all"` (every record, the foregrounded one included) with the first-visit tiles in its `#empty` slot and the shell's `highlightedId` passed through.
- `AztecWalletPanel.vue` replaces `WalletPanel` + `BridgeWalletPanel`: one component, `variant="faucet" | "bridge"` selects the testid set; the no-wallet install CTA is faucet-only (the bridge header has the strip for it); the idle label is "Connect Aztec" on both. Their two test files merged into `AztecWalletPanel.test.ts` with every case kept.
- `SendView` is the wizard alone (placeholder aside); `DripView` lost its hero + wallets and gained the `dripView` testid. `L1WalletPanel`/`AccountSwitcher` chips are flat (no inner border/fill) at a 40px min-height so the two sit level in the header.
- `SendWizard.showActivity` → `shell.openActivity(record)`; the wizard test now pins that the background strip's Activity link switches the section AND highlights the record.
- `tests/e2e/fixtures/sdk-boundary.ts` — the mocked SDK boundary shared by both smokes (`vi.mock` stays in each file, hoisting demands it; the factories live once). `tools-smoke` 3b re-pinned: no journal on Send, exactly one on Activity, the notice instead on a bridge-less network. `shell-smoke.test.ts` new: rail landing + tabindex, header chips per section, first-visit tiles → Send, a background completion toast while the faucet shows, arrow navigation.

## Findings while doing it

- `AppShell.test.ts` cannot stub its children at mount time: their modules pull the wallet session and wagmi in on import. They are replaced with `vi.mock` markers at the module level (a `vi.hoisted` marker factory keeps the twelve mocks one-liners).
- The two smokes mount `App.vue` over the same boundary; the first cut duplicated ~140 lines of mock bodies. A fixture module the `vi.mock` callbacks dynamically import keeps hoisting happy and the bodies single.
- The dock cases the plan lists under this phase's smoke ("dock hidden by default", the toast "with the dock hidden") are Phase 3's: there is no dock yet. The toast case runs without one; the dock cases join `shell-smoke` when the dock exists.
- The faucet's `deploymentsModule` mock in the merged panel test had drifted to `USDC`/`ETH` names from an older tree; the current deployments export the first and second faucet tokens. Harmless (the panel never reads them) but corrected to match `DripView.test.ts`.

## Gate

`bun run lint` exit 0 · `bun run --cwd apps/tools typecheck` exit 0 · `bun run --cwd apps/tools test` 94 files / 1210 tests passed (SendWizard re-run after the handoff pin: 47/47) · `bun run --cwd apps/tools test:e2e` 3 files / 26 passed (`shell-smoke.test.ts` 5/5 green, live-bridge manifest so no case short-circuited) · `git diff --quiet <rev> -- <nine frozen step files>` exit 0.
