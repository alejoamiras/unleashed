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
size: "over the 350-line mid target: the audit table and the verbatim loop rules carry the round-1 evidence"
---

# relayer-1: a testnet relayer for Base Sepolia sends

A small service fills the testnet's cross-chain sends by itself. It watches Across's Base Sepolia SpokePool for
deposits held for our filler and bound for the bridge on Sepolia, fills each on Sepolia before its deadline through
bridge-core's own fill code, and writes one log line per deposit. The manual `fill-testnet.ts` stays as the fallback.

**Chosen architecture (one line):** one Bun process on an owner host, started as a keyed run, that imports
`fill-testnet.ts`'s Node-only fill path unchanged, stores nothing (on-chain `fillStatuses` dedupes a restart) and
keeps the key off Cloudflare, where a shared build token can redeploy any Worker.

## Scope map

| Item | Arc | Note |
|---|---|---|
| ask4 | a1 | Delivered whole. Restock is the owner's manual faucet claim: Across's testnet repays no fill, and no automated channel with permitting terms exists (F4, F5). `OWNER-ASKS.md` #2 holds the automation option. |
| Issues | none | The lane names none; `gh issue list --state all` shows none in this area. |

**UI impact:** none. Recorded owner decision: "none recorded: this lane changes nothing a person sees. Any change
to the app (copy, a status, a notice about Base Sepolia sends) is an `OWNER-ASKS.md` entry and stays out of the
arc." The app copy the service makes stale is `OWNER-ASKS.md` #1; arc a1 ships without it.

## Outcome & Quality Bar

- **For whom.** A tester who sends Base Sepolia USDC to Aztec from the testnet app and watches the stepper; the
  owner, who starts the service and reads its log; a maintainer who inherits the workspace.
- **Excellent looks like:**
  1. A deposit the app built is filled within two poll intervals of its block, plus the fill's own Sepolia
     confirmation, while the inventory lasts.
  2. Nothing else is filled, and no fill is ever sent within 120 s of `fillDeadline`. Each ignored deposit names its
     reason.
  3. Every deposit seen gets exactly one terminal log line (`filled`, `already-filled`, `ignored:<reason>`,
     `skipped:<reason>`, `failed:<reason>`). A short balance logs `low-gas` or `low-inventory` once per crossing.
  4. A restart sends no second fill and misses no deposit still inside its fill window, with no stored state.
- **Good enough:** one process, one key, one fill at a time, logs on stdout, manual restock. No metrics, alerts,
  high availability or HTTP surface.

## Assumptions

### Facts

- **F1** `fillSourceDeposit` (`packages/bridge-core/scripts/fill-testnet.ts:166-187`) re-reads the source receipt,
  needs exactly one `FundsDeposited` from the pinned pool bound for Sepolia, and re-derives the relay hash through the
  destination pool. It refuses a deadline within 120 s, another relayer's open exclusivity and a short inventory,
  approves exactly the output, revokes on failure, and treats an already-filled relay as success. `no-receipt`
  throws before the deadline check (`:97` vs `:140`). The CLI signs only as `PLAN_PINNED_CANARY_SIGNERS.testnet`.
- **F2** It does not check the recipient, the message, the tokens or that the deposit names our filler
  (`fill-testnet.ts:136-153`). `sendFill` approves before `fillGas` simulates, so a fill that cannot log `FilledRelay`
  costs an approve and a revoke (`relayer.ts:250,295,300`).
- **F3** Off mainnet the app builds every deposit on `selfBuiltTerms`: output = input less 25 %, `fillDeadline` =
  source head + 7,200 s, `exclusiveRelayer` = `TESTNET_FILLER` (`0x7A4f…8fAc`, the canary), at most 8 whole tokens.
  Its message is one LI.FI step (`acrossDepositFor`, `lifi-decode.ts:566-597`): `callTo` = `approveTo` = the router,
  both asset ids = the output token, `fromAmount` = the output, `requiresDeposit` false, calldata
  `bridgeFromCaller(intent, swapData, output, output)` (`useCrossChainRoute.ts:233`), the user as fallback receiver.
  Every recorded variant's message is 1,408 bytes (`testnet-rail.json`). The router itself checks the intent's shape,
  partly against chain state (`DepositRouter._checkShape`: deposits paused, the pinned swap); a router revert recovers
  the output to the fallback receiver while the fill still counts.
