# Phase 8: The cross-chain screens

**Verdict: built; the gate results are in the Gate section below.** S-1…S-11, S-15 and S-16 are built from the
14 signed boards (digests checked against the plan before building). The Phase 7 plumbing now has its screens:
`crossChainRecords` render on Activity, in the dock, on the stepper and on the receipt; `useCrossChainRoute` is
bound to the wizard's `useGasShare` through `useCrossChainSend`; `useSourceChain` reads per-chain balances through
`readClientFor` and switches the wallet's chain; backups carry both journal keys; "Continue from Ethereum"
pre-fills an Ethereum-origin send. Every state a board does not draw is a proposal awaiting the owner (G-UX-2).

## Facts the next phases rely on

- **The source registry decides the path.** A token-step row is a source row exactly when `sourceTokenOf` finds
  it in `appSources()`; every other row is the Ethereum-origin path. `crosschain-steps`, `crosschain-activity`
  and the footer read the registry through that one lookup.
- **Bridging starts at the transport, not the hash.** A cross-chain record reads "Sending" until discovery writes
  `route.transport` from the source receipt; a broadcast `srcTxHash` alone keeps the Send phase active. The card,
  the stepper and the outcome panel's "stalled" all key on it.
- **A wallet throw without a clear rejection keeps the record and watches it at once**; the first discovery that
  finds the send lifts the flow's error flag (`clearRecordError`).
- **The signer is the wallet client's account.** `sendOn` passed the quoted account as the signer, so the
  account-switch refusal could never fire.
- **No price source exists**, so every fee and balance is in the source token's units ("≈ 0.49 USDC · 9.8 %").
  `FEE_CEILING_BPS = 1000`: mainnet blocks a token send over it, testnet only warns, a gas-only send never blocks.
- **The quote's 60 s TTL is visible**: the amount step re-quotes at zero, the review's band counts down and an
  expired quote replaces Sign and send with the H-States #3 box; Refresh quote re-asks in place.
- **Outcome panel.** `outcomeVariant(rec, now)` non-null swaps the stepper for `CrossChainOutcome`; a stalled send
  keeps this session's log under it (`BridgeLog`, shared with the stepper).
- **Shell requests.** `continueFromEthereum` and `showReceipt` queue one request each; the wizard (always mounted
  behind `v-show`) takes them through a watch.
- **Scoped class names collide inside one component.** A `.sign` rule for the "You sign" line also styled the
  Sign and send button; the line is now `.itemised`.
- **`ref()` deep-unwraps `Fr`**; the frozen review is a `shallowRef`. `SendWizard` tests must mock
  `useCrossChainSend`, or a second `useTokenSelection` disposes twice.
- **Vue condenses whitespace between inline spans split across lines**; use `{{ " " }}`.
- **`formatBigInt` defaults to 2 decimals**: native balances use 4 so a small ETH balance is not "0.00".
- **Every testnet send is built on fixed terms, with one exclusive relayer.** Two owner decisions set this.
  First, Across's testnet API returns no quote for the router message. Second, Across's own testnet relayer
  fills with 1.15× the node's gas estimate, and on Sepolia that lands in ReceiverAcrossV4's recovery path, so an
  organic fill sends the token back to the wallet.
  - `selfBuiltTerms` lives in `bridge-core/src/across-self-built.ts`, and the canary imports it from there. It
    keeps 25 % for the relay, gives a 2 h fill window and names `filler` as the exclusive relayer until
    `fillDeadline`. It throws on an L1 of chain 1.
  - `TESTNET_FILLER` is the pinned testnet canary signer, and a test holds the two equal.
  - The builder writes the relayer's word and an absolute exclusivity deadline. It refuses the zero address and
    a deadline of 31,536,000 or less, which the SpokePool reads as an offset. `verifyRoute` polices both fields.
  - Off mainnet, `appRouteDeps` passes `fixedTerms`, and the route never asks Across. Each route is
    `terms: "fixed"` with `limits: null`. On mainnet the deps carry no `fixedTerms`: there, Across's quote is
    the only source, and no quote still means no route.
  - The journal keeps `route.terms: "fixed"`. On such a record `etaSeconds` is the whole fill window, not an
    estimate, so the stepper and the card wait for the manual fill, and `bridgingLate` never fires.
  - Each such send needs `fill-testnet.ts` before its deadline, or Across refunds it (S-Refunded).
  - The fee ceiling is not shown for fixed terms, because a fixed share has no amount that clears it.

