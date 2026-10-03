## Outcome

Archived. Seeds retired.

# Fuel-bridge Fee-Juice portal V5 fix

**Status:** ✅ COMPLETE — all 3 phases ✓; candidate smoke self-paying claim PASSED + promoted live; `/code-review` clean; codex post-impl `no high/critical`. · **Tier:** light · **Parent:** an earlier plan, the Aztec 5.0 upgrade (testnet bring-up follow-up)

## Summary

The fueled bridge deposit (swap a slice of bridged AZLO → Fee Juice on L1 for a self-paying L2 claim) hangs forever on V5 with "No L1 to L2 message found". Root cause, confirmed on-chain (not a hypothesis): our deployed `SwapBridgeRouter` (`0x697bdb88`) was built pointing `FEE_JUICE_PORTAL` at the **V4** fee-juice portal `0xd3361019` — a hardcoded Sepolia constant in `DeployFuelLive.s.sol:45` from the holonym/4.2.0 reference era. V5's canonical fee-juice portal is `0x7c4176bff969c9417e42f9cb921100145911cc84` (from `node_getNodeInfo`). So `bridgeWithFuel` calls `feeJuicePortal.depositToAztecPublic(...)` on a **dead V4 portal**; the FJ L1→L2 message never lands in the V5 inbox (`0x599e8d0a`), so the wallet's `FeeJuicePaymentMethodWithClaim` searches the V5 inbox forever.

The **token** side already works — it goes through *our* fresh forked portal (`0x75f83c81`), wired to the V5 registry at deploy time; the token message (idx `3034112`, checkpoint `2964`) is folded and claimable. The FJ **asset** ERC20 (`0x762c`) is **unchanged** V4→V5, so the seeded AZLO/WETH + ETH/FeeJuice Uniswap pools are fine. **Only the portal address is wrong.**

The fix: re-pin the V5 portal address, redeploy **only** the `SwapBridgeRouter` against it (reuse the existing `UniswapFuelSwap` `0x459ea79d` + already-seeded pools), update the manifests, and verify end-to-end with `fuel-testnet.ts` using the deployer key.

## Why this is small (and why it's still a blueprint)

It's a one-address correction + a targeted redeploy of a single contract — no logic change, ABI verified compatible. But it touches an **external-system integration** (the canonical Aztec fee-juice portal) and an **on-chain value flow** (bridged FJ custody), which auto-fires the blueprint protocol per the repo's working rules. Light tier: single codex audit, single plan.

## Ground truth (verified this session — see Assumptions for cites)

- V5 canonical feeJuicePortal `0x7c4176bf…` (node authoritative); our router points at V4 `0xd3361019…`.
- 5.0 `FeeJuicePortal.depositToAztecPublic(bytes32,uint256,bytes32)→(bytes32,uint256)` **exactly matches** the router's `IFeeJuicePortal` interface (+ `UNDERLYING()` present). No ABI change → address-only fix.
- FJ asset `0x762c` unchanged V4→V5 → pools untouched.
- Token message folds + is claimable on V5 → the token portal wiring is already correct; isolate to the FJ portal.
- Stale V4 portal pinned in exactly 6 places (2 live, 4 fixtures/manifests).
- The `.fork.t.sol` tests `vm.createSelectFork(rpc)` at **latest** Sepolia (no pinned block) and actively call `depositToAztecPublic` through the router → updating + running them is a real fork-validation of the V5 portal⇄router interaction, and exercises `FEE_ASSET_HANDLER`/`POOL_MANAGER`/`WETH`/`PERMIT2` at fork-head.

---

## Phases

### Phase 1 — Re-pin the V5 fee-juice portal (source + fixtures) + make the deploy router-only — ✓ DONE

**Objective.** Replace the stale V4 portal constant with the V5 address everywhere it's pinned in Solidity, make `DeployFuelLive` genuinely router-only when reusing the swap, and prove the V5 portal⇄router interaction on a Sepolia fork *before* spending anything on-chain.

**Edits** (`0xd3361019E40026ce8a9745c19e67Fd3ACC10d596` → `0x7c4176bff969c9417e42f9cb921100145911cc84`) — 5 Solidity/env sites (codex corrected the inventory; the live deploy is the only load-bearing one):
- `packages/bridge-evm/script/DeployFuelLive.s.sol:45` — the live deploy (**load-bearing**).
- `packages/bridge-evm/script/DeployBridge.s.sol:131` — fork fixture (consistency).
- `packages/bridge-evm/test/DeployFuelLive.fork.t.sol:34` — fork test (**this one** calls `depositToAztecPublic` through the router → real portal-claim-path exercise).
- `packages/bridge-evm/test/DeployBridge.fork.t.sol:22` — fork test (wiring/seed coverage only — does NOT exercise the fee-portal claim path; codex corrected my overstatement).
- `packages/bridge-evm/.env.example:20` — template default (consistency; codex caught this 7th site).