- **F4** Across's docs: "relayer settlement does not occur on the testnet and unfilled deposits are not automatically
  refunded" (docs.across.to/chains-and-contracts, read 2026-10-28). The Sepolia HubPool's last root bundle closed in
  May 2025 (moderate). Each fill costs its output for good; a missed deposit stays in the Base Sepolia pool.
- **F5** Circle's faucet: 20 USDC per request, once per 2 h per address and chain, reCAPTCHA. Its API "requires
  upgrading to mainnet"; no terms on scheduled claims were found. Sepolia gas read 17–32 wei on 2026-10-28, one
  reading, no bound.
- **F6** The manifest (`apps/tools/public/testnet-bridge.json`) names `depositRouter` `0x6e55…035b`, `legacyRouters`
  `[0xad08…4303]` and the pair Base Sepolia USDC `0x036C…CF7e` → Sepolia USDC `0x1c7D…7238`; `lifiBook` names the
  pools (`0x82B5…0F8F`, `0x5ef6…B662`) and Sepolia's `receiverAcrossV4` (`0x51Cd…0f44`).
- **F7** `TestSpokePool` enforces exclusivity, `fillDeadline` and `RelayFilled`, keeps `fillStatuses`, hashes like
  the real pool, runs the message only when the recipient has code, and repays nothing. `depositsIn` decodes it.
- **F8** `fill-testnet.ts` loads the Aztec packages, `node:fs` and process helpers through `live-intent.ts` and
  `script-bootstrap.ts`: no Worker can bundle it unrefactored.
- **F9** Lint and unit tests run on every PR, unfiltered. `scripts/ci-cd/workspaces.test.ts:16` pins the workspace
  list. The forge job of `_bridge-contracts.yml` installs bun and Foundry 1.7.1 (anvil) and builds `out/`.
  `reserveSandboxPorts` is not in the `./sandbox` barrel (`scripts/sandbox/index.ts`).
- **F10** Base's official RPC caps `getLogs` at 500 blocks; PublicNode refuses over-large ranges (`source-chains.ts:24-33`).
  A load-balanced RPC can answer from a lagging backend (`lessons.md`).
- **F11** In a keyed run the command runs detached with the values in its environment, readable by any process of the
  same user and by root (`my-stack` § Keyed runs). The canary key today also sits in a file (`bridge-generation` SKILL.md:521).

### Inferences

- **I1** Base Sepolia does not reorg deeper than a few blocks under its single sequencer; a 2-block lag plus the
  overlap rescan covers the rest, and a reorged fill costs one testnet output.
- **I2** Across testnet traffic to Sepolia is low, so one log line per deposit seen stays readable.
- **I3** One faucet address restocks about three full sends per 2 h, above current testnet use.

### Asks (working assumption in force; none blocks arc a1's code)

- **A1 Host (a prerequisite of the live start).** A host, or an OS user, that runs no agent sessions (F11). The
  owner files the keyed request there, so no agent shares the process's user.
- **A2 Key.** The filler stays the canary key, so `TESTNET_FILLER` does not move. A dedicated key later is an owner
  step plus a one-line PR.
