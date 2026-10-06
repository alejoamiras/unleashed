# Phase 7: Plumbing and the Ethereum-origin switch

**Verdict: built; the gate results are in the Gate section below.** The Ethereum-origin send now goes through
`depositRouter`/`bridgeWithPermit`. S-12 and S-13 carry G-UX-1's strings, and S-14 already did. The cross-chain
plumbing (source registry, per-chain read clients, CSP, route quotes, the deposit flow, the journal on both keys,
watchers and outcomes) is built and unit-tested, and no screen reads it yet.

## Facts the next phases rely on

- **The live testnet manifest has no `depositRouter` until promotion.** `SEND_GENERATION` is undefined on it, so
  the app cannot send on testnet until Phase 6's manifest lands. `build:testnet` and `verify:build-target` still
  pass. `FUEL` falls back to the V4 `swap` block's budgets for a generation without `l1.fuel`.
- **Ethereum-origin gas.**
  - The review probes the manifest's venue at one whole unit (`useFuelQuote`).
  - `sliceSwapData` quotes the exact slice again right before the signature. It refuses (`GAS_QUOTE_MOVED`) when
    the venue now quotes under the floor the user reviewed, and otherwise signs that reviewed floor.
  - The testnet route row names the venue "the testnet fuel swapper": the swapper has no tool name for G-UX-1's
    parentheses.
- **`deposit-reconcile.ts` searches the deposit router and every legacy router.** A candidate verified on two
  routers is ambiguous and refused.
- **Read clients.**
  - `readClientFor(chainId)` builds one viem client per chain over the target's pinned keyless RPCs (fallback,
    20 s timeout, one retry) and never falls back to the wallet's transport.
  - The testnet CSP admits exactly those origins plus `testnet.across.to`. Mainnet stays `'self' data: blob:`.
  - `verify:build-target` now compares the built `_headers` with the target.
  - viem appends `/` to an RPC URL when it fetches it, so a fetch stub must normalize it.
- **Local target.** Its read RPCs are the handle's two anvils, and its Across API is the `relay-api.json` that
  `sandbox:up` writes. The sandbox source chain joins the source catalogue on the local build only.
- **Cross-chain route** (`useCrossChainRoute`, on the debounce and latest-wins core that `useFuelQuote` uses, with
  a 60 s TTL):
  - A draft built at the input amount sizes the message that `/suggested-fees` prices.
  - The gas slice is sized from Across's output and quoted again at that exact slice.
  - `minReceived = maxPull = outputAmount`, and `verifyRoute` runs on our own bytes before the route is offered.
  - A venue that returns the swap for another slice is refused by the decoder at
    `fuelSwap._swapData.fromAmount`: the composable's decoder-refusal test.
- **The core builds the route's bytes** (`crosschain-route.ts`: intent, `bridgeFromCaller`, the Across message
  and transaction). The canary delegates to it. The sandbox's `flows-crosschain.ts` keeps its own copy.
- **Journal.**
  - `records` stays Ethereum-origin, because every screen lists it. Schema-4 records live in `crossChainRecords`.
  - The engine's lookups (`engineRecords`, `currentRecord`) span both keys. `runsAsSend` admits schema 4 into the
    send lanes.
  - A schema-3 *view* of a schema-4 record was rejected: `CLAIM_SNAPSHOT_FIELDS` includes `schema`, so a
    completion guarded on a view never matches the stored record.
  - `claimTarget` leaves a cross-chain record to its watcher until the deposit lands, and for good once it has an
    outcome.
- **v3 → v2.** With the key in memory, the watcher re-seals a deposited private record exact. After a reload, the
  claim's unseal opens the v3 envelope with one signature, checks the deposited amount against the window and
  re-seals exact. A deposit outside the window is refused.
- **Watcher.**
  - Each round re-runs discovery and merges its patch into the freshly loaded record.
  - A deposit hands the record to the claim lanes; this session claims only what it sent. The watch then stops,
    so a deposit reorged out afterwards surfaces as a claim that never becomes ready.
  - An outcome is watched until its deciding block is final.
  - Twenty thrown rounds in a row flag the record. An `incomplete` round is retried without limit.
  - Journal setup resumes every undecided record.
- **App tests that hash secrets run in the node environment.** Under jsdom, `computeSecretHash` throws
  `BBApiException: std::bad_cast`.

