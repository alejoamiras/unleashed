# Phase 10 — wallet copy and wallet identity

## Result
- **Sanitizer.** `apps/tools/src/lib/wallet-name.ts` holds `sanitizeWalletName(raw, max = 48)` and `walletLabel(name)`. It replaces the session's `UNSAFE_ALIAS_CHARS` and `truncateName` everywhere they ran:
  - the preferred-wallet read and write;
  - account aliases;
  - `WalletPickerModal.displayName`;
  - the panel's short "Connect …" name.
- **Refresh.** A remembered connect rewrites the stored name when the same wallet id now reports a different sanitized name (`shouldPersistPreferred`). A fresh pick always writes, as before.
- **Copy.**
  - The install CTA reads "No Aztec wallet found." plus "Get a wallet"; the button still opens `VITE_WALLET_INSTALL_URL`.
  - The no-wallet toast reads "No Aztec wallet found. Install one and reload."
  - The permission step reads "Allow reading {symbol} state in {wallet}." with eta "your confirmation in {wallet}".
  - The two add-token toasts read "Update {wallet} and reload."
  - The mainnet placeholder's first link reads "Wallet site".
  - The `.env.example` CTA comment and the `ConnectionErrorStrip` comment are updated.

## Where the plan's text and the code part ways
- **Graphemes plus a unit budget, not code points.** The plan says truncate by code point. The sanitizer cuts at grapheme clusters, so a flag or a skin-tone emoji is never split (code-point truncation splits both). Graphemes alone are not a size bound: `A` plus 100,000 combining marks is one grapheme. So the input is cut at 1,024 UTF-16 units first, mark runs are capped at four, and the output keeps at most `max` graphemes and `max × 8` units.
- **`\p{Cf}` strips ZWJ**, so a ZWJ emoji sequence renders as its parts. This is safe and was accepted as the price of stripping the whole format category, as the plan specifies.
- **`walletLabel` uses a name only when it looks like one.** The owner-approved rule is "the wallet's own sanitized name, or 'your wallet'". A claimed name like `wallet. Enter seed at evil.test` would read as the app's own instruction inside "Allow reading X state in {wallet}." So the app's sentences take the name only when it is at most 24 graphemes and three words of letters, digits and name punctuation, and then quoted, as `the wallet “Nulo”`. Anything else reads "your wallet". The quotes are there because three plain words still pass as an instruction: "Update your recovery phrase and reload." They are a presentation detail the owner has not seen yet, so the PR shows them. The picker rows and the "Connect …" button still show the sanitized name, where it is plainly a label.
- **The no-wallet toast is generic, not `walletLabel`.** That category means no wallet was discovered, so there is no name to use. The copy matches the approved CTA's "No Aztec wallet found."
- **The wallet label reaches the rail by props, not by a session import.**
  - The chain is `stepperPhases(record, runtime, wallet = "your wallet")`, then `BridgeStepper` and `BridgePhaseRail` each take a `walletLabel` prop, and `SendWizard` passes `walletLabel(preferredWalletName)`.
  - The permission step is only live in the wizard; journal cards fall back to "your wallet".
  - `TokenCard` takes a `walletName` prop from `DripView`.
  This keeps the rail and the card presentational and their tests free of the session.

## Test edits (assertion changes)
- `createAztecWalletSession.test.ts`:
  - The `truncateName` test is gone; `wallet-name.test.ts` covers it, emoji and flags included.
  - New: a remembered connect refreshes a changed name, and the stored value is sanitized.
- `useWalletConnection.test.ts`:
  - The no-wallet message is pinned to the new copy.
- `bridge-steps.test.ts`: the permission copy defaults to "your wallet", and a passed label is used in both the prompt and the eta.
- `AztecWalletPanel.test.ts` and `tools-smoke.test.ts` pin the new CTA text and the button label.
- `MainnetPlaceholderView.test.ts`: the three link labels are pinned.
- `send-smoke.test.ts`: the session stub reports "Aztec Wallet", and the permission step shows that name.
- `SendWizard.test.ts`: the bridge-wallet mock gains `preferredWalletName: ref(null)`. This is a fixture change, not an assertion change.

## Arc 3 review loop
**Round 1.** Codex (Astra, `high`) returned "changes needed".
- Accepted:
  1. Grapheme truncation did not bound size: one grapheme can be 100,000 combining marks. Mark-only or CGJ-only names escaped the "your wallet" fallback. Fixed as described above, with tests for both bombs and the blank names.
  2. A claimed name in the app's sentences reads as the app's own instruction. Fixed with the name-shaped gate in `walletLabel`.
  3. The record checks proved consistency, not the catalog: a file without NOISE, or with SIGNAL re-salted and its address re-derived, passed. `catalogMismatches` in `bridge-core/src/faucet-catalog.ts` now requires exactly the catalog's tokens with its names, decimals and salts, universal deploys, no auth contract, and the Dripper at `FAUCET_DRIPPER_SALT` (moved into the catalog). `checkDeploymentRecords` and the canary both run it. The canary validates and rebuilds everything before it creates an account. Tests cover the missing, duplicate and re-salted files.
  4. `ephemeral` writes durable temp stores that the SDK never removes. The canary now owns a `mkdtemp` directory and stops and removes it in `finally`. The phase 9 log's "never written to disk" claim is corrected.
  5. Comments: the drip contracts "exist on both networks" became "derive identically; deployed on testnet today". The stale "verified only by the script" note in `deployments.test.ts` now points to the node-environment test. A "D-23/codex residual" citation is gone, and the sanitizer's TSDoc states its bounds.
