# relayer-1 recon

Read on the worktree's base (`main` at `fb90e366`). Three read-only agents on Sonnet: a reuse sweep, a map of the
two-anvil harness, and an external-facts search. The parent checked the decisive claims itself. `B` = `packages/bridge-core`.

## Reuse map

| Capability | Existing code | Verdict | Note |
|---|---|---|---|
| Fill one deposit by its source tx | `B/scripts/fill-testnet.ts` `fillSourceDeposit`, `FillRefused`, `FILL_ROUTE`, RPC defaults | reuse-as-is | Re-reads the receipt, re-derives the relay hash against the destination pool, refuses a deadline inside 120 s, another relayer's exclusivity, short inventory; approves exactly the output and revokes on failure; a relay already filled is success. Not exported: `B/package.json` `exports` lacks it. |
| Approve, gas and send `fillRelay` | `B/scripts/sandbox/relayer.ts` `sendFill`, `fillGas`, `AllowanceStillLive` | reuse-as-is (through `fillSourceDeposit`) | `fillGas` needs `eth_simulateV1` with per-call gas (PublicNode answers it). |
| Decode `FundsDeposited` | `relayer.ts` `depositsIn`, `SPOKE_POOL_ABI`, `relayHashOf`, `wordAddress`, `FILL_STATUS` | reuse-as-is | Exported through `@unleashed/bridge-core/sandbox`. `depositsIn` takes logs and drops the tx hash, so decode one log at a time. |
| Scan a source chain by cursor | `relayer.ts` `RelayLoop.tick`; `B/src/chain-scan.ts` `scanRange` | adapt | `RelayLoop` starts at the head, has no chunking or lag and fills every deposit for the destination: a sandbox tool, not a service. Base's official RPC caps `getLogs` at 500 blocks and PublicNode refuses over-large ranges (`B/src/source-chains.ts:24-33`). |
| Key from env, pinned, never echoed | `fillConfigFromEnv` (`fill-testnet.ts:204-232`) and its tests | adapt | Argv-bound to one hash. The key half (regex, `privateKeyToAccount`, pin check, no echo) is the reusable part: extract it. |
| Clients and the route's chain check | `fillCli` + private `assertRoute` (`fill-testnet.ts:235-268`); `createL1Clients`, `createL1PublicClient` (`B/scripts/script-bootstrap.ts`), `manifestL1Chain` (`B/scripts/script-l1.ts`) | adapt | Only `fillCli` composes them today. Extract the connect step so the service and the CLI share it. |
| "Is it ours" predicate | `verifyRoute` (`B/src/lifi-decode.ts:750`) needs the source calldata and an expectation; `decodeMessage` is private | build new (thin) | Built on exported pieces: `LIFI_RECEIVER_MESSAGE_PARAMS`, `DEPOSIT_ROUTER_ABI`, `TESTNET_FILLER`, `SELF_BUILT_RELAY_FEE_BPS`, `selfBuiltMaxDeposit`, `lifiBook`, all from `@unleashed/bridge-core`. |
| Addresses | `lifiBook(84532/11155111)` pools and `receiverAcrossV4`; manifest `apps/tools/public/testnet-bridge.json` (`bridge.l1.depositRouter`, `legacyRouters`, `bridge.routing` USDC pair); `parseManifestV2`, `legacyRoutersOf` | reuse-as-is | The fixture `testnet-rail.json` names an older router: never take an address from it. |
| Mainnet refusal | `selfBuiltTerms` throws on chain 1; `assertRoute` pins 84532/11155111 | reuse-as-is | `lifiBook(1)` and `lifiBook(8453)` exist, so the book alone refuses nothing. |
| Two-chain test harness | `B/scripts/sandbox/local-network.ts` (always boots Aztec); `crosschain.ts` `create2`, `l1.ts` `deployEvm`, `mint`; `registerHostPorts`/`releaseHostPorts`/`reserveSandboxPorts` | adapt | No anvils-only boot exists; `spawnAnvil` is private. The Across stand-ins (`TestSpokePool`, `MintableERC20`) deploy on bare anvils from forge `out/` with no Aztec. |
| Long-running process, Worker cron, logger | none | build new | Searched `scheduled`, `crons`, `triggers`, `Bun.serve`, `Bun.cron`, `setInterval`, `systemd`, `Dockerfile`, `daemon`, `pino`, `winston`, `logger`, `wrangler*`: only the sandbox loop and three assets-only wrangler configs. Scripts log with `console.*`. |
| Restart resume / cursor persistence | none (`cursor|resume|checkpoint|confirmations` over `B/src`, `B/scripts`) | build none | On-chain `fillStatuses` is the dedupe: a restart rescans the fill window. |
| Keyed-run template | `B/testnet-rpc.env.example`, `testnet-l1.env.example` | adapt | No template carries `CANARY_PRIVATE_KEY`; the runbook reads it from a file today (`bridge-generation` SKILL.md:521). |
| Workspace scaffold | `B/package.json`, `vitest.base.ts` `sharedTest`, `biome.json` | reuse pattern | `scripts/ci-cd/workspaces.test.ts:16` pins the workspace list. `test:all` and `typecheck:all` select `@unleashed/*`. Unit tests and lint run on every PR, unfiltered. |
| CI for an anvil test | `.github/workflows/_bridge-contracts.yml` forge job (bun install, `setup-forge`, `forge build`) | adapt | `bridge-contracts.yml`'s filter covers `packages/bridge-core/**`, not a new workspace. |

