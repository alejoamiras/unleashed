## Outcome

Archived. Seeds retired.

# Two-network tools deployment (mainnet + testnet) — v3

**Tier:** `mid` (scope has outgrown it — see note)
**Recon:** [recon.md](recon.md) (incl. Round-2). **Audits:** codex + fable — TWO rounds each.
**eli5_mode:** Artifact.

> **Version history.** v1 → both audits `reject` (fee-juice not decoupled from the router; mainnet
> manifest can't validate; ephemeral deployer). v2 → independent reviewer `conditional approve`,
> codex `reject` (2 new Criticals: mainnet private-fuel is testnet-pinned and strands funds; the
> testnet cutover was never actually performed + a plain-token/`mint()` conflict). v3 folds **every**
> finding from both rounds + the owner's two scope decisions. **v3-final** folds the round-3 fresh
> codex pass — `conditional approve`, both Criticals confirmed closed — resolving its 5 new findings:
> NEW-1 four missed flat-`l1.fuel` consumers (`verify-deployments.ts:68`, `deploy-bridge-testnet.ts:393`,
> `fuel-testnet.ts:57`, `smoke-swap-existing-testnet.ts:49`); NEW-2 A4 is fund-recovery not naming
> (re-pointing strands in-flight AZLO token journals/backups); NEW-3 token needs a `source`
> discriminant; NEW-4 renounce must follow the smoke; NEW-5 residual signed-witness theft → burner
> wallets are an explicit control. Plus a 5th integrity layer (hostname↔target).
>
> **Owner decisions (this round):** (1) **support private fee juice on mainnet** — deploy/pin a
> mainnet PrivateFPC (the wallet defaults Alpha to Private Fee Juice, so this is central, not
> optional); (2) **keep full both-now** (USDC token bridge + public & private fee-juice). Money at
> risk = the ~5 USDC users play with (a *communicated* limit, not on-chain); deploy gas is separate +
> accepted; take security into account proportionate to that.
>
> **Scope reality:** this is no longer "just a JSON." It deploys, on Ethereum + Aztec mainnet, a
> USDC-bound token portal + L2 trio + `SwapBridgeRouter` + a PrivateFPC, behind a two-build/two-CF
> pipeline. 9 phases; real money only in 8–9.

---

## Status (live — updated per phase gate)

| Phase | Status | Evidence |
|---|---|---|
| 1 withdraw no-fee | ✓ | unit pin, 505/505, lint 0 (e2e/manual → network layer) |
| 2 single-source network | ✓ | ban proven firing, F3 domain pin, prod `?chainId=` neutered; 509 |
| 3 schema + build integrity | ✓ | grep-complete migration; both builds distinct; 514 |
| 4 dual build/deploy plumbing | ✓ | per-target CSP (+`lb.drpc.live` fix), digest gate, PR matrix; actionlint 0 |
| 5 app real-USDC + gating | ✓ | approve fallback both legs; per-network grant/tab/mint; 517 |
| — code-review max --fix | ✓ | clean; define mechanism proven per-target (lessons/code-review.md) |
| — codex post-impl audit | ✓ | round 4: 4 HIGH, 0 CRITICAL → HIGH-1/2/3 fixed, HIGH-4 fixed |
| 6 testnet rehearsal + cutover | ✓ | TestUsdc `0x032E…2448` + fresh portal `0xe0fd…d21f` + L2 trio LIVE; 3/3 router-path smokes (public 3.0m / private 3.7m / redirect 3.1m); Etherscan-verified; intent-first + digest-pinned `promote --bridge-only --drop-swap`; swap retired (D22) — testnet now runs the exact mainnet shape |
| 7 deploy tooling | ✓ (to the offline boundary) | verify-l1 network+circle-proxy; **7b.1 (D21): forge mainnet L1 bundle — anvil MAINNET-FORK REHEARSAL PASSED** (real USDC/Permit2/live portal; stub proven inert; all readbacks); **7b.2: per-network FPC descriptor (mainnet FAILS CLOSED pending the owner's 5.1.0 compat ruling) + fail-closed mainnet signer pin**. **7b.3: TestUsdc (DP7 token, forge 4/4 — zero Permit2 allowance vs the legacy auto-grant) + stable network-keyed `resolveDeployerKeys` (F6/A11, 4 pins) + `deploySequenceFeeBudget` (fable NEW-2)**. The conductor's LIVE execution (wiring these into the owner-present Phase 6/8 runs) — runbook in lessons/phase-7.md |
| 8 mainnet deploy | ✓ | executed under owner go: L1 bundle + portal + FJ bridge + L2 trio (claim-in-tx bootstrap) + PrivateFPC + dust canary + public/private smokes + promote — receipts in lessons/mainnet-intent.json |
| 9 ship + harden | ✓ | app.unleashed.systems live under CF Access; owner UI smoke passed; DP8 done — router owner renounced (`0x93cb61bf…`, owner()==0), USDC→Permit2 revoked, AZTEC allowances already consumed; swapTarget owner kept (sweep-only) |

---

## Goal

Build + deploy `apps/faucet` twice from one codebase:

| Deployment | Host | Aztec network | Token bridge asset | Fee juice |
|---|---|---|---|---|
| Testnet | `testnet.app.unleashed.systems` | Aztec testnet (Sepolia) | self-deployed 6-dec test USDC | public + private |
| Mainnet / Alpha | `app.unleashed.systems` | Aztec mainnet (Ethereum) | **official Circle USDC** (6-dec) | public + private |

**Quality bar:** team-facing UI (CF-Access-gated), money paths at production rigor.
**Exposure:** ~5 USDC/user (communicated, not enforced); trusted team; owner manually smokes.

---

## Key design decisions (with the owner)

- **DP1 — Keep Permit2 + the router (Option B).** Owner uses Permit2 everywhere by design;
  max-approve to the canonical singleton is the intended pattern. Deploy `SwapBridgeRouter` on
  mainnet. (Rejected: direct-portal/exact-approve.)
- **DP2 — Swap-fuel disabled on mainnet.** Router deployed for `bridge()` + Permit2 only; no pools.
  **REVERSED by D23 (owner override): swap-fuel ships EVERYWHERE.** Mainnet rides the
  existing canonical Uniswap V4 liquidity (USDC → WETH 500-tier → native-ETH/AZTEC 10000-tier —
  proven live by `discover-mainnet-fuel.ts` + executed on a mainnet fork by `MainnetFuel.fork.t.sol`,
  public + private, through the REAL FeeJuicePortal/Inbox); testnet self-seeds per token generation
  (`SeedTokenPool.s.sol` + `restore-swap.ts`). `DeployBridgeMainnet.s.sol` now deploys
  `UniswapFuelSwap` as the swapTarget with a pre-flight quoter dust-probe of the exact route
  (fail-closed, simulation-time). DP8's inert-stub leg is superseded; its OTHER controls (renounce
  after smoke, revoke approvals, low balances) stand unchanged.
- **DP3 — Withdrawals set no fee** (both networks) — the wallet pays its own default.
- **DP4 — Fresh, network-keyed mainnet L1 signer.**
- **DP5 — No on-chain cap.** <$5 is communicated to users; the control is CF-Access + trust + low
  balances, not a contract limit.
- **DP6 — Support private fee juice on mainnet.** Pin a mainnet PrivateFPC identity + make
  `check-fpc-version` accept mainnet, so the wallet's Alpha Private-Fee-Juice default works and no
  private-fuel deposit strands. (codex round-2 Critical.)
- **DP7 — Testnet rehearsal/cutover token = permissionless-mint ERC20 WITHOUT the Permit2
  auto-allowance override.** Not plain OZ (no `mint()` for the faucet button) and not today's
  `MintableERC20` (auto-grants Permit2, so the approve path is never exercised). A distinct token
  variant. (codex round-2 Critical + F2/F4.)
- **DP8 — Cheap security hardening** (proportionate to <$5): provably-inert mainnet `swapTarget`
  (verified by runtime bytecode-hash + a revert probe, not address alone); **renounce the router
  `Ownable2Step` owner — but only AFTER the Phase-9 smoke** (renouncing first would strand a
  swapTarget fix, and `live-intent.ts:372` hard-fails once `owner()`≠signer); **revoke BOTH the USDC
  and the $AZTEC Permit2 approvals after the smoke**; keep deployer/portal balances low. **Low-balance
  burner wallets are the primary control** for the residual signed-witness path (a compromised UI can
  induce a signed deposit to a caller-supplied malicious portal — `SwapBridgeRouter.sol:244`; DP8
  contracts can't prevent it, so cap what a burner can lose). (codex round-2 Medium + round-3 NEW-4/5.)

---

## Architecture & Implementation

### Network selection: build-time config factory (NOT vite alias)
Two builds → two CF Pages projects, selected by a **git-committed** build config, never a CF
dashboard env var (`chain-constants.ts`'s incident). Each `vite.<target>.config.mts` imports one
typed `NetworkTarget` and passes it to (a) a `define`d/virtual app module and (b)
`buildMetaPlugin(target)`. `build.json` = `{ buildId, walletChainId, manifestDigest }`.

### Fail-closed at five layers (F3 hardened per codex round-2/3)
1. **Manifest self-describes chain** — new `l1ChainId` + `walletChainId` in `candidate-schema`.
2. **Target ↔ manifest ↔ node** — the startup assertion checks all three agree (the build target's
   pinned chainId == the manifest's `walletChainId` == the live node's derived chainId), not just
   manifest-vs-node. Refuses to render on any mismatch.
3. **`?chainId=` override neutered outside e2e** — `chain-info.ts:22-28`'s URL override is gated to
   a build-time e2e flag so a prod visitor can't repoint the handshake.
4. **`viem/chains` import ban** (Biome `noRestrictedImports`) outside `src/lib/network.ts`, + a test
   asserting the Permit2 EIP-712 domain chainId == `NETWORK.l1ChainId`.
5. **Hostname ↔ target** (codex round-3) — the build bakes its expected host; at runtime (outside
   e2e) it asserts `location.hostname` matches. Without this, a coherent *testnet* build accidentally
   deployed to `app.unleashed.systems` passes layers 1–4 (it's internally consistent — just at the wrong
   host). This is the cheap substitute for a CF-Access service-token verify-live (A6/A7). The mainnet
   CSP `connect-src` is `https://lb.drpc.live` (A3 — the Alpha host the wallet
   already pins).

### The manifest schema (atomic breaking change — codex round-2 HIGH + round-3 NEW-1/3)
Split `l1.fuel` → `core{router,permit2,swapTarget}` (required if `fuel` present) + `swap{poolManager,
quoter,weth,feeJuice,pools,slippageBps,minFuelFj}` (optional). `feeAssetHandler` → optional. Add
`l1ChainId`/`walletChainId`. Add a `privateFpc` block (address + version/digest pin). Add a token
**`source` discriminant** (`"permissionless-mint"` | `"circle-proxy"`) and make the test-only
`token.maxWholePerTx` **conditional on the mint variant** — today `candidate-schema.ts:39` requires
it unconditionally, so a mainnet (circle-proxy) manifest would have to lie; verification keys the
right contract-logic path off `source` (NEW-3). The split touches **every** flat-access consumer in
ONE commit — the round-2 list PLUS the four round-3 misses:
`bridge-deployments.ts:32-85`, `deploy-manifest.ts:30-47`, `live-intent.ts:350-375`,
`promotion.ts:32-40`, `verify-l1.ts:138-163`, **`verify-deployments.ts:68`** (inline flat type),
**`deploy-bridge-testnet.ts:393`** (`...priorFuel` carry-forward corrupts the new shape),
**`fuel-testnet.ts:57`**, **`smoke-swap-existing-testnet.ts:49`**, and the live
`public/testnet-bridge.json`. Gate = a **grep-completeness check** enumerating every `.l1.fuel` /
`.l1?.fuel` access + the compat test asserting the migrated live manifest still
`parseCandidateManifest`s — "live manifest parses" alone is insufficient (it passes while
verification reports missing router fields).

### Real-USDC identity (codex round-2 HIGH)
`reuse-token.ts` today checks only metadata + an already-known manifest address — a same-name 6-dec
counterfeit passes on first deploy. Mainnet pins **Circle's canonical Ethereum USDC** (expected
`0xA0b8…48`, verified against Circle's published list at deploy — A8) and reads back proxy/code
identity, not just `name/symbol/decimals`.

### swapTarget correctness (codex+fable round-2 — the sharpest deposit-killer)
`SwapBridgeRouter` constructor requires `swapTarget != 0` and **binds it into every Permit2 witness**
(`:266`; the app signs `BRIDGE_SWAP_TARGET`, `useDeposit.ts:987`). If the manifest's swapTarget ≠
on-chain `router.swapTarget()`, **100% of mainnet deposits revert**. Deploy a **provably-reverting**
swapTarget (DP2/DP8), and **gate** on a readback that manifest swapTarget == `router.swapTarget()`.

### CI verification: offline manifest-integrity only (owner-trimmed the on-chain half)
`_build-faucet.yml` sets `BRIDGE_MANIFEST` per target so `verify-deployments` runs its **offline**
checks: the built artifact bundles the manifest it claims (digest emitted in `build.json`, not a
recomputed one — codex round-3) + the committed addresses match the salt/arg derivation. This is the
part that stops a "labelled mainnet, wrong manifest" ship, and it's hermetic (no RPC). **The live
on-chain readbacks are NOT a CI ship-gate** — they run at **deploy time** (`verify-l1`, swapTarget
equality, USDC identity), which is the actual money moment, and the runtime target↔manifest↔node
assertion fails closed at page load regardless. Owner decision: hard-blocking CI on live RPC is
non-hermetic + redundant for a manually-smoked <$5 tool; no mainnet fund-safety is lost (the deploy
gate + runtime fail-closed both remain). Codex's round-2 HIGH (verify-deployments silently skipped) is
still closed — the offline gate is mandatory + per-target; only its *live-network* portion moved.

### Deployer + fees (F6 + codex round-2 NEW-2)
Port `resolveDeployerKeys()` → stable, network-separated, journaled deployer address (recoverable
across a crash). First tx (account deploy) pays via `FeeJuicePaymentMethodWithClaim`
(`publicFeeJuicePayment`, `fee-juice.ts:73`). **Pre-budget the FULL sequence's worst-case fee juice**
— account-deploy + 3 contract deploys + 2 wiring txs + the PrivateFPC deploy — not one claim.

### Reuse map (from recon.md)
`format.ts`/`asset-label.ts`, `reuse-token.ts`, `deploy-manifest.ts`, `publicFeeJuicePayment`,
`resolveDeployerKeys` pattern, the wallet's verified mainnet pair, a `mergeConfig` dual-build,
`useFuel.ts:176-197`'s Permit2-approve pattern, the headless canaries as the proof-of-mechanism.

---

## Phases

Fast layers (`typecheck && lint && test:faucet` for the touched packages) gate every phase.

1. **Withdrawal sets no fee** (isolated, both networks). Omit `fee` on all 3 `useWithdraw.ts` sends.
   Gate: +e2e + unit asserting no `paymentMethod`; manual testnet withdraw.
2. **Single-source the network** — `network.ts`; collapse 9 `sepolia` pins + `NODE_URL`×3 + explorer;
   derive decimals from the manifest; `viem/chains` ban + EIP-712-domain test; neuter `?chainId=`
   outside e2e. Gate: 6-dec + 18-dec BridgeForm tests green; lint proves no stray `viem/chains`.
3. **Schema + build integrity (atomic migration)** — split `l1.fuel`, add chain-identity + `privateFpc`
   + token-`source` discriminant, migrate ALL flat consumers (the round-2 five + the round-3 four:
   `verify-deployments.ts:68`, `deploy-bridge-testnet.ts:393`, `fuel-testnet.ts:57`,
   `smoke-swap-existing-testnet.ts:49`) + the live testnet manifest in one commit; config-factory +
   `buildMetaPlugin(target)`; target↔manifest↔node startup assertion. Gate: **grep-completeness** over
   every `.l1.fuel`/`.l1?.fuel` access (none left flat) + the migrated live `testnet-bridge.json`
   parses AND round-trips through verify-deployments + verify-l1 without a missing-field error;
   assertion throws on mismatch; schema tests cover the split + both token `source` variants.
4. **Dual build + dual deploy plumbing** — `vite.{testnet,mainnet}.config.mts`; per-target `publicDir`
   (CSP/manifest isolation; mainnet `connect-src https://lb.drpc.live`); **hostname↔target assertion**
   (5th integrity layer); `_build-faucet.yml` `target` input **with `BRIDGE_MANIFEST` set** →
   verify-deployments runs its **offline** gate per target (artifact-emitted `build.json` digest +
   committed-vs-derived address match; the live on-chain readbacks stay at deploy-time, NOT CI —
   owner-trimmed); second CF project + hook;
   verify-live is manual for the Access-gated mainnet host (A6/A7 deferred — the
   hostname layer backstops a mis-hosted build). Mainnet build points at a placeholder
   that fails the startup assertion. Gate: both builds; each `build.json` correct; actionlint;
   placeholder fails closed; a testnet manifest at the mainnet host is caught by the hostname layer.
5. **App: real-USDC + private-fuel + per-network gating** — Permit2 approve fallback in `useDeposit`
   (both `:823`/`:960`); per-network faucet tab / capabilities / registration; mainnet `privateFuel`
   feature wired to the pinned mainnet PrivateFPC (DP6) so `FuelForm`'s private default works — and
   **manifest `privateFpc.address` MUST equal the deterministic artifact/salt derivation** both
   `planPrivateFuelDeposit` and the wallet compute (schema-valid alone is insufficient); gate
   `MintFuelAsset`/`MintTestUsdc`. Gate: unit (approve fallback both-branches; capabilities excludes
   faucet tokens on mainnet; private-fuel resolves the mainnet PrivateFPC AND rejects an address ≠ the
   derivation) + e2e.
6. **Testnet rehearsal + real cutover** — deploy the DP7 token (permissionless-mint, no auto-Permit2)
   on Sepolia; fresh portal + L2 trio; **retire AZLO** (owner: testnet is play money — no
   keep-alongside). NEW-2's stranded-recovery risk relaxes accordingly: re-pointing does break token
   journal/backup recovery (`deploymentMatches` `useBridgeJournal.ts:300` + `restoreFile`
   `useBridgeBackup.ts:113` bind to the live portal+bridge; fee-juice records bind the canonical
   FeeJuicePortal → survive), but AZLO is play money, so this is a **best-effort heads-up, NOT a hard
   drain-gate** — post a "export/claim before the re-point" notice, then promote. rehearse the full
   mainnet path incl. **private** fuel + the Permit2 approve. Gate: verify-deployments (offline) +
   verify-l1 + canary deposit→claim (public + private) + manual.
7. **Deploy tooling for mainnet** — `deploy-bridge.ts --network`; stable/journaled/network-separated
   deployer; network-keyed signer (fresh EOA) + caps; verify-l1 network + reused-USDC skip + **router
   readbacks (permit2/portal/swapTarget/owner)** + **Circle USDC identity pin (address + proxy/code)**;
   inert swapTarget **verified by runtime bytecode-hash + revert probe**; PrivateFPC mainnet deploy/pin
   (address == derivation) + `check-fpc-version` mainnet acceptance; replace SponsoredFPC with
   claim-in-tx; **full-sequence fee budget** (account-deploy + 3 deploys + 2 wiring + PrivateFPC = 7
   L2 txs). Gate: `--network testnet --dry-run` parity; pre-computed mainnet deployer shows fee juice
   sized for the whole sequence + a claim is provably consumable.
8. **Mainnet deploy (real money)** — fund the fresh EOA (ETH + $AZTEC); deploy portal + L2 trio +
   router + PrivateFPC bound to real USDC; write + promote `mainnet-bridge.json`. **Owner key retained
   through the Phase-9 smoke** (renunciation deferred — NEW-4). Gate: verify-deployments + verify-l1
   (owner check runs pre-renounce) + swapTarget-equality readback + startup assertion vs real node +
   both hosts serve their own chainId. **Owner go required before any tx.**
9. **Ship + harden** — point the mainnet build live; owner manual smoke UNDER restricted Access: real
   <$5 USDC bridge + public **and** private fee-juice bridge+claim on Alpha; **then, last: renounce the
   router owner + verify `owner()==0`, and revoke BOTH the USDC and $AZTEC Permit2 approvals.** Gate:
   both live hosts verified (hostname layer green); manual smoke passes; `owner()==0`; both approvals
   revoked.

---

## Security & Adversarial Considerations

- **Threat model.** ~5 USDC/user, CF-Access-gated, trusted team → dominant risk is our own
  misconfiguration (wrong address/chain/decimals) + fund-stranding, not large-value theft. Codex's
  theft-credibility point is accepted at this scale with the DP8 hardening (inert swapTarget,
  renounced router owner, post-smoke revoke, low balances) rather than on-chain caps (DP5).
- **Config integrity** — build-time selection; **five-layer** fail-closed (target↔manifest↔node,
  neutered URL override, `viem/chains` ban, `build.json` digest, **hostname↔target**); mandatory
  per-target CI verify against the artifact-emitted digest.
- **Fund-stranding (the real money-loss risk here)** — the private-fuel path targets a *usable*
  mainnet PrivateFPC whose address == the derivation the app uses (DP6/NEW-4); the swapTarget-equality
  gate prevents 100%-revert deposits; the full-sequence fee budget prevents a mid-deploy stall. (AZLO
  token-recovery at the testnet re-point is knowingly NOT protected — play money; see D18.)
- **Residual signed-witness path (NEW-5, explicit).** `SwapBridgeRouter.sol:244` accepts a
  caller-supplied token portal; a compromised UI could induce a user to sign a Permit2 witness paying
  a malicious portal. No contract change closes this. **The control is low-balance burner wallets** —
  a user can only lose what the burner holds — plus the trusted-team + CF-Access perimeter. Accepted
  at the <$5 scale; documented so it isn't mistaken for "solved."
- **Key handling** — network-keyed fresh mainnet signer; stable/journaled deployer (no orphaned fee
  juice on crash); keys stay in the operator's local env, never read/printed/persisted.
- **Real-USDC identity** — Circle canonical address + proxy/code readback (not metadata alone).
  Accepted residual: USDC is upgradeable/pausable/blacklistable — could freeze bridging, not steal.
- **Contracts** — candidate-first + journal; `assertPortalUninitialized`; router owner renounced
  **only after the smoke** (`owner()==0` verified); provably-inert swapTarget (bytecode-hash + revert
  probe) so the dormant `bridgeWithFuel` can't route funds anywhere.
- **Supply chain** — no new runtime deps; 7-day min-age + frozen lockfile.

---

## Assumptions

**Facts (verified — see recon.md + audits):** the router `bridge()` touches only Permit2 + portal
(swapTarget is witness-bound, `SwapBridgeRouter.sol:244-284`, constructor rejects zero `:133`); the
fee-juice path routes through the router (`useFuel.ts:225-244`); `useDeposit.ts:960-968` throws
instead of approving; `useWithdraw.ts:219-223` hard-codes SponsoredFPC; deployer is ephemeral;
`FeeJuicePaymentMethodWithClaim` supports a not-yet-existing account; `l1.fuel` is all-or-nothing +
lacks chain identity; `verify-l1` assumes MintableERC20; `check-fpc-version.ts:212-217` rejects
mainnet; `MintableERC20` auto-grants Permit2 (so the rehearsal token must not).

**Inferences (attack these):** the atomic migration touches all listed consumers — now the round-2
five PLUS the round-3 four — with a grep-completeness gate, not just a parse test (I-a — was false
under the old gate; NEW-1); the rehearsal build uses mainnet feature flags + router-only shape (I-b);
a provably-reverting swapTarget satisfies the constructor + is inert, proven by bytecode-hash + revert
probe not just constructor acceptance (I-c); the mainnet FeeJuicePortal + PrivateFPC expose the
expected shapes AND `privateFpc.address` == the app's derivation (I-d — deploy-time node/readback +
derivation-equality checks).

**Asks (resolved / open):**
- A8 → **Circle canonical mainnet USDC**, verified at deploy. A9 → **support private fuel** (DP6).
  A10 → **inert swapTarget + renounce router owner post-smoke** (DP8/NEW-4). A11 → network-separated
  journaled deployer + full 7-tx budget (Phases 7–8). **A3 → resolved: `https://lb.drpc.live`** (the
  Alpha host the wallet pins; sets the mainnet CSP `connect-src`).
- **A4 → resolved: RETIRE AZLO** (owner: testnet is play money). NEW-2's stranded-recovery relaxes
  from a hard drain-gate to a best-effort "export before re-point" notice — re-pointing does break
  AZLO token recovery, but nobody's protecting testnet play money. (Fee-juice recovery survives a
  re-point either way.)
- **A6/A7 → resolved: NO CF service token; manual smoke + the hostname layer.** The owner trimmed the
  live-network CI gate as non-hermetic + redundant. The **hostname↔target assertion** (5th layer)
  independently catches a mis-hosted build, so automated verify-live isn't load-bearing. Second-CF-
  project build-config drift (A7): documented as a manual check, not a CI gate.

---

## Decision ledger (additions in v3)

| # | Decision | Chosen | Why |
|---|---|---|---|
| D1–D10 | (unchanged from v2) | — | Permit2/router, config-factory, swap-fuel off, no-fee withdraw, fresh signer, stable deployer, claim-in-tx, no on-chain cap, DP7 token, rehearsal-before-money |
| D11 | Private fuel on mainnet | Deploy/pin a mainnet PrivateFPC + accept mainnet in check-fpc-version | The wallet's Alpha default is Private Fee Juice; else deposits strand (codex Critical) |
| D12 | Real-USDC identity | Pin Circle canonical address + proxy/code readback | Metadata-only check passes a counterfeit (codex HIGH) |
| D13 | Router safety | Provably-inert swapTarget + renounce owner + swapTarget-equality gate | Zero-target reverts constructor; wrong-target reverts 100% of deposits; owner can change target |
| D14 | Schema migration | One atomic commit across all NINE flat consumers + grep-completeness gate | Strict parse breaks every consumer at once; a parse-only gate misses non-parsing readers (round-3 NEW-1) |
| D15 | <$5 | Communicated user limit, not on-chain | Owner clarified; deploy gas separate + accepted |
| D16 | Mis-hosted build | 5th integrity layer: hostname↔target assertion | A coherent testnet build at the mainnet host passes layers 1–4; lets A6/A7 defer (round-3) |
| D17 | Token identity | `source` discriminant (`permissionless-mint`\|`circle-proxy`); `maxWholePerTx` conditional | Mainnet manifest would otherwise have to lie; verification keys logic off it (round-3 NEW-3) |
| D18 | AZLO at cutover | RETIRE; best-effort "export before re-point" notice, NOT a drain-gate | Owner: testnet is play money — NEW-2's stranded-recovery risk isn't worth a hard gate |
| D19 | Router owner | Renounce LAST — after the Phase-9 smoke — then verify `owner()==0` | `live-intent.ts:372` hard-fails post-renounce; a pre-smoke renounce strands a swapTarget fix (round-3 NEW-4) |
| D20 | CI verify-deployments | Offline manifest-integrity only; on-chain readbacks stay at deploy-time | Owner-trim: hard-blocking CI on live RPC is non-hermetic + redundant with verify-l1 + runtime fail-closed; no mainnet fund-safety lost |
| D21 | Mainnet L1 legs | Forge script (`DeployBridgeMainnet.s.sol`: InertSwapTarget + router) + anvil mainnet-fork rehearsal gate | Owner steer: simulate-before-broadcast, `--resume`, `--verify`, and a zero-cost rehearsal against REAL Circle USDC/Permit2/FeeJuicePortal — safer than viem sends for the real-money moment. TS conductor keeps the L2 half + manifest (cross-domain interleave) |

*Resolved:* A3 (`lb.drpc.live`), A4 (retire), A6/A7 (manual + hostname layer, no service token). *No open asks.*

**Audit trail:** v1 both `reject` → v2 fable `conditional approve` / codex `reject` → **v3-final fable `conditional approve` (round-2) + codex `conditional approve` (round-3, both Criticals closed)**. Conditions all folded above.

---

## Seeds

*(Finalized. Phases 1–7 autonomous; 8–9 spend REAL mainnet funds → hard stop for explicit go.)*

```
/goal All phases ✓ in implementations-plan/archive/tools-two-network/plan.md, each backed by its validation gate reported passing in the transcript; per-phase `LESSONS_FILE=...` printed; `/code-review max --fix` applied + committed; codex post-impl audit high/critical addressed; `bun run test:faucet` + `bun run lint` exit 0. Phases 8–9 spend REAL mainnet funds — never execute a deploy/funding/mainnet tx without my explicit go each time.
```

```
/loop 15m Drive implementations-plan/archive/tools-two-network. Never idle. Each firing: read plan.md + lessons/ + git status; if a PR exists check `gh pr view --json statusCheckRollup`. Phases 1–7 are refactor/testnet/fake-money — proceed autonomously; after each edit run `bun run lint` + `bun run test:faucet`, commit + push. Phases 8–9 spend REAL mainnet funds — STOP and get my explicit go before any deploy/funding/mainnet tx. Stuck or a decision? `/codex xhigh`, decide, log in lessons. Same step 5× failed → stop, reassess with codex. Phase green = its plan.md gate passes (paste result, mark ✓, file lessons, print LESSONS_FILE=..., advance). All non-money phases ✓ → `/code-review max --fix` → commit separately → codex post-impl audit → address high/critical → wrap-up + stop for my mainnet go.
```