- **A3 Restock.** The owner claims Sepolia USDC by hand when the log says `low-inventory` (`OWNER-ASKS.md` #2).
- **A4 Copy.** The F3 app copy stays until the owner answers `OWNER-ASKS.md` #1.

## Architecture comparison (ask4's research)

| | **A. Bun process, keyed run (chosen)** | B. Workers cron + Durable Object | C. Managed container | D. Grow the sandbox loop |
|---|---|---|---|---|
| Runs | owner host, detached under `env-exec` | Cloudflare, every minute | Fly or a VPS | inside bridge-core scripts |
| Key custody | 1Password → process env (F11) | Worker secret; the shared build token can redeploy code that reads it | provider's secret store | as A |
| Fill path | imports `fillSourceDeposit` | needs a Worker-safe fill core moved into `src/` (F8), sdk-1's ground | as A | as A |
| State | none | D1 or Durable Object cursor | none | in memory |
| Restart | a new keyed approval | automatic | automatic | as A |
| Verdict | smallest proven design | more parts, key outside 1Password | a new vendor for a testnet key | `RelayLoop` fills everything from the head |

**Repay and restock.** Across repayment: none on testnet (F4). Circle's public faucet: permitted, manual (F5).
Circle's faucet API: a mainnet-upgraded account, terms silent (`OWNER-ASKS.md` #2). CCTP from Base Sepolia:
permitted, but no Base Sepolia USDC ever reaches the filler. The relay fee: locked in the source pool. **Choice:**
manual restock, announced by `low-inventory`.

**Detection.** Poll `getLogs` every 5 s (the tick below). Rejected: a WebSocket subscription (drops silently, needs
the rescan anyway); Across's testnet API (a third party between us and the chain).

## Architecture & Implementation

**New workspace `packages/testnet-relayer`** (`@unleashed/testnet-relayer`, private, Node-only under Bun; depends on
`@unleashed/bridge-core` `workspace:*` and `viem` `2.57.1`, bridge-core's pin).

| File | Contract |
|---|---|
| `src/route.ts` | `RelayerRoute { source: { chainId; spokePool; token }; destination: { chainId; spokePool; token; recipient; routers }; filler; maxInput }`. `testnetRoute(manifest, filler)` builds it from `lifiBook`, `bridge.l1.depositRouter`, `legacyRoutersOf`, the 84532 USDC routing pair and `selfBuiltMaxDeposit`; it throws unless `network` is `testnet` and `l1ChainId` 11155111. |
| `src/select.ts` | `classify(d: SourceDeposit, route): IgnoreReason \| null`, pure. It admits F3's envelope (who is paid, which contract is called, how much it pulls): destination chain; `exclusiveRelayer` = `filler`; both tokens; recipient = `receiverAcrossV4`; `0 < input ≤ maxInput`; `0 < output ≤ selfBuiltTerms(…, input, …).outputAmount` (the app's own formula); `fillDeadline − quoteTimestamp ≤ SELF_BUILT_FILL_WINDOW_S`; message ≤ 2,048 bytes, canonical `LIFI_RECEIVER_MESSAGE_PARAMS`, receiver ≠ 0, one step with F3's fields (`callTo` in `routers`), calldata canonical `bridgeFromCaller` with `intent.token` = the output token and `minReceived` = `maxPull` = the output. |
| `src/scan.ts` | `depositsBetween(source, route, from, to): Promise<SeenDeposit[]>`, `SeenDeposit { deposit; relayHash; txHash; blockNumber }`: `scanRange` in 500-block chunks, the topic filter, `depositsIn` one log at a time to keep each tx hash. |
| `src/service.ts` | `startService(deps: ServiceDeps): Service`, `ServiceDeps { source; destination: PublicClient; route; fill(txHash, relayHash): Promise<FillResult>; log; pollMs }`, `Service { tick(); stop() }`. In memory only: `pending` (with attempts and the next try) and `seen` (relay hashes, pruned below the rescan floor). |
| `src/log.ts` | `RelayerEvent` union, one JSON line each on stdout: `event`, `outcome`, `reason`, `relayHash`, `srcTx`, `fillTx`, `depositId`, amounts, `fillDeadline`. Never a key, never an RPC URL, an error's first line only. |
| `src/config.ts` | `relayerConfigFromEnv(env, argv, pinned = TESTNET_FILLER)`: the key through bridge-core's `canaryAccountFromEnv`, RPC URLs (PublicNode defaults), `--config <manifest>` (default the testnet manifest). |
| `src/main.ts` | Boot: config → `connectFillRoute` → `testnetRoute` → balances → `startService` with `fill = (h, r) => fillSourceDeposit({ ...deps, gasTerms }, h, { relayHash: r })`, where `gasTerms` = `boundedGasTerms` refusing a send whose worst fee passes 0.005 ETH (`GAS_CEILING`). `process.on` SIGTERM and SIGINT stop after the fill in flight, idempotently. Logs `boot` with the filler, the route and the pid. |
| `testnet-relayer.env.example` | `CANARY_PRIVATE_KEY=op://Keyed-Runs/Unleashed-Testnet-Canary/CANARY_PRIVATE_KEY` with `# op: import` (a new item: `Unleashed-Testnet` was created whole); plain `BASE_SEPOLIA_RPC_URL` and `SEPOLIA_RPC_URL` (PublicNode answers `eth_simulateV1`). |

**The tick.** It catches every error; only boot may exit.

1. At boot the cursor is `firstBlockAfter(head.timestamp − 7,200 s − 600 s)`, inclusive. Every deposit `classify`
   admits was made at most 7,200 s before its deadline, so this rescan finds every one still fillable.
2. Each tick scans `[max(cursor − 150, floor), head − 2]` and moves the cursor only when the whole scan returned. The
   150-block overlap re-reads what a lagging backend may have answered empty; `seen` drops the repeats.
3. A new relay hash goes to `classify`: ignored is logged once; ours joins `pending`.
4. Each tick makes at most one fill attempt, on the pending deposit with the largest output (then the earliest
   block), and the next tick rescans first: dust cannot delay a send that arrives later. Before the attempt the
   service checks the deadline itself against the destination head (`skipped:deadline`), so even a deposit stuck on
   `no-receipt` ends, and it checks the fee level: `estimateFeesPerGas` × 1,000,000 gas over `GAS_CEILING` is an
   uncounted `retry:gas-price` before any write.

| `fill` result | Outcome | Pending? |
|---|---|---|
| filled, with a hash | `filled` | dropped |
| already filled (by another relayer, or by ours whose receipt wait failed) | `already-filled` | dropped |
| `FillRefused`: `deadline`, `exclusive`, `relay-hash` (the receipt's deposit is not the one classified), `no-deposit`, `ambiguous`, `reverted`, `not-a-hash` | `skipped:<reason>` | dropped |
| `FillRefused` `balance` or `no-receipt` (both before any write) | `retry:<reason>`, logged on change, no attempt counted | kept |
| `fill-reverted`, `AllowanceStillLive`, the gas ceiling's refusal inside the fill (the approval may have landed), any other error | `retry:<reason>`, one attempt counted, the next try at least 60 s later; the fifth is `failed:<reason>` | kept until then |

Attempt counts and `seen` live for one process: a restart resets them and logs `already-filled` again for fills it
rediscovers.

5. The tick reads the filler's Sepolia ETH and USDC and logs `low-gas` (under 0.02 ETH) or `low-inventory` (under
   one full output, 6 USDC) once per crossing.

**bridge-core seam** (the whole change there; sdk-1's brief keeps these exports):

- `package.json` `exports` gains `"./fill-testnet": "./scripts/fill-testnet.ts"`.
- `fill-testnet.ts`: extract `canaryAccountFromEnv(env, pinned)` (the key half of `fillConfigFromEnv`, same errors)
  and `connectFillRoute(account, { sourceRpcUrl, destinationRpcUrl }): Promise<FillDeps>` (clients, `assertRoute`,
  `lifiBook` pools) from `fillCli`, which then calls both. `fillSourceDeposit` takes an optional third argument
  `{ relayHash }` and refuses `relay-hash` before any write when the receipt's deposit hashes otherwise. Re-export
  `boundedGasTerms`, the bound a caller passes as `gasTerms`.
- `scripts/sandbox/index.ts` re-exports `reserveSandboxPorts`.
- `src/across-self-built.ts`'s header says the SpokePool refunds an unfilled deposit; F4 says testnet does not.
  Correct the sentence and name the relayer as the filler.

**Trade-offs** are the decision ledger's. One more: concurrent fills would raise throughput, but one key has one nonce
sequence.

## Security & Adversarial Considerations

- **Anyone can name our filler.** `exclusiveRelayer` is the depositor's choice. The boundary is the filler's Sepolia
  USDC and ETH. `classify` admits only F3's envelope, so the message reaches only our router and USDC, its size is
  bounded, and the output never exceeds the app's terms. Whether the intent is valid is the router's call; an invalid
  one recovers to the depositor's fallback address and costs us what a delivered send costs, so it adds nothing to
  known limit (1). `fillSourceDeposit` re-checks the pinned pools, the relay
  hash (now bound to the classified one), the deadline and the balance. A per-send fee ceiling bounds a gas spike.
- **Known limits** (closed `known-limit` issues at close-out): (1) inventory exhaustion: every fill spends inventory
  (F4), so legitimate sends en masse can empty it, and later sends stay in the source pool; reopen on a stuck-send
  report or traffic above one faucet's rate. (2) A deposit missed while the service is down past its deadline stays in
  the source pool; the remedy before the deadline is `fill-testnet.ts`. (3) Custody: a same-user process or root on
  the host can read the key for the run's life (F11); the exposure is the filler's funded testnet balances.
- **A lying source RPC** can invent a deposit, since the receipt re-read asks the same provider: one testnet output
  each; exploitability unknown. The owner can point `BASE_SEPOLIA_RPC_URL` at a keyed provider.
- **Key handling.** The key reaches the process only through the keyed run and is never logged (the existing
  `fill-testnet.test.ts` case plus one service test). It never reaches Cloudflare, CI or a new file.
- **Mainnet.** Boot refuses unless both RPCs answer 84532 and 11155111 (`assertRoute`) and the manifest is testnet on
  11155111 (`testnetRoute`), before any signer touches a chain; no mainnet canary pin exists.
- **Nonces.** One process per key. The runbook stops the service before a canary matrix run or a manual
  `fill-testnet.ts`, which sign with the same key.
- **Supply chain and CI.** No new external dependency; `bun.lock` gains only the workspace link; no secret and no new
  permission in CI, which never runs the live service.

## Phases (arc a1)

### Phase 1 — the bridge-core seam

Steps: make the four seam changes above. Add `fill-testnet.test.ts` cases: `connectFillRoute` refuses a source RPC
on chain 1 before any other read; `fillSourceDeposit` with a mismatched `relayHash` refuses `relay-hash` and sends
nothing.

**Validation gate.** Commands: `bun run --cwd packages/bridge-core test`, `bun run typecheck:all`, `bun run lint`.
Pass: exit 0 each; the existing `fill-testnet.test.ts` and `relayer.test.ts` cases pass unchanged. Layers: typecheck/lint, unit.

### Phase 2 — the workspace and its pure core

Steps: scaffold the package (`package.json`, `tsconfig.json`, `vitest.config.ts` spreading `sharedTest`); write
`route.ts`, `select.ts`, `config.ts`, `log.ts`; add the workspace to `scripts/ci-cd/workspaces.test.ts`; `bun install`.
Tests: `select.test.ts` builds its positive deposits with the app's own builders (`selfBuiltTerms`,
`acrossMessageOf`), an odd amount included; each ignore reason flips one field of the first. The recorded
`testnet-rail.router.receipts.json` deposit (no exclusive relayer, a 10 % fee) stays as a negative case: `relayer`. `route.test.ts`: the testnet manifest yields F6's
addresses; a mainnet manifest throws. `config.test.ts`: a key that is not the pin is refused before a client exists,
and no refusal echoes the key.

**Validation gate.** Commands: `bun run --cwd packages/testnet-relayer test`, `bun run typecheck:all`, `bun run lint`,
`bun run test:ci-gating`. Pass: exit 0 each. Layers: typecheck/lint, unit, CI gating.

### Phase 3 — the service

Steps: write `scan.ts`, `service.ts`, `main.ts`; add a `start` script (`bun src/main.ts`).
Tests: `service.test.ts` with stubbed clients and a stubbed `fill`: one row per outcome-table line; a `balance`
retry filled on a later tick; the fifth counted attempt fails; the local deadline ends a `no-receipt` deposit; one attempt per
tick, largest first, rescanned between attempts; a gas-price pre-check sends nothing; a ceiling refusal after the
approval counts; a failed scan keeps the cursor; the overlap re-reads without a second line; a low
balance logs once per crossing.

**Validation gate.** Commands: the Phase 2 commands plus `bun run test:all`. Pass: exit 0 each. Layers: as Phase 2.

### Phase 4 — the two-anvil integration test and its CI step

Warning: a fresh worktree has no `contracts/bridge/evm/lib`. Copy `lib/` or run `forge install --no-git`, then
`forge build` (`implementations-plan/lessons.md`).

Steps: write `test/integration/anvil-pair.ts`. It claims two ports (`reserveSandboxPorts`, `registerHostPorts`),
spawns `anvil --chain-id 84532` and `--chain-id 11155111` detached in their own process groups (`ANVIL_BIN`, else
PATH), and tears down with `kill(-pgid)` and `releaseHostPorts` from `process.on` handlers. Deploy `TestSpokePool`
and a 6-decimal `MintableERC20` on each with `deployEvm` and `mint` (`./sandbox`). Deposits carry the app's message
(`acrossMessageOf`) to the real `receiverAcrossV4` address, which has no code on a bare anvil, so the pool pays without
running the message. The service runs in-process with `fill` over `fillSourceDeposit`; own `vitest.integration.config.ts`,
gated on `RELAYER_INTEGRATION=1` like bridge-core's suite. Scenarios:

| # | Proves | Why not a cheaper layer |
|---|---|---|
| S1 | an app deposit is filled once; a second service over the same chains logs `already-filled` and sends nothing (filler nonce unchanged) | the stateless restart rests on real `fillStatuses` and receipts |
| S2 | deposits naming another relayer, a foreign router, or an output over the terms are ignored and cost no transaction | the never-happens assertion, paired with S1's success control on real logs |
| S3 | a short inventory skips on `balance`; after a `mint`, a later tick fills it | the retry crosses real balance reads |
| S4 | a deposit inside the deadline margin by the destination's clock is `skipped:deadline`, no fill sent | needs two chain clocks |

CI: add `bun run --cwd packages/testnet-relayer test:integration` to the forge job of `_bridge-contracts.yml`, after
`forge build`; add `packages/testnet-relayer/**` to `bridge-contracts.yml`'s `contracts` filter, and pin it in
`scripts/ci-cd/behavior-gating.test.ts`. Estimated runtime: under 30 s after the build.

**Validation gate.** Commands: `(cd contracts/bridge/evm && forge build)`,
`bun run --cwd packages/testnet-relayer test:integration`, `bun run lint:actions`, `bun run test:ci-gating`, then the
Phase 2 commands. Pass: exit 0 each; S1–S4 green at retry 0; the measured runtime is in `lessons/phase-4.md`;
`~/.agents/ports.md` holds no row of the run afterwards. Layers: integration (two anvils), CI gating, unit, lint.

### Phase 5 — the runbook and docs

Steps: write `packages/testnet-relayer/README.md`: what it fills and ignores, the log lines, the known limits and the
runbook below. Add it to `AGENTS.md` § Read before you start. In `.claude/skills/bridge-generation/SKILL.md`, the
"Testnet fills are the canary's alone" bullet names the service as the filler and `fill-testnet.ts` as the fallback,
and promotion gains "restart the relayer at the promoted commit". Add the service beside `fill-testnet.ts` in
`packages/bridge-core/README.md`.

**The owner's runbook** (release steps; never a lead's):

