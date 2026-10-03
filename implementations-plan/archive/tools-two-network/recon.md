# Recon — two-network tools deployment

Phase 0.4 codebase recon for `tools-two-network`. Four read-only explorers mapped the surfaces the
work touches. This file feeds the plan draft AND every audit: reviewers should check the design
against the reuse map below ("does this duplicate or ignore what recon found?").

---

## Scope

Make `apps/faucet` (served at `app.unleashed.systems`) build and deploy **twice** from one codebase —
mainnet/Alpha and testnet — each bound to its own contract addresses. Mainnet's token bridge binds
to **official Ethereum USDC** (6-decimal); testnet binds to a **self-deployed 6-decimal test USDC**
on Sepolia. Fee-juice bridging must work on both.

---

## Surface A — app network/config consumption

### What exists

| File | Purpose |
|---|---|
| `apps/faucet/src/lib/chain-constants.ts` | Compile-time pin of testnet L1 chain id (Sepolia `11155111`), rollup version (`1821665230`), derived wallet chainId (`1816023401`). Zero imports; **deliberately no env override**. |
| `apps/faucet/src/lib/chain-info.ts` | Builds the `ChainInfo` for wallet-sdk discovery; precedence is URL `?chainId=&version=` then the constants. |
| `apps/faucet/src/contracts/bridge-deployments.ts` | Reads `public/testnet-bridge.json` via a **bundled JSON import** (not runtime fetch), strict-parses through `parseCandidateManifest`, exports L1/L2 addresses + token identity. |
| `apps/faucet/src/contracts/deployments.ts` + `deployments.json` | The faucet's own TKA/TKB token + Dripper records (unrelated to the bridge). |
| `apps/faucet/src/App.vue` | `defaultTab()` — `hostname.startsWith("bridge")` → Bridge tab. Only other hostname-as-input site. |
| `apps/faucet/src/lib/explorer.ts` | Aztec explorer URL builder (`VITE_EXPLORER_BASE_URL`, default testnet aztecscan); **Sepolia etherscan URLs hardcoded, no override**. |

### The incident that constrains the design

`chain-constants.ts`'s header documents why there is no `VITE_CHAIN_*` override: a stale Cloudflare
`VITE_CHAIN_VERSION=4127419662` once shadowed the correct value, producing a wallet chainId the V5
wallet had no network for ("No network configured for chainId …"). `.env.example` repeats the rule.
**Any network selector that is a Cloudflare-dashboard-editable env var reproduces this exact
failure.** The selector must be baked into git-committed source per build target, or be a CI
pipeline parameter checked into `.github/workflows/`.

`chain-info.ts`'s `?chainId=&version=` URL override is **not** a safe reuse seam: it is an
unauthenticated client-side override with no allowlist, and it changes only the wallet handshake
while every other layer (bundled manifest, `sepolia`-pinned composables) stays put — a *worse*
version of the original incident (partial/inconsistent chain identity).

### `sepolia` is hardcoded in 9+ app files

`useL1Wallet.ts` · `useDeposit.ts` · `useWithdraw.ts` · `useFuel.ts` · `useL1Usdc.ts` ·
`useL1FeeAsset.ts` · `useBridgeJournal.ts` · `useBridgeBackup.ts` · `components/BridgeForm.vue`
(plus display-only "SEPOLIA" strings in several components).

Sharpest edges: `useBridgeJournal.ts:302` and `useBridgeBackup.ts:120` hard-check `rec.chainId !==
sepolia.id` as a stale-deployment guard. Left unparameterized, a mainnet build would either falsely
quarantine valid records or wrongly accept testnet ones.

`NODE_URL` (Aztec node) is **triplicated** with the same testnet default in `useFuel.ts:43`,
`useDeposit.ts:84`, `useWithdraw.ts:40`.

---

## Surface B — deploy + verify tooling

### What exists

