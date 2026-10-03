## Outcome

Archived. Seeds retired.

# Fuel L1 mint — `/blueprint light`

Add a **"Mint $AZTEC"** card to the Fuel tab so a user with no L1 fee asset can mint test
`$AZTEC` (the L1 Fee-Juice ERC20) in one click, then fuel it into L2 Fee Juice. Revisits the
original `fuel-direct-bridge` locked decision 3 ("assume already held, no mint affordance").

## 1. Goal / success criterion

- On the Fuel tab, an always-visible card mints **1000 test $AZTEC** to the connected L1 account via
  the canonical `FeeAssetHandler.mint(address)`, then the L1 balance refreshes and the user can fuel.
- Mirrors `MintTestUsdc` (Bridge tab) in shape + states; uses NEW testids (reusing them would collide —
  both views stay mounted under `v-show`).
- Also fixes a pre-existing dead-end: the Fuel form defaults to `12` but the floor is now `16`, so the
  mint→fuel happy path would error until the user edits the amount. Bump the default to `20`.
- Gates green: faucet `typecheck` · unit + component tests · smoke e2e · `lint` · `build`.

## 2. Scope

**In:** a `MintFuelAsset.vue` card (mirror `MintTestUsdc.vue`); a `mint()` on `useL1FeeAsset`; the
`feeAssetHandler` address pinned in `testnet-bridge.json` + exported from `bridge-deployments`; a
runtime fail-closed `FEE_ASSET()` cross-check; tests.

