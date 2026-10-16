---
tier: light
driver: claude-code
codex_model: sol
code_review: off
explainer: off
eli5_mode: artifact
slug: aztec-fee-asset
trunk: main
---

## Outcome

- **Closed; delivered** in PR #22, one arc, awaiting the owner's merge. Phases 1–3 are ✓.
- **Shipped.**
  - The Send picker's first row is the network's fee asset: `AZTEC` · `Aztec gas (<L1 chain>)` · `AZ`, curated (`source: "manifest"`), with all three choices.
  - A testnet `+N AZTEC` button on the mint strip, and an "AZTEC on Ethereum" card on the Faucet tab with its own connect and switch. Both go through `useFeeAssetMint`: one shared lock, the amount read live from `mintAmount()` and superseded on disconnect, a `FEE_ASSET()` check before signing, and the credit taken from the receipt's `Transfer` log. A receipt wait is two rounds and names the hash.
  - The wizard refreshes on `feeAssetMinted`.
  - The sandbox carries the node's own handler into its manifest and handle after one proved mint.
  - Browser cells 18, 18b, 19 and 34 changed; 18c and 47 are new. The suite has 72 cells.
- **Reviews.** Plan audit: 2 Codex rounds, 6 findings adopted. Implementation fix loop: 2 rounds; round 1 had 3 material and 3 minor findings, all fixed; round 2 found "No material findings." `/code-review` was off.
- **Assumptions.** I1 held: the local network reports `feeAssetHandlerAddress`, so the fallback deploy was dropped. I2 held: cell 18c creates the fee asset's portal inline.
- **Known limits:**
  - the text "AZTEC" is not reserved: a token at another address may copy it, without curated status or the identity route;
  - the handler's owner can change `mintAmount()`; the button shows the value read at the last connect, while the success line reports what the receipt credited.
- **Open items:** the strip's manifest-token mint keeps the full receipt-wait budget; `AddressesView.test.ts` times out under heavy load. Both are in `follow-ups.md`. The owner's manual check on testnet.app follows the merge.
- **Retired:** the `/goal` and `/loop` seeds below. This plan is a record, never a task list.

# aztec-fee-asset — list $AZTEC in the Send picker and mint it on testnet

People want to bridge only Fee Juice. The app still bridges $AZTEC one for one (the "identity" route), but $AZTEC is not in the picker, so the only way in is pasting its address. This plan pins $AZTEC as the first picker row with all three choices, and brings back a testnet "Mint $AZTEC" button in the Send mint strip and on a Drip-tab card.

Owner decisions (recorded in chat): all three choices for $AZTEC; mint in both places; first row, symbol `AZTEC`, name `Aztec gas (Sepolia)`; this lands before the lifi-routing stack, which rebases onto it. Validation: the full local set, then the owner's manual check on testnet.app. Post-implementation hardening: none; the change adds no trust boundary.

## Outcome & Quality Bar

**For whom**: a tester on Sepolia who holds no $AZTEC and wants Fee Juice on Aztec, often on a phone.

- **Findable in one look**: AZTEC is the first row of the picker, with no paste needed. Picking it and choosing Gas shows "One for one." before anything is signed.
- **Mint where the need is**: one Ethereum signature mints from either surface. The Drip card connects or switches the Ethereum wallet itself. After a mint from either place, the Send balances show the new amount.
- **No false success**: a reverted mint, a wrong chain or a handler that disagrees with the manifest shows an error line. The success line states the amount the receipt's `Transfer` event shows, never an assumed amount.

Good enough: a monogram tile ("AZ"), not a drawn logo; no new mainnet surface.

## Architecture & Implementation