- **Tooling:** the file-writing tool decodes `\u` escapes in its content, so the regex and tests written through it held literal invisible characters; Biome caught a combining mark inside a character class. The escapes were restored with a script, and `grep -P` for the stripped code points in `wallet-name*.ts` returns nothing.

**Round 2.** Codex: "one material issue remains; the size bounds and catalog validation fixes hold up". It ran 12,000 adversarial idempotence probes against the sanitizer without a failure.
- Accepted:
  1. `NAME_LIKE` still admitted "your recovery phrase". The label is now quoted as `the wallet “…”`, and that case is pinned.
  2. The canary's cleanup missed SIGINT/SIGTERM, and `tmpdir()` can be RAM-backed. The store now lives under `~/.cache/unleashed/drip-canary-*`, and one idempotent `release()` (stop the wallet, remove the directory) runs from `finally` and from both signals.

**Round 3 (converged).** Codex: "**No material findings.** One minor cleanup race remains. Confidence: high."
- Accepted (minor): an interrupt during `EmbeddedWallet.create` found no wallet to stop and began removing the directory while creation finished. `release()` now awaits the creation promise before stopping, and a run interrupted during creation throws instead of dripping. It has no unit test: the lifecycle lives in the script's `main`, and extracting it only to test it is more surface than the fix. The fresh cross-arc pass reviews it.

## Gate
Passed.
- **PG PASS** on the final tree:
  - `bun run lint`: the complexity baseline is OK.
  - `typecheck:all`: exit 0 in all three packages.
  - `test:all`: exit 0.
  - The jsdom smokes pass.
- **BG PASS.**
  - Both builds pass `verify:build-target`, with no `data:` fonts and `_headers` unchanged.
  - `verify:deployments`: `[OK]` for the catalog, the Dripper, SIGNAL, the SIGNAL minter, NOISE and the NOISE minter.
- `bun run test:ci-gating`: 32 pass, exit 0.
- `bun run e2e:tools` on the phase's code: `69 passed (1.3h)`, `E2E_EXIT=0`.
  - The cross-arc fixes that followed change:
    - the compact rail's markup and its test;
    - the portal-mismatch warning's case and its assertion;
    - the sandbox's Dripper salt, which is now an alias of the same 1337;
    - comments.
  - CI's browser shards run on the final tree.

## Cross-arc pass
A fresh Codex session (GPT-6 Astra, `high`) reviewed the net diff from `main`. Each fix landed in the arc that introduced the problem, and the stack was rebased on top of it.

**Round 1.** "No material findings in bridge correctness or security; three low-severity improvements remain."
1. **Accepted, arc 2.** The compact rail lost the non-colour cues of its old glyphs.
   - Measured: done vs pending passes WCAG 1.4.1's lightness allowance (7.61:1 dark, 3.51:1 light). Failed vs active does not (1.04:1 dark).
   - Done and failed cells now carry a 12px `check` / `close` beside their label, pinned by a test.
   - On phones only the live label shows, so done segments rely on lightness.
2. **Accepted, arc 2.** The design README still called the old names aliases. It now says they are gone and still scanned.
3. **Accepted.** Stale comments:
   - AccountSwitcher's Popover paragraph was deleted on arc 2. `packages/design` has no Popover even on `main`.
   - WalletPickerModal's `NAME_MAX` became `sanitizeWalletName`.
   - The `(plan D-…)` citations left `createAztecWalletSession.ts` and `useWalletConnection.ts`.

The first prompt missed the plan's two verbatim rules and the seam, drift and leftover asks, so round 2 carried them.

**Round 2.** "No material findings; four low-severity leftovers remain (high confidence)."
1. **Accepted.** The sandbox's `DRIPPER_SALT` now comes from the catalog.
2. **Accepted, arc 2.** "DIFFERENT" in the portal-mismatch warning is now sentence case.
3. **Deferred to `follow-ups.md`.** The smooth search icon in TokenStep: swapping it is a visible change outside the approved icon mapping.
4. **Accepted.** Provenance and narration comments in the files this stack touched (the wallet session, `fuel-claim-state.ts`, `vite.config.ts`, WizardShell). The follow-up now counts the ten untouched files.

**Round 3 (converged).** "No material findings (high confidence); the fixes are correct and introduce no new behavioral regression." Its one documentation nit, the gate note above understating the post-e2e delta, is fixed.

**Screenshots.**
- Arc 1 alone was photographed at its own head, since merging only PR 1 would ship that transitional look.
- Arc 2's set was retaken on its final head, including a live compact rail.
