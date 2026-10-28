---
plan: relayer-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
quality_bar: production
base: main
trunk: main
budget: "recon: 3 Sonnet agents; code-review: off; foreign reviewer gpt-6.1-sol at high"
size: "over the 350-line mid target: the revision for ask13 keeps the superseded design's audit evidence in one table"
---

# relayer-1: a testnet relayer for Base Sepolia sends

A Cloudflare Worker fills the testnet's cross-chain sends by itself. Every minute it reads the recent Across
deposits on Base Sepolia, picks the ones the app built for our relayer, and fills one on Sepolia before its deadline
through bridge-core's own fill code. The manual `fill-testnet.ts` stays for canaries and by-hand fills.

**Chosen architecture (one line):** a cron Worker, run every minute and stateless (each run rescans the fill window
and skips what the SpokePool's `fillStatuses` shows filled), signing with a dedicated relayer key held as its secret
and filling through a Worker-safe fill core moved into bridge-core's `src`: always on, nothing to persist, and the
owner accepted a testnet key in the shared Cloudflare account (ask13).

**Revision.** The first approved draft ran a Bun process under a keyed run (option A). The owner then chose a hosted
Worker and a dedicated key (ask13), and the orchestrator steered the design (`STATUS.md`). Phase 1 (`8cfea22`) was
built for A and stays: its exports are promised to sdk-1 and the CLI uses its extractions.

## Scope map

| Item | Arc | Note |
|---|---|---|
| ask4 | a1 | The service, its unit and two-anvil tests, the runbook. Restock is manual: Across's testnet repays no fill and no automated channel with permitting terms exists (F4, F5); `OWNER-ASKS.md` #2. |
| ask13 | a1, a2 | a1: the Worker, its secret, its config and the runbook's owner steps. a2: point `TESTNET_FILLER` at the dedicated key once the owner has created it (one constant and its tests). a2 waits for that owner step. |
| Issues | none | `gh issue list --state all` shows none in this area. |

**UI impact:** none. Recorded owner decision: "none recorded: this lane changes nothing a person sees. Any change
to the app (copy, a status, a notice about Base Sepolia sends) is an `OWNER-ASKS.md` entry and stays out of the
arc." The app copy the relayer makes stale is `OWNER-ASKS.md` #1; a1 and a2 ship without it. a2 changes only the
address new sends name in their calldata.

## Outcome & Quality Bar

- **For whom.** A tester who sends Base Sepolia USDC to Aztec from the testnet app and watches the stepper; the
  owner, who reads the Worker's logs and tops up its float; a maintainer who inherits the workspace.
- **Excellent looks like:**
  1. A deposit the app built is filled within about two minutes of its block while the float lasts.
  2. Nothing else is filled, and no fill is sent within 120 s of `fillDeadline`.
  3. Every action is a log line: `filled`, `skipped:<reason>`, `failed:<reason>`; a deposit the run ignores is logged
     by the runs that see it in the newest 30 blocks; `low-gas` and `low-inventory` show while a balance is short.
  4. A redeploy, a crashed run or an overlapping run sends no second fill and misses no deposit still fillable.
- **Good enough:** one fill per run, logs in Workers Logs, a manual float top-up. No metrics, alerts, HTTP surface
  or stored state.

## Assumptions

### Facts

- **F1** `fillSourceDeposit` (`packages/bridge-core/scripts/fill-testnet.ts`) re-reads the source receipt, needs one
  `FundsDeposited` from the pinned pool bound for Sepolia, re-derives the relay hash through the destination pool, and
  refuses a deadline within 120 s, another relayer's exclusivity and a short balance before any write; it approves
  exactly the output, revokes on failure, and an already-filled relay is success. Phase 1 added an optional
  `{ relayHash }` that refuses a receipt holding another relay before any write.
- **F2** It does not check recipient, message, tokens or that the deposit names us. `sendFill` approves before
  `fillGas` simulates (`scripts/sandbox/relayer.ts:233-301`), so a fill that cannot log `FilledRelay` costs an
  approve and a revoke.
- **F3** Off mainnet the app builds every deposit on `selfBuiltTerms`: output = input less 25 %, `fillDeadline` =
  source head + 7,200 s, `exclusiveRelayer` = `TESTNET_FILLER` (today the canary), at most 8 whole tokens. Its message
  is one LI.FI step (`acrossDepositFor`, `lifi-decode.ts:566-597`): `callTo` = `approveTo` = the router, both asset
  ids = the output token, `fromAmount` = the output, `requiresDeposit` false, calldata `bridgeFromCaller(intent,
  swapData, output, output)` (`useCrossChainRoute.ts:233`), the user as fallback receiver; 1,408 bytes in every
  recorded variant. The router checks the intent partly against chain state (`DepositRouter._checkShape`); a router
  revert recovers the output to the fallback receiver and the fill still counts.
- **F4** Across's docs: "relayer settlement does not occur on the testnet and unfilled deposits are not automatically
  refunded" (docs.across.to/chains-and-contracts, read 2026-10-28). Each fill costs its output for good; a missed
  deposit stays in the Base Sepolia pool.
- **F5** Circle's faucet: 20 USDC per request, once per 2 h per address and chain, reCAPTCHA; its API "requires
  upgrading to mainnet" and its terms are silent on scheduled claims. Sepolia's base fee read 15–30 wei over 1,024
  blocks and its priority fee 2 wei (2026-10-28): a fill at the 16,777,216-gas cap costs under 10⁻⁹ ETH today.
- **F6** The manifest (`apps/tools/public/testnet-bridge.json`) names `depositRouter` `0x6e55…035b`, `legacyRouters`
  `[0xad08…4303]` and Base Sepolia USDC `0x036C…CF7e` → Sepolia USDC `0x1c7D…7238`; `lifiBook` names the pools
  (`0x82B5…0F8F`, `0x5ef6…B662`) and Sepolia's `receiverAcrossV4` (`0x51Cd…0f44`). Canary rows name the canary as
  their filler (`lifi-canary-run.ts`, `ctx.cfg.canary`), not `TESTNET_FILLER`.
- **F7** `TestSpokePool` enforces exclusivity, deadline and `RelayFilled`, keeps `fillStatuses`, hashes like the real
  pool, runs the message only when the recipient has code, repays nothing and has no constructor state.
  `MintableERC20` keeps `decimals` and its mint cap in immutables. Both work at any address through `anvil_setCode`.
- **F8** The fill path is Node-only today: `fill-testnet.ts` loads `live-intent.ts` and `script-bootstrap.ts` (Aztec,
  `node:fs`, process helpers); `relayer.ts` loads `node:http`, `node:crypto`, `zod` and `crosschain-discovery.ts`
  (Aztec artifacts); `manifest-v2.ts` loads Aztec. Viem-only modules: `lifi-addresses`, `across-v4`, `lifi-abi`,
  `lifi-gas`, `lifi-decode`, `stargate`, `chain-scan`, `across-self-built`, `deposit-router-abi`.
- **F9** Workers cron (developers.cloudflare.com/workers/platform/limits): Free allows 10 ms CPU and 50 subrequests
  per run; Paid allows 30 s CPU by default and 10,000 subrequests; a cron run may take up to 15 min of wall clock.
  Cloudflare does not prevent overlapping cron runs.
- **F12** The app's self-built deposits set `exclusivityDeadline` = `fillDeadline` (`across-v4.ts:134-137`), so only
  the named filler can fill one, and only before its deadline.
- **F10** Lint and unit tests run on every PR, unfiltered; `workspaces.test.ts:16` pins the workspace list; the forge
  job of `_bridge-contracts.yml` has bun, Foundry 1.7.1 (anvil) and `out/`. The landing Worker shows the Workers
  Builds pattern (`apps/landing/wrangler.jsonc`, `wrangler-config.test.ts`); wrangler is pinned at 4.129.1.
- **F11** Base's official RPC caps `getLogs` at 500 blocks; PublicNode refuses over-large ranges (`source-chains.ts:24-33`).

### Inferences

- **I1** A run makes about twenty subrequests (ten `getLogs`, chain ids, balances, fees), at most eight candidates'
  reads, and a fill's probes and receipt polls: under a hundred, so Workers Paid suffices and Free does not.
- **I2** Base Sepolia's 2 s block time holds (an OP-stack chain constant), so 4,000 blocks cover the 7,800 s window.
- **I3** One faucet address restocks about three full sends per 2 h, above current testnet use.

### Asks (working assumption in force)

- **A1 Workers Paid.** The account runs Workers Paid (F9, I1); otherwise runs may stop mid-fill. `OWNER-ASKS.md` #3.
- **A2 The dedicated key.** The owner creates it; a2 then pins its address. Until a2 merges, the Worker refuses to run
  because its key does not derive `TESTNET_FILLER`, and new sends still name the canary.
- **A3 Restock.** The owner tops up the float by hand on `low-inventory` (`OWNER-ASKS.md` #2).
- **A4 Copy.** The F3 app copy stays until the owner answers `OWNER-ASKS.md` #1.

## Architecture comparison (ask4's research, settled by ask13)

| | A. Bun process, keyed run | **B. Workers cron (chosen)** | C. Managed container | D. Grow the sandbox loop |
|---|---|---|---|---|
| Runs | an owner host, restarted by hand | Cloudflare, every minute, redeployed by Workers Builds | Fly or a VPS | inside bridge-core scripts |
| Key | 1Password → process env | Worker secret; the shared build token can redeploy code that reads it (accepted, ask13) | a provider's store | as A |
| Fill path | imports the Node path | a Worker-safe core moved into `src`, old paths re-export | as A | as A |
| State | none | none: `fillStatuses` and a rescan; a Durable Object only if that cannot hold | none | memory |
| Verdict | superseded by ask13 | always on, nothing to restart or persist | a new vendor for a testnet key | `RelayLoop` fills everything |

**Repay and restock.** Across repayment: none on testnet (F4). Circle's faucet: permitted, manual (F5). Its API: a
mainnet-upgraded account, terms silent. CCTP from Base Sepolia: permitted, but no Base Sepolia USDC reaches the
filler. **Choice:** a small float topped up by hand on `low-inventory`.

## Architecture & Implementation

**Worker-safe fill core in bridge-core** (code moves, never copies; every old import path re-exports it):

| New module | Moved in | Old path keeps |
|---|---|---|
| `src/across-relay.ts` | `AcrossRelayData`, `RELAY_DATA`, `acrossRelayHash`, `FILLED_RELAY`, `FILLED_RELAY_TOPIC` and discovery's fill-identity check (now `fillsRelay`) from `crosschain-discovery.ts` (its unnamed copy of `RELAY_DATA` and `relayer.ts`'s named one become this one) | `crosschain-discovery.ts` imports them and re-exports the three it exported |
| `src/across-fill.ts` | the relay leg of `scripts/sandbox/relayer.ts` (`SPOKE_POOL_ABI` … `sendFill`); the fill half of `scripts/fill-testnet.ts` (`FILL_ROUTE`, RPC defaults, `FillDeps` … `fillSourceDeposit`) | `relayer.ts` keeps the sandbox loop and API and re-exports the leg; `fill-testnet.ts` keeps the CLI and re-exports the rest |
| `src/gas-terms.ts` | `SendRequest`, `GasTerms`, `GasTermsFor`, `GasPricing`, `boundedGasTerms`, `withGasTerms` from `scripts/script-l1.ts` | `script-l1.ts` re-exports |
| `src/retried.ts` | `retried` from `scripts/retried.ts` | its two importers point at `src` |

- `package.json` gains `"./across-fill": "./src/across-fill.ts"`. That module also re-exports the viem-only pieces a
  filler checks a deposit against (`lifiBook`, `TESTNET_FILLER`, `selfBuiltTerms`, `SELF_BUILT_FILL_WINDOW_S`,
  `DEPOSIT_ROUTER_ABI`, `boundedGasTerms`, `acrossRelayHash`), so a Worker imports one path. A test bundles it with
  the browser target and fails on any `node:` or `@aztec` import.
- `lifi-decode.ts` gains one pure export, `decodeRouterMessage(bytes)`: its existing decoders applied without an
  expectation (canonical receiver parameters, exactly one step, a canonical `bridgeFromCaller`), returned as a
  verdict. The relayer compares the fields it can derive; the app's `verifyRoute` is unchanged.
- **Write-free refusal of an unfillable fill.** Before the approval, `fillSourceDeposit` simulates the approval and
  `fillRelay` at the gas cap in one `simulateBlocks` block (the probe `fillGas` already runs after the approval,
  factored out) and refuses `unfillable` unless the pool logs `FilledRelay`. A deposit that can never fill then costs
  reads only, on every run, with no attempt counter.

**New workspace `packages/testnet-relayer`** (`@unleashed/testnet-relayer`, private; `@unleashed/bridge-core`
`workspace:*`, `viem` `2.57.1`, `wrangler` `4.129.1` dev). Workerd at run time, Bun in tests.

| File | Contract |
|---|---|
| `wrangler.jsonc` | `name` `unleashed-testnet-relayer`, `main` `src/worker.ts`, `triggers.crons` `["* * * * *"]`, `workers_dev` false, no routes, no assets, `observability` on; `vars` `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL` (PublicNode). The secret `RELAYER_PRIVATE_KEY` is set in the dashboard. Workers Builds settings as in the landing's header comment. |
| `src/route.ts` | `RelayerRoute { source: { chainId; spokePool; token }; destination: { chainId; spokePool; token; recipient; routers }; filler; maxInput }`. `testnetRoute(manifest, filler)` reads `network`, `l1ChainId`, `bridge.l1.depositRouter`, `legacyRouters` and the 84532 routing pair from the bundled testnet manifest JSON, and takes the pools and receiver from `lifiBook`. It throws unless the manifest is testnet on 11155111. A Bun test pins its reading against `parseManifestV2` on the same file. |
| `src/select.ts` | `classify(d, route): IgnoreReason \| null`, pure. It admits F3's envelope: destination chain; `exclusiveRelayer` = `filler` and `exclusivityDeadline` = `fillDeadline` (F12); both tokens; recipient = `receiverAcrossV4`; `0 < input ≤ maxInput`; `0 < output ≤ selfBuiltTerms(…).outputAmount`; `fillDeadline − quoteTimestamp ≤ SELF_BUILT_FILL_WINDOW_S`; message ≤ 2,048 bytes and `decodeRouterMessage` accepts it, receiver ≠ 0, the step's `callTo` = `approveTo` in `routers`, both asset ids = the output token, `fromAmount` = the output, `requiresDeposit` false; the router call's `intent.token` = the output token and `minReceived` = `maxPull` = the output. |
| `src/run.ts` | `relayOnce(c: RelayConfig): Promise<RunSummary>`, `RelayConfig { source: PublicClient; destination: Destination; route; log }` (the route names the filler), and `connectRelay(account, route, endpoints)`, which builds those clients over HTTP. Clients come in so the tests can stub or wrap them. Steps below. |
| `src/key.ts` | `relayerAccount(env)`: `RELAYER_PRIVATE_KEY` → account; a missing or malformed key is refused without echo. |
| `src/worker.ts` | `export default { scheduled }`: `relayerAccount(env)`, `filler` = `TESTNET_FILLER`, then `relayOnce`. Minimal local types for the handler; no new type dependency. |
| `src/log.ts` | One JSON line per event through `console.log`: `event`, `outcome`, `reason`, `relayHash`, `srcTx`, `fillTx`, amounts, `fillDeadline`. Never a key or an RPC URL; an error's first line only. |
| `scripts/relayer.ts` | The owner's keyed commands: `address` prints the address `RELAYER_PRIVATE_KEY` derives, never the key (feeds a2); `once` runs `relayOnce` from the owner's machine, the same code the Worker runs, for a first live check or while the Worker is down. |
| `testnet-relayer.env.example` | `# op: generate eth-key` above `RELAYER_PRIVATE_KEY=op://Keyed-Runs/Unleashed-Testnet-Relayer/RELAYER_PRIVATE_KEY`. |

**One run (`relayOnce`).** It catches every error and logs it; the next minute is the retry.

1. Refuse unless the source RPC answers 84532 and the destination 11155111, the account derives `filler`, and the
   route's manifest is testnet: before any other read or any signature.
2. Read the filler's ETH and USDC; log `low-gas` (under 0.01 ETH) or `low-inventory` (under 6 USDC).
3. Scan `[head − 4,000, head − 2]` on the source in 500-block chunks with the `destinationChainId` topic, decoding
   each log alone to keep its tx hash. 4,000 blocks cover the 7,200 s fill window plus 600 s (I2); `classify`'s window
   check makes that exact for every admitted deposit. A transaction holding more than one such deposit is ignored
   whole (`ambiguous`: `fillSourceDeposit` refuses it). Log `ignored:<reason>` for a deposit in the newest 30 blocks.
4. On the destination, read the head and the pool's `FilledRelay` logs from origin 84532 over the last 800 blocks
   (the fill window at 12 s, plus margin) and drop each admitted deposit one of them fills by full identity
   (`fillsRelay`: the message hash and the relay hash rebuilt from every logged field, the check discovery already
   applies). A fill of another relay that reuses a deposit's origin and id drops nothing. Filled deposits cost no
   per-deposit read, however many. Drop those whose deadline is within 120 s of the head (`skipped:deadline`) and
   those whose output exceeds the USDC read at step 2 (`skipped:balance`), both logged.
5. Stop the run without a fill (`busy`) when the filler has a pending transaction (`pending` nonce above `latest`),
   or when the fill's worst fee at the gas cap, `TX_GAS_CAP` × `maxFeePerGas`, passes 0.005 ETH (`gas-price`). Both
   are write-free. The cap bound means no fill passing it can be refused by the ceiling after its approval unless the
   fee rises between the two (F5 puts today's fee about seven orders of magnitude below it).
6. Try candidates in order, the largest output first, then the earliest block, at most eight per run:
   `fillSourceDeposit` with `{ relayHash }` and `gasTerms` = `boundedGasTerms` refusing a send whose worst fee passes
   0.005 ETH. A write-free refusal moves to the next candidate; any other result ends the run.

| `fillSourceDeposit` result | Log | Then |
|---|---|---|
| filled, with a hash | `filled` | end the run |
| already filled (may have sent an approval and its revoke) | `already-filled` | end the run |
| `FillRefused`, any reason but `fill-reverted` (thrown before any write) | `skipped:<reason>` | next candidate |
| `FillRefused("fill-reverted")`, `AllowanceStillLive`, a ceiling refusal after the approval, any other error | `failed:<first line>` | end the run |

Write-free refusals cannot block the queue: a deposit refused before any write is passed over in the same run, and a
deposit that can never fill (`unfillable`, `ambiguous`, `balance`) costs reads only. The third row alone is
write-free; every row that may have written ends the run, and a deposit failing in the last row is retried each
minute until its deadline (known limit 3).

## Security & Adversarial Considerations

- **Anyone can name our filler.** The boundary is the float. `classify` admits only F3's envelope, so the message
  reaches only our router, the fixed swapper and USDC, its size is capped, and the output never exceeds the app's
  terms. `fillSourceDeposit` re-checks pools, relay hash (bound to the classified one), deadline and balance, and the
  pre-simulation refuses what cannot fill before any write. An invalid intent recovers to the depositor and costs what
  a delivered send costs. Dust goes last in the queue; filled deposits are dropped by two log reads, not one read
  each; at most eight candidates are tried per run, so a flood of admitted dust bounds a run's reads without
  delaying a larger send.
- **Key custody (accepted, ask13).** A dedicated key with a small float: about 0.02 ETH and 20 USDC on Sepolia, none
  on Base Sepolia (the relayer signs nothing there). It is generated into 1Password and pasted into the Worker secret
  by the owner. Any holder of the account's shared build token can deploy code that reads it (`follow-ups.md`): the
  loss is the float. The key never reaches CI, a file, a log or an agent; tests use anvil keys. The same key, as a
  keyed run, drives `scripts/relayer.ts once` on the owner's machine: the manual fallback for deposits that name it,
  since `fill-testnet.ts` stays pinned to the canary.
- **Mainnet.** Step 1 refuses any other chain id before any signature; the config has no route or HTTP surface;
  `selfBuiltTerms` throws on chain 1.
- **Overlap and nonces.** Cron runs may overlap (F9), and the pending-nonce check is an observation, not a lock: two
  runs that both read no pending transaction both proceed. Interleaved, their approvals overwrite one allowance and a
  revoke can void the other run's fill, so an overlap can cost several reverted, replaced or refused transactions.
  It cannot cost tokens: the allowance is to the pool, which pulls from the filler only inside the filler's own
  `fillRelay`, and the pool fills each relay once. A run lasts seconds against a one-minute period, so overlap needs a
  run stalled past a minute. The canary key signs canaries and its manual fills, so neither shares a nonce with the
  relayer. A lock (a Durable Object) would be a coordination protocol for a gas-only loss; not built.
- **Known limits** (closed `known-limit` issues at close-out): (1) inventory exhaustion: every fill spends the float
  (F4), so legitimate sends en masse can empty it and later sends stay in the source pool; (2) a deposit missed while
  the Worker is down past its deadline stays in the source pool; (3) a fill that fails after its approval is retried
  each minute until its deadline, at an approve and a revoke each, and, as the largest candidate, holds smaller ones
  back meanwhile; (4) overlapping runs can waste gas as above.
- **A lying source RPC** can invent a deposit, since the receipt re-read asks the same provider: one output each;
  exploitability unknown; the owner can set a keyed provider in the Worker's vars.
- **Supply chain and CI.** No new external package (wrangler is already pinned in the lockfile); no Cloudflare
  credential and no new permission in Actions; Workers Builds deploys.

## Phases

### Phase 1 — the fill-testnet seam ✓ (`8cfea22`)

Exports `./fill-testnet`; `canaryAccountFromEnv`, `fillEndpointsFromEnv`, `connectFillRoute` out of the CLI;
`fillSourceDeposit`'s `{ relayHash }`; `reserveSandboxPorts` in the sandbox barrel; the refund comment corrected.
Gate passed: bridge-core tests (671), `typecheck:all`, `lint`.

### Phase 2 — the Worker-safe fill core ✓ (`e3fb51c`)

Steps: create `src/retried.ts`, `src/gas-terms.ts`, `src/across-relay.ts`, `src/across-fill.ts` by moving the code in
the table; turn the old locations into re-exports; add the `./across-fill` export, its re-exports,
`decodeRouterMessage` and the `unfillable` pre-simulation. Tests: every existing bridge-core suite passes, its fakes
changed only to answer one simulated result per call; `fill-testnet.test.ts`'s `fillSourceDeposit` suite proves
`unfillable` is refused with no write while the fillable cases still fill; `lifi-decode.test.ts` proves
`decodeRouterMessage` accepts an app-built message and refuses two steps and a non-canonical encoding;
`across-fill-bundle.test.ts` bundles the module for the browser and finds no `node:` or `@aztec` import.

**Validation gate.** `bun run --cwd packages/bridge-core test`, `bun run typecheck:all`, `bun run lint`,
`bun run test:ci-gating`. Pass: exit 0 each. Layers: typecheck/lint, unit, CI gating.

### Phase 3 — the workspace, the config and the pure core ✓

Steps: scaffold the package (`package.json`, `tsconfig.json`, `vitest.config.ts` spreading `sharedTest`); write
`wrangler.jsonc`, `route.ts`, `select.ts`, `log.ts`; add the workspace to `scripts/ci-cd/workspaces.test.ts`;
`bun install`. Tests: `wrangler-config.test.ts` pins name, cron, `main`, no routes, `workers_dev` false, no assets;
`route.test.ts` pins F6's addresses and equality with `parseManifestV2`, and a mainnet manifest throws;
`select.test.ts` builds positives with the app's builders (`selfBuiltTerms`, `acrossMessageOf`), an odd amount
included, flips one field per ignore reason, and keeps the recorded `testnet-rail.router.receipts.json` deposit as a
negative case (`relayer`).

**Validation gate.** `bun run --cwd packages/testnet-relayer test`, `bun run typecheck:all`, `bun run lint`,
`bun run test:ci-gating`. Pass: exit 0 each. Layers: typecheck/lint, unit, CI gating.

### Phase 4 — the run and the Worker ✓

Steps: write `run.ts`, `key.ts`, `worker.ts`, `scripts/relayer.ts`, the env template. Tests: `run.test.ts` with
stubbed clients: chain or key mismatch refuses before any other read; deposits in the `FilledRelay` logs, late ones
and ones above the balance drop with no per-deposit read; a transaction holding two deposits is ignored whole;
`busy` and `gas-price` send nothing; a write-free refusal (`unfillable`) of the largest candidate moves to the next in
the same run, and many dust candidates do not keep a larger one from being tried first; each result row logs and ends or continues as the table says. `key.test.ts`: a malformed or
missing key is refused and never echoed. `bundle.test.ts`: `wrangler deploy --dry-run --outdir <tmp>` bundles
`src/worker.ts`.

**Validation gate.** The Phase 3 commands plus `bun run test:all`. Pass: exit 0 each. Layers: as Phase 3, bundling.

### Phase 5 — the two-anvil integration test and its CI step ✓

Warning: a fresh worktree has no `contracts/bridge/evm/lib`. Copy `lib/` or run `forge install --no-git`, then
`forge build` (`implementations-plan/lessons.md`).

Steps: `test/integration/anvil-pair.ts` claims two ports (`reserveSandboxPorts`, `registerHostPorts`), spawns `anvil
--chain-id 84532` and `--chain-id 11155111` in their own process groups (`ANVIL_BIN`, else PATH) and tears down with
`kill(-pgid)` and `releaseHostPorts` from `process.on` handlers. It deploys `TestSpokePool` and a 6-decimal
`MintableERC20` and copies their code (`anvil_setCode`) to the real pool and USDC addresses of F6, so the production
route runs unchanged. Deposits carry the app's message to the real `receiverAcrossV4`, which has no code there, so the
pool pays without running the message; the Aztec sandbox suite already fills real app messages through
`fillSourceDeposit`. `relayer.integration.test.ts` drives `relayOnce` (the scheduled handler's body) with an anvil key
as `filler`; own `vitest.integration.config.ts`, gated on `RELAYER_INTEGRATION=1` like bridge-core's suite.

| # | Proves | Why not a cheaper layer |
|---|---|---|
| S1 | an app deposit is filled by one run; the next run sends nothing (filler nonce unchanged) | statelessness rests on real `fillStatuses` |
| S2 | deposits naming another relayer, a foreign router, or an output over the terms are ignored at no transaction | the never-happens control beside S1 on real logs |
| S3 | a deposit above the float and a smaller one: the same run skips the first on `balance` and fills the second; after a `mint` the next run fills the first | the poisoned-first-candidate path and real balance reads across runs |
| S4 | a deposit inside the deadline margin by the destination clock is skipped with no fill | needs two chain clocks |
| S5 | two runs over two deposits whose wallets hold their first broadcast at a barrier until both arrive, so both are past the `busy` check and both write: each deposit is filled once, the filler's USDC falls by exactly the outputs filled, and a later run completes what they left | token safety under a forced overlap, which stubs cannot interleave |
| S6 | a stranger fills a relay reusing an app deposit's origin and id (another recipient, no message, no exclusivity) before the run: the app deposit is still filled | the full-identity match on real `FilledRelay` logs |

CI: run `bun run --cwd packages/testnet-relayer test:integration` in the forge job of `_bridge-contracts.yml` after
`forge build`; add `packages/testnet-relayer/**` to `bridge-contracts.yml`'s `contracts` filter and pin it in
`behavior-gating.test.ts`. Estimate: under 30 s after the build.

**Validation gate.** `(cd contracts/bridge/evm && forge build)`, `bun run --cwd packages/testnet-relayer
test:integration`, `bun run lint:actions`, `bun run test:ci-gating`, then the Phase 3 commands. Pass: exit 0 each;
S1–S6 green at retry 0; the measured runtime in `lessons/phase-5.md`; no row of the run left in `~/.agents/ports.md`.

### Phase 6 — the runbook and docs ✓

Steps: `packages/testnet-relayer/README.md` (what it fills and ignores, the log lines, the known limits, the
runbook); a line in `AGENTS.md` § Read before you start and § Hosting (a fourth Worker, cron only); the
`bridge-generation` skill's fill bullet names the Worker and keeps `fill-testnet.ts` for canaries and by-hand fills;
`packages/bridge-core/README.md` points at `./across-fill`.

**The owner's runbook** (owner steps; never a lead's):

1. Create the key: the agent files `env-exec request --template packages/testnet-relayer/testnet-relayer.env.example
   --slug relayer-address -- bun packages/testnet-relayer/scripts/relayer.ts address`; the owner runs `op-remote
   create <host> <id>` (it generates the key) and approves; the log shows the address. The agent opens a2 with it.
2. In the Cloudflare dashboard, create the Worker from Workers Builds (root directory `packages/testnet-relayer`,
   build, deploy and variables as the `wrangler.jsonc` header says) and paste the key from 1Password into the secret
   `RELAYER_PRIVATE_KEY`. Confirm Workers Paid (A1).
3. Fund the address on Sepolia: about 0.02 ETH, and 20 USDC from faucet.circle.com.
4. After a2 merges, send USDC from Base Sepolia in the testnet app; see `filled` in the Worker's logs.
5. Top up on `low-inventory`. To stop it, remove the cron trigger in the dashboard. While the Worker is down, a
   keyed run of `scripts/relayer.ts once` fills one deposit per call from the owner's machine.

Until a2 merges and the secret is set, a1's Worker is inert: it refuses every run because its key does not derive
`TESTNET_FILLER`.

**Validation gate.** `bun test scripts/ci-cd/doc-links.test.ts`, `bun run lint`, `bun run test:all`,
`bun run audit:tools`. Pass: exit 0 each. Layers: doc links, lint, unit, the app's build.

### Arc a2 — pin the dedicated relayer (after runbook step 1)

Steps: set `TESTNET_FILLER` to the printed address; update the tests that pin its value; note in the README that
in-flight sends naming the canary at the switch are filled by hand with `fill-testnet.ts` within their 2 h, and that
from then on `fill-testnet.ts` fills canary deposits only (the relayer key's fallback is `scripts/relayer.ts once`).
**Validation gate.** `bun run audit:tools`, `bun run test:all`, `bun run e2e:tools` on the cross-chain specs at retry 0.

## Decision ledger

| # | Decision | Rejected | Why |
|---|---|---|---|
| D1 | B: Workers cron (ask13) | A keyed process (the first draft), C container, D sandbox loop | always on; the owner accepted the key in the account |
| D2 | a dedicated relayer key; `TESTNET_FILLER` moves in a2 | the canary key | ask13; separate nonces from canaries and manual fills; the loss is the float |
| D3 | stateless runs: `fillStatuses`, a 4,000-block window, the newest-30-block ignore log | a Durable Object cursor | nothing to persist; the window check makes the rescan exact |
| D4 | move the fill core into `src`, old paths re-export | copy it into the Worker; bundle the Node path | imported, not copied; F8 |
| D5 | `classify` admits F3's envelope via the app's own formulas | trust `exclusiveRelayer`; mirror the router's intent rules | anyone can name us; the router reads chain state, and a recovery costs what a delivery does |
| D6 | write-free `unfillable` pre-simulation, and a `gas-price` check at the gas cap before any write | an attempt counter | together they leave no deterministic failure after an approval, with no state |
| D7 | one write per run, largest output first, write-free refusals passed over, at most eight tried | drain all; oldest deadline first; retry the head only | a run stays well inside a minute; neither dust nor a poisoned deposit holds a send back |
| D8 | `busy` (pending nonce) and `gas-price` stop a run before any write | a Durable Object lock | an overlap costs gas, never tokens (known limit 4); a lock is a protocol for no fund risk |
| D12 | drop filled deposits by the destination's `FilledRelay` logs, matched by full relay identity | one `fillStatuses` read per deposit; a match by `depositId` | two reads per run however many filled deposits sit in the window; a forged fill of another relay suppresses nothing |
| D13 | `scripts/relayer.ts once`: the Worker's own run from the owner's machine | unpin `fill-testnet.ts`; no manual path | the canary CLI keeps its pin; the fallback is the code the Worker runs |
| D9 | integration test on two anvils at the real addresses via `anvil_setCode` | anvil addresses with an injected route | the production route runs unchanged |
| D10 | integration in the forge job | a new job or workflow | `out/` is built there; no new required check |
| D11 | manual float top-up | Circle API faucet | the owner's account and terms (`OWNER-ASKS.md` #2) |

## Audit verdicts

**First draft (option A).** Round 1: Codex **reject** (7 findings), Opus Plan agent **conditional approve**
(C1–C6); final fresh Codex **conditional approve** (4), resumed **approve**. Carried into this revision: `classify`'s
envelope and size cap, the `{ relayHash }` binding, largest-first ordering, the gas ceiling, the app-built fixtures,
the recorded receipt as a negative case, the window check, the barrel export, the behavior-gating pin. Superseded by
the stateless Worker: the in-memory attempt cap (now D6's pre-simulation), the cursor overlap rescan (now the
whole-window rescan), keyed-run custody (now the Worker secret, ask13).

**Revision for ask13, Codex** (gpt-6.1-sol, high, fresh session): **reject** (blocking: queue starvation, an
incomplete replacement for the attempt cap). Six findings, each verified against the tree; all adopted:

| # | Finding | Disposition |
|---|---|---|
| 1 | `fill-reverted` is thrown after an approval and a fill, yet logged as a write-free skip | its own `failed` row; the write accounting below the outcome table corrected |
| 2 | one write-free refusal of the largest deposit (`ambiguous`, `balance`) blocks the queue every minute | write-free refusals pass to the next candidate in the same run; `ambiguous` and `balance` drop at the scan; S3 proves it on chain |
| 3 | the 1,000,000-gas fee pre-check passes a fill whose `fillGas` result the ceiling refuses after the approval | the pre-check prices `TX_GAS_CAP`; today's fee sits about seven orders of magnitude under it (F5) |
| 4 | the pending-nonce check is no lock; overlapping runs can waste several transactions | stated as such; token safety argued and proven by S5; known limit 4; a lock rejected (D8) |
| 5 | `fillStatuses` per candidate lets admitted dust exhaust a run's reads | filled deposits drop by `FilledRelay` logs (D12); at most eight candidates tried, sorted first |
| 6 | after a2, `fill-testnet.ts` (canary-pinned) cannot rescue a relayer-key deposit | `scripts/relayer.ts once` runs the Worker's code under the owner's keyed run (D13); the canary CLI keeps its pin |

Resumed verification: **reject** (blocking: a match by `depositId` lets a stranger's fill of another relay with the
same origin and id suppress a real deposit; verified against `TestSpokePool.sol` and discovery's own full-identity
check). Items 2, 3, 4 and 6 verified; item 1's write accounting still overstated. Dispositions: the match is by full
identity (`fillsRelay`, discovery's check moved to `across-relay.ts`), with S6 on chain; the accounting sentence
corrected; S5 forces its overlap with a broadcast barrier, so `relayOnce` takes clients.

Second resume: **approve**, no new material finding.

## Post-implementation

While implementing: comments state invariants and whys only. Log attempts in `lessons/phase-N.md`. After each gate:
`agent-worktree status relayer-1 "phase N green: <next>"` and a `STATUS.md` line. Three failures on one step end the
arc (`ARC_FAILED`).

1. **Codex fix loop** over a1's net diff from the plan commit (`bdca873`):
   `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol`. The prompt carries the
   diff, this plan, the adversarial ask, the no-`.env` and no-`~/.agents/orchy/` lines, and verbatim: "Report bugs and
   small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers,
   or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone." and
   "Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates
   its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and
   flag places where a non-obvious invariant or constraint deserves a comment it doesn't have." Verify each claim, fix,
   commit, log the round here, `resume-codex.sh` with the fix diff; stop on a round with no new material finding;
   three rounds without that: surface. A fix adding state, a lifecycle, a protocol, a recovery policy or a public
   contract is a plan change: stop. One same-family review (`Agent`, `model: "opus"`, general-purpose) of the final
   diff runs beside round 1.
2. **Delivery.** All gates on the final head; push `worktree-relayer-1`; `gh pr create --base main --title
   "feat(testnet-relayer): fill exclusive testnet deposits from a cron worker"`. Body: what and why, gates and
   outcomes, the integration runtime, `Delivers ask4`, `Delivers ask13` (a2 completes the key switch), and
   `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Then `gh pr checks <n> --watch` once, bounded.
3. **Close-out** (in a2's PR, or a1's if a2 is dropped; after merging `origin/main` and reading what changed in the
   index and `lessons.md`): the `## Outcome` block after the front matter (date, status, PRs, `Known limits:`, `Open
   items:`, a line retiring the seeds); promote "Across's testnet settles no fill and refunds no deposit: a missed
   testnet deposit stays in the source pool" to `lessons.md`; delete `follow-ups.md`'s "Testnet fills are manual" and
   "Observe an expired testnet deposit's refund"; file the three known limits as closed `known-limit` issues; `git mv`
   the folder to `implementations-plan/archive/relayer-1` in its own commit, one line in `archive/index.md`, delete
   `STATUS.md`. No row in `index.md`. Open work's homes:

   | Situation | Home |
   |---|---|
   | Work inside this implementation | this plan and the PR |
   | Actionable work that outlives the plan | a GitHub issue with a domain label and a `Record` link to the archived plan |
   | A product call or an outside wait | an issue labelled `owner-decision` or `blocked:external` |
   | A suspected exploitable weakness | a private draft security advisory; the plan records only its id |
   | Rejected, superseded or done | a disposition line in the Outcome |
   | A finding needing unsupported conditions | a closed `known-limit` issue, listed as `Known limits: #N` |
   | Knowledge that prevents a repeat | `implementations-plan/lessons.md` |

4. **Teardown after the merge** (the orchestrator merges): once `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/relayer-1/plan.md` succeeds, run `agent-worktree done relayer-1 --merged`
   and report its output; relay a refusal, never force past it.

## Delivery

Two arcs, sequential PRs against `main`, no stack. **a1** = Phases 1–6, from `worktree-relayer-1` (it holds the plan
commit). **a2** = the pin, from `origin/main` after a1 merges and the owner has run runbook step 1; it carries the
close-out. `code_review: off`. No lanes: the phases share files.

## Seeds

```
/goal Phases 2–6 of implementations-plan/relayer-1/plan.md are marked ✓, each backed by its validation gate reported passing in the transcript, with LESSONS_FILE=implementations-plan/relayer-1/lessons/phase-N.md printed per phase; the Codex fix loop (gpt-6.1-sol, high) converged on a1's net diff, shown by a resumed pass with no new material finding; a1's PR to main exists (gh pr view output) with Delivers ask4 and Delivers ask13; bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/relayer-1 from its plan.md and lessons/, judged against the Outcome & Quality Bar. If the plan path is gone, run `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/relayer-1/plan.md`: merged → `agent-worktree done relayer-1 --merged`, report, stop; not merged → babysit the PR's checks only. Otherwise take the next unticked step, run the fast gates after each edit, commit, and tick a phase only when its gate passes. Decide with Codex (gpt-6.1-sol, high); never merge, deploy or run a keyed step. Five failures on one step: reassess with Codex.
```

`/goal` is recommended: completion shows in the transcript. Use exactly one per session.
