## Outcome

Archived. Seeds retired.

# Faucet → Bridge: L1↔L2 Portal + Fee Juice Bridge

**Status:** ✅ **APPROVED** (user) · mega-deep complete (research + R1 + R2 folded) · **in implementation via `/loop`**. Phase-1 version gate pre-confirmed by user: **Aztec testnet supports 4.2.0** (still verify FeeAssetHandler wiring + `mintAmount` on-chain).
**Tier:** `mega-deep` — Novelty HIGH (first L1↔L2 surface in repo), External coupling HIGH (Ethereum + Uniswap V4 + Permit2 + Aztec portals), Security HIGH (atomic multi-step value flow + Permit2 witness). 3 HIGH incl. novelty.

## Product summary

Evolve the testnet faucet into a unified **Faucet + Bridge** app: a canonical Aztec
Portal (L1↔L2 via Inbox/Outbox) plus a Fee Juice bridge, with the headline "acquire
$AZTEC with your $USDC and land Fee Juice in one transaction" UX. Static frontend, no
server. Reference: the author's Holonym/Human-Tech bridge (`aztec-bridge`, an outside
repo) — copy the reusable core, drop the identity/server layer. Private fuel uses
Wonderland's `@wonderland/aztec-fee-payment` (already a dependency of the wallet).

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Frontend framework | **Vue 3** — reuse the brutalist design system; L1 via viem + `@wagmi/core` vanilla through the `@aztec/viem` alias (no React). Exact stack settled by the Phase-0.5 browser spike. |
| 2 | Product shape | **Unified app, tabbed** (Faucet / Bridge) |
| 3 | Design system | **Extract `@unleashed/design`** (tokens + Vue components) seeded from the faucet's already-decoupled set. |
| 4 | Direction | **Bidirectional** — L1→L2 deposit AND L2→L1 withdraw |
| 5 | Fuel swap | **Seed our own Uniswap V4 pools** on Sepolia. FJ side = the REAL FeeJuicePortal `UNDERLYING()`, minted via the **permissionless** `FeeAssetHandler.mint` (owner-set mutable `mintAmount` per call; succeeds only if the handler is wired as a minter on the live net). Swap is **optional/demo until Phase 1 confirms handler wiring + `mintAmount`**; the direct fee path is the stable core. |
| 6 | Fee Juice modes | **Both public + private**, toggled. Public → `FeeJuicePaymentMethodWithClaim` to user. Private → `fuelRecipient = PrivateFPC` via `@wonderland/aztec-fee-payment` (`PrivateMintAndPayFeePaymentMethod`). |
| 7 | Assets | **USDC + ETH** (match faucet); same L2 asset for faucet+bridge via `token_minter_proxy`. |
| 8 | Post-impl hardening | No dedicated `/security-audit` — rely on the blueprint's codex + opus audits. |
| 9 | Aztec version | **Pinned 4.2.0** (`-aztecnr-rc.2` for noir) — no bumps. |
| 10 | Network | **Sepolia ↔ Aztec testnet**. |
| 11 | Hosting | **Cloudflare Pages** (static). |
| 12 | Atomic-swap privacy | **FULL PARITY — keep `isPrivate`** in the `bridgeWithFuel` witness, wired to the clean (no-attestation) `depositToAztecPrivate`. Holonym disabled private-token-in-swap only for its compliance checks; dropping those unblocks it cleanly. |

## Take / Drop from the Holonym reference

**TAKE:** `SwapBridgeRouter.sol` (Permit2 witness-bound atomic `bridgeWithFuel`, **incl. `isPrivate`**) · `UniswapFuelSwap.sol` (V4 swap) · `bridge-sdk` `l1.ts`/`l2.ts` → `@unleashed/bridge-core` · L2 `token_bridge` + `token_minter_proxy` · the step/status UX shape (but IMPROVE the blocks-remaining bar) · `FeeJuicePaymentMethodWithClaim` + the `fuelType` toggle.

**DROP:** the identity layer (`CleanHandsData`/`PassportData`, `humanIdAttester`, `passportSigner`, nonce maps, `_validatePrivateAttestations`, trusted-forwarder relay) AND `feeBasisPoints` · Next.js + Prisma + JWT + `/api/*` + attestation API + server recovery + key backup · React stack · failed-tx recovery (happy-path localStorage + manual export only).

## Proposed workspace structure

