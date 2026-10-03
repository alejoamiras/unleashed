# Planning brief — bridge-security-remediation

Shared input for the three independent planners (main + codex + opus). Routes are DECIDED — plan the implementation, do not re-litigate route choices. Source audit: `audit/security/bridge-redteam/` (report.md, findings/verified.md, the verified PoC `poc/PortalReinit.t.sol`). Tier: deep.

## The 8 findings + FIXED routes

- **F-001 (CRITICAL)** — `packages/bridge-evm/upstream/TokenPortal.sol:37` `initialize` is unguarded + re-callable on the LIVE Sepolia portal `0x9c41d1DD627ed53E25702590ab974d9DfA0c11Ea`. **Route: minimal security fork** — fork the vendored portal, add `if (address(registry) != address(0)) revert AlreadyInitialized();` as line 1 of `initialize`; re-pin its keccak in `verify-l1.ts`; deploy + initialize ATOMICALLY (factory or single-bundle) + deploy-time read-back asserts on `registry()/underlying()/l2Bridge()`. Recipient-commitment NOT included (backlog).
- **F-002 (HIGH)** — `packages/bridge-aztec/token_minter_proxy/src/main.nr` owner is immutable + can authorize any minter → print→exit→drain L1. **Route: immutable single-minter** — constructor fixes the bridge as the ONLY minter (`can_mint[bridge]=true`), remove `set_minter` + owner-mint power entirely. MUST solve the proxy↔bridge deploy-ordering circular dependency (proxy needs bridge addr; bridge needs proxy addr) — via CREATE2 precompute OR a one-time lockable `set_bridge` on the proxy.
- **F-003 (HIGH)** — no `forge`/`nargo` in CI. **Route: fold into the Quality workflow** — paths-guarded `forge test` (bridge-evm) + `nargo test` (bridge-aztec, pinned rc.2) added to the existing Quality gate so they roll into the required `Quality / Status`; flip `packages/bridge-evm/test/WitnessHash.t.sol` from `console.log` to `assertEq`.
- **F-004 (MEDIUM)** — `swapTarget` owner-mutable but not in the Permit2 witness. **Route: bind into the witness** — add `address swapTarget` as the 12th `BridgeWitness` field (Solidity TYPEHASH + TYPE_STRING + struct + `_hashBridgeWitness` in `SwapBridgeRouter.sol:52-56,113-125,325-341`) AND the JS mirror `bridgeWitnessPermitTypedData` in `@unleashed/bridge-core` (l1.ts). `setSwapTarget` then voids outstanding signatures.
- **F-005 (MEDIUM)** — exported `runSwapBridge` (`packages/bridge-core/src/flows.ts:250`) fail-open for private fuel. **Route: refuse bad input** — throw BEFORE signing if `isPrivate && (missing fuelSecret || fuelRecipient !== PRIVATE_FPC_ADDRESS)`. JS-only.
- **F-006 (LOW)** — `UniswapFuelSwap.swap()` permissionless + caller minOutput. **Route: `require(minOutput > 0)`** in `packages/bridge-evm/src/UniswapFuelSwap.sol:88`.
- **F-007 (LOW)** — bearer-secret private claim. **Route: no contract change** — verify `RecoveryHooks.onSecret/onSecrets` (`bridge-core/src/flows.ts:46-64,236-239,263-268`) is seal-only/never-logged; document the integrator secret-handling contract. Recipient-commitment is BACKLOG.
- **F-008 (LOW)** — `UniswapFuelSwap.sweep` lacks `nonReentrant`. **Route: SKIP** (documented latent no-op). No change.

## Phase-0 decisions (from the user)