1. Prepare the host (A1): a host or OS user with no agent sessions, aa-skills installed, a clone at the approved
   commit and `bun install --frozen-lockfile`.
2. File the request there: `env-exec request --template packages/testnet-relayer/testnet-relayer.env.example --slug
   testnet-relayer -- bun packages/testnet-relayer/src/main.ts`. Create the item once with `op-remote create <host>
   <id>` and import the canary key, then approve with `op-remote <host> <id>`.
3. Fund the filler on Sepolia: about 0.05 ETH, and USDC from faucet.circle.com.
4. Check end to end: send USDC from Base Sepolia in the testnet app; see `filled` in the log and the stepper move.
5. Stop with SIGTERM to the pid in the `boot` line: before a canary matrix run or a manual `fill-testnet.ts`, and to
   restart at a promoted commit. Restock on `low-inventory`.

**Validation gate.** Commands: `bun test scripts/ci-cd/doc-links.test.ts`, `bun run lint`, `bun run test:all`,
`bun run audit:tools`. Pass: exit 0 each. Layers: doc links, lint, unit, the app's build (bridge-core changed).

## Decision ledger

| # | Decision | Rejected | Why |
|---|---|---|---|
| D1 | A: Bun process, keyed run | B Workers cron, C container, D sandbox loop | B needs bridge-core refactored for Workers and a Cloudflare-held key; both reviewers would build A |
| D2 | keep the canary key as `TESTNET_FILLER` | a dedicated key now | a new pin needs a key no agent may create; moving it later is one line |
| D3 | import `fillSourceDeposit`, bound to the classified relay hash | `sendFill` from the log; an `admit` callback | one copy of the fill checks; a hash is the narrowest binding |
| D4 | no stored state; boot rescan by timestamp, tick overlap of 150 blocks | a cursor file | `fillStatuses` dedupes; the window check makes the rescan exact |
| D5 | `classify` admits F3's envelope, via the app's own formulas | trust `exclusiveRelayer` alone; mirror the router's intent rules | anyone can name our filler; the router's rules read chain state, so a mirror stays incomplete, and a recovery costs what a delivery does |
| D6 | attempt cap 5, 60 s apart, for failures past a write | retry forever; a typed "unfillable" error in `relayer.ts` | bounded cost with no new error contract |
| D7 | one attempt per tick, largest output first, rescan between | drain the queue; oldest deadline first | a later send is seen before dust is drained; a short deadline cannot jump |
| D8 | manual restock | Circle API faucet | needs the owner's account and terms (`OWNER-ASKS.md` #2) |
| D9 | integration step in the forge job | a new job or workflow | `out/` is built there; no new required check |
| D10 | the anvil test does not run the message | a receiver, Executor and router rig | the real router needs the Aztec sandbox, whose suite already fills real app messages through `fillSourceDeposit` |
| D11 | viem's default nonce reads | viem `nonceManager` | one sequential sender; a lagging read costs one counted attempt |

