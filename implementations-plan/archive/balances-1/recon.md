# balances-1 recon

Base: `origin/main` at `a111e8a`. One Sonnet Explore sweep plus the driver's own reads and live checks. Paths are relative to
`apps/tools/src` unless prefixed.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| A wallet-independent Ethereum reader | `composables/useEthereumReader.ts:17-29` `readClientFor(chainId)`: one viem client per chain over the build's pinned keyless RPCs, `fallback` transport, 20 s timeout; `undefined` where the build pins none | reuse as is |
| One batched balance read | `packages/sdk/src/protocol/erc20.ts:189` `readErc20Balances`: one `multicall` (`allowFailure: true`), a failed entry reads `0n` | reuse as is |
| Row balances with epochs, fill and refresh | `composables/useRowBalances.ts`: the client is a dep (`pub`), so only the wiring changes | reuse as is |
| The selected token's Ethereum balance | `composables/useTokenSelection.ts:182-194` `loadBalances` reads through the `pub` that resolved the token (the wallet) | adapt: read through a dep of its own |
| A pinned L1 reader already in the wizard | `components/send/SendWizard.vue:1613` `bridgeL1 = () => readClientFor(NETWORK.l1ChainId)` | reuse: hoist it, use it for both reads |
| ETH held on Ethereum | `composables/useEthHeld.ts:19-22` already reads `readClientFor(NETWORK.l1ChainId)` by address alone | no change |
| Source-chain and Ethereum native balances | `composables/useSourceChain.ts:105-109,166-187`: pinned reader, owner is `l1.address` alone (`SendWizard.vue:155-159`) | no change |
| Browser check with the wallet elsewhere | `tests/browser/fixtures/l1-wallet.ts` `setChainId(id)`: reads go to the anvil of the chain it is on; every sandbox boots a source anvil (`packages/bridge-core/scripts/sandbox/deploy.ts:181`, `fixtures/test.ts:145-148`) | reuse in cell 37 |
| PR screenshots | `tests/browser/README.md` § Screenshot tours: a throwaway `specs/zz-*.spec.ts`, never committed | reuse |

No new module is built. Search trail for "another wallet-independent L1 balance helper": grepped `balanceOf|getBalance|readErc20|multicall|Balance` across `apps/tools/src`; the hits are the files above, plus L2 simulates (`useTokenBalance.ts`, `useGasHeld.ts`, `useGasShare.ts`), metadata (`useAddressLookup.ts:56`), allowances (`leftover-approval.ts:30`) and fuel quotes (`useFuelQuote.ts`). None of those is a balance a row shows.

## Every Ethereum balance read in the send flow

| Read | Client today | Blanks on another chain? |
|---|---|---|
| Token rows, `useRowBalances` (`SendWizard.vue:149-153`) | the wallet (`l1.publicClient`) | yes: owner is `l1Reader`, `undefined` while `wrongChain` (line 148) |
| Selected token, `useTokenSelection.loadBalances` (line 186) | the wallet | yes: `l1Account` is `l1Reader` (line 166); `watch(l1Reader)` re-reads (line 898) |
| Ethereum native row, `useSourceChain` | pinned | no |
| Continue panel's ETH clause, `useEthHeld` | pinned | no |

## Facts checked live or in the tree

- Multicall3 answers at `0xcA11bde05977b3631167028862bE2a173976CA11` on Sepolia (publicnode) and Base Sepolia (publicnode, `sepolia.base.org`): `eth_getCode` returned identical bytecode on both (sha256 of the replies equal). viem 2.57.1's `sepolia` and `baseSepolia` name that address; the local chain adds it by hand (`lib/network.ts:39`) and the sandbox installs it (`packages/bridge-core/scripts/sandbox/deploy.ts:110-111`).
- The testnet Sepolia read RPC is one keyless URL, `https://ethereum-sepolia-rpc.publicnode.com` (`lib/network-targets.ts:86,144-147`), already in the testnet CSP (`network-targets.ts:163`), pinned by `network-targets.test.ts:33-46`.
- PublicNode publishes no rate limit. Twenty parallel `eth_blockNumber` calls all returned 200. Forty 1 s samples of its head against `rpc.sepolia.ethpandaops.io` were never behind (0 or +1 blocks).
- The mainnet target pins no read RPC (`network-targets.ts:182`) and renders only the placeholder (`App.vue:16`), so no mainnet surface reads rows.
- `useSourceChain` reads each source token with its own `readContract` and the native coin with `getBalance` (`useSourceChain.ts:105-109,166-174`): N+1 calls per chain, not one multicall.
- `assertL1Chain` (`composables/useSend.ts:130-133`) asks the wallet's own client; selection, mint, exit and send keep using it.
- Balance keys are `logoKeyOf(chainId, address)` (`lib/send-model.ts:36`); Ethereum rows carry `MANIFEST.l1ChainId` (`useTokenCatalog.ts:95`), source rows their own chain, so the merged map in `SendWizard.vue:160` cannot cross chains.
- viem 2.57.1 splits one `multicall` into `eth_call`s of at most 1,024 calldata bytes (`actions/public/multicall.ts:168-205`): 28 `balanceOf` per call. Testnet shows about 9 Ethereum rows: the pinned Uniswap list (22.20.0) has 2 Sepolia tokens, `public/testnet-bridge.json` 6 tokens, plus the fee asset.
- `tests/e2e/send-smoke.test.ts:121-128` already points `readClientFor` at the same fake client as the wallet, and mocks `readErc20Balances` (line 200).

## Collisions

- PR #59 (send-copy-1, open) edits `SendWizard.vue` in one hunk at line 1162 and edits `SendWizard.test.ts`: no overlap with lines 146-170 or 897-898. Merge `origin/main` before the PR.
- `SendWizard.test.ts:1716-1731` pins today's blanking and is rewritten.
- No open or closed `known-limit` issue covers balances (`gh issue list --state all --search "balance chain"`).