```
packages/
  design/          @unleashed/design          — tokens + Vue component lib (seeded from faucet)
  bridge-core/     @unleashed/bridge-core      — framework-agnostic L1↔L2 logic (viem); NO attestation; reuses @alejoamiras/nulo-wallet-crypto
  bridge-evm/      (Foundry)              — MintableERC20, <forked-portal>, SwapBridgeRouter, UniswapFuelSwap + seed/deploy scripts
  bridge-aztec/    (Noir)                 — token_bridge + token_minter_proxy (no attestation)
  bridge-frontend/ — unified Vue app (Faucet + Bridge tabs); consumes @unleashed/design + @unleashed/bridge-core (absorbs packages/faucet)
```

## Defaults (locked unless noted)

1. Package layout/names as above.
2. Evolve `packages/faucet` → `packages/bridge-frontend`; port drip into the Faucet tab; retire old pkg (renames `_build-faucet.yml`, paths-filters, deploy scripts).
3. One app, two domains (hostname → default tab).
4. L1 faucet: permissionless `MintableERC20`, `mint(to,amount)` capped 1,000 units/tx, no allowlist, no server.
5. Permit2 pre-approve via an `allowance()` override (NEW code — see Phase 3 / Assumptions).
6. In-flight state: localStorage + manual export; no failed-tx recovery.

## Research outcomes (detail in `research/`)

