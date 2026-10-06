# Phase 5: Operator tooling, sandbox, integration through the claim

**Verdict: done.** The sandbox runs the whole testnet rail end to end, through LI.FI's compiled destination half
and our router, to an L2 claim paid by the bridged fuel. The router-only conductor, the verifier and the intent
tooling are ready for Phase 6, and the canary is written. Three agents built it in parallel: the sandbox and its
integration cells, the operator tooling, and the canary. The parent unified the `Deposited` parser and ran the gate.

## Facts the next phases rely on

- **Sandbox shape.**
  - L1 is anvil 31337 with the Aztec local network. A second anvil (chain 31338) is the source chain. It has its
    own registry ports (the sandbox now claims five), its own process group and a real-disk data dir, and it is
    reaped with the run.
  - `TestSpokePool` serves both sides with the deployed event and `fillRelay` shapes. A fill happens once per relay
    hash and respects `fillDeadline`. A reverting message handler reverts the whole fill, as ReceiverAcrossV4
    relies on.
  - `SourceAcrossStub` is ABI-identical to the Diamond's `startBridgeTokensViaAcrossV4`, so the bytes
    `across-v4.ts` builds run unchanged against it.
  - `DepositRouter` and `TestnetFuelSwapper` deploy beside the old router. LI.FI's Executor, ERC20Proxy and
    ReceiverAcrossV4 come from `out-lifi/` at CREATE2 addresses. `sandbox:up` also writes `relay-api.json`, the
    relay loop's loopback `/suggested-fees`.
  - The relay loop has four modes: now, delay, never and starve-gas.
- **The sandbox manifest has no `routing` block.** `enabledSources` refuses chain 31338, and neither the
  production catalogue nor `LIFI_BOOK` may learn a sandbox chain. Arc 4's browser suite needs an injection path
  that keeps both untouched.
- **A private token leg sends its fuel to the FPC; the router forces it.** "Private token+gas" and "private token
  + private fuel" are therefore one shape. The fourth integration cell is private fuel-only instead.
- **The Fee Juice L1 sender on the 6.0.0-rc.1 line is the protocol constant, not the portal.** The sandbox's
  discovery context names `FEE_JUICE_ADDRESS` as the Inbox's recorded sender, and every fueled cell's leaf
  authenticates against it. The live testnet confirms it in Phase 6; the older mainnet line stays unverified.
- **Router-only conductor** (`generation-router.ts`, `deploy-generation.ts deploy --router-only --rates …`).
  - The journal gains `fuel-swapper-deployed` and `deposit-router-deployed`, each with its creation-code hash and
    constructor arguments. A landed contract is adopted only when both match; otherwise the conductor deploys and
    appends. Old kinds still parse, the committed testnet journal included.
  - The swapper's owner is the guardian (the pinned signer). The operator supplies the rates.
  - `DeployGeneration.s.sol` is not a live path: nothing calls `_deployGeneration`, and `DeployFuelLive.s.sol` uses
    only `_resolveFactory`. It was left unchanged.
- **`verify-l1`.**
  - It checks the router's immutables and owner, the swapper, and the LI.FI book on every routing source.
  - `DEPOSIT_WITNESS_TYPE_STRING` is compared exactly: an EIP-712 type string is case-sensitive.
  - The strict rebuild runs in a fresh temp dir with its own `out` and `cache`, so it never pulls artifacts from
    under a running sandbox.
  - On chain 31337 only, the legacy swap target is `MockSwapTarget`, checked by its payout asset.
- **`live-intent.ts`.** `PLAN_PINNED_CANARY_SIGNERS` is `null` on both networks, so a canary-signed run refuses
  until Phase 6 pins the address. `CANARY_CAPS` is keyed by chain id. Router-only scope is enforced on the intent
  and on the journal.
- **The canary.**
  - Every live run first replays the whole matrix as a dry run, so every refusal fires before the first send.
  - Cross-chain rows are built twice: draft, quote, then rebuild at Across's `outputAmount`.
  - With no Across quote for the message, the canary builds its own terms (25 % fee, 7,200 s window) and
    self-fills.
  - Ethereum-origin rows read their deposit through `readRouterDeposit`, discovery's parser.
  - Judgement calls to revisit at Phase 6: amounts of 6, 2 and 3 USDC; a 5-minute organic window;
    `recoveryFloor` = 2 × quote; gas reserves of 0.005 ETH (Base Sepolia) and 0.03 ETH (Sepolia) per row.
- **`readRouterDeposit`** (`crosschain-discovery.ts`) is the one `Deposited` parser. It authenticates each leg by
  its portal's event and the recomputed Inbox leaf. Discovery's delivery path and the canary's Ethereum-origin rows
  share it; arc 4's `readSendReceiptLeaves` switches to it.

## Open

- Arc 4: the sandbox `routing` injection (above), and `src/index.ts` exports for whatever the app needs from the
  operator modules.
- The sandbox deploys its rail directly, not through the router-only journal. The rehearsal test drives the
  journal on the same sandbox.
- viem collapses the `fillRelay` struct tuple argument to `never`, so the relayer casts it.

## Attempts

1. **A module the integration global setup loads must use `import z from "zod"`.** The named import fails there
   with "does not provide an export named 'z'", although it works under the unit runner.
2. The canary first carried its own `Deposited` decoder, which checked neither the portal events nor the Inbox
   leaf. Discovery's leg checks were lifted into the exported `readRouterDeposit`, and the canary uses it.
3. The canary first loaded `fill-testnet.ts` dynamically because it did not exist yet. It now imports it
   statically.
4. **`aztec start --local-network` always spawns its own `anvil --port 8545`**, inside its process group, even
   when it is given `--l1-rpc-urls`. In a concurrent run only the first spawn binds. Every later run logs
   `Address already in use (os error 98)` near the top of its aztec log and carries on against the L1 it was
   given. This is noise, not a failure.
5. **The live `verify:l1` ran over the A5 PublicNode Sepolia RPC, not as a keyed run.** `env-exec` refuses a HEAD
   that is not the tip of a pushed branch, and pushing before the arc loops converge would put the stack on
   GitHub early. The check only reads, so it needs no secret.
6. **Gate.**
   - G0: forge build, the `lifi` build, 247 hermetic tests, the gas snapshot, 23 halmos proofs (2 + 11 + 2 + 8),
     lint, `typecheck:all`, `test:all`, `lint:actions` and `test:ci-gating` all exit 0.
   - `test:integration` from two checkouts started at the same moment: 8 files, 47/47 in each. That includes
     the cross-chain cells and the four router-only rehearsal cells: crash-resume, identical re-run adopts, a
     changed router deploys beside, and the candidate passes `verify:l1 --strict`.
   - `sandbox:smoke`: OK in 12.0 min, every (j) cross-chain step ✅.
   - `verify:l1 --config apps/tools/public/testnet-bridge.json` passes on the live manifest (old router). The
     `--strict` run passes on a `sandbox:up` candidate.
   - Operator suites (`verify-l1 live-intent deploy-manifest generation calibration`): 6 files, 39 passed.
   - No anvil or aztec process from these runs remains, and none of their rows is left in `~/.agents/ports.md`.
