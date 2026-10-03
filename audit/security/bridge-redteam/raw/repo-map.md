# Repo map — bridge contract surface

## Inventory (in-scope)

| Component | Path | Lang | LOC | Purpose |
|---|---|---|---|---|
| SwapBridgeRouter | bridge-evm/src/SwapBridgeRouter.sol | Solidity | 351 | L1 entry: Permit2 witness pull → fuel swap → FJ deposit → token deposit, one tx |
| UniswapFuelSwap | bridge-evm/src/UniswapFuelSwap.sol | Solidity | 304 | L1 V4 swap: inputToken → FeeJuice, flash-accounting, native-ETH unwrap |
| MintableERC20 | bridge-evm/src/MintableERC20.sol | Solidity | 51 | Testnet faucet token; permissionless capped mint; Permit2 allowance override |
| MockSwapTarget | bridge-evm/src/mocks/MockSwapTarget.sol | Solidity | 47 | Sandbox swap stand-in (test infra) |
| TokenPortal (vendored) | bridge-evm/upstream/TokenPortal.sol | Solidity | 151 | Canonical Aztec L1↔L2 portal; deposit (pub/priv) + withdraw; **unprotected initialize** |
| TokenBridge | bridge-aztec/token_bridge/src/main.nr | Noir | 147 | L2: claim_public/private, exit_to_l1_public/private, pause, 2-step owner |
| TokenMinterProxy | bridge-aztec/token_minter_proxy/src/main.nr | Noir | 98 | L2: minter allowlist → token mint/burn; owner authorizes minters |
| keystone | bridge-aztec/keystone/src/main.nr | Noir | 35 | Cross-toolchain content-hash equality test (guards strand boundary) |
| DeployBridge | bridge-evm/script/DeployBridge.s.sol | Solidity | 209 | Deploys L1 router/swap/token + seeds V4 pools |
| aztec.js deploy/wire | bridge-core/scripts/{deposit,fuel}-testnet.ts, bridge-aztec/scripts/ | TS | — | Deploys TokenPortal + L2 token/bridge/proxy; **portal initialize + proxy.set_token + minter auth** |
| JS bridge builders | faucet/src/composables/useDeposit.ts, @unleashed/bridge-core (flows.ts, private-fuel.ts) | TS | — | Build witness/route/secret/recipient; sign Permit2 |

## L1↔L2 deposit flow (the fund path)

```
User signs Permit2 witness (binds intent) ──▶ SwapBridgeRouter.bridgeWithFuel/bridge
  ├─ permit2.permitWitnessTransferFrom  (pull totalAmount; spender=router bound by Permit2)
  ├─ [fuel] approve→ UniswapFuelSwap.swap → FeeJuice ; router enforces minFuelOutput + balance + consumed
  ├─ [fuel] FeeJuicePortal.depositToAztecPublic(fuelRecipient, fuelReceived, fuelSecretHash)  (canonical, fixed addr)
  └─ TokenPortal.depositToAztecPrivate(amount, secretHash)  OR  depositToAztecPublic(recipient, amount, secretHash)
        └─ contentHash = sha256ToField("mint_to_{public(bytes32,uint256)|private(uint256)}") ; inbox.sendL2Message(actor=l2Bridge, content, secretHash)
                                                  │  (L1→L2 message; secretHash gates consumption)
                                                  ▼
L2 TokenBridge.claim_public(to,amount,secret,leaf) / claim_private(recipient,amount,secret,leaf)
  ├─ content_hash = get_mint_to_{public(to,amount)|private(amount)}  ← MUST equal the L1 hash (keystone guards)
  ├─ consume_l1_to_l2_message(content_hash, secret, portal, leaf)   ← secret required; recipient NOT bound for private (bearer)
  └─ TokenMinterProxy.mint_to_{public|private}(recipient, amount)  ← bridge must be can_mint
```

Withdraw (L2→L1): TokenBridge.exit_to_l1_* burns + message_portal(withdraw content) → L1 TokenPortal.withdraw consumes outbox + safeTransfer.

## Trust boundaries
- **Untrusted input**: all router/swap params (incl. arbitrary `bridgeToken`, `tokenPortal`, `path`, recipients, secretHashes); the Permit2 signature; the L2 claim `secret` (bearer).
- **Trusted/canonical**: Permit2, FeeJuicePortal (fixed addr), Uniswap v4 PoolManager, Aztec Inbox/Outbox/Rollup, OZ libs.
- **Privileged**: router/swap owner (setSwapTarget, sweep); L2 bridge owner (pause, ownership); L2 minter-proxy owner (set_minter, set_token).

## Dep graph
SwapBridgeRouter → {Permit2, FeeJuicePortal, IUniswapFuelSwap(swapTarget), ITokenPortal, IERC20}. UniswapFuelSwap → {PoolManager, WETH, FeeJuice}. TokenBridge → TokenMinterProxy → Token. keystone → token_portal_content_hash_lib (shared with TokenBridge).
