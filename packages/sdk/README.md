# @unleashed/sdk

The bridge's protocol and flows, framework-agnostic TypeScript over `viem` (Ethereum) and `aztec.js` (Aztec). It needs
no server of ours. The app (`apps/tools`) and `@unleashed/bridge-core` build on it; the integrator's interface and the
publish setup land on top of this layout.

## Entries

| Entry | What | Published |
|---|---|---|
| `@unleashed/sdk` | `parseNetwork` and its trust roots, `Network`, transfer records and events, `BridgeError`. | yes |
| `@unleashed/sdk/fuel` | `probeFuel`, `quoteFuel`, `depositFuel`: gas-only deposits. Never loads the hub artifact. | yes |
| `@unleashed/sdk/bridge` | `resolveToken`, `quoteBridge`, `depositToken`, `hubArtifact()`: token deposits. Loads the hub artifact. | yes |
| `@unleashed/sdk/protocol` | The pure layer: ABIs, derivations, the manifest, gas math, the LI.FI client and book, fee methods, code pins. | yes |
| `@unleashed/sdk/networks` | The bundled testnet and mainnet manifests. | yes |
| `@unleashed/sdk/artifacts` | The hub's Noir artifact, loaded eagerly. | workspace only |
| `@unleashed/sdk/private-fpc-artifact` | The PrivateFPC artifact, for a dynamic `import()` only. | workspace only |
| `@unleashed/sdk/l1` | The viem-only slice of `./protocol` (the router ABI, the LI.FI ABIs, book and gas constants): esbuild resolves every member of a barrel, so a Worker bundles this one instead. | workspace only |
| `@unleashed/sdk/internal` | The orchestration (`execution/`): the L1 send, receipt leaves, arrival gates, claims, recovery. | workspace only |

Source imports use `.ts` specifiers, so every consumer's tsconfig sets `allowImportingTsExtensions`. `src/` imports no
`node:` built-in and declares every package it imports (`imports.test.ts`), and `.` and `./fuel` never reach the hub
artifact statically (the same test).

## File map

### `src/protocol/`