| File | Purpose |
|---|---|
| `apps/faucet/scripts/deploy.ts` | Deploys the faucet's own L2 Dripper + tokens. **Already has `--network`** (`"testnet" \| "local-network"`). Candidate-first output; refuses live output without `--allow-live-output`. |
| `apps/faucet/scripts/deploy-config.ts` | `Network` union + `NETWORK_URLS` + token/salt catalog. **Zero Ethereum coupling** (L2-only). |
| `apps/faucet/scripts/verify-deployments.ts` | Offline address-rebuild verifier (**no RPC, chain-agnostic**). Opt-in bridge-manifest check via `BRIDGE_MANIFEST`. |
| `packages/bridge-core/scripts/deploy-bridge-testnet.ts` | The bridge deploy: L1 token + the forked portal, L2 proxy/token/bridge, wiring, journal, candidate manifest. |
| `packages/bridge-core/src/reuse-token.ts` | `--reuse-token` seams: arg parse, **decimals-aware** metadata readback, manifest match, portal-uninitialized assertion. Unit-tested. |
| `packages/bridge-core/src/candidate-schema.ts` | Strict zod manifest schema. `network: z.string()` → a `mainnet` manifest **validates today**. `l1.token.decimals` accepts 0–36. |
| `packages/bridge-core/scripts/verify-l1.ts` | Etherscan source verification. `CHAIN_ID = "11155111"` + `sepolia.etherscan.io` hardcoded. |
| `packages/bridge-core/scripts/live-intent.ts` | Deploy-intent build/verify/promote + signer + spend-cap gates. `PLAN_PINNED_L1_SIGNER = 0xFcc2238319aC360e985f1736aBB3df6251DAF6F5`. |

### Three blockers for a mainnet deploy

1. **SponsoredFPC pays every L2 send** (`deploy-bridge-testnet.ts:232-237`) — account deploy, all
   three contract deploys, and both wiring txs. SponsoredFPC **does not exist on Aztec mainnet**
   (confirmed in `fuelClaim.ts:9,195` and `bridge-core/src/fee-juice.ts:8`). Mainnet needs the
   deployer account pre-funded with real Fee Juice + a balance-based payment method threaded
   through every `.send()`. This is an adaptation, not a parameter.
2. **9 bridge-core scripts hardcode Sepolia** with no `--network` seam at all
   (`deploy-bridge-testnet`, `deposit-testnet`, `deploy-sandbox`, `fuel-testnet`,
   `fee-juice-canary-testnet`, `smoke-existing-testnet`, `smoke-swap-existing-testnet`,
   `verify-l1`, `live-intent`). Unlike `apps/faucet/scripts/deploy.ts`, which has a clean one.
3. **`PLAN_PINNED_L1_SIGNER` is a single global constant**, hard-asserted before any spend
   (`deploy-bridge-testnet.ts:142`, `fuel-testnet.ts:91`, `live-intent.ts:183`). Needs to become
   network-keyed so mainnet cannot silently run under the testnet key.

### Token identity is NOT "USDC" today

Despite variable names and comments saying `usdc`, the deploy actually creates
an 18-decimal `MintableERC20` under the test token's own name, symbol AZLO (`deploy-bridge-testnet.ts:51-53`). A 6-decimal test
USDC is a **new token identity**, not a decimals tweak to AZLO — flipping `TOKEN_DECIMALS` in place
would break the committed AZLO identity everywhere it's referenced.

**Good news:** `contracts/bridge/evm/src/MintableERC20.sol` already takes `decimals_` as a
constructor arg, and `contracts/bridge/evm/script/DeployBridge.s.sol:154` already contains
`new MintableERC20("Test USDC", "USDC", 6, 1000)`. **No contract changes needed** for the 6-dec
Sepolia token.

---

## Surface C — build / CI / Cloudflare

### What exists