## Fidelity screenshots

- The boards render locally with their canvas runtime beside them and the design's fonts served from the repo;
  every other origin is aborted. Theme comes from the board's `theme` prop default; a drawn state from its
  `this.state = { … }` initialiser.
- The build is shot through a gitignored harness (`apps/tools/harness.local/`, ignored by `*.local`): the real
  `AppShell` with `SendWizard` aliased to a fixture view that mounts the real step, stepper, receipt and outcome
  components, both wallets primed through their singletons, journal records set on the journal's refs, and a
  JSON-RPC stub answering the pinned read RPCs. The wizard raises `bridgeForm` on its form steps; a harness must
  too, or the contract links show where the boards draw none.
- The first dev-server load can answer 504 "Outdated Optimize Dep" while Vite re-bundles; load once before
  shooting.

## Open

- **Owner gates (G-UX-2):** every undrawn state built here (account switched, gas venue unreadable, route
  unavailable, a failed read, a failed contract check, the testnet over-ceiling warning, "Waiting for {source} to
  confirm the send…", register and claim prompts on the cross-chain rail, the provisional "Finalizing" guides,
  "Bridge · waiting", the revoke errors, the dock's "Ended" group, the stalled panel's "Last checked") and every
  deviation in the Phase 8 report. The fixed-terms copy is the same kind of gate: the review's terms line in the
  limits' place, its Takes row, "Fixed testnet terms" in place of the amount step's quote age, "Terms valid
  for … · rebuilt before you sign", the Details "Quote" row, and the bridging line, ETA and estimate of the
  stepper and the card.
- **Phase 9:**
  - Cross-chain browser specs: the LI.FI book injection for the sandbox chain, and the `l1-wallet` fixture's chain
    map, `wallet_switchEthereumChain` and EIP-5792 calls (from Phase 7, still open).
  - `tokens.spec` assumes the manifest's tokens head the list; with a routed source, source rows come first.
  - The outcome panel's "Lands as ≈ …" line needs a fresh Ethereum-origin quote (`figures.continueQuote`).
  - A cross-chain send does not ask for the hub token's grant before signing; the claim asks later.
  - The Ethereum-origin review's wrong-chain notice is wired but unreachable: a chain change closes that review.
  - Whether `scan.li.fi` tracks a testnet transfer ("Track on LI.FI") is a manual check.
  - A testnet send is filled only if someone runs `fill-testnet.ts` with the canary key within 2 h, and nothing
    tells the operator one is waiting. Each carries at most 8.00 USDC (`SELF_BUILT_MAX_WHOLE_TOKENS`).
  - The review's quoted-limits line can no longer render on testnet, since nothing quotes there.

## Attempts

1. Four workers built the surfaces in one worktree. The git index is shared, so each staged only its own paths
   and checked `git diff --cached --stat` before committing; a file two workers touched was staged by hunk
   (`git hash-object -w`, `git update-index --cacheinfo`). Commitlint rejects body lines over 100 characters.
2. Gate 1's first run timed out one `AddressesView` test at 5 s while the screenshot run loaded the machine; it
   passes alone and in the rerun. Gates and the screenshot run go one at a time.
3. Two e2e runs were stopped when the code changed under them (27 and 9 of 70 green; the runner's EXIT trap
   reaped each sandbox group). The second had failed `activity.spec` cell 40, two tabs racing: one record had
   no `claimTxHash` when its stepper showed it arrived. That code is not cross-chain, and the cell passed in the
   runs before and after, so it is a flake.

## Fix round

Two fresh reviewers compared the shots with the signed boards. Their lists were the spec for this round. Every
row classed `fix` was fixed, or is listed in the report with the reason it was not.
- **Evidence was the first defect.**
  - The boards had rendered in fallback fonts. Their stylesheet answers a `fonts.googleapis.com` request, so a
    relative font URL resolved against that origin; the URLs are now absolute, and the renderer refuses a page
    whose A′ fonts did not load.
  - The full-page 390 captures painted the fixed action bar mid-page. Phone shots are now 390×844 viewport
    captures, a taller page adding scrolled ones.
  - The harness had hidden or changed what the wizard shows: no review band, a stepper where the receipt opens,
    no foreground record, hashes too short to link, no `bridging-late` step, quoted terms where testnet only
    builds fixed ones, a 406/410 mismatch. It now does what the wizard does in each case.
