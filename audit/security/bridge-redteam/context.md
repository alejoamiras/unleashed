# Harden (security) — bridge smart-contract red-team

**Run:** bridge-redteam · **Effort:** max · **Models:** Opus 4.8 (Fable substitute, per user) + Codex xhigh.
**Skill note:** invoked as `/harden security`. `/harden` normally excludes smart contracts and routes them to `security-audit`. Per the user's explicit, repeated request ("check ALL the smart contract logics of the bridge … swap, approve, permit2 … how can someone steal money from users") the harden map-reduce machinery is being run AGAINST the contracts: the web-app CWE taxonomy and the "DO NOT FLAG smart-contract vulns" rule are overridden with a smart-contract red-team taxonomy. JS clusters keep the web prompt (light pass per user).

## Scope

In scope (custom + the one fund-path vendored file):
- **L1 / Solidity** (`packages/bridge-evm/src`): `SwapBridgeRouter.sol` (351), `UniswapFuelSwap.sol` (304), `MintableERC20.sol` (51), `mocks/MockSwapTarget.sol` (47), interfaces.
- **L1 / vendored** (`packages/bridge-evm/upstream`): `TokenPortal.sol` (151) — canonical Aztec portal, keccak-pinned. In the fund path, so in scope for *integration/deploy/init* risk even though the body is upstream.
- **L2 / Noir** (`packages/bridge-aztec`): `token_bridge/{main,config}.nr` (160), `token_minter_proxy/main.nr` (98), `keystone/main.nr` (35, cross-toolchain content-hash test).
- **JS (light)**: frontend bridge construction (`packages/faucet/src/composables/useDeposit.ts`, `@unleashed/bridge-core` witness/secret/route builders).

Out: third-party libs (OZ, Uniswap v4-core, Permit2 itself), generated `out/`, the canonical body of `TokenPortal` (we audit how it's wired/initialized, not OZ/Aztec internals).

## Assets at risk

- User ERC-20 (AZLO and any token the user bridges) pulled via Permit2 into the router.
- FeeJuice (AZTEC) acquired in the swap and bridged as L2 gas.
- The L2 bridged-token supply (mintable via the minter proxy).
- L1↔L2 message integrity (content-hash correctness) — a mismatch strands funds; a forgery mints free L2 tokens.

## Trusted actors (and their powers — these are the centralization surface)

- **Router/Swap owner** (`Ownable2Step`): `setSwapTarget` (points the router at ANY swap contract), `sweep` (drains router/swap residue). Owner is trusted but its powers are an attack surface if the key is compromised.
- **L2 TokenBridge owner**: `set_paused`, 2-step ownership.
- **L2 TokenMinterProxy owner**: `set_minter` (authorize ANY address to mint unlimited token), `set_token` (once).
- **Aztec sequencer / rollup**: canonical; assumed honest per Aztec's model (still note reorg/replay).

## Attack-surface hot-spots (grounded — read the code, these are real leads to attack or clear)

1. **`TokenPortal.initialize` is unprotected + has no already-initialized guard** (`upstream/TokenPortal.sol:37`). Re-calling it repoints `registry/underlying/l2Bridge`. CRITICAL **if** the deployment doesn't initialize atomically / block re-init. Verify against `packages/bridge-evm/script/*` deploy flow + whether a front-run between deploy and initialize is possible. This is the #1 thing to confirm or kill.
2. **`swapTarget` is owner-mutable and NOT bound in the Permit2 witness** (`SwapBridgeRouter.sol:61,142,52-56`). The witness binds `routeHash` but not which target executes it. The router self-enforces `fuelReceived >= minFuelOutput` (:196), a FJ balance-delta check (:199), and a strict `tokenBalBefore - balanceOf == fuelAmount` "fuel consumed" check (:204). Attack: can a malicious/replaced target steal beyond the user's signed slippage? Can it strand residue (owner-sweepable)? Confirm the three guards are airtight or find the gap.
3. **Bearer-secret private claim** (`token_bridge/main.nr:104` `claim_private`; `TokenPortal.sol:90` `depositToAztecPrivate`): the private content hash omits the recipient, so anyone who learns the secret claims to any recipient. Known/accepted design (recipient-commitment deferred), but quantify: where can the secret leak (events, calldata, frontend), and is the deposit→claim window front-runnable?
4. **Owner = infinite mint** (`token_minter_proxy/main.nr:55,68,84`): any `can_mint` address mints arbitrary amounts. Confirm deploy authorizes ONLY the bridge; assess blast radius of a compromised proxy owner.
5. **Arbitrary `bridgeToken`** (`SwapBridgeRouter`): both entry points accept any token address. A malicious ERC-20 (rebasing/fee-on-transfer/reentrant/lying balanceOf) flows through the balance-delta guards. Determine whether it only self-harms the caller or can break a guard / harm the protocol.
6. **`MintableERC20.allowance` override grants Permit2 infinite allowance for EVERY holder** (`MintableERC20.sol:47`) + permissionless capped mint. Testnet-by-design; confirm it cannot generalize to a fund-theft path (Permit2 still needs the owner's signature) and flag the production footgun.
7. **EIP-712 witness type-string correctness** (`SwapBridgeRouter.sol:52-56` TYPEHASH vs TYPE_STRING vs `_hashBridgeWitness` field order): a mismatch is either a DoS (sig never verifies) or, worse, type confusion / cross-context replay. Verify the three are mutually consistent and that Permit2 binds spender=router + chainId (no cross-router / cross-chain replay).
8. **Cross-chain content-hash equality** (`keystone/main.nr` vectors vs `TokenPortal` selectors `mint_to_public(bytes32,uint256)`/`mint_to_private(uint256)`/`withdraw(address,uint256,address)`): the strand-funds boundary. Confirm the keystone test runs in CI (else drift is silent) and the L2 `token_portal_content_hash_lib` matches L1 byte-for-byte.
9. **Settlement / native-ETH unwrap reentrancy** (`UniswapFuelSwap.sol:188-216`, `receive()` :75): trace WETH.withdraw → receive → PoolManager take/settle for reentrancy or stuck-ETH; confirm `unlockCallback` PoolManager-only (:125) is sufficient.
10. **`forceApprove`-to-zero discipline & residue**: any path leaving non-zero allowance or sweepable user funds across the tx boundary.

## Negative list (do not flag)

- Bodies of OZ / Uniswap-v4-core / Permit2 / canonical Aztec internals (we trust the pinned upstream; audit *our wiring* of it).
- `MockSwapTarget` internals as a production bug — it's a sandbox stand-in. BUT the router's `setSwapTarget`→arbitrary-target capability IS in scope.
- `keystone` as deployable code — it's a test-vector prover (but its CI-run status and the equality it guards ARE in scope).
- Pure gas/style/quality nits (separate focus).
- Theoretical issues with no concrete trace or exploit/strand scenario.
- Owner-key-compromise framed as "owner is malicious" UNLESS it reveals a missing safeguard a non-malicious deployment should have (timelock, witness-binding, event, 2-step) — those ARE findings.

## Deliverable

Per real finding: severity (CVSS band assigned at reduce), confidence, CWE/SWC mapping, full trace (source→sink, file:line), exploit/strand scenario, preconditions, fix, and a **PoC test** (Foundry `*.t.sol` for L1, Noir `#[test]`/TXE for L2, vitest for JS) that demonstrates the vuln and would fail pre-fix / pass post-fix. Report: `report.md` (engineering).