- `apps/faucet/vite.config.ts` — single config. `buildMetaPlugin()` injects a build meta tag
  and writes `dist/build.json` with `chainId: TESTNET_WALLET_CHAIN_ID` (imported straight from
  `chain-constants.ts`, hence that file's no-imports constraint).
- `.github/workflows/_build-faucet.yml` — reusable: verify:deployments → test:e2e → build. **No
  network/target input**; single hardcoded build.
- `apps/faucet/public/_headers` — COOP/COEP + CSP whose `connect-src` allows only
  `*.aztec.network` / `*.aztec-labs.com`.
- No `wrangler.toml` / `functions/` / `_routes.json` / `_redirects` anywhere — pure static Pages,
  deployed by CF dashboard Git-integration. A workflow POSTs a single
  `CLOUDFLARE_FAUCET_DEPLOY_HOOK` (skips silently if unset).
- `verify-live-run.ts` — single `faucetUrl` (default
  `https://testnet.app.unleashed.systems`), `expectedWalletChainId` hardcoded to testnet via
  `chain-guard.ts`.

### The manifest is build-time, which settles the mechanism

`bridge-deployments.ts:9` does `import rawConfig from "../../public/testnet-bridge.json"` — Vite
**inlines this into the bundle at build time**. There is no runtime fetch (grep-confirmed). So
"one build = one network" is already how the app is architected. Two builds → two Cloudflare Pages
projects is the low-churn fit; a runtime hostname switch would swim against the architecture.

### Precedent to copy

The wallet already ships a dual build of this shape: a shared base config plus thin per-target
`mergeConfig` wrappers. Lesson: don't over-abstract before duplication hurts.

The wallet also **already has the mainnet pair** — L1 chain id 1 and rollup version 4248422647,
live-verified. Reuse the numbers; don't rediscover them.

---

## Surface D — decimals + fee-juice money paths

### The decimals risk is SMALLER than expected

- **Zero** `parseEther` / `formatEther` / `parseUnits` / `formatUnits` calls exist in either
  `apps/faucet/src` or `packages/bridge-core/src` (grep-confirmed). All amount math goes through
  `apps/faucet/src/lib/format.ts`'s decimals-parameterized `formatBigInt(value, decimals)` /
  `parseAmount(text, decimals)`, BigInt end-to-end.
- `BridgeForm.vue` is already decimals-agnostic; `BridgeForm.test.ts` mocks **6-dec USDC as its
  default fixture**, with `BridgeForm.18dec.test.ts` as a deliberate 18-dec pin. Direct prior art.
- Contracts are decimal-agnostic by construction: the forked portal moves `uint256`, the Aztec
  `token_bridge` / `token_minter_proxy` move `u128`.
- `deployments.test.ts` already asserts 6dec for the first faucet token and 18dec for the second faucet token side by side — the codebase
  demonstrably handles mixed decimals.

**The one real decimals defect** is a duplicated source of truth: `bridge-deployments.ts:105`'s
standalone `BRIDGE_TOKEN_DECIMALS = 18` literal vs. the manifest's own
`config.l2.token.constructorArgs[2]` (read two lines later at `:120`) vs.
`deploy-bridge-testnet.ts:53`. Three places must agree by hand; nothing enforces it.

### The Permit2 blocker (highest-severity finding)

`useDeposit.ts:823-826` (fueled path) and `:960-968` (bridge-only path) **only check** Permit2
allowance and throw *"This token does not pre-approve Permit2 - bridging is unavailable for it."* —
**no approve fallback**. Today's `MintableERC20` cheats via an `allowance()` override
(`MintableERC20.sol:47-50`) that auto-pre-approves Permit2 for every holder. **Real USDC does
neither.** Binding to real USDC makes the token-bridge deposit fail 100% of the time until a
one-time-approve step is added. The correct pattern already exists in `useFuel.ts:176-197`.

### The swap-fuel pool coupling

`bridgeWithFuel` (`SwapBridgeRouter`) swaps the *bridged token itself* → WETH → FeeJuice through a
pool configured as `BRIDGE_FUEL.pools.azloWeth`, seeded for AZLO(18-dec)/WETH pricing. Rebinding the
bridged token to 6-dec USDC makes this pool the wrong instrument (different tick math/price range).
Either re-seed a USDC/WETH V4 pool or disable swap-fuel on mainnet.

**Critically: the DIRECT fee-juice path is architecturally decoupled** — `useFuel.ts` /
`bridge-core/src/fee-juice.ts` use a separate `l1.feeJuice` manifest block and are unaffected by the
token bridge's decimals or pool. That is the lane that delivers "my team can bridge fee juice."

### Mainnet-only UI gaps

- `FuelView.vue:37` renders `<MintFuelAsset />` **unconditionally**. On mainnet
  `feeAssetHandlerAddress` is absent, so the manifest omits `FUEL_ASSET_HANDLER` and the button
  always errors (fails closed with a message — but the card is misleading). Gate on its absence.
- `useL1Usdc.ts` `mint()` + `MintTestUsdc.vue` assume a permissionless test-mint that real USDC
  has no equivalent for. Must be feature-gated per network, not deleted (testnet still needs it).
- "Sepolia" / "Testnet only" copy is hardcoded across `FuelView.vue:26`, `BridgeForm.vue`,
  `FuelForm.vue`, `MintTestUsdc.vue`, `MintFuelAsset.vue`, `BridgeFooter.vue`, `L1WalletPanel.vue`,
  `BridgeJournalCard.vue`, `Footer.vue`, `BridgeView.vue`, `FaucetView.vue`.
- The app has **no router-free direct-portal path** — both `useDeposit` and `useFuel` always go
  through `SwapBridgeRouter`'s Permit2-gated entrypoints. A direct-portal fallback exists only in
  headless scripts (`fee-juice-canary-testnet.ts` via `feeJuiceDepositArgs`).

---

## Consolidated: reuse-as-is

- `apps/faucet/src/lib/format.ts` + `asset-label.ts` — fully decimals-parameterized, BigInt-safe.
- `contracts/bridge/evm/src/MintableERC20.sol` — `decimals_` already a constructor param.
- `packages/bridge-core/src/candidate-schema.ts` — `network` is a free string; decimals 0–36.
- `packages/bridge-core/src/reuse-token.ts` (+ tests) — decimals-aware, chain-agnostic.
- `packages/bridge-core/src/content-hash.ts`, `fuel.ts`, `fee-juice.ts`, `private-fuel.ts` — bigint-only.
- `apps/faucet/scripts/verify-deployments.ts` — offline, chain-agnostic.
- `packages/bridge-core/scripts/deploy-manifest.ts` — journal + atomic candidate writer.
- The verify-live script's pure `verifyLive()` — already parameterized on url + chainId.
- `apps/faucet/vite.config.ts`'s `buildMetaPlugin()` — target-agnostic except its `chainId` field.
- The wallet's mainnet pair — reuse the verified numbers.
- The `mergeConfig` dual-build structure the wallet uses.
- The `deployEvm("usdc", "MintableERC20", …, [name, symbol, decimals, maxWholePerTx])` call pattern.

## Consolidated: adapt-with-changes

| Target | Change |
|---|---|
| `chain-constants.ts` | Add the mainnet pair; select the active pair **at build time**. Must stay import-free (Node-readable from `vite.config.ts`). |
| `bridge-deployments.ts:9` | Manifest import becomes target-selected (resolve alias per vite config). |
| `bridge-deployments.ts:104-105` | Token identity per network; **derive decimals from the manifest** instead of a literal. |
| 9 app files pinning `sepolia` | Resolve one `Chain` from a single module; journal/backup staleness checks parameterized. |
| `NODE_URL` ×3 | Dedupe to one module + per-network default. |
| `explorer.ts` | Mainnet aztecscan + mainnet etherscan branches (a chainId-keyed map). |
| `useDeposit.ts:823-826, :960-968` | **Add the one-time Permit2 approve** (copy `useFuel.ts:176-197`). |
| `FuelView.vue:37` | Gate `<MintFuelAsset />` on `FUEL_ASSET_HANDLER` presence. |
| `useL1Usdc.ts` / `MintTestUsdc.vue` | Feature-gate the test-mint per network. |
| `deploy-config.ts:17` | Add `"mainnet"` to `Network` + `NETWORK_URLS`. |
| `deploy-bridge-testnet.ts` | Parameterize L1 chain/RPC/node/output-paths/token-identity; **replace SponsoredFPC fee payment**. |
| `verify-l1.ts:37,167-171` | Network-selected chain id + etherscan host. |
| `live-intent.ts:31` | `PLAN_PINNED_L1_SIGNER` → network-keyed. |
| `_build-faucet.yml` | Add a `target` input; build per target. |
| The deploy-hook workflow | Second deploy hook + per-target jobs. |
| `verify-live-run.ts` / `chain-guard.ts` | Check both hosts with matching expected chainIds. |
| `public/_headers` | Per-target if mainnet RPC needs a wider `connect-src`. |

## Conventions / patterns / test shapes to match

- BigInt end-to-end; never `Number()` on base units (`format.ts`'s documented reason).
- Strict zod at every manifest boundary; fail loudly on unknown/stale keys.
- Candidate-first deploys; a separate deliberate `promote` step is the only writer of live manifests.
- Write-ahead journal for irreversible multi-step deploys.
- Signer/identity pinning as code, hard-asserted before any spend.
- Idempotency via deterministic address precomputation + `node.getContract(addr)` existence check.
- Fail-closed readback cross-checks (`verifyPortalAsset`, `assertReusedTokenMetadata`).
- Base config + thin per-target `mergeConfig` wrapper; extract shared bits only after duplication hurts.
- Tests: vitest; `vi.stubEnv` for env branches; real-JSON-import client pins; inline fixtures where
  bb.js/WASM can't run; explicit per-decimals regression files (`BridgeForm.18dec.test.ts`).

## Collision / dedup risks (ranked)

1. **Permit2 approve gap** — real USDC bridging is 100% broken without it (money path).
2. **Env-var network selection** would reproduce the documented Cloudflare incident. Build-time only.
3. **`sepolia` in 9+ files** — patching `chain-constants.ts` alone ships a half-switched app.
4. **Duplicated decimals source of truth** (3 places, unenforced).
5. **SponsoredFPC on mainnet** — blocks the L2 deploy until the deployer is fee-juice-funded.
6. **Copy-forking `deploy-bridge-testnet.ts`** (~500 lines) instead of parameterizing it.
7. **Swap-fuel pool identity** breaks silently on a 6-dec rebind; direct fee-juice lane is safe.
8. **CSP `connect-src`** shared via one `public/` — widening for mainnet leaks to testnet.
9. **`verify-live` / `chain-guard` single-target** — a second deploy goes silently unchecked.
10. **Single deploy-hook secret** — a second project needs its own; reuse would misdeploy.
11. **`PLAN_PINNED_L1_SIGNER` global** — must be network-keyed before any mainnet spend.

## Open asks surfaced by recon

- **Mainnet L1 signer**: reuse `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` (currently pinned,
  Sepolia-funded) or provision a fresh mainnet-only EOA? User selected "separate mainnet key" but
  also asked to fund "the address on Sepolia" on Ethereum — mutually exclusive; must be resolved.
- **Swap-fuel on mainnet**: re-seed a USDC/WETH V4 pool, or ship mainnet with swap-fuel disabled and
  only the direct fee-juice lane?
- **Mainnet RPC host** for the tools app — if it's a dRPC-style host, `_headers` `connect-src` must
  widen (and should then be per-target).

---

## Round-2 recon (post-audit, load-bearing)

### Q1 — the router is NOT actually needed on-chain for a plain deposit

`SwapBridgeRouter.bridge()` (`contracts/bridge/evm/src/SwapBridgeRouter.sol:244-284`) touches only
**Permit2 + the L1 portal**. `swapTarget` is read as an *address binding* into the Permit2 witness
(`:266`) — never called; `poolManager`/`quoter`/`weth`/pools are **never referenced** by the router
contract at all (grep: zero matches). The app's so-called "direct" fee-juice path (`useFuel.ts`) is
NOT direct — it also calls `router.bridge()` with `fuelAmount=0` and `tokenPortal=feeJuicePortal`
(`useFuel.ts:225-244`), so it, too, drags in router + Permit2 + a real `swapTarget` address.

**But the L1 portals natively expose `depositToAztecPublic`/`depositToAztecPrivate` callable by
anyone, router-free** — proven by the headless scripts `fee-juice-canary-testnet.ts:166-171` and
`deposit-testnet.ts:205-221`, which do a plain `approve(portal, amount)` + `portal.depositToAztecPublic(...)`
with no router and no Permit2. The APP just never got such a path.

Schema (`candidate-schema.ts:47-71`): `l1.fuel` is `.optional()` but all 11 fields inside are
required if present; `l1.feeJuice` requires `feeAssetHandler` (absent on mainnet). There is no way
to express "router present, pools absent." `bridge-deployments.ts:32-35` derives
`BRIDGE_ROUTER/PERMIT2/SWAP_TARGET` from inside that same block — the coupling bug.

**Two options** (both need a schema/guard change; do NOT ship fake placeholder pool data):
- **A (router-free direct-portal):** add a plain-`approve`+`depositToAztecPublic` path to
  `useDeposit`/`useFuel`. Minimal manifest: `l1.usdc`+`l1.portal` (USDC), `l1.feeJuice.portal`+`asset`
  (fuel). **No router, no Permit2, no swapTarget, no pools deployed on mainnet.** Drops the Permit2
  max-approve. Cost: a new app deposit path (well-precedented by the scripts).
- **B (keep the router):** split the schema into always-required `router`/`permit2`/`swapTarget` +
  an optional swap sub-block; **deploy the router + swapTarget on Ethereum mainnet**. Keeps app code;
  more real-money contracts + a nonzero-swapTarget constructor requirement.

### Q2 — withdrawal fee: confirmed clean fix

`useWithdraw.ts:219-223` hard-codes `SponsoredFeePaymentMethod`; that `sendOpts` is reused for all
three withdraw sends (`:238,:249,:253-256`). Omitting `fee` is first-class in the SDK
(`interaction_options.ts:99-118`; `toSendOptions` no-ops on absent `fee`) and the app already does it
for the no-fuel claim (`useDeposit.ts:548` `fee = undefined // wallet's fee picker selects`). The
withdraw fee code is **fully separate** from deposit/claim. Deposit has **no L2 fee** (it's an L1 tx);
claim forces a specific method only where the protocol requires consuming a specific bridged message
(`useDeposit.ts:441-447, 512-519`) — leave those. **Only `useWithdraw.ts` changes.**

### Q3 — deployer key is ephemeral; my Phase 4 was impossible

`deploy-bridge-testnet.ts:225-230` generates the L2 deployer from two `Fr.random()` calls every run
(no `DEPLOYER_SECRET_KEY`/`DEPLOYER_SALT` support — that exists only in `apps/faucet/scripts/deploy.ts:386-412`
`resolveDeployerKeys()`). The journal (`deploy-manifest.ts:80-114`) stores only **contract** salts,
never the deployer key → a crash after a partial deploy loses control of any funded fee juice, and
you cannot pre-fund an address you can't compute ahead. **Fix:** port `resolveDeployerKeys()` into the
bridge deploy so the deployer is stable/known-ahead/recoverable. The account-deploy (first) tx pays
via `FeeJuicePaymentMethodWithClaim` — already wrapped as `publicFeeJuicePayment`
(`bridge-core/src/fee-juice.ts:73`), mechanically supported for a not-yet-existing account
(`@aztec/aztec.js deploy_account_method.ts:128-163`). Pinned fee classes:
`PrivateFeePaymentMethod`, `PublicFeePaymentMethod`, `FeeJuicePaymentMethodWithClaim`,
`SponsoredFeePaymentMethod` — **no balance-only class** (balance = omit `paymentMethod`), so I2 is
correct only via the claim method, not a "balance" method.

### Resolved inferences
- **I2** — correct only via `FeeJuicePaymentMethodWithClaim`/`publicFeeJuicePayment`, NOT a
  "balance-based class" (none exists). First tx must claim-in-tx.
- **I4/F1** — false: the fee-juice lane is NOT decoupled from the router (both audits). Option A adds
  the genuinely-decoupled direct-portal path the scripts already prove.
- **I5** — false, confirmed: portal init + L2 proxy bindings are one-shot; re-pointing testnet to a
  new token forces a **fresh portal + L2 trio** and **cannot** use `--reuse-token`.