## Open

- **Phase 8, owner gates** (copy built here that no board draws yet):
  - Already visible: `GAS_QUOTE_MOVED`, and the swapper venue text.
  - Shown only by Phase 8 surfaces: `ROUTE_EXPIRED`, `ROUTE_REFUSED`, the source-chain and account mismatch
    lines, `OUTSIDE_SEALED_WINDOW`, and the watcher's failure note.
- **Phase 8, surfaces and wiring:**
  - Render `crossChainRecords`.
  - Bind `useCrossChainRoute` to the wizard's `useGasShare` (`SliceSizer`).
  - `useSourceChain`, the wallet's switch to the source chain, and source balances.
  - Backups that carry both keys: export and import still open Ethereum-origin files only.
  - "Continue from Ethereum" after a delivery to the wallet.
- **Phase 9:**
  - `verifyRoute` and `acrossDepositFor` read `LIFI_BOOK` only, which knows no sandbox chain. The browser suite
    needs a book injection path for the handle's LI.FI addresses before it can verify a sandbox route.
  - The `l1-wallet` fixture needs a chain map, `wallet_switchEthereumChain` and the EIP-5792 calls
    (`wallet_getCapabilities`, `wallet_sendCalls`, `wallet_getCallsStatus`).
- **Not built:** the Stargate rail (`useCrossChainRoute` answers `unavailable`), and mainnet's li.quest route path.
- `recoverDepositLeg` still refuses a schema-4 record. Discovery writes the leaf and the deposit hash together,
  so no cross-chain record reaches it.

## Attempts

1. The fixture manifest was regenerated from a fresh sandbox. The diff only adds `depositRouter`, `fuelSwapper`
   and `fuel`.
2. `contracts/bridge/evm/lib` came from a sibling worktree's install, not `forge install --no-git`. Halmos is not
   installed on this host.
3. The first browser run stopped at `verify:build-target` for the local target. The runner built with
   `UNLEASHED_TOOLS_WEB_WALLETS` but verified without it, so the built `connect-src` carried wallet origins the
   check did not expect. The verify step now gets the same wallets.
4. The second run failed cells 21p and 21 (WETH). The sandbox's fuel swapper rates only the manifest's fee assets,
   and before the deposit router a mock venue sold anything at one rate. The WETH cells now set their own rate,
   one at which a base unit buys what a 6-decimal token's base unit does.

## Gate

- `contracts/` is untouched by this phase. G0's forge chain still ran: remappings, `forge build`, the `lifi`
  build, 247 hermetic tests, the gas snapshot check and the AST build all exit 0. Halmos was not run (not
  installed).
- `bun run lint && bun run typecheck:all && bun run test:all`: exit 0. design 242, bridge-core 680 passed and 11
  env-gated skips (the ABI pin suites ran), tools 1672.
- `bun run audit:tools`: exit 0 (`verify:deployments` matches, the build succeeds).
- `build:testnet && verify:build-target`: exit 0. The built `connect-src` lists the node, the token list, the
  two Base Sepolia RPCs, the Sepolia RPC and `testnet.across.to`. The live manifest still lacks the deposit
  router, and the build does not need it.
- `bun test scripts/ci-cd/`: 31 pass.
- `bun run e2e:tools`: 68 passed, 2 failed (the WETH cells, attempt 4). After the fix,
  `bun run e2e:tools -- specs/deposit-gas-only.spec.ts`: 8 passed.

## Integration onto arc 3

- The branch was built on an early arc 3 commit. Its 18 commits were cherry-picked onto the converged arc 3 tip
  without a conflict; four files overlap (`lifi-canary-build.ts`, `lifi-canary-fixture.ts`, `lifi-canary-run.ts`,
  `crosschain-discovery.ts`), and the gate below is the proof the merge is sound, not git's clean apply.
- The bridge-core unit count falls from 706 to 696 by design: this phase deletes the old router's `flows.test.ts`
  and `swap.test.ts` and rewrites `send-flow.test.ts`.
- Gate on the integrated branch: G0 (forge, snapshot, halmos 23/23, lint, typecheck, `test:all`: design 242,
  bridge-core 696 + 11 skipped, tools 1672), `audit:tools`, `build:testnet` + `verify:build-target`, and
  `e2e:tools` 70 passed, all exit 0.