## The two-anvil harness (mapped)

- `TestSpokePool` (`contracts/bridge/evm/src/mocks/`) emits `FundsDeposited` in Across's field order and enforces
  exclusivity, `fillDeadline` and `RelayFilled` on `fillRelay`. It sets `fillStatuses[hash] = 2`, emits
  `FilledRelay` and pays `outputAmount` from the filler. It calls `handleV3AcrossMessage` only when the recipient has
  code. It has no repayment and no refund. `getV3RelayHash` is `keccak256(abi.encode(relayData, block.chainid))`.
- Anvil takes `--chain-id`, so the stand-ins can run as 84532 and 11155111 and the production chain check holds.
- A worktree has no `contracts/bridge/evm/{lib,out}`: copy `lib/` or `forge install --no-git`, then `forge build`
  (`implementations-plan/lessons.md`).

## External facts

| Fact | Source | Confidence |
|---|---|---|
| "relayer settlement does not occur on the testnet and unfilled deposits are not automatically refunded" | docs.across.to/chains-and-contracts (fetched by the parent) | high |
| The Sepolia HubPool's last root bundle proposal ended its challenge period in May 2025 | `rootBundleProposal()` read over PublicNode | moderate |
| `fillRelay` has no relayer allow-list; exclusivity, `fillDeadline` and `RelayFilled` are its gates | across-protocol/contracts `SpokePool.sol` | high |
| Circle faucet: 20 USDC per request, one per 2 h per address and chain, reCAPTCHA | faucet.circle.com | high |
| Circle's faucet API `POST /v1/faucet/drips` "requires upgrading to mainnet"; no terms on scheduled claims found | developers.circle.com | high / unknown |
| CCTP V2 TokenMessenger on both testnets; domains Sepolia 0, Base Sepolia 6 | developers.circle.com/cctp | high |
| Sepolia gas price about 17-32 wei | `eth_gasPrice`, `eth_feeHistory` over PublicNode | high |
| Workers paid cron: 30 s CPU, 15 min wall clock; free: 10 ms CPU; KV is eventually consistent | developers.cloudflare.com | high |

## Collisions

- **sdk-1** reshapes `B` into an SDK. This lane adds one `exports` entry and two extracted functions in
  `B/scripts/fill-testnet.ts`; sdk-1's brief says to keep those exports.
- **The canary matrix** signs on Sepolia with the same key. Two processes on one key race on nonces.
- `implementations-plan/follow-ups.md` "Testnet fills are manual" is the open item this lane resolves.
  "Observe an expired testnet deposit's refund" is answered by Across's docs: there is none.
- No open issue, no closed `known-limit` issue and no open PR touch this area (`gh issue list --state all`).

## Revision for ask13 (hosted Worker)

Rows above that say "from `@unleashed/bridge-core`" assumed a Bun process. A Worker cannot load the package root
(`src/index.ts` reaches Aztec through `crosschain-discovery.ts`, `manifest-v2.ts` and `private-fuel.ts`); it imports
`@unleashed/bridge-core/across-fill`, whose graph is viem only (`src/across-fill-bundle.test.ts`). The private
`decodeMessage` is reached through the new pure export `decodeRouterMessage`. Workers Paid allows 10,000 subrequests per
invocation (developers.cloudflare.com/workers/platform/limits); Free allows 50.