1. **Execute the live testnet cutover autonomously** — the plan must produce the forked contracts + migration scripts + a Sepolia-FORK dry-run, AND then run the real testnet redeploy + re-point `packages/faucet/public/testnet-bridge.json` + faucet config + verify on-chain. GATE: the live cutover phase runs ONLY after the fork dry-run is green; verify on-chain post-cutover and abort/rollback on mismatch. Deployer key stays in the existing `vm.envUint("PRIVATE_KEY")` / `process.env` script pattern — NEVER printed/exfiltrated.
2. **Fresh deploy, abandon the old portal** — no drain/quiesce phase; deploy the new stack, re-point the app, leave the old portal's residual testnet funds. (Residual risk noted: the old portal stays exploitable but is unreferenced + low-value testnet.)
3. **Sequencing — independent fixes first:** PR A = F-003 (CI) + F-005 (JS) + F-007 (docs), no redeploy, lands first. PR B = F-001/F-002/F-004/F-006 (contracts + the live migration).
4. **Post-impl re-audit:** re-run `/harden security` on the new contract surface (forked portal + new proxy/router + migration) as the final phase.

## Repo facts (verify against source)

- Tooling: `bridge-evm` has NO package scripts → run `~/.aztec/current/bin/forge test`. `bridge-core`: `bun run test` (vitest), `bun run verify:l1`, `bun run deploy:sandbox`. `bridge-aztec`: `scripts/compile.sh` (nargo) → `nargo test` directly. Faucet: `bun run audit:vue`, `bun run --cwd packages/faucet test`.
- Deploy scripts: `packages/bridge-core/scripts/deploy-bridge-testnet.ts` (production testnet deploy: deploys portal via `@aztec/l1-artifacts` bytecode, then separately initializes), `deploy-sandbox.ts`, `verify-l1.ts` (keccak-pins the vendored portal), `check-fpc-version.ts`.
- `packages/faucet/public/testnet-bridge.json` shape: `{ network, l1:{usdc,portal,token,fuel}, l2:{proxy,token,bridge} }`. Migration re-points `l1.portal`, `l2.proxy`, `l2.bridge`. Consumed via `packages/faucet/src/contracts/bridge-deployments.ts`.
- The vendored portal's transitive `@aztec` deps don't compile standalone in the Foundry project (BlobLib remapping missing) — that's why the PoC tests the LIVE bytecode via a Sepolia fork + a minimal interface, NOT by importing the portal. The fork is also how the deployed contract would be tested. Forking the portal to add the guard means the FORK must compile — resolve the `@aztec-blob-lib` remapping / dep tree, or vendor only the minimal interfaces the portal needs.
- L2 contracts use the aztec.nr macro framework; the bridge has 2-step ownership, the proxy does NOT. Token (AZLO) minter authority currently flows token → proxy → bridge.
- Foundry: solc 0.8.28, via_ir, `@aztec/=node_modules/@aztec/l1-artifacts/l1-contracts/src/`. forge at `~/.aztec/current/bin/forge`.

## What each plan must produce

Phases with explicit **Validation gates** (real commands from the tooling above + pass criteria), ordered for the two-PR sequencing. Must cover:
- The keccak re-pin consequence in `verify-l1.ts` (forking the portal changes its bytecode hash).
- The forked-portal COMPILATION problem (the @aztec dep tree) — a concrete approach.
- The proxy↔bridge deploy-ordering resolution (CREATE2 vs lockable set_bridge) — pick one + justify.
- The L2 migration: redeploy proxy (immutable single-minter) + bridge + transfer the AZLO token's minter authority from old proxy → new proxy (does the token allow this? verify). Order of L1+L2 redeploys.
- The live cutover sequence (deploy → verify on-chain → re-point testnet-bridge.json + faucet config → verify app) with a fork dry-run gate + rollback.
- Flipping `poc/PortalReinit.t.sol` to `vm.expectRevert(AlreadyInitialized.selector)` as the regression test (move it into the bridge-evm suite).
- F-003's CI conditional-install of foundry+nargo (paths-guarded) without slowing non-contract PRs.
- A **Security & Adversarial Considerations** section + an **Assumptions** section (Facts/Inferences/Asks).