- **Picker row**: `useTokenCatalog.ts` `manifestCatalog()` prepends one `SelectableToken` built from `FUEL_ASSET`: address lowercased like the other rows, `source: "manifest"` (keeps the curated label, `useTokenSelection.ts:110`), symbol `AZTEC`, name `Aztec gas (<L1 chain name>)`, decimals 18 as the fallback only (live metadata and registration words win, `:65`, `send-flow.ts:125`). The dedupe in `merge()` hides a list row for the same address, and the lookup treats a paste of it as a known row (`useAddressLookup.ts:87`). Not added to `MANIFEST_TOKENS`, which holds pre-created portals (`verify-deployments.ts:70`).
- **Mint core**: new `src/lib/fee-asset-handler-abi.ts` (`FEE_ASSET`, `mintAmount`, `mint(address)` via viem `parseAbi`) with a test that pins it against `FeeAssetHandlerAbi`. New `src/composables/useFeeAssetMint.ts` with transient module-level state shared by both surfaces:
  - `available` is true only when `FUEL_ASSET_HANDLER` is set (testnet manifests only).
  - `amount` comes from `mintAmount()`. It is re-read whenever the Ethereum wallet becomes connected on the right chain; a failed read leaves it `null`, and the button then reads "Mint AZTEC".
  - `minting`, `error` and `lastMinted` are refs. `lastMinted` holds the address and amount of the latest confirmed mint, in memory only.
  - `mint(): Promise<boolean>`:
    1. refuses unless connected on `NETWORK.l1ChainId`;
    2. re-reads `FEE_ASSET()` and fails closed unless it equals `FUEL_ASSET`;
    3. calls `writeContract` with `chain: NETWORK.viemChain`;
    4. rejects a receipt whose `status !== "success"`;
    5. takes the minted amount from the receipt's `Transfer(0x0 → owner)` log emitted by `FUEL_ASSET`.
- **Surfaces**:
  - `MintStrip.vue` renders one more button (`data-symbol="AZTEC"`). While either lock is held, every strip button is disabled. It emits `minted` for manifest tokens only.
  - `SendWizard.vue` setup watches `lastMinted` and calls its existing `onMinted` (`SendWizard.vue:688`), which refreshes the row and selected balances. The strip cannot carry this watch: it renders only on the token step (`WizardShell.vue:93`), so a Drip mint during Amount would be missed. This adds one `watch` to a file the lifi stack rewrites; its rebase keeps it.
  - New `src/components/MintFeeAssetCard.vue` on `DripView.vue`. The Drip header shows only the Aztec wallet (`AppShell.vue:78-80`), so the card carries its own controls from `useL1Wallet`: `connect()` and `switchL1Network()`. Its testids are its own, because Send and Drip are both mounted (`AppShell.vue:94-97`).
- **Sandbox**: `scripts/sandbox/deploy.ts` and `manifest.ts` carry `info.l1ContractAddresses.feeAssetHandlerAddress` into the sandbox manifest when the node reports a usable one (I1).
- **Not taken**:
  - A new `TokenSource "pinned"`: it would touch `readMetadata`, `toResolved`, `TokenTile`, `token-mark` and every fixture for no gain.
  - A visibility-driven refresh in `AppShell`: it adds a prop path through `SendView` for one case; the `lastMinted` watch reuses `onMinted`.

