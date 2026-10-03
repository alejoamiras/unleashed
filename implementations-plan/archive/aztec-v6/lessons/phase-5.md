# Phase 5 — Chain cascade, node constant, trust anchors

## Node constant and CSP

- `TESTNET_NODE_URL` (`packages/bridge-core/src/testnet-node.ts`) is the dRPC endpoint `https://lb.drpc.live/aztec-testnet/Ak_eT5HA2kbyqamqGTF702daoH37vEsR8YYxjmVXwXgc`. Its key is testnet-only and public by design (A3).
- The constant replaces the literal in 11 scripts, `deploy-config.ts`, `network-targets.ts` (a Node-safe copy, held equal by `network-targets.test.ts`), both `.env.example` files and the `bridge-generation` SKILL.md probe.
- The testnet `connect-src` is now `'self' data: blob: <TESTNET_NODE_URL> <TOKEN_LIST_URL>`. The `*.aztec-labs.com` and `*.aztec.network` wildcards are gone, wss included (A1: the wallet reports the same URL).
- **No redirect.** A POST `node_getNodeInfo` returned `200` with an empty `redirect_url`, which matters because CSP stops path-matching after a redirect. A bare `HEAD` returns `405`; that is not a redirect.

## Identity

- Node: `nodeVersion 6.0.0-rc.1`, `l1ChainId 11155111`, `rollupVersion 2914217885`.
- Wallet chain id: `(11155111 ^ 2914217885) >>> 0 = 2904119610`.
- Classification of every `1821665230` / `1816023401` hit:

| Hit | Disposition |
|---|---|
| `chain-constants.ts`, `chain-info.test.ts`, `wallet-chain-id.test.ts`, `build-integrity.test.ts` | moved to v6 |
| `private-fpc-canonical.json` network pins and `private-fuel.test.ts` | moved to v6 |
| the `bridge-generation.test.ts` testnet tuple | moved to v6; red until the phase 6 manifest |
| `apps/tools/public/testnet-bridge.json` `walletChainId` | the phase 6 deploy writes it |
| the `chain-constants.ts` doc's historical `1816023401` (the stale-variable incident) | kept, now worded as history |

## Reset baseline

`implementations-plan/aztec-v6/lessons/reset-baseline.json` is now `NO_RESET_BASELINE`, and this directory is in `OPERATIONAL_ALLOWLIST`.

**Registry authenticated upstream, independently of the node.** Both config sources that `@aztec-labs/cli@6.0.0-rc.1` reads (`dest/config/network_config.js`) give `testnet.registryAddress = 0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba`, `feeAssetHandlerAddress = 0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9` and `l1ChainId = 11155111`:
- `https://metadata.aztec.network/network_config.json`
- `https://raw.githubusercontent.com/AztecProtocol/networks/refs/heads/main/network_config.json`

**L1 graph on Sepolia.** The reads went through two independent public RPCs: `ethereum-sepolia-rpc.publicnode.com` at block 11822691 and `sepolia.gateway.tenderly.co` at block 11822692. Every read equals the node's claim on both:

| Read | Result |
|---|---|
| `registry.getRollup(2914217885)` | `0x8c2fb2a6…bbd9` |
| `registry.getCanonicalRollup()` | `0x8c2fb2a6…bbd9` (agrees) |
| `rollup.getVersion()` | `2914217885` |
| `rollup.getFeeAssetPortal()` | `0x5bb7523a…2d7f` |
| `rollup.getFeeAsset()` | `0x762c1320…3c18` |
| `portal.ROLLUP()` | the rollup (points back) |
| `portal.UNDERLYING()` | the fee asset (points back) |
| `feeAssetHandler.FEE_ASSET()` | the fee asset |

All 13 node-claimed L1 contracts have code. `INTENT_SECOND_AZTEC_RPC` stays unset because no second v6 endpoint exists.

**Moved vs v5:**
- The rollup moved: `0xd73a91bd…3178` → `0x8c2fb2a6…bbd9`.
- The FeeJuicePortal moved: `0xb4a9f8ea…37a3` → `0x5bb7523a…2d7f`.
- The registry, fee asset `0x762c…3c18` and fee-asset handler did not move. **I5: the fee asset did not move, so the ETH/FJ pool needs no re-seed.**

## Fork fixtures

The `FEE_JUICE_PORTAL` constants (two fork suites, `DeployFuelLive.s.sol`, `contracts/bridge/evm/.env.example`) now point at the v6 portal. Every other Sepolia constant is unchanged on L1. The TS unit fixtures' `FEE_PORTAL` strings are arbitrary shape fixtures, not identity, so they stay.

## Gate (rebased tree at the pre-deploy review's fixes)

Each command ran separately.

| Command | Result |
|---|---|
| `bun run lint` | exit 0 |
| `bun run typecheck:all` | exit 0 (three packages) |
| `bun run test:all` | exit 1 on exactly the expected-red set: `bridge-generation.test.ts › testnet-bridge.json is a valid v2 manifest for its own chain`, which waits for the phase 6 manifest. bridge-core 458 passed, design 242, tools 1644 |
| `bun run test:ci-gating` | 35 pass, 0 fail |
| `bun audit` | exit 1: 64 advisories (30 high, 27 moderate, 7 low), the same set as the pre-bump lockfile (phase 1). CI runs it advisory |
| `npm audit signatures` | exit 0: 2015 registry signatures, 500 attestations |
| `forge test --no-match-contract Fork` | 157 passed across 21 suites |
| `bun run --cwd apps/tools build:testnet` + `verify:build-target testnet` | `✓ … matches target testnet (chainId 2904119610; testnet-bridge.json digest verified)` |
| `build:mainnet` + `verify:build-target mainnet` | `✓ … matches target mainnet (chainId 4248422646; mainnet-bridge.json digest verified)` |
| `rg -n 'v5\.testnet\.rpc\|1821665230' --glob '!implementations-plan/**'` | no output, exit 1 (the pass) |

The generated testnet `connect-src` is `'self' data: blob: https://lb.drpc.live/aztec-testnet/<key> <token list>`. Mainnet's is `'self' data: blob:`.

A1 is confirmed in the transcript: the owner said the wallet uses the dRPC URL.
