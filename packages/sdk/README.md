# @unleashed/sdk

Bridge from Ethereum to Aztec inside your own app, with your user's own wallets: an Ethereum wallet (a viem
`WalletClient`) signs the deposit, an Aztec wallet (`@aztec-labs/aztec.js` `Wallet`) signs the claim. No server of
ours sits in between. Every call is a plain promise, and each transfer reports its progress as typed, ordered events.

| Flow | Calls | Entry |
|---|---|---|
| Gas: the fee asset, or any token the network prices, swapped into Fee Juice and claimed as public Fee Juice or private credit | `probeFuel`, `quoteFuel` → `depositFuel` → `claimFuel` | `@unleashed/sdk/fuel` |
| A token, or a token plus the gas to use it, claimed as a public or a private balance | `resolveToken` → `quoteBridge` → `depositToken` → `claimToken` | `@unleashed/sdk/bridge` |

Runnable shapes of both, and of a resume after a reload, are in
[`examples/`](https://github.com/alejoamiras/unleashed/tree/main/packages/sdk/examples).

## Install

```sh
npm install @unleashed/sdk
```

ESM only. The peers are the Aztec packages, at the exact versions this release names, and `viem` 2. Your app must
resolve the same copies: `Fr` and `AztecAddress` are classes, and a second copy fails `instanceof`. An app on another
Aztec version cannot use this release.

## Networks

```ts
import { parseNetwork, type Reads } from "@unleashed/sdk"
import { TESTNET_MANIFEST } from "@unleashed/sdk/networks"

const reads: Reads = { l1: publicClient, aztecNode: createAztecNodeClient(aztecNodeUrl) }
const net = await parseNetwork(TESTNET_MANIFEST, reads)
```

Every call that signs takes a `Network` and refuses one `parseNetwork` did not build. `parseNetwork` refuses
(`BridgeError`, nothing sent) a manifest that:

- fails strict validation, or whose derivable addresses (portals, the hub, L2 tokens) disagree with their derivations;
- runs an Aztec line this release does not: each L1 chain is pinned to one Aztec version, and a network on any other
  is refused with `unsupported-line` before anything is signed, since its claims could not be built;
- names a non-canonical Permit2, a slippage above `MAX_FUEL_SLIPPAGE_BPS`, or, on mainnet, a registry or Fee Juice
  contract other than the pinned ones;
- disagrees with the Aztec node on its chain, rollup, registry or Fee Juice contracts;
- points at deployed contracts that are not this release's builds bound to the registry's canonical rollup.

`@unleashed/sdk/networks` bundles the reviewed `TESTNET_MANIFEST` and `MAINNET_MANIFEST`. Pass these rather than a
manifest fetched at run time: the checks above read through your own `Reads.l1`, so the bundled copy is the root
that no RPC answer can move. Testnet (Sepolia) carries the token bridge and the gas route. The bundled mainnet
manifest is a placeholder until mainnet's gas route is deployed, so `parseNetwork` refuses it (`invalid-network`); on
mainnet the planned network sells gas only, and `net.bridge` is absent there.

## Persistence is yours

The SDK keeps no state. Each call hands you the transfer's record through `persist`, and a transfer can only be
finished from what you stored.

- `persist(record, secrets?)` is awaited before the first wallet prompt and before every event that names a new fact
  (a transaction hash, a message leaf). Calls arrive one at a time, in order: keep the latest record per `record.id`.
  Records are plain JSON.
- A private transfer's salts (`secrets.claimSalt`, `secrets.fuelSalt`, `Fr` values) come with `persist` and appear in
  no record and no event. Store them apart from the record, sealed. A private claim cannot be built without them.
- A rejected `persist` throws `persist-failed`. In a deposit before anything was sent, `retry` is `"safe"`; after the
  deposit was sent it is `"never"`: the record you already stored names the deposit, so finish it with a claim and
  never deposit again. In a claim it is `"safe"`: the claim resumes from whatever you last stored.
- To resume, call the claim again with the record as last persisted (and its salts). A record that lost its leaves
  has them read from the deposit's receipt, after its deposit is found on Ethereum when the hash was lost too (while
  the record is under 50,000 blocks old, about a week). A claim it already sent is watched, never sent again, and
  counts only once its message's nullifier shows; one that dropped or reverted is cleared and reported, and the next
  call claims again. An attempt whose hash was never stored is waited out until its nullifier or its age settles it.
