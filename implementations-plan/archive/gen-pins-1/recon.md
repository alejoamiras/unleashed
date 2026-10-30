# gen-pins-1 recon

Base: `main` at `a111e8a`. Two read-only Explore agents (Sonnet) plus the planner's own reads and live read-only probes.
Paths are repo-relative.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Masked runtime pin of a build, deployed-code hash | `packages/sdk/src/protocol/code-hash.ts` (`CodePin`, `pinOfBuild`, `deployedHash`, `PinnedContract`) | reuse-as-is |
| Pin of a forge artifact | `packages/sdk/scripts/code-pins.ts` `buildPin(contract, out)` (takes an `out` dir already) | reuse-as-is |
| HEAD pins (what the sources at HEAD build) | `packages/sdk/src/protocol/code-pins.json`, held to the forge build by `packages/sdk/scripts/code-pins.test.ts` (skips without `out/`; CI's contracts job guards the skip with `test -f`) | reuse-as-is, renamed in prose only ("HEAD pins") |
| SDK code check of a network | `packages/sdk/src/execution/trust-roots.ts` `codeBindings` (reads `CODE_PINS`), called by `networkBindings` from `network.ts` `assertChainRoots` | adapt: pins come from the record the chain selects |
| Hub artifact load | `packages/sdk/src/protocol/artifacts.ts` (static import of `contracts/bridge/aztec/token_bridge_hub/target/*.json`); users: `manifest-v2.ts` `deriveManifestHub` (dynamic import), `execution/hub-l2.ts` `hubAt` + `hubTokenOfSlot`, `bridge/index.ts`, app `bridge-generation.ts` `HUB_ARTIFACT` (registered with the wallet in `useWalletConnection.ts:122`), `apps/tools/scripts/verify-deployments.ts`, bridge-core `generation.ts`, `script-l2.ts` | adapt: the live generation's kept artifact on live chains, the HEAD target on sandbox chains |
| Per-network committed trust record selected by chain | `packages/sdk/src/protocol/private-fpc-canonical*.json`, read by `aztec-line.ts` `aztecLineOf(l1ChainId)` | pattern to follow (static JSON import, chain-selected) |
| Strict JSON schema style | `manifest-v2.ts` (zod `.strict()`, `evmHexAddress`, `bytes32`), `deepFreeze` in `protocol/freeze.ts`; bridge-core `deploy-manifest.ts` | reuse the style |
| ABI-shape comparison against a forge artifact | `packages/sdk/src/protocol/deposit-router-abi.test.ts`, `factory-abi.test.ts` (shape helpers, read `contracts/bridge/evm/out`) | adapt: extract the shape helper, run it against kept artifacts too |
| Live code check at promotion | `packages/bridge-core/scripts/verify-l1.ts` `checkCodeHash` + `sameBuild` (fresh forge build vs deployed vs `CODE_PINS`) | adapt: compare against the record the manifest binds |
| Candidate → live promotion | `packages/bridge-core/scripts/live-intent.ts`: `NETWORKS` (candidate/live paths), `OPERATIONAL_ALLOWLIST`, `verify --candidate` (records `candidateSha256`), `promote` (`readPromotionBytes`, `writeAtomic`, `writeReceipt`) | adapt: a record pair beside the manifest pair |
| Writing a record from deployed artifacts | none. Searched `generation-record`, `record.json`, `deployedArtifact`, `frozen`, `generations/` across `packages/`, `apps/`, `contracts/`, `scripts/`. The conductor journals `{tokenClassId, hubClassId}` (`deploy-manifest.ts:58`) but writes no artifact copy | build new: one script |
| Hub class id pin at HEAD | `packages/bridge-core/src/noir-artifact-classids.test.ts`, `contracts/bridge/aztec/scripts/compile.sh --check` | keep as HEAD checks; the record adds the deployed class beside them |

## Facts verified (read-only)

- Live testnet code equals the committed pins: `deployedHash(getCode(a), CODE_PINS[c]) === pin.hash` for `DepositRouter 0x6e55…035b`, `PortalFactory 0x2509…7817`, `TokenPortalImpl 0x4346…9f1e`, `TestnetFuelSwapper 0x2b22…86ab` on PublicNode Sepolia. Raw `getCode` keccak is identical on PublicNode and the Tenderly public gateway for all four.
- The HEAD hub artifact derives the manifest's hub `0x1d50…7530`; its class `0x2132…2abe` equals `currentContractClassId` and `originalContractClassId` that the keyless testnet node returns for that instance (`node_getContract`).
- The committed hub target's sha256 `d7e3be3c…328a` equals `artifacts.noirTargets` in the archived 6.0.0 intent (`archive/aztec-6-stable/lessons/intent.json`): the file in the tree is byte-for-byte the artifact the live hub was deployed from.
- Promotion provenance: the factory, implementation and hub entered the live manifest in `4d53adc` (#26); the router and swapper in `0b9be3f` (#9). Last source edits: `DepositRouter.sol`/`TestnetFuelSwapper.sol` `fbf46bf`, `PortalFactory.sol`/`TokenPortalImpl.sol` `ccbc82b`, `FuelOnlyGate.sol` `6acc489`.
- Mainnet has no deployed bridge contract: `mainnet-bridge.json` has `bridge: null` and no `fuelRoute`, so `parseNetwork` refuses it before any code check.
- The sandbox, the e2e app (`vite.local.config.mts` + the run's `manifest.json`) and bridge-core's integration suite deploy the HEAD forge build and the committed hub target, then pass through `parseNetwork` on chain 31337. No code-pin exemption for sandbox chains exists (`SANDBOX_LIFI_CHAIN_IDS` only swaps the LI.FI stand-in).
- No CI job compares the live testnet manifest to the chain: `network.live.test.ts` is opt-in (`TESTNET_LIVE`), `verify:deployments` is offline, `verify-l1` is manual.
- The SDK and app call the hub functions their wallet grants list (`packages/sdk/src/capabilities.ts:26-27`: `register_token`, `register_and_claim_public`, `claim_public`, `claim_private`, `token_for`; `apps/tools/src/lib/capabilities.ts:124-140` adds `exit_to_l1_public`, `exit_to_l1_private`, `portal_for`, `exits_paused`), and read `storageLayout.token_of` (`hub-l2.ts:32`), whose value packing `hubBindingAt` assumes (`hub-l2.ts:42-45`). Private functions run client-side from the artifact, so the PXE needs the deployed class's artifact, not only its id.
- The sandbox integration job takes about 43 minutes against a 45-minute timeout (run 40904336010).
- Forge artifacts carry `rawMetadata`/`metadata` (about 90 KB each, compiler input with remappings); `abi`, `bytecode`, `deployedBytecode` are about 50 KB per contract.

## Collisions and open work

- No open issue covers this. Closed known limits searched (`pins`, `generation`, `class id`, `bytecode`): none collide; #31 (a promoted mainnet fuel route cannot be replaced through live-intent) stays as is.
- `implementations-plan/follow-ups.md` "Pin mainnet's guardian in the SDK" is adjacent: a record that binds addresses refuses a genuine-code generation someone else deployed. Not claimed as closed here.
- route-auth-1 (parallel lane, no PR yet) changes `parseNetwork` to accept only the bundled manifest on live chains, sandbox exempt. This plan builds on that behaviour and implements after it merges.
- portal-ingress-1 holds an EVM portal source change that needs this lane first.
- Seven SDK test files mock `CODE_PINS` with `syntheticPins` (`test/fakes.ts`); they move to the record seam.