Competing outline (B, Workers-first): `plan-outline-b.md`, local only.

## Audit verdicts

**Round 1, Codex** (gpt-6.1-sol, high, fresh): **reject**: incomplete message validation, an unbound receipt
re-read, repeated gas on permanent failures, insufficient integration coverage. Would build A, not B.
**Round 1, Opus Plan agent:** **conditional approve** (C1 deadline check and attempt cap, C2 `classify` checks and
ordering, C3 overlap rescan, C4 custody, C5 app-built fixtures, C6 the export). Would build A.

| Finding | Disposition |
|---|---|
| `classify` misses step fields; gas not bounded by the router (Codex 1, Opus 2) | adopted: F3's exact shape, a 2,048-byte cap, the fee ceiling |
| receipt not bound to the classified log (Codex 2, Opus 7) | adopted: the `{ relayHash }` argument, refused before any write |
| retries re-approve forever; `no-receipt` never reaches the deadline (Codex 3, Opus 1) | adopted: the local deadline check and D6 |
| boot rescan vs an unbounded deadline (Codex 4) | adopted: the window check |
| a lagging backend's empty `getLogs` loses a deposit (Opus 3) | adopted: the 150-block overlap |
| tests share `classify`'s own model (Opus 5) | adopted: the app's builders, an odd amount, the recorded receipts |
| the anvil test never runs the message (Codex 5) | partly: app-built messages adopted; the rig rejected (D10) |
| custody wording and the agent on the host (Codex 6, Opus 4) | adopted: A1 is a live-start prerequisite, the owner files the request, known limit (3) |
| `reserveSandboxPorts` missing from the barrel (Codex 7, Opus 6) | adopted, with the behavior-gating pin |
| nonce races; stop before manual fills (Opus 8) | runbook adopted; `nonceManager` rejected (D11) |
| our own fill read as `already-filled`; `not-a-hash`; inclusive bound (Opus 9) | the last two adopted; the first is documented in the table |
| a testnet minimum send (Opus, Ask) | not needed: `output > 0`, one attempt per tick and largest-first keep dust from delaying sends |

