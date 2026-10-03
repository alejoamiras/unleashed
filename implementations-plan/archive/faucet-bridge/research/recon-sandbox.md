# Local sandbox snapshot (running 4.2.0 `aztec start --sandbox`)

A working local network is up (the one to develop against). **Addresses are sandbox-instance-specific — the deploy/node layer must read them at runtime via `node_getNodeInfo`, NOT hardcode them.** This file is a reference snapshot only.

- PXE / node: `http://localhost:8080` · nodeVersion **4.2.0** · rollupVersion `3056981557` · l1ChainId **31337**
- L1: anvil at `http://localhost:8545` (chainId 31337)
- L1 deployer for local: anvil **account0 `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`** (~9479 ETH). Well-known anvil key. (The Holonym key in `bridge-evm/.env` has 0 ETH on the sandbox anvil — use account0 for LOCAL deploys, the `.env` key for testnet.)

## L1 contracts (this sandbox instance)
| contract | address |
|---|---|
| registry | `0xb7f8bc63bbcad18155201308c8f3540b07f84f5e` |
| inbox | `0x6a1b3c7624b69000d7848916fb4f42026409586c` |
| outbox | `0x2925ce379bca1f75f94b31af463ad05fad7050aa` |
| feeJuicePortal | `0x846005fdb8e3f125749df47d36b2c826029e5364` |
| feeJuice (L1) | `0xa513e6e4b8f2a923d98304ec87f64353c4d5c853` |
| rollup | `0x322813fd9a801c5507c9de605d63cea4f2ce6c44` |

## Implications (codex verdict c)
- **No Uniswap V4, no FeeAssetHandler** on the sandbox → the local swap+fuel path uses `MockSwapTarget` (funded with the sandbox's L1 feeJuice `0xa513…`); the REAL V4 swap stays fork-tested.
- Local deploy: token + MockSwapTarget + SwapBridgeRouter(`permit2`, sandbox feeJuicePortal `0x8460…`, mock) on the sandbox anvil; canonical TokenPortal + L2 token/bridge via aztec.js against the PXE; fund the mock with sandbox feeJuice.
- The keystone content-hash is version/chain-independent (selector+args only), so it holds on the sandbox too.