**Out:** any new mint mechanism (we call the standard handler); Bridge-tab changes (it mints AZLO/USDC,
not $AZTEC); rate-limit UI beyond surfacing a revert; live-network e2e (manual, maintainer's call).

## 3. Phases

### Phase 1 — ✅ DONE — Config + composable (`useL1FeeAsset.mint`)
- Add `feeAssetHandler: "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9"` to `public/testnet-bridge.json`'s
  `l1.feeJuice` block; export `FUEL_ASSET_HANDLER` from `contracts/bridge-deployments.ts` (alongside
  `FUEL_PORTAL`/`FUEL_ASSET`/`FUEL_MIN_FJ`).
- `useL1FeeAsset`: add **dedicated** `minting` + `mintError` refs (NOT the shared `error` — the deposit
  flow + balance poll also write `error`, so a failed `approve()`/poll must not surface as a mint
  failure, per codex). Add `mint()` — `writeContract(FeeAssetHandler.mint, [owner])` then
  `waitForTransactionReceipt` then `refresh()`. Reuse `FeeAssetHandlerAbi` from `@aztec/l1-artifacts`.
  A handler revert (e.g. rate-limit) sets `mintError`, never throws uncaught.
- **Fail-closed handler cross-check** (mirrors `verifyPortalAsset`): before minting, read
  `FeeAssetHandler.FEE_ASSET()` and refuse if it ≠ `FUEL_ASSET` (a tampered/stale handler must not be
  called). Cache the verified verdict.
- **Validation gate.** `bun run --cwd packages/faucet typecheck` + `bun run --cwd packages/faucet test
  src/composables/useL1FeeAsset.test.ts` + `bun run lint`. Pass: typecheck clean, the new mint +
  cross-check cases green, lint exit 0. Layers: typecheck · unit.

### Phase 2 — ✅ DONE — UI card on the Fuel tab
- `components/MintFuelAsset.vue`: mirror `MintTestUsdc.vue` (heading, one-line body, `Button` with
  loading/disabled). Copy follows the just-shipped style rules: no em dashes, no redundant header.
  Use **generic CTA copy** ("Mint test $AZTEC", NO live `mintAmount()` read — avoids handler-controlled
  UI + a fallback path, per codex). Reads/binds the dedicated `minting`/`mintError` from the composable
  (inline error text — Fuel-view journal toasts are disabled). NEW `data-testid`s in `lib/testids.ts`
  (`fuelMintCard`, `fuelMintBtn`).
- Gate the button on **L1 connected AND on the right chain (Sepolia)** — do NOT copy `MintTestUsdc`'s
  weak connect-only gate (codex). Mount it in `FuelView.vue` (below `FuelForm`, above the journal).
- Bump `FuelForm`'s default amount `12` → `20` (above the 16 floor) so mint→fuel doesn't dead-end.
- **Validation gate.** `bun run --cwd packages/faucet typecheck` + `bun run --cwd packages/faucet test`
  (unit + component, incl. a `MintFuelAsset.test.ts` ≥5 cases) + `bun run --cwd packages/faucet
  test:e2e` (fuel smoke still green) + `bun run lint` + `bun run --cwd packages/faucet build`. Pass:
  all green. Layers: typecheck · unit · component · smoke e2e · build.

## 4. Security & Adversarial Considerations

- **Threat model.** Frontend-only; the mint is a permissionless testnet faucet call. No secrets, no
  auth, no privileged creds. The attack surface is a user pointing the button at a wrong/tampered
  handler or asset.
- **Wrong/tampered handler (top risk).** Because the address is PINNED in config (the user's choice),
  the pinned address IS the trust boundary: it must be code-reviewed against the node's
  `getNodeInfo().l1ContractAddresses.feeAssetHandlerAddress` (= `0x5602c39a…` on V5) at config time.
  The fail-closed `FEE_ASSET() == FUEL_ASSET` cross-check is a CONSISTENCY guard (the pinned handler
  hands out the expected asset), NOT an authenticity check — a malicious handler could return the right
  asset and still misbehave (codex). So the guard layers on top of address review, it does not replace
  it. (`FUEL_ASSET` is itself cross-checked against the portal's `UNDERLYING()` in the deposit path.)
- **Input validation.** No user input feeds the mint (fixed amount, `owner` is the connected account).
- **Rate-limit / revert.** The handler may rate-limit per address; a revert surfaces as inline error
  text (the card's dedicated `mintError`; Fuel-view journal toasts are disabled), never an uncaught
  throw or a false "minted".
- **Supply chain.** No new deps (`FeeAssetHandlerAbi` is in the already-pinned `@aztec/l1-artifacts`).
  `@aztec/viem` unchanged. Frozen lockfile.
- **Clickjacking/XSS.** No new HTML sinks; `Button` + static copy only.
- **Testnet-only.** The card is bounded to the testnet deployment (same as `MintTestUsdc`); document it.

## 5. Assumptions

### Facts (verified)
- The V5 node exposes `l1ContractAddresses.feeAssetHandlerAddress = 0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9`
  (probed live via `getNodeInfo()`).
- `FeeAssetHandler.mint(address)` is `nonpayable` with no auth arg (permissionless); `FeeAssetHandlerAbi`
  also exposes `mintAmount() view`, `FEE_ASSET() view`, `setMintAmount`, `owner` (probed the ABI).
- `mintAmount() == 1000e18` on the live V5 handler (probed) — ≈62× the 16 FJ fuel floor, so one mint is
  plenty; no repeat-mint logic.
- `FeeAssetHandlerAbi` is exported from `@aztec/l1-artifacts` (verified import).
- `FUEL_ASSET = 0x762c132040fda6183066fa3b14d985ee55aa3c18` = the node's `feeJuiceAddress` = the
  portal's `UNDERLYING()` (established in `fuel-direct-bridge`); the handler's `FEE_ASSET()` must equal it.
- The mint template exists: `useL1Usdc.ts:99 mint()` (`writeContract`→`waitForTransactionReceipt`) +
  `MintTestUsdc.vue` (the card); `useL1FeeAsset.ts` already has `balance`/`refresh`/`approve` + the
  `verifyPortalAsset` fail-closed pattern to copy.

### Inferences (attack these)
- The handler MIGHT rate-limit per address — the absent ABI cooldown getter does NOT prove there's none
  (codex). This is acceptable ONLY because a revert is surfaced gracefully as inline error text, not
  because first-mint success is guaranteed.
- (Resolved → out) CTA uses generic copy, not a live `mintAmount()` read — drops the extra
  handler-controlled read + its fallback path (codex: smaller + safer).

### Asks (resolved by the user)
- Placement → **always-visible mint card**. · Handler address → **pinned in `testnet-bridge.json`**. ·
  Validation → **unit + component + smoke** (no `/harden`, no live-network gate).

## 6. Post-implementation hardening
Not warranted: testnet-only, permissionless mint, no secrets/auth/CI surface. (Recorded per protocol.)

## 7. Audit verdicts
- **Codex (`/blueprint light` single audit, xhigh): conditional approve** — conditions: (1) narrow the
  handler-security claim, (2) isolate mint UI state from the shared fee-asset error, (3) fix the
  "mint then fuel" happy-path default. No HIGH/Critical. All findings folded in:
  - MED (FEE_ASSET guard ≠ authenticity) → §4 narrowed: pinned address is the trust boundary
    (review against the node value); the cross-check is a consistency guard only.
  - MED (shared `error` ref) → Phase 1: dedicated `minting` + `mintError` refs, not the shared `error`.
  - MED (default 12 < floor 16 dead-ends) → §1 + Phase 2: bump `FuelForm` default to 20.
  - LOW (testids would collide under `v-show`) → §1 + Phase 2: NEW testids, not reused.
  - LOW ("error toast" misstated) → §4: inline error text (Fuel toasts disabled).
  - LOW ("no cooldown getter" weak) → §5: reworded; revert-handled-gracefully is the real safety.
  - LOW (`mintAmount()` CTA + wrong-chain gate) → Phase 2: generic CTA copy; gate on connected + Sepolia.
  - Affirmed: pinning the handler in the same config as portal/asset is coherent; the cross-check is
    worth keeping; unit+component+smoke is the right depth.
- **Codex post-impl audit (xhigh, on the impl diff): no HIGH/CRITICAL; all 4 plan-conditions verified
  implemented.** One MED + one LOW:
  - MED (`waitForTransactionReceipt` resolves on a mined revert → false "minted") → **fixed**: capture
    the receipt + `throw` if `status !== "success"`; pinned by a new reverted-receipt test.
  - LOW (`verifyHandlerAsset` cache lives the page lifetime; only wrong if the pinned contract changes
    mid-session) → **accepted** (pinned-address-is-the-trust-boundary; a proxy upgrade mid-session isn't
    a testnet concern). Noted.
  - Follow-up (out of scope, pre-existing): `approve()` has the same revert-not-checked pattern — a
    reverted approve would silently "succeed". Not in the mint plan's scope; left for a separate fix.