- `watchOnly: true` resumes without asking the wallet to sign or send (it still reads through it): it does all of
  the above that needs no signature and throws `needs-prompt` (`retry: "safe"`) where a fee would be priced or a
  prompt opened. Pass it when a page resumes
  its records on load, and call again without it when the user acts.
- `claimRetired(record)` says when a record is complete and its claim material may be dropped.
- A deposit the user refused (`user-rejected`, `submission: "none"`) moved nothing: drop the record. One that
  reverted on chain (`deposit-reverted` with `submission: "submitted"`) moved nothing once its block is final, and a
  reorg can still land it before then: drop the record only after that. A `deposit-reverted` with
  `submission: "unknown"` may have been broadcast: keep it. A page that closed between `persist` and the signature
  leaves a record no deposit may match: its claim reports `deposit-not-found` (`after-wait`), and when to give it up
  is yours.
- `signal` stops a call's waiting. It never cancels a sent transaction and is not honoured between a send and the
  persist of its hash.

## Events

`onEvent` receives each event with the record's `id` and a `seq` that strictly increases within one call. It is
display only: a listener that throws is ignored. Events carry hashes and amounts, never a salt or a private recipient.

A deposit (`depositFuel`, `depositToken`) reports:

| Event | When |
|---|---|
| `prepared` | The record is persisted; nothing has been asked yet. |
| `approval` | Only when the token's allowance to Permit2 is short, for a one-time maximum approval: `requested`, `sent` and `confirmed` with its hash, and `waiting` with a `round` while its receipt is slow. |
| `signature-requested` | The Ethereum wallet is asked for the deposit: its Permit2 signature, then its transaction. |
| `deposit-sent` | The deposit's hash is persisted. |
| `deposit-confirmed` | Mined: `leaves` holds each message's leaf, and the gas leg's Fee Juice received. The call resolves here. |

A claim (`claimFuel`, `claimToken`) reports:

| Event | When |
|---|---|
| `deposit-recovery` | Only on a resume that lost its leaves: `searching` for a deposit whose hash was lost, `reading` its receipt, and `waiting` when that deposit is not mined yet and the call waits for Ethereum to confirm it. |
| `deposit-confirmed` | The recovered leaves are persisted. |
| `arrival` | Repeated while the messages travel: `counting` with `block` and `blocksLeft`, or `checkpointsLeft` (never rising within a call, 0 once passed); `unfolded`; `wallet-sync` before each claim simulation, `counted` once a wait came first. |
| `claimable` | The claim's simulation passes. |
| `registration-requested`, `registration-sent` | A token's first private claim only: its registration is a transaction of its own. |
| `claim-requested` | The Aztec wallet is asked for a claim (`leg`: `token`, or `gas` for gas claimed on its own); once per attempt. |
| `claim-sent` | The claim's hash is persisted. `payer` is `fuel` when the bridged gas paid; otherwise what the account already held paid, `fpc-credit` for a private claim and `own-gas` for a public one. |
| `claim-waiting` | Before each receipt read of a watched claim, `poll` counting from 1 per hash, and again when a read changes `unreachable`, the count of consecutive reads the node did not answer. |
| `claim-proposed` | The claim is in a proposed block: not yet settlement. |
| `claim-verifying` | A claim this call did not send landed: `checking` its message's nullifier, `wallet-sync` while it does not show yet. |
| `claim-landed` | The tokens are claimed (`via` as in `settled`). A failure after it is the claim of the gas they left. |
| `settled` | The record is persisted complete. `via` is `claim`, or `claimed-elsewhere` when another submitter spent the message. |

A token plus gas whose claim left its gas unspent reports one more `claim-requested`, `claim-sent` (payer `fuel`) and
`claim-waiting`, with `leg: "gas"`, between `claim-landed` and `settled`.

## Claims

- **`claimFuel`** claims a gas deposit for the account it names: public Fee Juice that pays for its own claim, or
  private credit at the network's PrivateFPC, which needs `secrets.fuelSalt`.
- **`claimToken`** claims a token deposit and registers the token on its first claim (inside the claim when public, a
  registration of its own first when private). A private claim needs `secrets.claimSalt`, and its gas
  `secrets.fuelSalt`. It pays from the bridged gas, from private credit, or from Fee Juice the account holds; a
  private claim never pays from public Fee Juice.