- **Fixed terms dropped A10's cap.** `limits` is null on fixed terms, so nothing bounded a send that only a
  ~30 USDC filler can fill. `SELF_BUILT_MAX_WHOLE_TOKENS` (8, Across's testnet `maxDeposit`) restores it, and
  a larger send is refused as no route.
- **Never remove a feature to match a board.** The app chrome, "+ Add USDC to wallet", the Activity footer
  line, the backup control on in-flight cards, the Clear and tx-link rows, the "Testnet build only" caption
  and the mint strip go to the owner instead.
- **Workers in one worktree.** Three workers split the rows by file. Two rows touched a file another worker
  owned, so their owners took patches (the approval hash, the outcome log's links), and two (`RecordChips`,
  `DockStrip`) were left for the parent. A worker that hits its turn limit resumes with a message naming what
  is uncommitted.
- **The approval is a journaled fact now.** `approveTxHash` on a cross-chain record draws the Approve row and
  its link after a reload. `observedRows` skips it, or the log would print the hash twice.
- **D46 leaves signed copy false.** Five strings still name "Across's test relayer". Replacement copy is
  proposed in the report and is not applied.

## Fix round 2

Two fresh reviewers compared the round's shots, now rendered in the real fonts, with the boards. Their 29
`fix` rows were the spec.
- **A fix built on bad evidence regresses.** Round 1 moved S-Delivered's aside under its buttons from a
  fallback-font render; with the real fonts the board puts it beside them, and at 390 the "fix" clipped it.
  When the evidence changes, re-check the previous round's fixes against it before building on them.
- **The send on screen is a dock row like any other, marked.** It keeps its own group (Needs you, Ended), its
  action and its place in the badge; only the dock's self-opening skips it, since the stepper is already on
  screen. An outcome replaces "this send" with what happened, and a delivered send's Continue stays a word
  beside the panel's button. A receipt reopened from Activity marks its row too: `receiptFromActivity` now
  carries the record id. A tone rule that zeroes the fill, or colours the word, must not outrank the current
  row's own rules (`Slow` turned pink, an ended current row went flat).
- **A row shows what left the wallet until the send arrives.** A cross-chain record reads as its deposit once
  that lands, so its amount dropped to the token part mid-flight; an Ethereum-origin token + gas send headed
  its stepper with the token claim alone. `sentAmountOf` adds the gas slice back.
- **A preview reads the bridge's L1, not the wallet's chain.** The delivered panel's "Lands as" resolves the
  Ethereum token and probes its gas venue through `readClientFor(l1)`: after a send from a source chain the
  wallet usually sits there, and a read through its client fails the chain check. The slice comes from the
  amount step's own gas plan (`gasPlanFor`).
- **The git index is shared, so commit by pathspec.** A plain `git commit` took files a worker had just
  staged. `git reset --soft HEAD~1`, then `git commit -F <msg> -- <own paths>`, which commits only those
  paths and leaves the rest staged.
- **Flex truncation in priority order needs weights, not small factors.** The dock's second line is route,
  middle and last. With shrink factors under one, the middle stopped short once the route hit its minimum
  (the spec scales the free space by their sum) and overflowed; with the route merely heavier, the middle's
  sliver of the shrink still clipped it with an ellipsis. The route's factor is a million, so the middle's
  share stays under a layout unit until the route is spent.
- **Phone captures overlap.** The review's fixed action bar hid a band of every scrolled 390 capture; the
  shooter now steps 160px less than the viewport.
- **The owner approved the manual-fill copy.** The review notice, its Takes row, S-Refunded's account, the
  expired card and `expiryLead` now say a testnet send waits for a manual fill and is refunded after the
  window; mainnet keeps the relayer wording.
- **Not fixed:** "which is enough" beside the ETH held (the app has no gas estimate for an Ethereum-origin
  send, so the claim could be false), "Show receipt" on the another-deposit card and the "Testnet build only"
  caption (owner keeps or drops).

## Gate

On fix round 2's final code, one gate at a time:
- `contracts/` is untouched by this phase; forge was not run.
- `bun run lint && bun run typecheck:all && bun run test:all`: Biome clean, complexity baseline OK; design 242
  passed; bridge-core 73 files, 688 passed and 11 skipped; tools 126 files, 1742 passed.
- `bun run audit:tools`: 1742 passed, complexity baseline OK, every committed address matches its rebuilt
  instance, the build succeeds.
- `bun run e2e:tools`: 70 passed. No page object needed a change: no spec reads the dock rows or drives a
  cross-chain send.
