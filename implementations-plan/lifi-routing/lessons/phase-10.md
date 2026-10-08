# Phase 10: Uniswap and the old router removed

**Verdict: the code part is built; the keyed A11 promotion and the second schema commit are not.** The contracts,
scripts, core, CI and docs no longer carry Uniswap V4 or the SwapBridgeRouter; the manifest keeps the old router's
fields as optional until the live testnet manifest loses them. The gate results are in the Gate section.

## Facts the next steps rely on

- **The schema is half-way, on purpose.** `bridge.l1.router`, `swapTarget`, `swap` and `tokens[].pools` parse when
  present and are never required. `promote` strict-parses the live manifest, so the fields leave the schema only
  after the live testnet manifest has been promoted without them.
- **The A11 candidate is derived, never edited.** `live-intent.ts build --retire-router` reads the live manifest at
  the build commit (`git show HEAD:apps/tools/public/testnet-bridge.json`), records its digest and the journal's
  length, and writes the one candidate the intent permits: `l1.router` moved to the front of `legacyRouters`,
  `swapTarget`, `swap` and every `tokens[].pools` dropped, every other byte kept. `verify` re-derives it from the
  intent's commit and refuses other bytes, another live manifest, or a journal step appended since build.
- **Proved without keys.** `testnet-bridge.pre-arc5.json` is a byte-identical copy of the live testnet manifest;
  `live-intent.test.ts` runs it through the retire-router arc, and the candidate passes the faucet-shape strict
  parse, the zero-seed interlock and the scope check, with `legacyRoutersOf` unchanged. A dry build of that copy
  produced a candidate that `verify-deployments` accepted.
- **Each arc keeps its intent in its own directory.** The promotion receipt is written as
  `promotion-receipt.json` beside the intent, so the A11 intent lives under `lessons/arc5/`, which `build` now
  creates, and arc 4's receipt stays where it is.
- **A retired router stays reconcilable.** `legacyRoutersOf` reads `router` while a manifest names it and every
  `legacyRouters` entry; `deposit-reconcile.ts` decodes their deposits through `legacy-router-abi.ts`, the old
  router's two deposit calls and events as deployed, with their selectors and topics pinned. The journal readers
  still parse the `swap-target-deployed` and `router-deployed` step kinds.
- **A generation is the factory and the hub.** `deploy-generation deploy` takes `--rates`, pre-creates the seed
  tokens and ends with the router-only arc, so a fresh generation's DepositRouter and swapper come from the same
  path as the live ones. The sandbox ships the `fuel` block only.
- **The DepositRouter's `swapTarget` keeps its name.** It is the LI.FI Diamond or the fuel swapper, never V4, and
  the contract is frozen; its tests, `verify-l1.ts`, the router-only scope and the canaries use the same word.
- **The contract gate shrank.** 161 hermetic forge tests in 20 suites; halmos runs 15 proofs in three contracts
  (`FormalDepositRouterTest` 11, `FormalCloneTest` 2, `FormalFactoryTest` 2). `forge build` passes without
  `lib/v4-core`, which proves nothing imports it.

## Attempts

1. `rg -niE 'a|b'` fails: ripgrep's `-E` is `--encoding`. The scan runs as `rg -ni 'a|b'`.
2. Renaming `inputs.feeJuice` by plain substring also rewrote `inputs.feeJuicePortal`; a word-boundary match fixed it.
3. The regenerated sandbox fixture moved every seed token's address, and `local-target-loader.test.ts` named
   the old USDC. It now reads USDC from the fixture.
4. A dry `live-intent build` into `lessons/arc5/` failed with ENOENT: nothing created the intent's directory.
   `build` now creates it before writing.

## Open

- **The keyed A11 promotion** (`build --retire-router` → `verify --candidate` → `promote --bridge-only`), then the
  second schema commit: the fields and `poolV2Schema` leave `manifest-v2.ts`, `legacyRoutersOf` stops reading
  `router`, the retire-router arc and its tests leave `live-intent.ts`, and the pre-arc5 fixture is deleted.