| File | Purpose |
|---|---|
| `manifest-v2.ts` / `aztec-line.ts` | STRICT zod schema for the generation manifest (`schema: 2`; `bridge: null` = a placeholder network). Every derivable address (portal, hub, L2 token) is re-derived on parse; a manifest that disagrees with itself is rejected. The additive deposit-router fields (`depositRouter`, `fuelSwapper`, `fuel`, `legacyRouters`, `routing`) are refined against each other and the network. `aztec-line.ts` keys each L1 chain to its line's PrivateFPC descriptor and refuses a send to a line this client does not run. |
| `hub-token.ts` / `portal-address.ts` | The L2 token the hub derives for an ERC-20 (aztec-standards `Token`, `deployer = hub`, `salt = erc20`) and the portal clone the factory derives (`Clones.cloneDeterministicWithImmutableArgs`, salt = token). Both pinned against the on-chain derivations. |
| `register-hash.ts` / `claim-secret.ts` / `content-hash.ts` | The three-toolchain keystones (Solidity ↔ Noir ↔ TS): the factory's `register` message, the recipient-committed private-claim secret, the deposit/withdraw content hashes. |
| `factory-abi.ts` / `deposit-router-abi.ts` / `legacy-router-abi.ts` / `erc20.ts` | Hand-written browser ABIs pinned against the forge artifacts (the retired router's frozen); gas-capped ERC-20 metadata reads decoded from the factory's own bytes. |
| `l1.ts` | Permit2 `DepositWitness` typed-data and the hash `DepositRouter.hashWitness` checks (it commits to `keccak256(swapData)`), pinned to the Solidity vector in `l1.test.ts`. |
| `lifi-addresses.ts` / `lifi-abi.ts` / `lifi-gas.ts` | The third-party contracts a LI.FI route touches per chain, with their runtime code hashes; the LI.FI swap and bridge ABIs and facet selectors; the fork-pinned gas budgets, `LIFI_INTEGRATOR` and the venue allow-list. Viem only, so a Worker can bundle them through `@unleashed/sdk/l1`. |
| `lifi-api.ts` / `capped-fetch.ts` | The keyless li.quest client (quotes and `/v1/status`, schema-parsed and held to the request it answers) over one bounded fetch (no redirects, a streaming byte cap, one deadline, typed refusals, never throws). |
| `gas-share.ts` | The integer gas-share math (`fjPerTx` × target [+ `fjRegister`], the signed floor, the 50 % cap). |
| `fee-juice.ts` / `fuel.ts` / `private-fuel.ts` / `private-fpc-artifact.ts` | Fee-juice payment methods, the direct `FeeJuicePortal` lane, the Wonderland PrivateFPC (pinned address + salt policy; artifact via dynamic import only). |
| `wallet-chain-id.ts` / `artifacts.ts` | `walletChainIdOf` (`(l1 ^ rollupVersion) >>> 0`); the hub artifact (its own entry, `@unleashed/sdk/artifacts`). |

### `src/execution/` and the root

| File | Purpose |
|---|---|
| `send-generation.ts` / `send-flow.ts` / `legacy-router.ts` | What a send binds to (read off a manifest) and the L1 leg for every intent — token, token+gas, gas-only — through the deposit router: `runSend` signs the `DepositWitness` (it commits to the fuel quote's `swapData`), sends `bridgeWithPermit`, and `readSendReceiptLeaves` reads the leaves through `readRouterDeposit` (`router-receipt.ts`), the one `Deposited` parser. `legacy-router.ts` reads the retired `SwapBridgeRouter`'s receipts for records still in flight, through its frozen calls and events in `legacy-router-abi.ts`; nothing sends through it. The portal is never taken from a caller. |
| `hub-l2.ts` | The L2 leg: `claimViaHub` (register-if-first, decided at claim time by `token_for`, race-tolerant), `exitViaHub` / `preflightHubExit` / `hubExitsPaused` (fail-closed) for L2→L1. |
| `factory-registry.ts` | The factory's frozen registration and the hub's registration view, read together. |
| `fuel-quote.ts` | The router's fuel leg: LI.FI's same-chain quote on mainnet (allow-listed venues only) or `TestnetFuelSwapper`'s fixed rate elsewhere, with the signed floor written into the swap's own minimum; `manifestFuelProvider` picks the one a manifest names. |
| `flows.ts` / `l1-receipt.ts` / `l1-to-l2-readiness.ts` / `chain-scan.ts` | `consumeWithdrawal` + `isOutboxMessageConsumed` for exits and the `L1Ctx` every flow takes; the resilient receipt wait; when an L1→L2 message is consumable; budgeted, reorg-checked scans that report "incomplete", never absence. |
| `router-receipt.ts` | `readRouterDeposit`: the router's own `Deposited` in a mined transaction, each leg authenticated by its portal's event and the Inbox leaf recomputed from the intent. |
| `records.ts` (root) | The protocol facts of a transfer record (`JournalTokenBlock`). |

## Scripts

| Script | What |
|---|---|
| `bun run test` | vitest: pure functions and mocked-chain orchestrations. The sandbox integration suite that drives these flows lives in `@unleashed/bridge-core` (`test:integration`). |
| `bun run typecheck` | `tsc --noEmit` over `src/`. |
| `bun run stage` | Builds `dist/` from the published entries only: what they reach is emitted, the JSON assets they import are copied with their digests checked, and the published `package.json` is derived (peers exact at the Aztec pins, `viem` a caret range). |
| `bun run pack:check` | Stages, packs, and installs the tarball into `test/consumer/` (frozen lockfile, install scripts off, nothing resolvable from the repo); typechecks it under `NodeNext` and `Bundler` and imports every entry in Node and Bun. After an Aztec bump, update the fixture's pins and run `bun scripts/pack-check.ts --relock`: a relock re-checks the 7-day gate, so a version younger than that needs a local, uncommitted exclude. |
| `bun scripts/code-pins.ts` | Rewrites `src/protocol/code-pins.json` from the forge build after a pinned contract changes; `scripts/code-pins.test.ts` fails until it is rerun. |

## Key invariants

- **Leaf indices from the mined events, never a preflight simulate** (`send-flow.ts`). A concurrent deposit changes a simulated index, so the claim would retry against the wrong leaf forever. `readSendReceiptLeaves` takes them from the router's own `Deposited` for this send's secret hashes — filtered by emitter, each leg matched to its portal's event and to the Inbox leaf recomputed from the send's own facts, so a look-alike event from another contract in the same receipt cannot forge them.
- **The portal is derived, never supplied.** The deposit router derives the token's factory clone itself and a first send creates it inside the same transaction; the client derives the same address only to authenticate the receipt.
- **A claim is decided at claim time** (`hub-l2.ts`): `token_for == 0` ⇒ this claim also registers (one tx for public; `register_token` first for private). If another claimant registers in between, the registration path fails on the consumed register leaf and the claim is retried as a plain one — a deposit is never stranded on a race.
- **A private first claim's two transactions pay from the same bridged Fee Juice, and nothing is ever sponsored** (`hub-l2.ts` seams `registerFee` / `registeredClaimFee`): the registration spends the fuel message (`PrivateFPC.mint_and_pay_fee`, sized with `PRIVATE_HUB_REGISTER_GAS`), which leaves `amount − max_gas_cost` as the claimer's private credit at the FPC, and the claim that follows pays from that credit (`pay_fee`, sized with `PRIVATE_HUB_CLAIM_GAS`). The FPC keeps each transaction's committed ceiling, not its charge, so a first-time private bridge must carry both ceilings. The claim is sent only once its own simulation passes in the claimer's wallet: the registration's binding lands on the node first, and `claim_private` reads it at the wallet's synced block, which lags (`registrationWait`, 5 s polls, 3-minute deadline; `onRegistered` hands the caller the registration's hash as soon as it exists).
- **The Permit2 witness is cross-pinned.** `l1.ts`'s `DepositWitness` member list + `DEPOSIT_WITNESS_TYPE` must stay byte-identical to `DepositRouter.hashWitness`. `l1.test.ts` pins the hashes; the evm fork test proves a post-signature tamper reverts.
- **Gas-share math is integer-only with two exact ceilings** (`gas-share.ts`): the slice sized from `fjPerTx` and the floor signed from it never lose a base unit to a folded division — a property test pins it.
- **Token behaviours are bounded on chain, not trusted off chain.** The clone refuses fee-on-transfer (exact-in), `amount > uint128.max`, and protects the reserve on withdraw with an exact portal-debit; a token no fuel venue prices is refused before signing (`fuel-quote.ts`); rebasing tokens are unsupported and surfaced as a caution, never detected.