**Final pass, Codex** (gpt-6.1-sol, high, fresh session): **conditional approve** (gas-ceiling accounting, intent
validity, the fixture, rescan between fills).

| Finding | Disposition |
|---|---|
| a ceiling refusal after the approval retries uncounted | adopted: an uncounted pre-check before any write; a refusal inside the fill counts |
| the recorded receipt cannot pass as a positive case | adopted: a negative case; positives are app-built |
| canonical calldata admits an invalid intent (`FuelOnlyShape`) | rejected with the path written: a revert recovers to the depositor at a delivered send's cost (D5); the plan now says "envelope", not "exact shape" |
| a batch drain delays sends found later | adopted: one attempt per tick (D7) |
| attempt bounds are per process | adopted: stated under the outcome table |

**Final pass, resumed:** **approve**. All five dispositions verified; no new material finding.

## Post-implementation

While implementing: comments state invariants and whys only. Log meaningful attempts in `lessons/phase-N.md`.
After each gate: `agent-worktree status relayer-1 "phase N green: <next>"` and a `STATUS.md` line. Three failures on
one step end the arc (`ARC_FAILED`).

1. **Codex fix loop** over the net diff from the plan commit:
   `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol`. The prompt carries the
   diff, this plan, the ledger, the adversarial ask, the no-`.env` and no-`~/.agents/orchy/` lines, and verbatim:
   "Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration
   surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear,
   leave it alone." and "Audit the comments for value per character. Flag any comment that narrates what the code
   visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a
   sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have."
   Verify each claim, fix, commit, log the round here, then `resume-codex.sh` with the fix diff. Stop when a round
   has no new material finding; three rounds without that is a stop to surface. A fix that adds state, a lifecycle, a
   protocol, a recovery policy or a public contract is a plan change: stop. One same-family review (`Agent`,
   `model: "opus"`, general-purpose) of the final diff runs beside round 1.