- **A router-only redeploy forgets the router it replaces** (`follow-ups.md`): `routerOnlyCandidate` overwrites
  `depositRouter` without moving the old one into `legacyRouters`.
- **`lessons.md`'s v4-core `.env` entry stays until close-out.** Checkouts that installed v4-core before this
  phase still hold `lib/v4-core/.env`, which `env-exec request` refuses, and the A11 run may start from one.
- **Resolved in arc 4: three jsdom send smokes failed** (`tests/e2e/send-smoke.test.ts`) once the claim's token
  check moved to the pinned Ethereum reader (D49). The smoke now mocks that reader; see Phase 9's lessons.

## Gate

Run at the branch head with the forge outputs in place, Foundry 1.7.1 and halmos 0.3.3:

- G0, in `contracts/bridge/evm`: the remappings, `forge build` and the `lifi` profile build exit 0;
  `forge test --no-match-contract Fork`: 20 suites, 161 tests passed, 0 failed, 0 skipped; the gas snapshot check
  passed (3 tests); `forge build --ast --force` exit 0; `halmos --match-contract '^Formal'`: FormalCloneTest 2,
  FormalDepositRouterTest 11 and FormalFactoryTest 2 passed, 15 proofs in three summaries. `bun run lint`: Biome
  checked 613 files with no fixes applied (2 infos, both outside this phase's files), complexity baseline OK;
  `typecheck:all` exit 0 for design, bridge-core and tools; `test:all`: design 242 passed, bridge-core 660 passed
  and 11 skipped, tools 1756 passed.
- `bun run lint:actions` exit 0; `bun run test:ci-gating`: 31 pass, 0 fail.
- `bun run audit:tools` exit 0: tools 1756 passed, `verify:deployments` matched every committed address, the
  build completed.
- `bun run --cwd packages/bridge-core test:integration`: 8 files, 47 passed.
- `bun run e2e:tools` from a fresh sandbox: 75 passed in 1.3 h, Playwright exit 0. The egress fixture asserts an
  empty record at every teardown, so a green run is an empty record.
- Every commit of the phase typechecks and lints on its own.
- `rg -ni 'uniswap|v4-core|PoolKey|IV4Quoter|swapTarget|routeHash'` over apps, packages, contracts, `.github`
  and scripts: the live testnet manifest and two frozen fixtures; the optional schema fields; the retire-router
  arc and the router-only scope's pin of the old fields in `live-intent.ts`; the DepositRouter's own swap
  target and its readers; and the Uniswap-format token list.

## Review round 1

Four findings from the foreign review, each verified against the code and accepted.

1. **Medium: a retire-router promote could overwrite a newer live manifest.** The candidate was checked against
   the live manifest at the build commit only; `promote` compared the working-tree live file through
   `assertZeroSeed`, and the allowlist hides it from the drift check. A calibration or promotion landed between
   build and promote would have been lost. Fix: `assertRetireLiveUnmoved` runs in `verify --candidate` and in
   `promote` right before the write, and accepts the live file only at the digest the build recorded or as the
   pinned candidate itself (a re-run after a promote that stopped before its receipt).
2. **Medium: the listed old router went unchecked.** `verify-l1` and the promotion's code check read
   `legacyRouters` alone, while reconcile also reads `l1.router` through `legacyRoutersOf`, so during the
   transition the live old router had no code, factory or owner check. Fix: both read `legacyRoutersOf`.
3. **Low: `deploy` parsed `--routing` after the generation was on chain**, and a dry run never parsed it. Fix:
   it is parsed beside `--rates`, before connecting.
4. **Low: `generationBase`'s doc narrated.** Deleted; the budgets' constraint already sits on `priorFuelBudgets`.

Gate on the fixed head: `bun run lint` checked 613 files with no fixes applied (2 infos outside this phase's
files), complexity baseline OK; `typecheck:all` exit 0 for design, bridge-core and tools; `test:all`: design 242
passed, bridge-core 661 passed and 11 skipped, tools 1756 passed; `bun run lint:actions` exit 0;
`bun run test:ci-gating`: 31 pass, 0 fail.