**Script correctness (codex BLOCKER).** `DeployFuelLive.s.sol:93` constructs `PoolSetupHelper` **unconditionally** — it's only used inside the two `SEED_*` blocks, so with both seed flags false it's a wasted deploy and "router-only" is false. Guard it: read `SEED_AZLO_WETH`/`SEED_ETH_FJ` up front and only `new PoolSetupHelper(...)` if either is true (`helper` is referenced only at `:112-144`, all inside seed blocks, so the guard is safe). This makes Phase 2's "router-only" pass criterion literally achievable.

**Validation gate** (reframed per codex consult `019ee5b2`, after the fork test proved environment-broken — see below).
- Commands: `forge build` (fuel script + tests compile) AND `forge test --no-match-path 'test/*.fork.t.sol'` (non-fork suite).
- Pass criteria: `forge build` exit 0; **34/34 non-fork forge tests green**; AND the `git stash` non-regression proof — the re-pin introduces zero fork-test delta (identical pass/fail set on stashed-V4 vs my code). This gate is **compile + non-regression evidence, NOT a portal-acceptance gate.**
- **Portal acceptance is deferred to Phase 3's real self-paying claim** (codex: the fork test dies in pool-seeding setup *before* `depositToAztecPublic`, so even green it wouldn't prove message/claim semantics — Phase 3's live claim is strictly stronger). Standalone portal evidence already gathered: live `cast` shows the V5 portal `0x7c4176bf` has code + `UNDERLYING()==0x762c` (Fact 10), and the ABI matches (Fact 3).
- **`DeployFuelLive.fork.t.sol` is broken-by-environment** (3 fails, all `PoolAlreadyInitialized` — its `LIVE_AZLO` pools are already seeded live, so its fresh `initialize` reverts). Logged as a follow-up (make the test idempotent against already-init pools); NOT fixed here — the salvage touches the shared `PoolSetupHelper` used by the live deploy, out of scope for an address re-pin.
- Layers: solidity-compile + non-fork unit.

### Phase 2 — Redeploy the SwapBridgeRouter against the V5 portal (reuse swap + pools) — ✓ DONE (router `0xa2003149`)

**Objective.** Deploy a fresh `SwapBridgeRouter` wired to the V5 portal; reuse everything else.

**Steps.**
- Dry-run (no `--broadcast`): `forge script script/DeployFuelLive.s.sol --tc DeployFuelLive --rpc-url <rpc>` with env `FUEL_SWAP_ADDRESS=0x459ea79dde33b415974a8355f551d0c750fa6411` (reuse the existing swap), `SEED_AZLO_WETH=false`, `SEED_ETH_FJ=false` (pools already seeded). After the Phase 1 helper guard, the script deploys ONLY a new `SwapBridgeRouter(PERMIT2, 0x7c4176bf, 0x459ea79d)` — no swap, no helper, no seeding.
- Broadcast: same command + `--broadcast --slow`. Capture the new router address.
- Read-back on Sepolia (`cast call`): `router.feeJuicePortal() == 0x7c4176bf`, `router.swapTarget() == 0x459ea79d`, AND `router.owner() == 0xFcc2238319…` (the deployer — the router is `Ownable2Step`; codex flagged confirming the owner of the contract that holds the `sweep` safety valve).

**Validation gate.**
- Commands: the dry-run, then the broadcast, then the three `cast call` read-backs.
- Pass criteria: dry-run shows exactly ONE new contract deployment (the `SwapBridgeRouter` — no `UniswapFuelSwap`, no `PoolSetupHelper`, no pool `initialize`/liquidity txs); broadcast prints `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`; all three read-backs equal the expected addresses.
- Layers: live-network deploy + on-chain read-back.

### Phase 3 — Candidate-first smoke → promote → verify — ✓ DONE (smoke PASSED, promoted live)

**Objective.** Prove a fueled deposit's FJ claim completes against the **candidate** manifest, then promote candidate→live — the definition of done. (codex: candidate-first is the repo's cutover discipline; `fuel-testnet.ts` defaults to the LIVE manifest, so it's the wrong gate for a not-yet-promoted change.)