2. **Delivery.** All gates on the final head; push `worktree-relayer-1`; `gh pr create --base main --title
   "feat(testnet-relayer): fill exclusive testnet deposits automatically"`. Body: what and why, gates with outcomes,
   the integration runtime, `Delivers ask4`, and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
   Then `gh pr checks <n> --watch` once, bounded.
3. **Close-out** (the PR's final commits, after merging `origin/main` and reading what changed in the index and
   `lessons.md`): the `## Outcome` block after the front matter (date, status, PR, `Known limits:`, `Open items:`, a
   line retiring the seeds); promote "Across's testnet settles no fill and refunds no deposit: a missed testnet deposit
   stays in the source pool" to `lessons.md`; delete `follow-ups.md`'s "Testnet fills are manual" and "Observe an
   expired testnet deposit's refund"; file the three known limits as closed `known-limit` issues; `git mv` the folder
   to `implementations-plan/archive/relayer-1` in its own commit, add one line to `archive/index.md`, delete
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

Single arc. **a1** = Phases 1–5 plus the close-out: one PR from `worktree-relayer-1` (it holds the plan commit) to
`main`; `code_review: off`. No stack and no lanes: the phases share files and run in order.

## Seeds

```
/goal All five phases of implementations-plan/relayer-1/plan.md are marked ✓, each backed by its validation gate reported passing in the transcript, with LESSONS_FILE=implementations-plan/relayer-1/lessons/phase-N.md printed per phase; the Codex fix loop (gpt-6.1-sol, high) converged on the net diff, shown by a resumed pass with no new material finding; the PR to main exists (gh pr view output) with Delivers ask4 and the close-out's archive-move commit (git show --stat); bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/relayer-1 from its plan.md and lessons/, judged against the Outcome & Quality Bar. If the plan path is gone, run `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/relayer-1/plan.md`: merged → `agent-worktree done relayer-1 --merged`, report, stop; not merged → babysit the PR's checks only. Otherwise take the next unticked step, run the fast gates after each edit, commit, and tick a phase only when its gate passes. Decide with Codex (gpt-6.1-sol, high); never merge, deploy or run a keyed step. Five failures on one step: reassess with Codex.
```

`/goal` is recommended: completion shows in the transcript. Use exactly one per session.