- **Private Fee Juice nuance + the exact bug** (`holonym-l2-and-fee-juice.md`): FJ always bridges via `FeeJuicePortal.depositToAztecPublic`; only `fuelRecipient` differs (user = public, FPC = private). Bug fixed in Holonym `b21421a`: private claim secret = `poseidon2([salt, USER_ADDRESS], 3952304070)`, NOT `[salt, fpcAddress]` — the FPC re-derives from `msg_sender()`. Copy faithfully.
- **Content-hash spec**: public = `sha256ToField(selector("mint_to_public(bytes32,uint256)")||to||amount)`; private = `sha256ToField(selector("mint_to_private(uint256)")||amount)`. Canonical `token_portal_content_hash_lib`. Pin with a fixed-vector test + round-trip e2e.
- **Portal/bridge is FRESH code** (R1-corrected): with attestations gone, `depositToAztecPrivate` is user-callable (no `*For`/forwarder). BUT canonical 4.2.0 hashes the **GROSS** amount and `Outbox.consume` takes **`_epoch`** (verified `IOutbox.json`, `TokenPortalAbi.js`) — Holonym's `amountAfterFee` + `_l2BlockNumber` are 4.1.x-shaped. Reconcile the ABI explicitly; the router KEEPS `isPrivate` (Decision #12).
- **Fee-juice underlying** (`uniswap-v4-sepolia.md`, HIGH): swap output MUST be the real `feeJuicePortal.UNDERLYING()` (mismatch hard-reverts). Real FJ minted via `FeeAssetHandler.mint()` — **fixed-size packet (~1000/call), `onlyMinter`-gated, only works if the protocol wired it on the live net** (Phase-1 go/no-go). FJ address from `getNodeInfo()` at runtime.
- **V4 Sepolia**: PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`, Permit2 `0x0000…78BA3`. Two-hop USDC→WETH→FeeJuice.
- **Timing/bar**: L1→L2 = `getL1ToL2MessageCheckpoint` (poll ~2 min, ~2–20 min, time-based bar). L2→L1 = `getProvenCheckpointNumber ≥ l2Block` (poll ~2 min, ~20–60 min, exposes `(provenBlock,neededBlock)` → real "N blocks remaining" bar). Withdraw epoch via `getEpochForCheckpoint`; witness via `computeL2ToL1MembershipWitness`. Brute-force leaf-index 0–63 fallback.
- **Vue + L1** (R1-corrected): viem is aliased repo-wide to the `@aztec/viem` FORK (`bun.lock:2446`) — `viem` and `@aztec/viem` are ONE identity, so `bun why viem` is a tautology. Real gate = a **browser smoke-test of the chosen wagmi stack against the fork** (Phase 0.5) + enforce one specifier via lint. `useWalletConnection` is a module singleton (Bridge tab inherits Aztec connection). Tabs = `ref<'faucet'|'bridge'>`, no router.
- **`@unleashed/design`**: 5 ui + 5 composite + tokens + base.css; fonts consumer-owned.
- **localStorage recovery**: two arrays; **reuse `@alejoamiras/nulo-wallet-crypto`'s PBKDF2(600k)+AES-GCM** (R1 — don't roll own). Drop all server/Prisma.
- **Wonderland is ALREADY integrated in the wallet** (R1-corrected): ships as a GitHub prerelease tarball `4.2.0-prerelease.215fd08` (NOT npm `rc.2`), with a vite raw-artifact alias, FPC derived at `salt = Fr.zero()`, and `additionalScopes:[fpc.address]` threaded through simulate/prove/send. **Mirror this integration; don't build fresh.**

## Audit verdicts (R1 + R2)

- **R1 Codex** (`019e9d73`): conditional approve — 5 conditions (FPC salt/assert; secret-export before P6; P0.5 spike; P1 FeeAssetHandler go/no-go; atomic-router privacy). **All 5 resolved** in the revision.
- **R1 Opus** (fresh): conditional approve — 6 conditions (withdraw epoch; viem-fork; FeeJuice dependency; invented MintableERC20; hooks check + Permit2 tests; FPC funding). Folded.
- **R2 Codex** (resumed self-critique): conditional approve — retracted its own dual-viem + COOP/COEP over-assertions; 4 new conditions (private secrets are theft-capable bearer credentials → UX/copy; P0.5 must exercise the EXACT execution path incl. `additionalScopes`; gas-sufficiency guard for the fixed FJ packet; freeze the recovery blob format).
- **R2 Opus** (fresh hostile): conditional approve — 5 conditions. **Two ground-truthed corrections (verified in installed source):** (1) `FeeAssetHandler.mint` is PERMISSIONLESS, `mintAmount` mutable — not `onlyMinter` (both R1 audits were partly wrong); (2) the canonical `TokenPortal` in `@aztec/l1-artifacts` IS the clean spec → **deploy an instance, don't hand-roll** (removes the biggest net-new attack surface). Also confirmed RIGHT: `isPrivate` kept is correct (intended unlinkability, no hole); `PrivateMintAndPayFeePaymentMethod` exists in the installed tarball; viem single-identity; Epoch; `minter==DRIPPER` test. New: recovery crypto is password-based (need an L1-signature-derived key); no phase builds the parallel-safe L1/anvil e2e harness (CLAUDE.md mandates it); verify whether the FPC actually needs bootstrap-seeding (the wallet never seeds).
- **Convergence (high confidence):** canonical portal (not hand-rolled); `hooks==address(0)` + hop-continuity mandatory in `_validateRoute`; private fuel before swap; swap optional until live economics proven; owner powers broad (testnet-OK); private export = theft-capable.
- **Final fresh-codex pass: COMPRESSED** — codex ran R1 + R2 self-critique, both R2 audits land at conditional-approve with only polish/de-risk conditions (no rejects), and the architectural changes (canonical portal, permissionless handler) made the plan SIMPLER. Marginal value low; available on request.

## Assumptions

**Facts (verified):**
- aztec-standards Token has a SINGLE immutable `minter` (no `set_minter`); current L2 USDC/ETH use the Dripper. `deployments.test.ts:19` asserts `minter == DRIPPER` → **breaks under the Phase-3 proxy redeploy** (update to `minter == proxy`).
- 4.2.0 `IOutbox.consume(L2ToL1Msg, _epoch, _leafIndex, _path)` takes `Epoch`; canonical TokenPortal hashes the GROSS amount. Holonym's verbatim withdraw/`amountAfterFee` won't work at 4.2.0.
- viem is aliased to the `@aztec/viem` fork repo-wide (`bun.lock:2446`); single identity. `@alejoamiras/nulo-wallet-crypto` already ships PBKDF2(600k, OWASP)+AES-GCM. COOP/COEP + in-browser poseidon2 already run in the faucet + the wallet at 4.2.0 (so NOT an open risk — R1 downgrade).
- `@wonderland/aztec-fee-payment` is already a dependency of the wallet (GitHub prerelease tarball + vite alias + `salt=Fr.zero()` + `additionalScopes` plumbing). **`FeeAssetHandler.mint(address)` is PERMISSIONLESS** (verified source: no modifier); it mints an owner-set mutable `mintAmount` of the real fee asset and succeeds only if the handler is wired as a minter on the live net (R2 correction — NOT `onlyMinter` as R1 assumed). **The canonical `TokenPortal` (`@aztec/l1-artifacts`) already ships the clean public/private/withdraw(Epoch) interface with no fee/attestation params** → deploy an instance, don't hand-roll (R2). `@alejoamiras/nulo-wallet-crypto`'s `EncryptionKey` is **password-based** (`fromPassword`/`fromPasshash`) — the bridge needs an L1-signature-derived key instead (R2).

**Inferences (Phase 1 / 0.5 resolve):**
- Live net is 4.2.0-compatible AND `FeeAssetHandler.mint` is usable by our deployer with seed-able economics — **Phase-1 hard go/no-go** (faucet local config is suggestive, NOT proof).
- The chosen wagmi stack functions against the `@aztec/viem` fork (else fall back to hand-rolled viem-aliased composables) — **Phase-0.5 browser spike**.
- Clean portal + canonical content-hash lib interop with a fresh `token_bridge` — only provable by the Phase-6 round-trip.

**Asks (RESOLVED):**
- **A. Private fuel IN v1** — mirror the wallet's Wonderland integration; pin FPC `salt = Fr.zero()` (matches the wallet's discovery), assert the derived address before any deposit, block on mismatch.
- **B. Same-asset minter → `token_minter_proxy` redeploy** (update `deployments.test.ts`).
- **C. Atomic-router privacy → FULL PARITY (keep `isPrivate`)**, wired to the clean `depositToAztecPrivate`.
- **D. Swap = optional/demo** until Phase-1 proves live FeeAssetHandler economics; direct fee path is the stable core.

## Implementation phases

`[∥]` = parallelizable. Critical path: **P0.5/P1 (front-load) → P2 → P6 → P7 → P8 → P9.**

**P0 — Workspace skeleton + `@unleashed/design` extraction. ✅ DONE** (with the followup; **10/10 components** — `EmojiGrid`+`BalanceRow` decoupled to presentational props, testid values preserved; consumers run `toGrid`/`formatBigInt`). `[∥ P1]` LOW. Five packages; move tokens + ui + composite → `@unleashed/design`; biome override; faucet rewired; fonts consumer-owned. **Validated:** lint 0 errors · 51 design tests · 143 faucet tests · faucet build · design+faucet typecheck all green.

**P0.5 — Runtime/integration spike (in the real bridge-frontend).** `[∥ P1]` HIGH (de-risks the stack). Prove, end-to-end in a throwaway page: (a) the chosen L1 wallet stack (`@wagmi/core`/`@wagmi/vue`) actually works against the `@aztec/viem` fork — Permit2 EIP-712 sign + a Sepolia tx; else fall back to hand-rolled aliased composables; (b) Wonderland import mode mirroring the wallet (tarball + vite alias) loads in the static app; (c) browser poseidon2 + the `additionalScopes:[fpc]` path runs a private FPC call; (d) derive the PrivateFPC address at `salt=Fr.zero()` and match the wallet's. **Validate:** a committed spike note + a one-specifier lint rule; STOP if the wallet stack can't drive the fork.

**P1 — Network recon + L1↔L2 interop spike. ✅ DONE — recon GO** (`research/recon-testnet.md`: net 4.2.0-compatible @ rollupVersion 4127419662, FeeAssetHandler wired [FEE_ASSET==feeJuice 0x762c…, mintAmount 1000 FJ, permissionless], bridge-evm + bridge-aztec compile, keystone cross-chain hash proven). Recon gate CLEARED → P2+ unblocked. `[∥ P0]` HIGHEST. (a) `getNodeInfo()` → record FJ portal/asset, `feeAssetHandlerAddress`, `rollupVersion`, registry; **hard go/no-go: net is 4.2.0-compatible (✅ user-confirmed: testnet supports 4.2.0) AND the `FeeAssetHandler` is wired as a minter on the live net (so its permissionless `mint` succeeds) AND record `mintAmount`** (drives pool-seed call count + the Phase-6/7 gas-sufficiency guard). No implication from the faucet's local config — verify on-chain. (b) Foundry skeleton + `UniswapFuelSwap.sol` + interfaces verbatim. (c) Strip attestation from `token_bridge`; compile both Noir contracts. (d) **Keystone hash-equality test** (Solidity vs Noir) for `mint_to_public`, `mint_to_private`, **and `withdraw`** (fixed vectors). Pin-drift gate: `aztec-standards@prerelease-1ad0e28` (proxy) mint sigs == faucet token's. **Validate:** `forge build` + `nargo compile` + hash test green; a real `FeeAssetHandler.mint` mints `mintAmount` FJ to us.

**P2 — Deploy the CANONICAL TokenPortal + L2 bridge wiring. ✅ DONE** (sandbox: canonical `TokenPortal` deployed via viem from `@aztec/l1-artifacts` + `initialize(registry, MintableERC20, token_bridge)`; `token_bridge` + `token_minter_proxy` deployed + wired; rc.2 transpile via `bridge-aztec/scripts/compile.sh`; proven by the deposit-public + deposit-private smokes). P1 · MED (was HIGH — de-risked by R2). **Do NOT hand-roll a portal.** `@aztec/l1-artifacts` already ships the exact clean `TokenPortal`: `depositToAztecPublic(bytes32,uint256,bytes32)` (gross, no fee), `depositToAztecPrivate(uint256,bytes32)` (no attestation, user-callable), `withdraw(...,Epoch,...)`, `initialize(registry,underlying,l2Bridge)` — zero fee/attestation params (verified in the installed ABI). Deploy an INSTANCE per asset, initialized with our L1 `MintableERC20` underlying + our L2 `token_bridge`; it's the same contract the deployed rollup runs → no ABI reconciliation, content-hash compatible by construction. Finalize stripped `token_bridge` + `token_minter_proxy`. **Validate:** `forge script` deploy + init; keystone hash test (incl. withdraw) against the canonical portal's signatures + our bridge.

**P3 — L1 `MintableERC20` + Permit2 pre-approve + minter-proxy redeploy.** P2 · MED. `mint(to,amount)` capped 1,000/tx, no allowlist; Permit2 pre-approve via an **`allowance()` override returning max for Permit2** (NEW code — not in Holonym; unit-test it). Redeploy L2 USDC/ETH with `minter=proxy`; wire `set_token → set_minter(dripper) → set_minter(bridge)`. **Update `deployments.test.ts` (`minter==proxy`)**; regenerate `deployments.json`. **Validate:** `forge test` (cap + allowance==max); faucet drips via proxy; CI `verify:deployments` green.

**P4 — `@unleashed/bridge-core` SDK. ✅ DONE** (l1 [witness keystone] + l2 [claim/exit] + status [block/time progress] + recovery + recovery-crypto + content-hash [3-toolchain keystone] + progress + fee-juice [`publicFeeJuicePayment` via `FeeJuicePaymentMethodWithClaim` (claim-and-pay in one tx) + `sponsoredFeePayment` bootstrap + `feeJuiceClaimArgs`] — done, 37 unit tests; deposit public/private proven end-to-end. Private-fuel *payment* deferred: aztec.js 4.2.0 `PrivateFeePaymentMethod` is `@deprecated` + the Wonderland private-FPC path needs an FPC deployed + sandbox validation — the bridge still bridges FJ privately [private claim]; only paying gas from a private FJ note is deferred). `[∥ P5]` P2-ABIs · MED. Framework-agnostic viem: `l1.ts`, `l2.ts` (claim public/private + brute-force leaf-index), `status.ts` (checkpoint + proven polling), `fee-juice.ts` (addr from `getNodeInfo()`; public `FeeJuicePaymentMethodWithClaim`; private via Wonderland, mirroring the wallet's usage + `additionalScopes`), `recovery.ts` (**reuse `@alejoamiras/nulo-wallet-crypto`** for AES-GCM/PBKDF2), `progress.ts`. Re-export the aliased `@aztec/viem`; one specifier enforced. **Validate:** `bun test` pure fns + mock-node poll states.

**P5 — Frontend shell: tabbed app + dual-wallet. 🟡 app + sandbox dual-wallet DONE** (bridge-app: tabbed Faucet|Bridge shell + deposit/withdraw form + the loading bar; sandbox dual-wallet [L1 viem account0 + in-browser L2 PXE, lazy-imported so it stays out of the prod bundle] reads `sandbox.json` + the bridge artifact; builds with the full aztec stack; **`bun run audit:vue` exits 0**. Remaining: real-use dual-wallet [MetaMask + Nulo wallet], faucet-tab port). `[∥ P4]` P0,P0.5 · MED. Rename faucet → `bridge-frontend`; `ref<'faucet'|'bridge'>` + hostname default; L1 wallet via the P0.5-proven stack; Aztec via the `useWalletConnection` singleton; hoist `useToast`. CI rename + `packages/design/**` filter; CSP `connect-src` += L1 RPC (don't loosen `script-src`). **Validate:** faucet e2e green under new name; MetaMask injects under COOP/COEP.

**P6 — L1→L2 deposit + DIRECT public fuel (first real round-trip). 🟡 deposit-public PROVEN THROUGH THE APP + LIVE-TESTNET ROUND-TRIP PROVEN** (deposit-public + deposit-private proven end-to-end on the sandbox via `--smoke`; **deposit-public ALSO driven GREEN through the bridge-app via Playwright** — in-browser dual-wallet, `deposit-success` snapshot. **LIVE TESTNET: `scripts/deposit-testnet.ts` bridged 100 USDC Sepolia→testnet-L2 with REAL proofs — `claim_public` synced live in 7.9m, L2 balance asserted; addresses + timing in `lessons/phase-testnet-deposit.md`.** deposit-private through the app lags on the long-lived accumulated sandbox [reliable per-flow app e2e needs a fresh sandbox per run]. Remaining: the public-fuel claim + secret export/import + the destructive recovery test, all through the app). P2,3,4,5 · HIGH. Mint → Permit2 sign → portal deposit → poll → claim → public FJ (direct `depositToAztecPublic` + `FeeJuicePaymentMethodWithClaim`, no 1.5× gas mult). Fixed-size FJ mint reflected in the UX. **Exit gate (R1): prominent secret export/import + a destructive recovery test** (close tab → reimport → claim completes). **Validate:** real Sepolia→Aztec round-trip e2e; refresh mid-flight resumes.

**P7 — Private fuel direct (Wonderland PrivateFPC) — BEFORE the swap.** P6 · HIGH. `PrivateMintAndPayFeePaymentMethod`; register at `salt=Fr.zero()`, **assert the address at startup, block deposit on mismatch**; `additionalScopes` matrix proven end-to-end; fuel-type toggle. Operator runbook: bootstrap-seed the FPC public balance (a full bridge op). **Validate:** real private-fuel round-trip; negative test (wrong claimer secret → revert).

**P8 — L2→L1 withdraw. 🟡 PROVEN (smoke)** (withdraw-public green end-to-end on the sandbox: `SetPublicAuthwitContractInteraction` burn-authwit → `exit_to_l1_public` → `waitForProven` → `computeL2ToL1MembershipWitness` → `portal.withdraw`; 40 USDC burned L2 → released L1. bridge-core `consumeWithdrawal` extracts the proven finalization tail (proven → witness → `portal.withdraw`), 2 unit tests. Remaining: the authwit+exit head wired through the app + localStorage resume + block-bar UI). P6 · HIGH. `burn_public` → `waitForBlockProven` (real blocks-remaining bar) → `computeWitness` → epoch via `getEpochForCheckpoint` → `Outbox.consume`. Point-of-no-return after burn. localStorage resume. **Validate:** real Aztec→Sepolia round-trip e2e.

**P9 — Uniswap V4 swap + atomic `bridgeWithFuel` (public AND private token). 🟡 contract + bridge-core orchestration DONE + LIVE-SWAP FORK-VALIDATED** (`SwapBridgeRouter.sol` forge-proven + audited; bridge-core `runSwapBridge` signs the witness-bound Permit2 transfer → `bridgeWithFuel` → reads both leaf indices from the `BridgeWithFuel` event, 2 unit tests. **`SwapBridgeRouterPermit2Fork.t.sol` drives the REAL Uniswap V4 + REAL Permit2 on a Sepolia fork: `bridgeWithFuel` swaps USDC→WETH→ETH→FeeJuice + bridges, with nonce-replay + expiry reverts — closes audit #6.** 30 forge tests green incl. fork. Remaining: the app swap UI [the L2 claims of the bridged token + fuel need the sandbox]). P2,6,7 · HIGH. `SwapBridgeRouter.sol` **keeping `isPrivate`** (witness-bound, wired to clean `depositToAztecPrivate`); keep nonReentrant/forceApprove-to-zero/`UNDERLYING()` readback/balance check/sweep. **Mandatory contract edits: `hooks==address(0)` + hop-continuity in `_validateRoute`.** `SeedUniswapPools.s.sol` seeds OUR USDC/WETH + ETH/FeeJuice (FJ = real underlying). Fresh quote pre-sign; slippage 5–10%. **Tests: include `SwapBridgeRouterPermit2Fork.t.sol` + explicit nonce-replay + deadline-expiry cases.** Swap framed as demo (Decision #5/D). **Validate:** `forge test` + Sepolia fork + real `bridgeWithFuel` (both public + private token).

**P10 — Polish, activity list, retire faucet pkg, domains, docs.** all · LOW. localStorage activity; retire the faucet pkg; two subdomains → one Pages project; CLAUDE.md/ARCHITECTURE/READMEs + testnet banner. **Validate:** full regression both tabs.

## Security & Adversarial Considerations

Threat model: a public testnet bridge an attacker WILL poke (grief/clog value; possible mainnet later). Defense-in-depth as if real.

- **No-server claim-secret loss → permanent L1 lock.** localStorage AES-GCM (reuse `@alejoamiras/nulo-wallet-crypto`); **prominent export/import is a Phase-6 exit gate**, not Phase 10. Tight CSP — same-origin XSS exfiltrates in-flight secrets; adding L1 RPC to `connect-src` must NOT loosen `script-src`/`wasm-unsafe-eval`.
- **Permissionless mint × thin pools.** Free L1 USDC + operator-seeded FJ liquidity = grief-drainable; `minFuelOutput` protects users from price, NOT operator liquidity/liveness. Treat pool prices as untrusted; reseed runbook; swap is a demo not core infra.
- **Permit2 witness.** Typehash binds all fields incl. `routeHash` and **`isPrivate`** (kept). Exact EIP-712 type-string grammar; `SignatureTransfer` unordered nonce + short deadline (test replay + expiry); `fuelRecipient`/`aztecRecipient` displayed at sign-time and witness-bound (never relayer-chosen).
- **PrivateFPC.** Salt pinned `Fr.zero()`; address asserted at startup, deposit blocked on mismatch (version-drift = unrecoverable). FPC pays from a PUBLIC balance bound per-caller to internal balance (good); operator bootstrap seed is partially drainable — seed conservatively. `additionalScopes:[fpc]` required on every FPC-paid tx.
- **Content-hash L1↔L2** = stranded funds, no TXE coverage → Phase-1 keystone (mint + withdraw) + Phase-6 round-trip. Non-negotiable.
- **V4 settlement/reentrancy.** nonReentrant + balance check + zero-reset approvals + **`hooks==address(0)` + hop-continuity enforced in `_validateRoute`** (mandatory edit).
- **Owner/sweep.** Unrestricted owner-only sweep on router + adapter; router holds zero between calls. Ownable2Step; **document separate operator keys now**; timelock if it ever leaves testnet.
- **Dual-wallet.** Assert `chainId===sepolia.id` before every L1 sign; show both addresses; singleton Aztec connection persists across tabs.
- **Supply chain.** Wonderland tarball + new deps honor `minimumReleaseAge`; `bun.lock` committed; frozen CI install.
- **Private claim secrets are THEFT-capable bearer credentials** (R2). Private content-hash omits the recipient (intended unlinkability) and `claim_private` lets the claimer pick the recipient → a leaked in-flight/export secret = STOLEN funds, not just locked. The export feature must warn loudly; treat the recovery blob as a bearer secret; never log/telemeter/URL it. Public deposits bind `to` in the hash (not bearer).
- **`additionalScopes` is a permission surface** (R2), consumed by execution at simulate/prove/send. The capability prompt + copy must make clear what FPC scope the user is granting; don't over-scope.
- **Fixed FeeJuice packet vs gas ceiling** (R2). `mint_and_pay_fee` reverts if `amount < max_gas_cost`; the UI must check `mintAmount` vs current max gas and disable/reroute rather than submit a reverting tx.
- **Browser secrets** out of logs/telemetry/URLs.

## Decision Ledger

**Sources:** main skeleton + Opus independent plan + 7 research artifacts + R1 dual audit (codex + fresh Opus, both conditional-approve, strongly convergent).

**Adopted from Opus:** recon-first ordering; Phase-1 keystone hash test; direct fuel before swap; no-fee gross-amount hashing.

**R1 corrections folded (audits over earlier research):**
- Portal/bridge is FRESH code — gross amount + `_epoch` (not Holonym's `amountAfterFee`/`_l2BlockNumber`). Keystone covers withdraw.
- viem: the dual-viem framing was WRONG; viem is one forked identity via the repo alias → gate is a Phase-0.5 browser spike of the wagmi stack against the fork, not `bun why`.
- Wonderland is ALREADY a wallet dep (GitHub tarball `4.2.0-prerelease.215fd08`, vite alias, `salt=Fr.zero()`, `additionalScopes`) → mirror it (corrects research artifact 4's "private FPC not needed" + artifact 7's npm-version claim — both annotated stale).
- FeeJuice mint is fixed-size + `onlyMinter` → Phase-1 hard go/no-go; swap demoted to demo-until-proven.
- Reuse `@alejoamiras/nulo-wallet-crypto` for recovery crypto (don't roll own). Update `deployments.test.ts` minter invariant. MintableERC20 Permit2 pre-approve is NEW code (test it). poseidon2/COOP-COEP downgraded (already proven in repo).
- Reorder: private fuel (P7) BEFORE swap (P9). New Phase 0.5 runtime spike.

**Decided (user):** private fuel IN v1; minter-proxy redeploy; **atomic router FULL PARITY (`isPrivate` kept)** — Holonym disabled it only for compliance, which we drop; run split R2.

**Decided (planner):** no bridge fee (gross hash); Permit2 unordered nonce + deadline; `token_minter_proxy` `PublicImmutable` v1; FPC salt `Fr.zero()`; conservative FPC bootstrap seed.

**R2 outcomes folded (audits over the R1 plan):**
- **Deploy the canonical `TokenPortal` instance; drop the hand-rolled forked portal** (R2 Opus, verified) — removes the biggest net-new attack surface + all ABI-reconciliation risk. Phase 2 downgraded HIGH→MED.
- **`FeeAssetHandler.mint` is permissionless** (verified) — Phase-1 gate reframed to "handler wired on live net + record `mintAmount`," not "callable by us."
- `isPrivate` KEPT is correct (R2 Opus: intended unlinkability, no contract hole) — but private in-flight/export secrets are **theft-capable bearer credentials** (R2 Codex) → security copy + export UX must warn; never expose recipient-unbound secrets casually.
- Recovery key: `@alejoamiras/nulo-wallet-crypto` is password-based → use an **L1-signature-derived** key (Holonym's model); **freeze the bridge recovery blob format** explicitly.

**R2 conditions → target phase (apply at implementation):**
- Theft-capable-secret UX/copy → P6 (export gate) + P10 (copy) + Security.
- P0.5 exercises the EXACT execution path (incl. `additionalScopes`) + injected-wallet under COEP (only WASM is proven today) → P0.5.
- Gas-sufficiency guard: if `mintAmount`/claim < `max_gas_cost`, UI disables/reroutes (else `mint_and_pay_fee` reverts) → P6/P7.
- Freeze recovery blob format + L1-signature key → P4.
- Build the parallel-safe L1/anvil e2e harness (anvil + aztec + app per run; CLAUDE.md mandate — faucet has only a no-network smoke) → lands with the first network round-trip (P6).
- Verify FPC actually needs bootstrap-seeding (the wallet never seeds — may self-fund atomically) → P7.
- `_validateRoute`: per-hop `hooks==address(0)` + hop-continuity → P9 (mandatory contract edit).

**Open (Phase 1 / 0.5):** live-net go/no-go (version + handler wiring + `mintAmount`); wagmi-against-`@aztec/viem`-fork browser spike; canonical-portal↔fresh-bridge interop (proven by the Phase-6 round-trip).

## Seeds

Use exactly ONE per session (they don't compose). **Recommended: `/loop`** — this is a long, dependency-ordered, CI-gated build where the per-turn "pick next pending phase → implement → validate → commit → watch CI → advance" cadence is the value.

**`/loop` (recommended):**
```
/loop Each turn, in priority order:
1. Inspect (non-blocking): read implementations-plan/archive/faucet-bridge/plan.md (per-phase status = source of truth) + lessons/; `git status` + `git log --oneline -5`. If a PR exists, `gh pr view --json statusCheckRollup` (no --watch).
2. CI in flight on HEAD SHA? Stream `gh run watch <id>` up to ~10 min; if stuck, inspect logs + report blocked.
3. Failed check/local run? Triage + fix; `/codex xhigh` if non-trivial. Commit (small, conventional) + push. After 5 failures on the same step, STOP + reassess.
4. In-flight phase green? Mark it ✓ in plan.md, file lessons/phase-N.md, print `LESSONS_FILE=implementations-plan/archive/faucet-bridge/lessons/phase-N.md`, advance.
5. Nothing in flight? Pick the next pending phase (respect deps: P0/P0.5/P1 front; P4∥P5) + execute: edit → `bun run lint` + the relevant test (`forge test` / `nargo test` / `bun run test` / `bun run test:e2e` / `bun run e2e:agent`) → commit → push.
6. All phases ✓? Post-impl: `/code-review max --fix` → commit separately → codex post-impl audit (`/codex xhigh`, net diff + adversarial/security ask) → address high/critical → stop + surface.
Discipline: plan.md/lessons/git are authoritative, not the chat checklist. Call codex on any architecture/scope/risk fork. Never merge to main, never deploy/publish. **Phase-1 STOP-THE-LINE** if the live net isn't 4.2.0-compatible or the FeeAssetHandler isn't wired. Stop when all phases ✓, reviews applied + committed, gates green.
```

**`/goal` (alternative — durable cross-session outer):**
```
/goal All phases ✓ in implementations-plan/archive/faucet-bridge/plan.md; each phase printed `LESSONS_FILE=implementations-plan/archive/faucet-bridge/lessons/phase-N.md`; `/code-review max --fix` applied + committed; codex post-impl audit done with high/critical addressed; `bun run audit:vue` + `bun run lint:actions` + the relevant contract tests (`forge test`, `nargo test`) + `bun run e2e:agent` all report exit 0 in the transcript. Hard stop + surface if Phase-1 recon finds the live net isn't 4.2.0-compatible or the FeeAssetHandler isn't wired.
```