- **Gas a token claim left unspent** (the claim paid from held gas, or another submitter claimed the token) is claimed
  on its own, public or private, before the record settles. A private leftover without its fuel salt throws
  `invalid-request` with `retry: "safe"` and leaves the record open: call again with the salt. The record says
  `claimedByOther` as soon as another submitter's claim is read, before that gas claim.
- **`withoutGas: true`** pays a public token + gas claim from Fee Juice the account holds and settles with the bridged
  gas unclaimed; `claimFuel` on that record claims it later. `claimFuel` takes a token + gas record once its tokens are
  claimed (`completedAt`) or were claimed by another submitter (`claimedByOther`), checks only its chain and recipient,
  and changes only its gas leg.
- **`gasLeft`** on the outcome is set only when the tokens landed and no retry could claim the gas; it says why.
- **A record missing its gas leg's leaf, message hash or amount** reads the deposit's receipt before claiming.
- **The wallet's grant.** `capabilitiesFor(net, { fuel: true, tokens })` returns the exact-address capability entries
  the claims call, to merge into the request your app sends its Aztec wallet. `hubArtifact()` serves a wallet that
  must register the hub.

## Errors

Every claim failure, and every deposit failure from its signature on, is a `BridgeError` (`isBridgeError`). Anything
else comes from your RPC, node or wallet failing before the deposit was signed: the deposit was not sent, and the same
call may run again. `code` says what happened; `submission` whether anything reached a chain for this transfer
(`none`, `submitted`, `unknown`); `retry` what to do next. A claim's `submitted` names its deposit, not a claim it
broadcast, and a claim refused before it reads anything says `none` although its deposit was sent: never drop a record
because its claim reported `none`.

| `retry` | Meaning |
|---|---|
| `safe` | Call again now. |
| `after-wait` | The chain has not caught up yet: call again later. |
| `never` | Repeating the call could move funds twice or cannot succeed. Keep the record and show the error: a deposit that was sent is still finished with its claim. |

`fee-stop` names its stop in `stop`, a typed union, for your own copy: the claim cannot pay for itself now, and
nothing was sent. `deposit-not-found` names its search's result in `search`: `none`, `ambiguous` (`never`: finish it
by hand) or `incomplete`. A claim reports `claim-dropped` and `claim-reverted` with the hash cleared and `retry:
"safe"`, and `needs-prompt` from a `watchOnly` call.

## Supported tokens

- **Token bridge**: any ERC-20, listed in `net.bridge.tokens` or not, through `resolveToken`. A first-time token's
  portal is created by its deposit and its L2 token by its first claim. Fee-on-transfer tokens and amounts above
  `uint128` are refused on chain; rebasing tokens are unsupported and not detected.
- **Gas**: the fee asset at par, or a token the network's venue prices: a pinned swapper on testnet, LI.FI through
  allow-listed venues on mainnet. `probeFuel` gives the rate; a token no venue prices is refused before signing
  (`no-fuel-route`).

## Content Security Policy

The SDK connects only where you point it: your Ethereum RPC (`Reads.l1`), your Aztec node (`Reads.aztecNode`), and,
on a network without a pinned swapper, `https://li.quest` (keyless, through `Reads.fetch` or the global `fetch`).
Its Poseidon2 hashes run in `@aztec-foundation/bb.js`'s WebAssembly, which it fetches from a `data:` URL: `connect-src`
needs those three origins and `data:`, and `script-src` needs `'wasm-unsafe-eval'`, as any aztec.js page does.

## Trust

- **LI.FI is a routing dependency, not a trusted party.** A quote is accepted only inside fixed pins (allow-listed
  venues, the Diamond as target and spender, zero value, the pinned selector, the router as receiver), the signed
  floor is written into the swap, the router re-checks it on chain, and the signature commits to the swap's bytes.
- **The chains are asserted before signing.** The Ethereum wallet must be on the network's chain, and the Aztec
  wallet's chain must match the network's.
- **Salts are full-entropy** (64 WebCrypto bytes reduced into the field) and never appear in a record, an event, an
  error or a log.

## Releasing

Bump `version` in `packages/sdk/package.json` through a pull request. Once it is on `main`, run the **Publish SDK**
workflow (`publish-sdk.yml`) from `main`. Its `pack` job runs every workspace's unit tests and
`pack:check --out`; its `publish` job, the only one that holds npm's OIDC token, checks the tarball's digest and runs
`npm publish --provenance`. A run from any other branch stops after `pack`.

Before the first run, the owner:

1. publishes the first version by hand (`npm publish <tarball> --access public`, with npm's two-factor prompt) from a
   tarball `pack:check --out` checked;
2. on npmjs.com, once the next version is ready to publish, adds the package's trusted publisher: repository
   `alejoamiras/unleashed`, workflow `publish-sdk.yml`, environment `npm-publish`, with the `npm publish` action allowed
   (a new entry allows only `npm stage publish`). An entry that no run has used within two days expires. Then sets
   publishing access to require two-factor authentication and disallow tokens;
3. in the repository's settings, creates the `npm-publish` environment with its deployment branches limited to `main`.

## Maintaining the package

The app (`apps/tools`) and `@unleashed/bridge-core` import the package from the workspace, whose manifest exports
`src/*.ts` directly; only `bun run stage` builds.

### Entries

| Entry | What | Published |
|---|---|---|
| `@unleashed/sdk` | `parseNetwork` and its trust roots, `Network`, transfer records and events, `BridgeError`, `capabilitiesFor`. | yes |
| `@unleashed/sdk/fuel` | `probeFuel`, `quoteFuel`, `depositFuel`, `claimFuel`: gas only. Never loads the hub artifact. | yes |
| `@unleashed/sdk/bridge` | `resolveToken`, `quoteBridge`, `depositToken`, `claimToken`, `hubArtifact()`: a token, or a token plus gas. Loads the hub artifact. | yes |
| `@unleashed/sdk/protocol` | The pure layer: ABIs, derivations, the manifest, gas math, the LI.FI client and book, fee methods, code pins. | yes |
| `@unleashed/sdk/networks` | The bundled testnet and mainnet manifests. | yes |
| `@unleashed/sdk/artifacts` | The hub's Noir artifact, loaded eagerly. | workspace only |
| `@unleashed/sdk/private-fpc-artifact` | The PrivateFPC artifact, for a dynamic `import()` only. | workspace only |
| `@unleashed/sdk/l1` | The viem-only slice of `./protocol` (the router ABI, the LI.FI ABIs, book and gas constants): esbuild resolves every member of a barrel, so a Worker bundles this one instead. | workspace only |
| `@unleashed/sdk/internal` | The orchestration (`execution/`): the L1 send, receipt leaves, arrival gates, claims, recovery. | workspace only |

Source imports use `.ts` specifiers, so every consumer's tsconfig sets `allowImportingTsExtensions`. `src/` imports no
`node:` built-in and declares every package it imports (`imports.test.ts`), and `.` and `./fuel` never reach the hub
artifact statically (the same test).

### File map

#### `src/protocol/`

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
| `random-field.ts` | `randomField`: 64 WebCrypto bytes reduced mod r, the source of every fresh field the SDK draws (salts, claim secrets, authwit nonces); the Permit2 nonce stays an unreduced uint256. Exported through `./internal`. |
| `wallet-chain-id.ts` / `artifacts.ts` | `walletChainIdOf` (`(l1 ^ rollupVersion) >>> 0`); the hub artifact (its own entry, `@unleashed/sdk/artifacts`). |

#### `src/execution/` and the root

| File | Purpose |
|---|---|
| `send-generation.ts` / `send-flow.ts` / `legacy-router.ts` | What a send binds to (read off a manifest) and the L1 leg for every intent — token, token+gas, gas-only — through the deposit router: `runSend` signs the `DepositWitness` (it commits to the fuel quote's `swapData`), sends `bridgeWithPermit`, and `readSendReceiptLeaves` reads the leaves through `readRouterDeposit` (`router-receipt.ts`), the one `Deposited` parser. `legacy-router.ts` reads the retired `SwapBridgeRouter`'s receipts for records still in flight, through its frozen calls and events in `legacy-router-abi.ts`; nothing sends through it. The portal is never taken from a caller. |
| `hub-l2.ts` | The L2 leg: `claimViaHub` (register-if-first, decided at claim time by `token_for`, race-tolerant), `exitViaHub` / `preflightHubExit` / `hubExitsPaused` (fail-closed) for L2→L1. |
| `factory-registry.ts` | The factory's frozen registration and the hub's registration view, read together. |
| `fuel-quote.ts` | The router's fuel leg: LI.FI's same-chain quote on mainnet (allow-listed venues only) or `TestnetFuelSwapper`'s fixed rate elsewhere, with the signed floor written into the swap's own minimum; `manifestFuelProvider` picks the one a manifest names. |
| `flows.ts` / `l1-receipt.ts` / `l1-to-l2-readiness.ts` / `chain-scan.ts` | `consumeWithdrawal` + `isOutboxMessageConsumed` for exits and the `L1Ctx` every flow takes; the resilient receipt wait; when an L1→L2 message is consumable; budgeted, reorg-checked scans that report "incomplete", never absence. |
| `router-receipt.ts` | `readRouterDeposit`: the router's own `Deposited` in a mined transaction, each leg authenticated by its portal's event and the Inbox leaf recomputed from the intent. |
| `records.ts` (root) | The protocol facts of a transfer record (`JournalTokenBlock`). |

### Scripts

| Script | What |
|---|---|
| `bun run test` | vitest: pure functions and mocked-chain orchestrations. The sandbox integration suite that drives these flows lives in `@unleashed/bridge-core` (`test:integration`). |
| `bun run typecheck` | `tsc --noEmit` over `src/`, the tests, the scripts and `examples/`. |
| `bun run stage` | Builds `dist/` from the published entries only: what they reach is emitted, the JSON assets they import are copied with their digests checked, and the published `package.json` is derived (peers exact at the Aztec pins, `viem` a caret range). |
| `bun run pack:check` | Stages, packs, and installs the tarball into `test/consumer/` (frozen lockfile, install scripts off, nothing resolvable from the repo); typechecks it under `NodeNext` and `Bundler` and imports every entry in Node and Bun. `--out <dir>` copies the checked tarball there. After an Aztec bump, update the fixture's pins and run `bun scripts/pack-check.ts --relock`: a relock re-checks the 7-day gate, so a version younger than that needs a local, uncommitted exclude. |
| `bun scripts/code-pins.ts` | Rewrites `src/protocol/code-pins.json` from the forge build after a pinned contract changes; `scripts/code-pins.test.ts` fails until it is rerun. |

### Key invariants

- **Leaf indices from the mined events, never a preflight simulate** (`send-flow.ts`). A concurrent deposit changes a simulated index, so the claim would retry against the wrong leaf forever. `readSendReceiptLeaves` takes them from the router's own `Deposited` for this send's secret hashes — filtered by emitter, each leg matched to its portal's event and to the Inbox leaf recomputed from the send's own facts, so a look-alike event from another contract in the same receipt cannot forge them.
- **The portal is derived, never supplied.** The deposit router derives the token's factory clone itself and a first send creates it inside the same transaction; the client derives the same address only to authenticate the receipt.
- **A claim is decided at claim time** (`hub-l2.ts`): `token_for == 0` ⇒ this claim also registers (one tx for public; `register_token` first for private). If another claimant registers in between, the registration path fails on the consumed register leaf and the claim is retried as a plain one — a deposit is never stranded on a race.
- **A private first claim's two transactions pay from the same bridged Fee Juice, and nothing is ever sponsored** (`hub-l2.ts` seams `registerFee` / `registeredClaimFee`): the registration spends the fuel message (`PrivateFPC.mint_and_pay_fee`, sized with `PRIVATE_HUB_REGISTER_GAS`), which leaves `amount − max_gas_cost` as the claimer's private credit at the FPC, and the claim that follows pays from that credit (`pay_fee`, sized with `PRIVATE_HUB_CLAIM_GAS`). The FPC keeps each transaction's committed ceiling, not its charge, so a first-time private bridge must carry both ceilings. The claim is sent only once its own simulation passes in the claimer's wallet: the registration's binding lands on the node first, and `claim_private` reads it at the wallet's synced block, which lags (`registrationWait`, 5 s polls, 3-minute deadline; `onRegistered` hands the caller the registration's hash as soon as it exists).
- **The Permit2 witness is cross-pinned.** `l1.ts`'s `DepositWitness` member list + `DEPOSIT_WITNESS_TYPE` must stay byte-identical to `DepositRouter.hashWitness`. `l1.test.ts` pins the hashes; the evm fork test proves a post-signature tamper reverts.
- **Gas-share math is integer-only with two exact ceilings** (`gas-share.ts`): the slice sized from `fjPerTx` and the floor signed from it never lose a base unit to a folded division — a property test pins it.
- **Token behaviours are bounded on chain, not trusted off chain.** The clone refuses fee-on-transfer (exact-in), `amount > uint128.max`, and protects the reserve on withdraw with an exact portal-debit; a token no fuel venue prices is refused before signing (`fuel-quote.ts`); rebasing tokens are unsupported and surfaced as a caution, never detected.