**Steps.**
- Update `packages/faucet/public/testnet-bridge.candidate.json` FIRST: `l1.fuel.router` → new router (the runtime-critical field — the faucet's `FuelDeployment` reads `router`), `l1.fuel.feeJuicePortal` → `0x7c4176bf…` (metadata + `verify-l1.ts`, not runtime per codex). `biome format` to tabs.
- Candidate smoke (the proper gate): `bun run --cwd packages/bridge-core scripts/smoke-swap-existing-testnet.ts --config packages/faucet/public/testnet-bridge.candidate.json` — the "pre-promotion FUELED smoke for a candidate manifest": deposit → swap → bridge → **self-paying claim** with the deployer key, against the candidate.
- During the smoke, capture the FJ message key from the `BridgeWithFuel` event and confirm `node.getL1ToL2MessageCheckpoint(fuelKey)` becomes **defined** (the message folds into the V5 inbox) — replacing the brittle absolute-index heuristic codex flagged. The self-paying claim succeeding is the primary proof; the defined checkpoint for the exact key is the corroborating signal.
- Promote: only after the candidate smoke is green, copy candidate→live (`testnet-bridge.json`) so the local faucet at :5176 serves the fixed set.

**Validation gate.**
- Commands: candidate manifest update + `bun run lint`, then `smoke-swap-existing-testnet.ts --config …candidate.json`, then the per-key checkpoint query, then the candidate→live promotion.
- Pass criteria: `smoke-swap-existing-testnet.ts` runs to completion with the self-paying claim **confirmed/included** (the script's own success log); `getL1ToL2MessageCheckpoint(fuelKey)` defined for the smoke's FJ message; `bun run lint` exit 0. Promotion is the final step, gated on the smoke being green — NOT a precondition of the gate.
- Layers: lint + live-network e2e (real swap+bridge+claim with real proofs).

---

## Security & Adversarial Considerations

- **Trusting the right portal (primary threat).** Pointing the router at a wrong/malicious fee-juice portal would strand or misdirect bridged FJ. Mitigation: the V5 address is sourced from `node_getNodeInfo` `l1ContractAddresses.feeJuicePortalAddress` (the node's authoritative registry-derived list), not a guessed constant; asserted by the fork test's `router.feeJuicePortal()` check; read back from the deployed router on-chain (Phase 2). The router additionally reads `feeJuicePortal.UNDERLYING()` and approves exactly that ERC20 (`SwapBridgeRouter.sol:188`), so a portal whose underlying ≠ the swap's FJ output reverts rather than mis-bridging.
- **Reorg / replay (smart-contract domain).** Testnet only. No logic change — we correct one immutable constructor arg and redeploy. The FJ deposit stays recipient-bound by `secretHash`; the router's `bridgeWithFuel` stays Permit2-witness-bound (untouched). No new trust surface.
- **Least privilege / secrets.** Uses the existing deployer key (`0xFcc2238319`) in `bridge-core/.env` (gitignored) — Sepolia testnet ETH only, no mainnet value, no new secret handling. No CI/token surface touched.
- **Supply chain.** No new dependencies. The prior `v4-core@v4.0.0` pin already constrains the fuel Solidity toolchain; forge libs installed `--no-git` (no submodule pollution).
- **Old router left live (codex hardened this).** The prior router (`0x697bdb88`, pointing at the dead V4 portal) stays deployed and is a **live sink**: a stale client still holding the old manifest could route a fuel slice into it and strand that FJ at the dead V4 portal (token bridging would still succeed, masking the loss). It has no kill switch. Mitigation: candidate→live promotion updates the served manifest; document the dead router prominently in lessons + the manifest changelog so no client is pointed at it. Residual testnet risk accepted (no mainnet value).
- **Router ownership.** The new `SwapBridgeRouter` is `Ownable2Step` with the deployer as owner and an owner-only `sweep()` (`SwapBridgeRouter.sol:290`) — a pre-existing trust surface preserved by the redeploy, not introduced. Phase 2 reads `owner()` back to confirm it's the deployer (no accidental ownership transfer).

## Assumptions

### Facts (verified this session)
1. V5 canonical feeJuicePortal = `0x7c4176bff969c9417e42f9cb921100145911cc84` — `node_getNodeInfo` `l1ContractAddresses.feeJuicePortalAddress` on `https://v5.testnet.rpc.aztec-labs.com`.
2. Our `SwapBridgeRouter` (`0x697bdb88`) points at V4 portal `0xd3361019` — hardcoded `DeployFuelLive.s.sol:45`, passed to `new SwapBridgeRouter(PERMIT2, FEE_JUICE_PORTAL, swap)` (`:88`).
3. 5.0 `FeeJuicePortal.depositToAztecPublic(bytes32,uint256,bytes32)→(bytes32,uint256)` matches the router's `IFeeJuicePortal` (`packages/bridge-evm/src/interfaces/IFeeJuicePortal.sol`) exactly; `UNDERLYING()→address` present — verified against `@aztec/l1-artifacts` `FeeJuicePortalAbi`.
4. FJ asset `0x762c132040fda6183066fa3b14d985ee55aa3c18` unchanged V4→V5 — V5 node `feeJuiceAddress` == manifest `l1.fuel.feeJuice` == `DeployFuelLive` `FEE_JUICE`.
5. Token L1→L2 message folds + claimable on V5 (idx `3034112`, checkpoint `2964` ≤ anchor `2982`) — on-chain Inbox `MessageSent` query + `node.getL1ToL2MessageCheckpoint`. The FJ message (router-reported idx `117768202`) is NOT in the canonical inbox (that index → checkpoint ~115008, impossible).
6. Stale V4 portal pinned in 7 in-repo places (codex corrected my count) — `DeployFuelLive.s.sol:45`, `DeployBridge.s.sol:131`, `DeployFuelLive.fork.t.sol:34`, `DeployBridge.fork.t.sol:22`, `.env.example:20`, `testnet-bridge.json:21`, `testnet-bridge.candidate.json:21` (plus historical mentions in research docs, left as record). Phase 1 fixes the 5 Solidity/env sites; Phase 3 the 2 manifests.
7. `DeployFuelLive` supports reuse + skip-seeding via env: `FUEL_SWAP_ADDRESS` (`:84`), `SEED_AZLO_WETH` (`:96`), `SEED_ETH_FJ` (`:125`).
8. `fuel-testnet.ts` reads the live manifest by default (`:46`), uses the deployer `PRIVATE_KEY`, deploys only a throwaway sponsored L2 account, drives swap+bridge → self-paying claim (`:7`).
9. `DeployFuelLive.fork.t.sol` forks **latest** Sepolia (`vm.createSelectFork(rpc)`, no block pin) and calls `depositToAztecPublic` via the router, asserting `router.feeJuicePortal()` + FJ-at-portal balance deltas (`:66,198-242`) — the real portal-claim-path exercise. `DeployBridge.fork.t.sol` is wiring/seed coverage only (codex corrected my "both exercise the portal" overstatement). `DeployFuelLive.s.sol:93` deploys `PoolSetupHelper` unconditionally (used only in the seed blocks `:112-144`).
10. The live V5 portal `0x7c4176bf` has code (1758 bytes) and `UNDERLYING()` returns the FJ asset `0x762c` exactly — on-chain `cast` this session. The router approves exactly `UNDERLYING()` (`SwapBridgeRouter.sol:188`), so the V5 portal + the existing pools' FJ output are provably compatible.
11. No wallet/runtime code pins the L1 fee portal — confirmed this session + by codex: the claim path (`fee-juice.ts:14`, upstream `fee_juice_payment_method_with_claim.ts:15-42`) packages only `sender + claimAmount + claimSecret + messageLeafIndex`; the L2 `FeeJuice` contract resolves against the protocol `FEE_JUICE_ADDRESS`, and `Inbox.sol:104-107` rewrites the sender to that magic address only when `msg.sender == FEE_ASSET_PORTAL`. So the wrong portal is the whole story; `FeeJuicePortal` ≠ `FeeAssetHandler` (the latter is just a mint helper).

### Inferences (unverified — attack these)
- **I1.** Correcting the portal + redeploying ONLY the router (reusing swap + pools) fully fixes the claim with NO wallet-side change: the wallet's `FeeJuicePaymentMethodWithClaim` takes the leaf index from the `BridgeWithFuel` event, and the corrected portal makes that a real V5 inbox leaf → the faucet's checkpoint gate resolves and the claim sends. *Attack: any wallet-side dependency on the portal address itself, not just the index?*
- **I2.** `FEE_ASSET_HANDLER` (`0x5602c39A`) is V5-valid. Codex weakened my framing: seeded pools prove swap *liquidity*, not bridge *correctness* — the load-bearing guarantee is that the router approves exactly `feeJuicePortal.UNDERLYING()` (Fact 10), so an asset mismatch fails the approve/balance path rather than mis-bridging. `FEE_ASSET_HANDLER` is only a mint helper for seeding (out of Phase 2/3's path).
- **I3.** Updating the fork-test portal constant won't break them — they fork at latest (V5 portal live there). *Attack: does the V5 portal's custody/return differ enough to fail the balance-delta asserts? (Phase 1 gate catches this.)*
- **I4.** `POOL_MANAGER` (`0xE03A1074…`), `WETH`, `PERMIT2` are chain/Uniswap-canonical, not V4-stale. *Attack: is the Sepolia Uniswap V4 PoolManager still `0xE03A…`? (Fork test exercises it.)*

### Asks (decisions)
- None outstanding. Resolved this session: verification = autonomous `fuel-testnet.ts` (deployer key); fixture scope = update all 4 Solidity sites.

## Post-implementation hardening

No `/harden` pass warranted — this corrects one constructor argument; it doesn't change the trust model, secrets, or CI surface. The parent plan already carried the security review for the bridge.

## Decision ledger (light — key calls)

- **Redeploy only the router, reuse the swap + pools.** The `UniswapFuelSwap` has no portal dependency (`new UniswapFuelSwap(POOL_MANAGER, FEE_JUICE, WETH)`); only the router takes the portal. Reuse is cheaper (no re-seed of ~0.34 ETH liquidity) and lower-risk (pools already validated). Rejected: full fresh fuel redeploy (wasteful, re-seeds working pools).
- **Verify with `fuel-testnet.ts`, not the UI.** Autonomous, deployer-funded, no dependency on the user's gas-less account. The UI path stays available for the user's own confirmation but isn't the gate.
- **Update all 5 Solidity/env pin sites.** Fork tests fork-at-latest so `DeployFuelLive.fork.t.sol` actually validates the V5 portal — updating it adds a free pre-deploy check rather than just hygiene.
- **Candidate-first (codex).** Verify against `testnet-bridge.candidate.json` via `smoke-swap-existing-testnet.ts` BEFORE promoting to live — the repo's cutover discipline. Rejected my original `fuel-testnet.ts` gate (it defaults to the live manifest, so it would prove a change that isn't promoted yet). Same self-paying-claim proof, candidate-scoped.
- **Guard `PoolSetupHelper` (codex).** Make `DeployFuelLive` genuinely router-only when not seeding, rather than tolerating a wasted helper deploy — keeps Phase 2's pass criterion honest and the redeploy minimal.

## Audit verdicts

- **Codex post-impl (xhigh, session `019ee648-1b14-…`): `no high/critical`.** Confirmed the fix is sound: helper guard has no `address(0)` path + full-seed behavior unchanged; no runtime consumer still points at the old router `0x697bdb88` / V4 portal; the router's per-call checks (approves only `fuelAmount`, witness-binds `swapTarget`, verifies FJ balance increase + exact fuel-slice consumption) prevent steal-whole-deposit / sweep-mid-flight. Three LOW/optional findings, logged as follow-ups (none mandatory, none triggered by this deploy):
  1. **Reuse-matrix footgun** (pre-existing, outside this change): `ROUTER_ADDRESS` set without `FUEL_SWAP_ADDRESS` would deploy a fresh swap then reuse the old router, orphaning the swap. Not triggered here (we set `FUEL_SWAP_ADDRESS`, not `ROUTER_ADDRESS`). Optional: guard the env matrix.
  2. **Old-router neutralization** (optional testnet hardening): the orphaned old router `0x697bdb88` could be made fail-closed by setting its `swapTarget` to a reverter, so stale clients revert instead of burning FJ into the dead V4 portal. Acceptable as-is on testnet; surfaced to the user as an optional follow-up.
  3. **`swapTarget` is also runtime-critical** (clarification, not a bug): the frontend signs it into the Permit2 witness, so a future `setSwapTarget()` must be mirrored to the manifest. Unchanged here (`0x459ea79d`), so the manifest is correct.

- **Codex (light, xhigh, session `019ee564-406f-…`): conditional approve.** Conditions (all folded in): (1) fix the Phase 2 router-only assumption — `PoolSetupHelper` deploys unconditionally → guard it (Phase 1); (2) candidate-first via `smoke-swap-existing-testnet.ts` before promoting live (Phase 3); (3) correct the stale-address inventory (7 sites, +`.env.example`) and the fork-test claim (only `DeployFuelLive.fork.t.sol` exercises the portal) (Facts 6/9); (4) drop the brittle absolute-index heuristic → gate on defined checkpoint for the exact key + claim success (Phase 3). Also adopted: `owner()` read-back (Phase 2), hardened old-router security note, weakened I2 framing. Codex confirmed the core thesis: no wallet-side change needed (Fact 11), reusing the swap is portal-safe, and redeploying only the router is functionally sufficient.