**Visible surfaces (owner sign-off with screenshots)**:
- **Picker, first row**: `AZTEC` · `Aztec gas (Sepolia)` · monogram `AZ`.
- **Strip button**: `+1000 AZTEC` (the live `mintAmount()`; `Mint AZTEC` while unread).
- **Drip card**:
  - title: `AZTEC on Ethereum`;
  - body: `Free test AZTEC on Sepolia. On Send, pick AZTEC, then Gas: it arrives as Fee Juice, one for one.`;
  - button when disconnected: `Connect Ethereum wallet`;
  - button on another chain: `Switch to Sepolia`;
  - button when ready: `+1000 AZTEC`;
  - success line: `Minted 1000 AZTEC. Bridge it on Send.` (the receipt's amount; `Minted. Bridge it on Send.` if no matching log);
  - errors: the existing `safeSentence` line.

## Security & Adversarial Considerations

- **Trust boundary unchanged**: the handler and asset addresses come from the build manifest, never from user input. The schema checks only the shape of `feeAssetHandler` (`manifest-v2.ts:117`); swapping it needs a compromised build input, so manifest review stays the control. The `FEE_ASSET()` check is a consistency guard, not authentication.
- **Copied symbols** (Codex L2): the text "AZTEC" is not reserved. A token at another address can be named "AZTEC" and shows "AZ", as any token can copy any symbol today. It gets no curated status (`source` stays `list` or `pasted`) and no identity route, which is address-based (`route-discovery.ts:99`), and its tile shows its address (`TokenTile.vue:28`). Known limit, same as today; no symbol registry.
- **Wrong chain**: `mint()` refuses off-chain reads and writes; viem's `writeContract` with `chain` also refuses a mismatched wallet.
- **Mainnet**: the manifest has no `feeAssetHandler` (no mint UI), and the wizard never mounts there (`App.vue:14-17`).
- **Supply chain**: no new dependency. `l1-artifacts` is already a dependency and is used only by the pin test. CSP unchanged.

## Assumptions

**Facts**:
- F1: The identity route exists for the fee asset (`route-discovery.ts:99`). The router and send flow serve all three intents (`send-flow.ts:113-122`, `SwapBridgeRouter.sol:187-188,256,311`), with forge tests at `SwapBridgeRouter.t.sol:203-243`.
- F2: Sepolia, read before drafting:
  - the asset is `FEE`/`FeeJuice`/18;
  - the handler's `FEE_ASSET()` is the asset, and `mintAmount()` is 1000e18, which the handler owner can change;
  - the rc.3 portal's `UNDERLYING()` is the asset;
  - `factory.portalOf(asset) = 0`, which holds only until the first token-leg send.
- F3: Curated strings survive selection only for `source: "manifest"` (`useTokenSelection.ts:110`). Metadata conflicts are checked for list rows only (`:81-82`).
- F4: `addPasted` refuses a duplicate address (`useTokenCatalog.ts:159-176`). The lookup shows a known address's row instead of reading it (`useAddressLookup.ts:87`).
- F5 (corrected by Codex): Send and Drip are both mounted (`AppShell.vue:94-97`). The Ethereum wallet panel shows on Send only (`AppShell.vue:78-83`). `useL1Wallet` reads go through the injected provider and throw without one (`useL1Wallet.ts:29-38`).
- F6: The browser suite runs Chromium only (`tests/browser/playwright.config.ts:33`). Cells 18, 18b and 19 paste the fee asset (`deposit-gas-only.spec.ts:42-76`). Cell ids run to 46.
- F7: The lifi stack keeps the identity route (`useFuelQuote.ts:59` on `lifi-routing-close-out`) and does not touch `useTokenCatalog.ts`, `MintStrip.vue` or `DripView.vue`. It rewrites `SendWizard.vue`, where this plan adds one `watch`.

**Inferences**:
- I1: The sandbox node reports a `feeAssetHandlerAddress` that may mint its TestERC20 fee asset. Phase 3 checks this first. If it fails, the fixture deploys `FeeAssetHandler` from `FeeAssetHandlerBytecode`. It then grants the handler minter rights through `ensureFeeAssetMinter(l1, feeJuice, minter)`, a new optional `minter` parameter defaulting to the harness account. The fixture proves one mint before it writes the manifest.
- I2: Token and token + gas on $AZTEC work through the generic path. The first such send creates the fee asset's factory portal inline. The hub mints an L2 token named from the asset's own words (`FeeJuice`/`FEE`). Cell 18c proves it.

**Asks**: none open. The Drip card's connect, switch, loading and success copy is listed above for sign-off at the approval gate.

## Phases

### Phase 1 — The AZTEC row in the picker ✓
<!-- Gate passed: lint exit 0; typecheck:all exit 0; test:tools 1643/1643; test:e2e 29/29. Lessons: lessons/phase-1.md -->

1. Add the row in `useTokenCatalog.ts`.
2. Add `FUEL_ASSET` to every test mock of `bridge-generation`.
3. Add unit cases:
   - the row is first;
   - a paste of it is refused, however it is cased;
   - a list row for it is dropped;
   - a list row named "AZTEC" at another address stays `list` and sits after the pinned row;
   - a placeholder network has no row.
4. Extend the jsdom smoke `tests/e2e/send-smoke.test.ts` (l.521 case): AZTEC is first, and choosing it shows the three choices with "One for one."

**Validation gate**: `bun run lint && bun run typecheck:all && bun run test:tools && bun run --cwd apps/tools test:e2e` exit 0. Layers: lint, typecheck, unit, jsdom e2e.

### Phase 2 — The mint button and the Drip card ✓
<!-- Gate passed: lint exit 0; typecheck:all exit 0; test:tools 1662/1662; test:e2e 29/29; build:testnet ok. Deviation: the card's testid sweep lives in its own test (lessons/phase-2.md). -->

1. Add the ABI file and its pin test.
2. Add `useFeeAssetMint`. Unit tests:
   - a handler that disagrees with the manifest is refused before signing;
   - a reverted receipt is an error;
   - the wrong chain is refused;
   - the lock refuses a second mint;
   - a failed `mintAmount()` read recovers on the next connect;
   - the success amount comes from the `Transfer` log, not from `mintAmount`.
3. Add the strip button and extend `MintStrip.test.ts`.
4. Add the `lastMinted` watch in `SendWizard.vue`. Extend `SendWizard.test.ts`: a mint confirmed while the Amount step is shown refreshes the selected and row balances.
5. Add `MintFeeAssetCard.vue` on `DripView.vue`, with its disconnected, wrong-chain, ready and success states. Without a matching `Transfer` log, the card shows a plain "Minted." with no amount.
6. Add new `TESTIDS` entries. Register the card in `testid-coverage.test.ts`. Extend `DripView.test.ts`.

**Validation gate**: the Phase 1 commands, plus `bun run --cwd apps/tools build:testnet` exit 0. Layers: lint, typecheck, unit, component, build.

### Phase 3 — Sandbox handler and browser cells ✓
<!-- Gate passed: bun run e2e:tools exit 0, 72 passed (1.7h, local wall-clock 6259 s at load ~210); I1 held, no fallback deploy. Baseline from CI (lessons/phase-3.md). -->
**Warning**: a new worktree has no `contracts/bridge/evm/{lib,out,cache}`. Copy them in first (`implementations-plan/lessons.md`).
1. Check I1 and wire the handler into the sandbox manifest.
2. Measure the suite's wall-clock before the change.
3. Change the browser cells. Update each changed family's fixture `cells` count (`fixtures/test.ts:104`).
   - **Cells 18, 18b, 19**: select the AZTEC tile instead of pasting.
   - **Cell 34**: AZTEC is first; a paste of its address shows the existing row with no Add action.
   - **New cell 18c**: token + gas on AZTEC from the tile.
     - Assert the fee asset's portal is absent before, then send through the real UI grant prompt.
     - Assert both L2 legs settle, and that the receipt names the token.
     - Failure mode: inline portal creation, the grant and the identity split together, which only mocks cover today. Estimate: 90 s.
   - **New cell 47**: from a disconnected Drip tab, the card connects the Ethereum wallet and mints with one signature.
     - Assert the chain balance grows by the minted amount.
     - Back on Send, the AZTEC tile shows the new balance.
     - Failure mode: the card's own connect path and the cross-tab refresh, which jsdom cannot drive with a real provider. Estimate: 30 s.
4. Take screenshots of the picker, the strip and the card for the PR.

**Validation gate**: `bun run e2e:tools` exit 0 with the new cells green. Record the wall-clock before and after in `lessons/phase-3.md`. Layers: browser e2e against the sandbox.

**Pre-PR gate** (`AGENTS.md` Quality gates): `bun run audit:tools && bun run test:all` exit 0, run after the fix loop and before `gh pr create`.

## Delivery

One arc, one branch (`worktree-aztec-fee-asset`), one PR: `feat(tools): list aztec first in the send picker and mint it on testnet`. The PR body carries the screenshots and the e2e wall-clock before and after. The close-out lands as the PR's final commits. Parallelism: the phases are sequential (Phase 3 tests Phases 1–2), so there are no lanes.

Size: about 200 lines against the light target of 150. The extra comes from the copy that needs sign-off and the two-round audit record.

## Plan audit (Codex, gpt-6.1-sol, high, session `01a1457e`)

**Verdict**: conditional approve (with conditions: resolve the Drip Ethereum connection, retryable chain-correct mint reads, refresh Send balances after a Drip mint, specify the fallback minter, tighten the gates and security claims). Every finding was verified against the code; all six were adopted:

| # | Finding | Disposition |
|---|---|---|
| M1 | The Drip header has no Ethereum controls (`AppShell.vue:78`) | adopted: the card connects and switches itself; F5 corrected |
| L2 | The text "AZTEC" is not reserved by the address dedupe | adopted: security claim corrected, namesake unit case; known limit, no registry |
| M3 | A one-time `mintAmount()` read can fail or go stale; a fixed "1000" can lie | adopted: re-read on connect, chain-checked; success amount from the `Transfer` log |
| M4 | A Drip mint leaves Send balances stale | adopted: `SendWizard` watches `lastMinted` and calls `onMinted` (round 2 moved it out of the strip, which unmounts off the token step) |
| L5 | The fallback cannot reuse `ensureFeeAssetMinter` unchanged | adopted: optional `minter` parameter |
| L6 | Missing pre-PR gates; cell ids and the cell-34 expectation were wrong | adopted: pre-PR gate; cells 18c and 47; cell 34 expects the known row |

**Round 2** (verification, same session): five conditions met; one regression found. The strip-hosted relay misses mints while the strip is unmounted. **Verdict**: conditional approve (with conditions: move the refresh watch to `SendWizard` scope, and test a mint confirmed during the Amount step). Applied above: the M4 row, Phase 2 step 4. The Codex fix loop on the implementation (below) re-checks them.

## Post-implementation

While implementing:
- Write comments to the value-per-character bar, with no plan references.
- Log attempts in `lessons/phase-N.md`.
- At each gate, run `agent-worktree status aztec-fee-asset "phase N green: <next>"`.
- Stop and reassess after 3 failures on one step (5 under `/loop`).

1. **Codex audit** of the net diff from `6196c4b`:
   - Run `run-codex.sh` with `gpt-6.1-sol` as the fifth argument, at `high`.
   - Send the diff and this plan.
   - Ask the adversarial and security question.
   - Include these two rules verbatim:
     - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
     - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. **Fix loop**:
   - Verify each claim against the repo, fix what you accept, and commit.
   - Log the round in `lessons/`.
   - Resume the same Codex session with the fix diff, under the same rules.
   - Stop when a round finds nothing material. A fix that adds persistent state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop for the owner.
   - Still material after 3 rounds: stop and report.
3. **Delivery**: run the pre-PR gate, then `gh pr create`, then `gh pr checks --watch`.
4. **Close-out**, as the PR's final commits:
   - Write `## Outcome` after the front matter. It carries the status, the PR, dropped items, `Known limits:` (the copied-symbol limit), `Open items:` and a line that retires the seeds.
   - Promote lessons to `implementations-plan/lessons.md` (dedupe, retire, stay under 8 KiB), and `memo note` each one.
   - File open items in `implementations-plan/follow-ups.md`, per this repo's `AGENTS.md` rule. A suspected weakness goes to a private draft advisory.
   - Run `git mv implementations-plan/aztec-fee-asset implementations-plan/archive/aztec-fee-asset` in its own commit, then repair the links.
   - Move the `index.md` line to `archive/index.md`.
   - Report and wait: the owner merges.
5. **Teardown after the merge**:
   - The trigger: `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/aztec-fee-asset/plan.md` succeeds. A `/goal` session arms one background wait for it after its wrap-up.
   - Run `ExitWorktree` (`keep`), then `agent-worktree done aztec-fee-asset --merged`.
   - Report what it removed.
   - Relay a refusal; never force past it.

## Seeds

ELI5: https://claude.ai/artifact/6cX92eeEVeUFVYYg97Lj5Q (source: `implementations-plan/aztec-fee-asset/eli5.html`, gitignored; republish the same path to keep the URL)

```
/goal All three phases marked ✓ in implementations-plan/aztec-fee-asset/plan.md, each backed by its validation gate reported passing in the transcript, with LESSONS_FILE=implementations-plan/aztec-fee-asset/lessons/phase-N.md printed per phase; /code-review NOT run (code_review: off); the Codex fix loop on gpt-6.1-sol converged, evidenced by a resumed pass reporting no new material findings quoted in the transcript; the pre-PR gate (`bun run audit:tools && bun run test:all`) exit 0 in the transcript; one PR opened only after that, carrying screenshots and the e2e wall-clock, with the close-out's archive-move commit shown by `git show --stat`.
```

```
/loop 15m Drive implementations-plan/aztec-fee-asset forward; never idle. Each firing: read plan.md and lessons/ (not the chat), judged against its Outcome & Quality Bar. If plan.md is gone: `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/aztec-fee-asset/plan.md` succeeds → run the teardown (ExitWorktree keep if entered, then `agent-worktree done aztec-fee-asset --merged`), report, clear this loop, STOP; fails → babysit the PR's checks only, report once when green, STOP. Otherwise take the next pending step, run `bun run lint` and `bun run test:tools` after each edit, commit and push the branch. Stuck or deciding: consult `/codex high` on gpt-6.1-sol, log the verdict in lessons; never merge, deploy or widen scope. Same step failed 5 times: reassess with codex. Phase green = its plan.md gate passes: paste it, mark ✓, print LESSONS_FILE, `agent-worktree status`. All ✓: run plan.md's Post-implementation from where it stands (pre-PR gate before the PR), then report and stop; merging is the owner's call.
```
