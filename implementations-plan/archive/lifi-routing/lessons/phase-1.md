# Phase 1: `DepositRouter` + `TestnetFuelSwapper`, hermetic and symbolic

**Verdict: done, no twins.** I6 holds: the destination half of `lifinance/contracts` compiles unmodified under
the `lifi` profile. Three agents ran in parallel. Each used its own forge `out`, cache and failure-persist
directories, and none edited a production source.

## Facts the next phases rely on

- **The LI.FI pin.**
  - Commit `65bae143b249a5fba3dd27d506e9e1d6d8538899`: the newest commit on `main` that clears the 7-day gate.
  - Versions at that commit: Executor 2.1.0, ERC20Proxy 1.2.0, ReceiverAcrossV4 1.0.0, ReceiverStargateV2 1.1.0.
  - Executor's and ReceiverAcrossV4's runtime sizes match mainnet.
  - Installed as `lifi-contracts=lifinance/contracts@rev=…`. Its nested libs (solady, OZ, Permit2) come at LI.FI's
    own pins.
  - The profile builds one entry file, `lifi-build/LifiArtifacts.sol`, into `out-lifi/` with solc 0.8.29, cancun,
    no IR and 1,000,000 optimizer runs.
- **`auto_detect_remappings = false` in the default profile is load-bearing.** Without it the new lib's `test/`,
  `ds-test/` and `lifi/` remaps leak into the default build. The profile directory also cannot be named `lifi/`:
  Foundry then resolves `lifi/...` imports as project paths.
- **Our own OpenZeppelin pin ships `CLAUDE.md` and `.claude/`.** The lib cleanup (README, CI) deletes agent files
  and `.env*` across all of `lib/`, not only LI.FI's tree.
- **Forge writes fuzz/invariant failure files and `cache/test-failures` into the project's `cache/` even when
  `FOUNDRY_CACHE_PATH` points elsewhere.** Parallel runs also need `FOUNDRY_FUZZ_FAILURE_PERSIST_DIR`,
  `FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR` and `FOUNDRY_TEST_FAILURES_FILE`.
- **Proof-name collision.** `check_sweep_revertsForNonOwner` exists in both `FormalRouterTest` and
  `FormalDepositRouterTest`. CI's proof list now counts occurrences, so a rename in either contract still fails the
  check.
- **Canary hooks.** `_requireDepositsOpen`, `_requirePinnedSwap`, `_tokenPortal` and `_revokeApproval` are
  `internal virtual` only so the mutants can delete each guard. Each mutant breaks its proof (forge canary) and its
  invariant (a temporary swapped-in run). Internal virtual dispatch is static, so it costs nothing at runtime.
- **The stray split's boundary.** Returned input is attributed to the target's prior balance first, so a 2-wei
  donation to the Diamond can never grief a Permit2 deposit into `InexactFuelConsumption`.
  - The price: a venue that returns only its own leftover *while* holding a prior balance gets that leftover booked
    as residue. On Permit2 this means no revert; on the caller path the token leg is short by
    `min(stray, leftover)`. Either way the residue stays sweepable.
  - Neither production target behaves that way: LI.FI's facet returns its whole balance, and the swapper returns
    nothing.
  - Two tests pin the behaviour, and the `bridgeWithPermit` natspec states it.
- **The witness vector the TS side pins in Phase 3.** Inputs are the `VECTOR_*` constants in
  `DepositWitness.t.sol`.
  - `hashWitness = 0xcda2e450d719bcba586bd091421030f02d669556fb96588ed276ce120b2c5d12`.
  - Typehash `0x106905f54299d4971393cc302e6e9a86a81a2925c8fb4d2a00597a2551eb5745`.
  - Both were checked with `cast` and `vm.eip712HashStruct`.
- **Gas.**

  | Call | Gas |
  |---|---|
  | `bridgeWithPermit`, first time (portal created inside) | 652,346 |
  | `bridgeWithPermit`, known portal | 234,782 |
  | `bridgeFromCaller` with fuel (mocks, known portal) | 405,177 |
  | Same call on a mainnet fork: real Diamond, a nordstern route, private token leg, fuel to the PrivateFPC | 662,570 |

  The fork figure is already above the 692k that a 900k `toContractGasLimit` allows at the 1.3× margin, so Phase 2
  sets the constant from the measured worst shape.
- **Pre-existing drift.** `SwapBridgeRouterTest:test_gas_bridge_firstTime` measures 656,690 against 655,910
  committed (+0.12 %, inside the 2 % tolerance). This is unrelated to the remapping change; the committed line is
  kept.

## Deviations from the plan

- `src/mocks/TestSpokePool.sol` and `src/mocks/SourceAcrossStub.sol` were tagged `[1]` in the change map. Only the
  sandbox uses them, so they move to Phase 5 with it; the map is corrected to `[2]`.
- The new suites import the Uniswap-free fakes (`MockPermit2`, `MockFeeJuicePortal`, `MockTokenPortal`,
  `FakePortalFactory`) from `test/mocks/RouterMocks.sol`, which also imports `SwapBridgeRouter`. Arc 5 must move
  those fakes out before it deletes the old router. The change map's arc-5 line now says so.

## Attempts

1. The contracts compiled first time. A mainnet-fork smoke test (Phase 2 groundwork, real Diamond + recorded quote)
   delivered 578.43 AZTEC against the quote's 578.43 to the real FeeJuicePortal.
2. The three agents' suites passed on their first full integration run: 242/242 hermetic, 23/23 halmos.
