---
plan: sdk-1
tier: deep
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: approved; the owner answered OWNER-ASKS §1–§7 and §10 (ask26); a6 in progress
base: main fb90e366
budget: "recon: 3 Sonnet explorers; drafts: driver + Codex + Opus 5.5; code-review: off; Codex gpt-6.1-sol at high"
---

# sdk-1: a publishable bridge SDK, the app on it, and mainnet fuel through LI.FI

## Summary

Move the bridge's client flows out of the private `@unleashed/bridge-core` and the app's composables into a new
published package, `packages/sdk`, with a small typed interface: a **fuel** entry (the fee asset, or any priced token
swapped to it, into the Fee Juice portal as public or private Fee Juice) and a **bridge** entry (a token, or a token
plus gas, through the hub). The SDK takes the caller's wallets, awaits the caller's persistence before every
irreversible step, and reports typed, ordered events. The app then runs on it with no visible change. Before that,
and independent of the owner's interface answer, a fuel-only route lets the existing `DepositRouter` run on mainnet
with no token portals. ask3 wires the keyless li.quest client in through the SDK and proves it in the browser.

## Requirements map

| Item | Delivered by | Note |
|---|---|---|
| ask5 | a1 (mainnet fuel route), a2 (SDK + interface), a3 + a4 + a6 (app on the SDK), a5 (publish setup) | The interface and the npm name wait for the owner (`OWNER-ASKS.md` §1–§2). |
| ask3 | a3 | Mainnet traffic needs the owner's deploy and promotion of the fuel route, and a mainnet app (mainnet-1). |
| ask26 | a6 | The SDK's claims gain the card's events, a watch-only resume, the Ethereum wait status and the claim-without-gas choice; then the app's claims run on them. |
| Issues | none | No open issue; closed known limits searched (`bridge`, `fuel`, `sdk`, `lifi`): only #27, unrelated. |

## UI impact

The whole visible budget is the owner's recorded decision: *"none on screens: after the move onto the SDK the app
must look and behave exactly as today, proven by the full browser suite; any visible difference is an
`OWNER-ASKS.md` entry. The SDK's public interface and its npm package name are the owner's to approve (ask5)."*

- a1: none (contracts, manifest schema, scripts, runbook).
- a2: none (the app changes imports only).
- a3: none on the shipped builds. The LI.FI-venue cells run a test-only local variant; the testnet and mainnet
  bundles keep their CSP and behaviour (`verify:build-target` proves it).
- a4: none. a5: none.
- a6: §10's items 1, 2, 3, 7 and 8 (ask26, P7-02's sentence), and the private claimed-by-other line that item 2
  replaces; every other state as today (D86).

## Outcome & Quality Bar

**For whom.** A developer of an Aztec dApp or wallet who wants users to bridge a token or buy gas from Ethereum without
a server of ours; the later mainnet-1 lane, which builds a gas-only mainnet app on the fuel entry; the maintainers of
`apps/tools`.

**What excellent looks like.**
- An integrator goes from quote to settled claim with one typed example that compiles, and cannot reach a signature
  before its own store has the claim secrets: the SDK awaits `persist` and refuses on failure.
- Every failure says whether anything reached a chain (`submission: none | submitted | unknown`) and whether a retry
  is safe; no error message or event carries a secret.
- Events arrive in a documented order, each naming only facts already persisted, and map one-to-one onto the app's
  rail, so the app's stepper is unchanged.
- The tarball installs and typechecks in a fresh project under `NodeNext` and `Bundler`, with exact Aztec peers and
  npm provenance.

**Good enough.** v1 covers ask5's flows only. Exits, the cross-chain source leg, Drip and the AZTEC mint stay on
private code (an owner scope ask). README plus typed examples, no docs site.

## Architecture & Implementation

### Proposed architecture

```text
packages/sdk            published (name: the owner's). Depends on no private package.
  src/index.ts          parseNetwork, Network, records, events, BridgeError (no hub artifact)
  src/fuel/             quoteFuel, depositFuel, claimFuel: identity and swap venues
  src/bridge/           quoteBridge, depositToken, claimToken, capabilitiesFor
  src/protocol/         moved protocol: ABIs, derivations, manifest, gas math, LI.FI client and book, fee methods
  src/execution/        moved orchestration: L1 send, receipt leaves, arrival gates, fee ladder, claims, recovery
packages/bridge-core    private: app state (journal, backup, seals, token list), ops, cross-chain, scripts, sandbox
apps/tools              Vue: journal engine (locks, attention, scheduling), seals, prompts, copy, views
```

Dependencies point one way: `apps/tools` → `bridge-core` → `sdk`, and `apps/tools` → `sdk`. Nothing is copied: modules
move with `git mv` and their tests travel with them (recon `Reuse map`).

**What moves into the SDK.**
- From bridge-core: `send-flow`, `send-generation`, `l1`, `l1-receipt`, `l1-to-l2-readiness`, `deposit-router-abi`,
  `factory-abi`, `factory-registry`, `portal-address`, `erc20`, `hub-l2`, `hub-token`, `register-hash`,
  `claim-secret`, `content-hash`, `artifacts`, `fuel`, `fuel-quote`, `fee-juice`, `private-fuel`,
  `private-fpc-artifact`, `gas-share`, `lifi-api`, `capped-fetch`, `lifi-abi`, `lifi-addresses` (with the two
  selectors it takes from `across-v4`/`stargate`), `lifi-gas`, `manifest-v2`, `wallet-chain-id`, `flows`,
  `chain-scan`, `legacy-router`, `legacy-router-abi` (frozen), and `readRouterDeposit` with `InboxContext` extracted
  from `crosschain-discovery.ts` into `router-receipt.ts` (one `Deposited` parser). The protocol types the moved code
  takes from modules that stay (`JournalTokenBlock` from `journal.ts`, `RouterIntent` from `lifi-decode.ts`;
  `send-flow.ts:29-31`) move with it and are imported back.
- From the app (Vue-free today): the fee ladder of `composables/deposit-flow.ts` (`resolveHubClaimSendOpts` :898,
  `resolvePrivateFuelFee` :495, `resolvePublicClaimFee` :777, `ownGasFee` :729, the standalone fuel claim, the
  receipt and nullifier probes, `recoverDepositLeg`), `composables/fuelClaim.ts`, `composables/deposit-reconcile.ts`,
  `lib/{fuel-claim-state,wallet-fee-budget,message-nullifier,claim-receipt,wallet-features}.ts`, the claim sequence
  of `useBridgeJournal.ts` (`awaitBlockCountdown`, `awaitCheckpointGate`, `awaitConsumable`, `classifyConsumable`, the
  not-ready and consumed classifiers, the receipt rounds), the token resolution of `useTokenSelection.ts`
  (`readMetadata`, `wordsOf`, `toResolved`, :69-127), the quote logic of `useFuelQuote.ts`, the math of
  `useGasShare.ts`.
- Deleted: `progress.ts`, `status.ts` (no importer outside their own tests).

**What stays.** bridge-core keeps `journal`, `backup`, `recovery-crypto`, `seal-trust`, `token-list`, `promotion`,
`drpc-node`, the cross-chain modules (`across-*`, `stargate`, `lifi-decode`, `crosschain-route`, `crosschain-discovery`,
`source-chains`), `relay-claim`, `faucet-catalog`, `scripts/` and the sandbox. relayer-1 merges first and adds a seam
that `packages/testnet-relayer` imports (`./fill-testnet`, `canaryAccountFromEnv`, `connectFillRoute`,
`fillSourceDeposit`'s `{ relayHash }`, the `boundedGasTerms` re-export, `reserveSandboxPorts`); it lives in scripts and
the sandbox, which do not move. Its Worker-safe fill core in bridge-core's `src/` stays Worker-runnable because the
SDK's `src/` imports no Node built-in (a test pins it). a2 migrates every importer of a moved symbol, the relayer
workspace and `fill-testnet.ts`'s relative `../src/lifi-addresses` included, and every a2 gate runs that workspace's
typecheck and tests.

**Entry points.** Published: `.`, `./fuel`, `./bridge`, `./protocol`, and `./networks` if the owner wants promoted
manifests bundled (`OWNER-ASKS.md` §1). `./protocol` is semver'd and documented as low-level: the pure builders an
integrator with its own signing pipeline can use. Workspace-only: `./internal` (the execution modules bridge-core's
scripts, the sandbox and the app's engine import); `stage.ts` drops it from the published exports and `pack:check`
asserts it is absent. The fuel/bridge split has a cause: `artifacts.ts:6` loads the 3 MB hub artifact at module load
and `manifest-v2.ts:19` imports it eagerly; the hub derivation becomes a dynamic import taken only for a token route,
and a test asserts that `./fuel`'s import graph never reaches `artifacts`.

**Build.** Source uses explicit `.ts` relative specifiers, so the tsconfigs of `apps/tools`, `apps/tools/tests/browser`
and bridge-core gain `allowImportingTsExtensions` (only `apps/landing` has it). `tsc -p tsconfig.build.json` emits ESM
`.js` and `.d.ts` into `dist/` with `rewriteRelativeImportExtensions`. `scripts/stage.ts` copies the hub artifact,
rewrites the one out-of-package specifier (`artifacts.ts:6`; `tsc` keeps it verbatim), checks the digest and writes
`dist/package.json` (name, exports, `files`, peers, `sideEffects`). The workspace `package.json` keeps exporting
`src/*.ts`, so nothing in the repo builds first. `pack:check` stages, packs, and typechecks and imports the tarball
from a consumer fixture under `NodeNext` and `Bundler`, in Node and Bun (D9).

**Dependencies.** Peers, exact at the repo's pins because `Fr` and `AztecAddress` are nominal classes:
`@aztec-labs/{aztec.js,stdlib,foundation,constants}` 6.0.0, `@aztec-foundation/{l1-artifacts,aztec-standards}` 6.0.0,
`@aztec-labs/ethereum` (`flows.ts:8`), `@alejoamiras/private-fee-juice` 6.0.0; every other package a moved module
imports is declared too (`layout-identity.test.ts` extended to the SDK proves it). `viem` is a peer range `^2.57.1`:
its types are structural, and an exact pin would block wagmi users. Dependency: `zod`, exact, at the patched version
(the zod follow-up lands before a5). `scripts/ci-cd/published-packages.test.ts` holds the SDK to the peer model of the
`@nulo-sh` packages; the app and bridge-core declare every peer.

### Key interfaces

The full sketch is `OWNER-ASKS.md` §1. Its contracts, which every arc after a1 builds against:

- `parseNetwork(manifest, reads): Promise<Network>`: strict parse, re-derives every derivable address, takes the PrivateFPC
  from the manifest and refuses one that is not the pinned descriptor's for that line, and reads the line table (keyed
  by L1 chain). `Network = { fuel: FuelRoute; bridge?: TokenRoute }`; a manifest with neither route (today's mainnet
  placeholder) is refused, so the app builds a `Network` only when a route exists and keeps its identity-only parse for
  the placeholder.
- Trust roots (D11): `parseNetwork` refuses a `permit2` other than the canonical Permit2, a `feeJuice.portal`/`asset`
  other than the Aztec node's `l1ContractAddresses` (and the line table's pin on chain 1), and a `slippageBps` above an
  SDK constant (`MAX_FUEL_SLIPPAGE_BPS`, 300, today's testnet value). Once per network it checks the masked runtime
  code hashes of the router and of its factory (`PortalFactory` or `FuelOnlyGate`), and the router's `PERMIT2`,
  `FEE_JUICE_PORTAL`, `FEE_ASSET`, `FACTORY` and `SWAP_TARGET` (the book's Diamond on chain 1; the pinned swapper's
  code hash elsewhere). A token route also anchors `bridge.l1.registry` to the node's `registryAddress` and checks
  the factory's `L2_HUB`, `IMPLEMENTATION`, `INBOX` and `ROLLUP_VERSION` and the implementation's `FACTORY`,
  `L2_HUB`, `INBOX`, `OUTBOX` and `ROLLUP_VERSION` against it: a genuine factory built on a hostile registry freezes a
  foreign Outbox that would release every clone's reserve. `verify-l1.ts`'s binding checks (:136-175) move into the
  SDK for this, and `verify-l1` imports them back.
- `resolveToken(net, reads, erc20): Promise<BridgeToken>` (portal, words, decimals, derived L2 address, frozen
  registration if any), moved from `useTokenSelection.ts`; `quoteBridge` and `capabilitiesFor(net, { fuel?: true;
  tokens?: BridgeToken[] })` take its result, so a permissionless token's derived L2 address joins the exact-address
  grant, as `useTokenGrant.ts:50` does today; no wildcard.
- `probeFuel` (a rate for sizing, no floor; what the gas-share control reads today through `provider.probe()`) and
  `quoteFuel` (the executable quote with its signed floor) stay separate: a probe must not hide a route that the real
  amount supports (`fuel-quote.ts:156-165`).
- Signers are parameters of the calls that sign: `depositFuel`/`depositToken` take a viem `WalletClient` (any
  EIP-1193 source); `claimFuel`/`claimToken` take aztec.js's `Wallet` (what a `@aztec-labs/wallet-sdk` session yields)
  and the account. Reads (`PublicClient`, Aztec node, optional `fetch`) are separate.
- `RunOptions.persist(record, secrets?)`: awaited before the first wallet prompt, then before each event that names a
  new fact. Private salts travel only in `secrets`, never in the record or an event.
- `TransferEvent = { id, seq } & (prepared | approval | signature-requested | deposit-sent | deposit-confirmed |
  arrival | claimable | registration-sent | claim-sent | claim-proposed | settled)`; `seq` strictly increases per run.
  a6 adds `deposit-recovery`, `claim-waiting`, `claim-verifying` and `claim-landed` (Arc a6).
- `DepositRecord`: the protocol fields the app's schema-3 record already stores, with the same names; the app's record
  type becomes `DepositRecord & AppFields`, so stored records resume with no migration.
- `BridgeError { code; submission: "none" | "submitted" | "unknown"; retry: "safe" | "after-wait" | "never" }`.

### Data and control flow: a fuel deposit (the critical path)

1. `quoteFuel` picks the venue from `net.fuel`: identity for the fee asset; the fixed swapper where the manifest names
   one; otherwise LI.FI through the default keyless client (`globalThis.fetch`). It returns expected and floor amounts.
2. `depositFuel` refuses `unsupported-line`, asserts the L1 chain and re-quotes the exact slice (`quote-moved` below
   the reviewed floor) before any prompt: a wrong chain or a moved quote costs no prompt and leaves no record, as
   today (`useSend.ts:684-690`). Then it draws the salt (`Fr.random()`), builds the claimer-bound secret hash
   (private: PrivateFPC from `net.fuel.privateFpc`), awaits `persist`, emits `prepared`.
3. It ensures the Permit2 allowance (`approval` events, each hash persisted first), asserts the chain again, emits
   `signature-requested`, signs the witness, sends `bridgeWithPermit` with the network's chain (viem then asserts it;
   today it passes the wallet's, `send-flow.ts:313`), persists the hash, emits `deposit-sent`.
4. It waits for the receipt, takes the leaves from the router's own mined `Deposited` (emitter-filtered, recomputed
   against the Inbox context of that line), persists them, emits `deposit-confirmed`.
5. `claimFuel(record)` waits for the L1→L2 message (`arrival`), emits `claimable`, then claims: public `FeeJuice.claim`
   for the recipient, or private `mint_and_pay_fee` into PrivateFPC credit; it persists the claim-attempt latch before
   sending, emits `claim-sent`, then `settled` (or `claimed-elsewhere` when the nullifier shows another claimant).
6. A resumed `claim*` reads what the record holds: no deposit hash → `findDepositTx`, which a2 extends to gas-only
   records (matched by the fuel secret hash in the router's `Deposited`; today it returns `"none"` for them,
   `deposit-reconcile.ts:96`); no leaves → read the receipt; a claim hash → watch it, never resend; a registration hash
   → re-read that registration's fate and the live binding, as `claimViaHub` does (`hub-l2.ts:296-330`), before
   choosing the claim.

### Non-obvious mechanics

- **The fuel route.** `DepositRouter` needs a non-zero factory (`DepositRouter.sol:115`), reads
  `FACTORY.depositsPaused()` on every entry (:235) and calls `createPortal` only on a token leg (:253, :266). A new
  `FuelOnlyGate` in that slot answers `depositsPaused()` and reverts `createPortal`, so a token leg reverts atomically.
  The router source does not change: `verify-l1 --strict` compares masked runtime hashes with the live testnet router.
- **The line table** (`aztec-line.ts`). `readSendInbox` reads the factory and hard-codes the `artifact` event shape and
  the genesis Fee Juice sender (`send-flow.ts:125-137`); the fuel leg reads `INBOX()`/`VERSION()` from the Fee Juice
  portal instead. Each L1 chain's line is its PrivateFPC descriptor (chain 1 → `private-fpc-canonical-mainnet.json`,
  every other chain → the installed one); a line is supported when its descriptor's version is the installed one. Keyed
  by L1 chain because the sandbox's rollup version is read at each boot (`sandbox/deploy.ts:138`). Mainnet's canonical
  rollup runs 6.0.0 (owner answer §3), so today every network is supported; a bump that leaves a network behind
  re-pins its descriptor and the gate refuses it (`UPDATE.md`). No `checkpoint`-shape send support is built (D24).
- **The line gate.** On a network whose line is not supported, every send refuses before any wallet prompt
  (`assertSupportedLine` in `runSend` and `readSendInbox`; the SDK's `unsupported-line`).
- **Persist-then-emit.** The SDK never emits an event naming a hash, a leaf or a registration before `persist` resolved
  with it, and never honours an abort between a wallet send and persisting its hash.

### Trade-offs

In the ledger: wallets over unsigned data (D2), promises over Effect 4 (D3), one package (D1), a gate over a router
change (D10), the browser cell (D13), the arc order (D15).

## Security & Adversarial Considerations

- **Threat model.** Attackers: a hostile LI.FI answer, a phishing manifest handed to `parseNetwork`, a lying RPC, a
  wallet left on another chain, a malicious integrator page (out of scope: it holds the user's signer), a compromised
  npm dependency. Assets: user funds in flight, claim salts, the recipient↔amount link of private deposits.
- **Funds safety.** Awaited `persist` before the first prompt; abort never between a send and persisting its hash;
  leaves from mined, emitter-filtered events only; a claim hash is watched, never resent; private never pays from
  public Fee Juice (`decideOwnGasSource`); salts are full-entropy and never appear in an event, error or log.
- **LI.FI is not trusted.** The fuel quote keeps every pin of `unsafeLifiField` (allow-listed venues, Diamond-only
  target and approval, zero value, pinned selector, `_receiver` = router, the floor rewritten into the swap); the
  router re-checks on chain; the witness commits to `keccak256(swapData)`. `capped-fetch` bounds every response.
- **Hostile manifests.** A genuine router built on an attacker's Permit2, portal or factory passes a check against
  the manifest itself, and the max Permit2 approval (`deposit-flow.ts:1010-1018`) would drain the token; so the trust
  roots are independent of it (D11, Key interfaces). Known limit: they read through the integrator's `Reads.l1`; the
  bundled `./networks` are the root for integrators who need more (`OWNER-ASKS.md` §1).
- **Wrong chain or wallet.** The L1 chain is asserted immediately before signing; the Aztec wallet's chain info must
  equal the network's `walletChainId`.
- **The gate contract.** Token legs are impossible by construction; the pause stays reachable (`Ownable2Step`,
  renounce refused, as `PortalFactory.sol:24`); no upgrade path.
- **Supply chain.** Exact Aztec peers; no install scripts; a `files` allow-list; the 7-day gate for any new dev
  dependency; the OIDC token only in a publish job that runs no repository or dependency code (D22, 5.1); the
  `pack:check` fixture installs frozen from a committed lockfile.
- **Cryptography.** None new: `@aztec-labs/foundation` Poseidon2 and secret hashes, viem typed data, the existing
  `@nulo-sh/wallet-crypto` seals (app side).
- **Privacy.** Events carry hashes and amounts, never a private recipient or salt.

## Assumptions

### Facts (verified at fb90e366)

- Recon (`recon.md`) holds the export map, the app's flow map and the router facts with line references.
- ask3's claim holds and is wider: no LI.FI client anywhere in the app (`useFuelQuote.ts:54`); `manifestFuelProvider`
  returns `undefined` on `bridge: null` (`fuel-quote.ts:258`); no build's CSP admits `li.quest`
  (`network-targets.ts:122-152`); the mainnet build is a static placeholder (`App.vue:16`).
- `SendRecoveryHooks.onSecrets` returns `void` and is not awaited (`send-flow.ts:107-113`, :293); the app is safe only
  because `localStorage` writes are synchronous and `persistPreTx` reads back (`useSend.ts:744-777`).
- ask5's flow (1) reads two ways, and both are delivered: Fee Juice deposited publicly or privately (the router's
  identity route, `deposit-gas-only.spec.ts` cell 18; `fuel.ts`'s direct-portal planners have no app caller), and L2
  fees paid from public Fee Juice or PrivateFPC credit (the claims' fee ladder). Flows (1) and (3) are one fuel entry.
- Both manifests carry `privateFpc.address`; testnet's equals `PRIVATE_FPC_ADDRESS`, mainnet's does not
  (`0x1a6d…1bc0`, version 5.0.1). The constant has eight non-test users in the app (`deposit-flow`, `deposit-reconcile`,
  `fuelClaim`, `useHubExit`, `lib/capabilities`, `lib/fuel-target`, `lib/send-record`, `contracts/private-fpc`) and
  four in bridge-core `src/` (`fuel`, `crosschain-route`, `crosschain-discovery`, `private-fpc-artifact`).
- The repository is public (`gh repo view`), which npm provenance requires. The canonical `FeeJuicePortal` exposes
  `INBOX()`, `VERSION()`, `ROLLUP()`, `UNDERLYING()`.
- `implementations-plan/follow-ups.md`'s "One fork test for Ethereum-origin sends through real LI.FI" is stale:
  `LifiDestinationFork.t.sol:291, :308` already sign with real Permit2 and swap through real LI.FI.
- Effect 4.0.5 is the newest version past the 7-day gate; 4.0.0 is the first 4.x release.
- Root scripts select workspaces by `--filter '@unleashed/*'`; `scripts/ci-cd/workspaces.test.ts:16` pins the list.

### Inferences (each settled by a named gate)

- A `@aztec-labs/wallet-sdk` session's wallet satisfies aztec.js `Wallet` (`wallet.d.ts:208-230`). Settled by a2's
  type-level test against the app's real session type.
- `tsc` declarations with `rewriteRelativeImportExtensions` resolve under `NodeNext`. Settled by `pack:check` (a2).
- The Vite preview serves a second local bundle under a base path with the test wallet's single tools origin. Settled
  by a3's first step; the fallback is a fourth port (D13).
- npm trusted publishing cannot be configured before a package's first version exists, so the first publish needs a
  credential (`OWNER-ASKS.md` §6). Settled by the owner at publish time.

### Owner answers (`OWNER-ASKS.md` §1–§6, signed)

§1 the interface as proposed, bundled networks yes. §2 `@unleashed/sdk`; creating the npm organization is the owner's
step. §3 corrected: mainnet's canonical rollup already runs Aztec 6, the SDK's line (a 5.0 rollup still runs but is not
canonical), so the SDK supports mainnet; a1 verified it read-only and re-pinned the stale mainnet constants (D27). §4 v1
covers gas, the token bridge, and exits when the cost is modest; a2's start sizes exits and places them in an arc.
§5 the gate's owner is the pinned mainnet signer alone (D28). §6 the owner publishes v1 from their machine with npm's
two-factor prompt; every later version goes through the workflow.

## Phases

Every gate below includes `bun run lint`, `bun run typecheck:all` and `bun run test:all`, all exit 0, unless it says
otherwise. "Browser suite" means `bun run e2e:tools`, every cell green, the touched specs at retry 0; record the
wall-clock before and after in the PR body.

### Arc a1: the fuel route for mainnet (no interface dependency; starts on approval)

**Phase 1.1 — `FuelOnlyGate`.** ✓
- Add `contracts/bridge/evm/src/FuelOnlyGate.sol`: `Ownable2Step`, `renounceOwnership` reverts, `bool public
  depositsPaused`, `setDepositsPaused(bool)` with an event, `createPortal(address)` reverts `TokenLegsDisabled()`.
- Add `test/FuelOnlyGate.t.sol` and a halmos `FormalFuelOnlyGate` beside `FormalDepositRouter`: a router bound to the
  gate refuses every token leg with nothing moved; a paused gate stops a fuel-only send; a stranger cannot pause.
- Warning: a new worktree lacks `contracts/bridge/evm/lib` (`lessons.md`); install it with `forge install --no-git`
  per the README, and install halmos at the version `halmos.version` pins.
- Validation gate: from `contracts/bridge/evm`, the README's build, `forge test --no-match-contract Fork`, and the
  halmos command CI runs (`_bridge-contracts.yml`), all pass; the halmos count assertion is raised by the new proofs.
  Layers: unit, symbolic.

**Phase 1.2 — the manifest and the send binding.** ✓
- `manifest-v2.ts`: a top-level `fuelRoute { depositRouter, gate, guardian, permit2, fuelSwapper?, fuel { slippageBps,
  minFuelFj } }`, legal only with `bridge: null`; the `refineRouterBlock` rules apply to it (chain 1 refuses a
  swapper; other chains require one). Existing manifests parse unchanged.
- `fuelRouteOf(m)` returns one shape from `bridge.l1` or `fuelRoute`. `sendGenerationOf` becomes `fuelRouteOf` plus the
  token-route fields. `manifestFuelProvider` reads `fuelRouteOf`.
- `readSendInbox`: the fuel-only leg reads `INBOX()`/`VERSION()` from the Fee Juice portal; the line table (keyed by
  L1 chain; chain 1 `unsupported`) holds each line's PrivateFPC descriptor.
- Make the manifest's `privateFpc.address` authoritative, checked against the descriptor of its line; the sandbox's
  `buildManifest` (`scripts/sandbox/manifest.ts`) writes `privateFpc`, which it lacks today. `PRIVATE_FPC_ADDRESS`
  stays as the installed line's FPC (deviation, D26).
- Tests: `manifest-v2.test.ts` (a `fuelRoute` beside a bridge is refused; chain 1 with a swapper is refused; a valid
  mainnet route parses); `send-flow.test.ts` (a fuel-only send on a gate authenticates its leaves with the Inbox read
  from the portal, and fails against a forged emitter); a descriptor-mismatch FPC is refused. The "FPC differs from
  today's" app case is dropped with D26.
- Re-pin mainnet to its canonical rollup (owner answer §3, D27): `MAINNET_ROLLUP_VERSION`, the mainnet manifest's
  wallet chain id, Fee Juice portal and PrivateFPC, and the mainnet FPC descriptor.
- Validation gate: base commands; `bun run audit:tools`; the browser suite (the phase edits the app's claim code);
  `bun run --cwd packages/bridge-core test:integration`. Layers: typecheck, lint, unit, integration, e2e.

**Phase 1.3 — the conductor, the verifier, the intent tooling.** ✓
- `scripts/fuel-route.ts` behind `deploy-generation.ts deploy --fuel-route [--dry-run]`: deploy or adopt the gate
  (owner as given), then `deployDepositRouter(permit2, feeJuice.portal, gate, swapTarget, owner)` (`generation.ts:633`)
  with the Diamond `lifiBook(1).diamond` on chain 1; journal each step; read the bindings back; write
  `apps/tools/public/mainnet-bridge.candidate.json`. Refuse any chain but 1 and the sandbox chains, and any signer but
  the pinned one on chain 1. `generation-router.ts` keeps refusing chain 1.
- `verify-l1.ts`: branch on `bridge ?? fuelRoute`; for a route, check code at router and gate, the router immutables
  (`PERMIT2` = the canonical Permit2, `FEE_JUICE_PORTAL` = `feeJuice.portal` whose `UNDERLYING()` = `feeJuice.asset`,
  `FACTORY` = gate), owners, unpaused, masked runtime hashes of router and gate. The swap target keeps today's two
  branches (`depositRouterSwapTarget`, `verify-l1.ts:203-205`): a listed fixed swapper is checked as the swapper
  (sandbox, testnet); on chain 1 the Diamond is checked through its facets for the two swap selectors.
  `script-bootstrap.ts` `requireBridge` becomes `requireRoute` where a route suffices.
- `live-intent.ts`: a mainnet `fuel-route` scope (identity re-probe, tree allowlist, candidate digest, `--strict` on
  the candidate). Add `packages/bridge-core/mainnet-l1.env.example` (names only).
- `contracts/bridge/evm/test/FuelRouteMainnetFork.t.sol` on `MainnetLifiFork`: Permit2 + the recorded USDC→AZTEC quote
  to a public recipient and to the mainnet PrivateFPC; AZTEC identity; a token leg reverts with the signer's balance
  unchanged; a paused gate reverts. `lifi-fixtures.ts`'s suite selector gains it.
- Sandbox: `test/integration/fuel-route.integration.test.ts`: the conductor on the sandbox chain (with the swapper),
  crash-resume, adopt, `verify-l1 --strict`, one gas-only send claimed public and one private.
- Validation gate: base commands; `bun run --cwd packages/bridge-core test:integration` passes; the contract gate of
  1.1 passes. The fork suite is an owner keyed run (archive `ETH_RPC_URL`) and a precondition of the runbook's
  promotion, not of the merge. Layers: unit, integration (sandbox).

**Phase 1.4 — the runbook.** ✓
- `bridge-generation` SKILL: "Branch F: mainnet fuel route" (preconditions: the security lane, the line gate,
  owner authorisation, the fork suite green; then intent build → keyed deploy → `verify-l1 --strict` → canary →
  promote). `UPDATE.md`: the line table. `contracts/bridge/evm/README.md`: the gate.
- Remove the stale fork follow-up entry from `follow-ups.md` (D16).
- Validation gate: `bun test scripts/ci-cd/doc-links.test.ts` passes; base commands. Layers: lint.

### Arc a2: the SDK package and its public interface (waits for the owner's answer)

**Phase 2.1 — the package and the moves.**
- Add `packages/sdk/{package.json,tsconfig.json,tsconfig.build.json,vitest.config.ts}`; `git mv` the modules listed in
  Proposed architecture with their tests; extract `router-receipt.ts`; delete `progress.ts`/`status.ts`; move
  relative imports to `.ts` specifiers.
- bridge-core declares the SDK and imports it. Every importer of a moved symbol switches to the SDK's subpath: the app,
  bridge-core `src/` and `scripts/`, the sandbox, `tests/browser`, `packages/testnet-relayer`. bridge-core's barrel
  keeps only what bridge-core owns (D17). `apps/tools`, `apps/tools/tests/browser` and bridge-core tsconfigs gain
  `allowImportingTsExtensions`. A test pins that `packages/sdk/src` imports no `node:` built-in.
- CI: `workspaces.test.ts`, `aztec-line.test.ts` (`PIN_SOURCES`), `published-packages.test.ts`, the path filters of
  `pr-quick.yml`, `pr-tools-e2e.yml`, `bridge-contracts.yml`, `_bridge-contracts.yml`, and
  `behavior-gating.test.ts`. Aggregator names do not change.
- Validation gate: base commands; `bun run lint:actions && bun run test:ci-gating`; `bun run --cwd
  packages/bridge-core test:integration`; the moved tests pass unchanged; `layout-identity.test.ts` extended to the
  SDK passes. Layers: typecheck, lint, unit, integration.

**Phase 2.2 — the build.**
- `scripts/stage.ts`, `scripts/pack-check.ts`, a consumer fixture under `packages/sdk/test/consumer/` with its own
  committed lockfile and the 7-day gate, installed frozen with install scripts off.
- Validation gate: `bun run --cwd packages/sdk pack:check` passes: the tarball typechecks under `NodeNext` and
  `Bundler`; each published entry imports in Node and in Bun; `./bridge` loads the hub artifact and its digest
  matches; `./internal` is not exported; the packed file list holds no source map to `src`, no script, no `.env*`.
  Layers: package.

**Phase 2.3 — the L1 leg.**
- `depositFuel`, `depositToken`, `probeFuel`, `quoteFuel`, `quoteBridge`, `events.ts`, `errors.ts`; `runSend` splits
  in the order of data flow steps 2–4: line gate, chain assert, re-quote, prepare, awaited persist, approval, chain
  assert, sign, send with the network's chain, confirm. The default LI.FI client lives here. The trust-root checks
  of D11 (Key interfaces) run in `parseNetwork` and once per network before the first prompt.
- Tests: `persist-order.test.ts` (no `signTypedData` before `persist` resolves; a rejected persist yields
  `persist-failed` with `submission: "none"`); `events.order.test.ts` (each shape's sequence, `seq` monotonic, every
  named fact persisted first); `quote.test.ts` (a slice below the reviewed floor refuses before signing; a LI.FI
  venue with no `fetch` refuses with a typed error, never "no route"; a probe below a pool's minimum does not block a
  quote that clears it); `trust-roots.test.ts` (a genuine router whose `PERMIT2` or portal is the attacker's, a foreign
  `SWAP_TARGET`, a non-canonical `permit2`, a slippage above the cap, a genuine factory on a registry whose rollup
  reports a foreign Outbox: each refuses before any prompt; the bundled testnet manifest passes); a wrong-chain wallet costs no prompt and no `persist` call. The pinned hashes join the
  ABI-pins step of `_bridge-contracts.yml`, which rebuilds them from the forge output.
- Validation gate: base commands; `bun run --cwd packages/sdk test`. Layers: unit.

**Phase 2.4 — the L2 leg.**
- Move the app blocks; `claimFuel`, `claimToken`, `capabilitiesFor`; `AbortSignal` at safe points; the ladder's
  `{ kind: "stop", why }` becomes a typed `FeeStop` code, and the app keeps today's sentences in a copy table.
- The app's current orchestration calls the moved blocks, so its behaviour is identical in this arc.
- `findDepositTx` gains gas-only records, matched by the fuel secret hash in the router's `Deposited`, and filters on
  the payer before its candidate cap, so a stranger's look-alike event cannot keep a search incomplete.
- `wallet-fee-budget.ts` takes `Reads.aztecNode` instead of the app's `NETWORK.nodeUrl`, and its gas-limit cache is
  keyed by node, so two networks on one page never share limits.
- Tests: `claim.resume.test.ts` (a record at each persisted checkpoint resumes without a second send; a registration
  hash whose transaction was dropped re-registers, one that mined claims plainly; a gas-only record with no deposit
  hash finds its deposit); `fee-stop.copy.test.ts` in the app (each code maps to today's exact sentence); an abort
  mid-wait settles with no send.
- Validation gate: base commands; the browser suite. Layers: unit, e2e.

**Phase 2.5 — the public API in the sandbox.**
- `packages/bridge-core/test/integration/sdk-flows.integration.test.ts`: one cell per shape through the public entry
  points (fuel identity public and private; fuel swap public and private; token public and private, first-time; token
  plus gas public and private) and one crash-resume cell; each asserts balances or credit and the event sequence.
- Validation gate: `bun run --cwd packages/bridge-core test:integration` passes. Layers: integration.

### Arc a3: the app's send lanes on the SDK, and ask3

**Phase 3.1 — the send lanes.**
- `useSend.ts`: `executeSend` calls `depositToken`/`depositFuel`; `persist` builds, seals and reads back the record
  (today's `openSendRecord`, `sealPrivateRecord`); an event map drives `setRecordStep`. Today's split stays: a public
  send's row is provisional until its signature (discarded on a failure before it), a private send's row is permanent
  from its seal (kept on a non-rejection failure, `useSend.ts:723-731, 859-868`).
- `useFuelQuote.ts`'s sizing calls `probeFuel`, its signing-window re-quote `quoteFuel`; `useGasShare.ts` calls the
  SDK's sizing; `contracts/bridge-generation.ts` builds a `Network` only when the manifest has a route (the mainnet
  placeholder keeps its identity-only parse, pinned by its existing test); `useTokenSelection.ts` calls
  `resolveToken`; `lib/capabilities.ts` composes `capabilitiesFor` with the resolved tokens.
- Tests: the existing `useSend.test.ts` cases, re-pointed; two parity cases on a non-rejection failure at approval: a
  public send leaves no row, a private send keeps its row.
- Validation gate: `bun run audit:tools`; the browser suite. Layers: unit, e2e.

**Phase 3.2 — ask3: LI.FI through the SDK, proven in the browser.**
- `network-targets.ts`: `https://li.quest` in the local target's `connect-src` only, pinned equal to the SDK's
  `LI_QUEST_API` origin; testnet and mainnet unchanged.
- `refineRouterBlock`: a sandbox chain (`SANDBOX_LIFI_CHAIN_IDS`) may name a router without a swapper; Sepolia still
  may not. `SandboxLifiContracts.ethereum` gains `diamond`; the sandbox handle exposes the router's `SWAP_TARGET`
  (`TestnetFuelSwapper`, which speaks LI.FI's swap ABI).
- `local-target-loader.ts` and `agent.sh`: a second local bundle, the LI.FI venue, without `fuelSwapper` and with the
  sandbox book's `diamond` set to the swap target, served under `/lifi/`.
- `fixtures/egress.ts` answers `https://li.quest/v1/quote` from the recorded mainnet same-chain quote re-encoded for the
  sandbox (chain, tokens, amount, router, `toAmount` from the swapper's `quote()`, tool `sushiswap`); every other
  request is still aborted.
- `specs/deposit-gas-lifi.spec.ts`. Cell A: the review names the LI.FI venue; a gas-only send settles; the receipt shows
  the Fee Juice. Cell B: a quote whose `to` is not the book's Diamond leaves the gas route blocked and opens no prompt.
  Failure caught: the app's quote has no LI.FI client, or a hostile quote reaches a signature. A unit test cannot
  prove the CSP, the bundle wiring and the rendered route together. Estimate 90 s for both; measure.
- Tests: `manifest-v2.test.ts` (31337 may omit the swapper, 11155111 may not, chain 1 refuses one);
  `network-targets.test.ts` (local admits li.quest; testnet and mainnet do not).
- Validation gate: base commands; `bun run lint:actions && bun run test:ci-gating`; the browser suite with the new
  spec; then, from `apps/tools`, `bun run build:testnet && bun run verify:build-target testnet` and `bun run
  build:mainnet && bun run verify:build-target mainnet` (the verifier reads one `dist/`). Layers: unit, e2e.

### Arc a4: the app's claim lanes on the SDK

**Phase 4.1 — the claim engine.**
- `useBridgeJournal.ts` keeps the locks, guards, unseal, completion and attention; `runDepositClaimLocked` calls
  `claimToken`/`claimFuel` with `signal` tied to `bumpGen`, `persist` = `patchRecord`, and an event map to
  `setRuntime`; the receipt soft cap maps to `receipt-timeout`, which shows today's note and re-arms Retry.
  `fuel-recovery.ts`'s standalone claim goes through `claimFuel`. Cross-chain records claim through the same entries.
- Tests: `runtime-map.test.ts` (every event maps to today's exact `step`/`stepDetail`); `persisted-records.test.ts` (a
  fixture of current-shape records at each stage resumes with no migration); the PR body maps each removed
  `useBridgeJournal.test.ts` case to its new home.
- Validation gate: `bun run audit:tools`; the browser suite (recovery, registration-retry, fee-states, spike, exits and
  activity at retry 0); the sandbox integration suite. Layers: unit, integration, e2e.
- **Deviation (D67).** The premise did not hold: the SDK's claim entries order the claim differently from the app's
  engine in eight ways a person would notice (`OWNER-ASKS.md` §10). a4 ships the app's engine unchanged, two SDK
  fixes the comparison found (D68, D69) and the claim's prompt events (D70); the port waits for §10.

### Arc a5: the publish setup

**Phase 5.1 — README, examples, workflow.**
- `packages/sdk/README.md` (flows, events, persistence duty, CSP origins, the line gate, supported tokens),
  `examples/{fuel,bridge,resume}.ts` (typechecked, not run).
- `.github/workflows/publish-sdk.yml` (D22), `workflow_dispatch`. Job `pack` (`contents: read`): build → `test:all` →
  `pack:check` → upload the tarball and its SHA-256. Job `publish` (needs `pack`; environment `npm-publish`, restricted
  to `main`; `id-token: write`): download, check the digest, `npm publish <tgz> --provenance --access public
  --ignore-scripts`; no checkout, no install. `pr-quick.yml` runs `pack:check` on SDK paths.
- Validation gate: `bun run lint:actions && bun run test:ci-gating`; `bun run --cwd packages/sdk pack:check`; the
  examples typecheck in `typecheck:all`. Layers: lint, package. The owner configures the trusted publisher and runs
  the first publish.

### Arc a6: the SDK's claims show what the card shows, then the app's claims run on them

The owner answered §10 with ask26: *"Before the app's claims move onto the SDK, the SDK's claim entries gain, for every
integrator, what the app's claim card shows today: its progress events, a resume that watches and never prompts, a
status for the Ethereum confirmation wait, and the claim-without-gas choice. The SDK keeps its safer behaviours (the
early fee check, claiming gas a claimed-elsewhere token left, no second fee after an interrupted prompt). Then the
app's claims run on the SDK."* The card's whole visible budget is §10's items 1, 2, 3, 7 and 8, item 8 with P7-02's
sentence (*"This app could not check the bridge on this network. Nothing was sent."*). Every other state shows what it
shows today. A difference the port cannot avoid would be an `OWNER-ASKS.md` entry that holds 6.3 until answered; the
panel found none that is reachable (D86).

Two PRs: 6.1 and 6.2 change the SDK and the journal and leave the app's behaviour as it is; 6.3 ports the claims and
carries the close-out.

**Phase 6.1: the SDK's claim entries (PR 1).**
- Events. All additive except `arrival`, `claim-requested` and `claim-sent`, which change before the first publish:
  - `deposit-recovery`: `searching` before a hash-less record's search, `reading` (txHash) before the receipt read,
    `waiting` (txHash) when a direct read finds the deposit unmined; the signal is checked before the run waits (the
    Ethereum confirmation status).
  - `arrival`: `counting` carries `block`, the L2 block read; the checkpoint count never rises within one call and
    reports `checkpointsLeft: 0` when the gate passes; `wallet-sync` comes before every simulate with `counted` (a gate
    waited), not only after a refusal.
  - `claim-requested`, `claim-sent` and the new `claim-waiting` carry `leg: "token" | "gas"`, since a token claim can
    claim its leftover gas in the same call. `claim-waiting` comes before every receipt read of a watched hash with
    `poll` (from 1 per hash) and `unreachable` (consecutive failed reads), and again with the same `poll` as soon as a
    read changes that count, recovery to 0 included; the signal is checked before each read.
  - `claim-verifying` (txHash, `checking` | `wallet-sync`): a resumed claim's success being checked (D74).
  - `claim-landed` (`via`, txHash?): the token claim landed, before any leftover gas claim (D84).
- Behaviour: D74 (a resumed success settles on its message's nullifier), D75 (`claim-dropped`, never a send again in
  the same call), D76 (`ClaimOptions.watchOnly`), D77 (`claimedByOther` persisted as read), D78 (`withoutGas`, and
  `claimFuel` on a token + gas record's gas), D79 (a gas-only claim's hash), D80 (`deposit-not-found` names its
  search's result), D81 (`claimRetired`, the one retirement rule), D85 (an invalid message refuses before any fee),
  D87 (deposit facts are searched for only when the leaves are missing).
- Tests, in the existing claim suites with a scripted node and wallet:
  - each event's order and payload on a fresh claim, a resumed one and a recovered deposit; `claim-waiting` numbers
    each hash's polls from 1, and an abort before a read stops the watch with nothing settled;
  - a resumed token claim that dropped or reverted throws with its hash cleared and nothing sent; a gas-only record
    holding only its fuel block's hash (the write the engine interrupted) stops on an included or pending receipt as
    today and claims again on a dropped one;
  - the first failed receipt read and the recovery are reported by that same poll;
  - `watchOnly` throws `needs-prompt` before any fee read on an unsent record and after `claim-landed` before the
    leftover gas, sending nothing;
  - a resumed success with a live nullifier keeps watching until the nullifier shows, across re-entries, an invalid
    one throws `message-invalid`; a fresh claim
    whose message reads invalid refuses before the ladder (an unregistered token whose probe would pass);
  - `withoutGas` pays from held gas and settles with the gas open; `claimFuel` then claims it on a completed record
    and on an unfinished `claimedByOther` one, and refuses an unsettled one;
  - `claimedByOther` is written before the leftover gas prompt and dropped on a live reading;
  - a record with its leaves but no deposit hash claims without a search; `claimRetired` on each record shape.
- README event and error tables; `examples/resume.ts` resumes on load with `watchOnly`.
- Validation gate: `bun run lint`, `bun run typecheck:all`, `bun run test:all`, `bun run --cwd packages/sdk
  pack:check`, the sandbox integration suite. Layers: unit, integration.

**Phase 6.2: the journal's claim writer and record views (PR 1).**
- `claim-view.ts` (bridge-core): `claimView(rec): DepositRecord | undefined`. Schema 3 as stored; schema 4 without
  `route`, as schema 3; schema 2 with `assetKind: "fee-juice"` and a fuel block as intent `gas`, without
  `assetKind`. Anything else is undefined (D86).
- `packages/bridge-core/src/journal.ts` `patchRecordDelta(kv, id, base, next)`: one load, guard and write, on the
  stored record's own lane and shape. It refuses (throws, writes nothing) when the record is missing, when the stored
  record's view no longer has `base`'s claim identity (today's `CLAIM_SNAPSHOT_FIELDS` and the fuel block's secret
  hash, leaf and message hash, compared view to view so schema 2 and 4 records compare as their views), or when a
  field `next` changed from `base` holds neither `base`'s value nor `next`'s (top level, and field by field inside
  `fuel` and `token`). `updatedAt` is never compared. Fields the view lacks (`route`, `sealedEnvelope`, `sealerL1`,
  `blocked`, `assetKind`, `schema`) never enter a delta.
- The storage unit is the whole journal array, so the guard is a compare-and-set only between writers that hold
  `locks.journal`. The claim's writes take it, and so do the writers that change a record while it is being claimed:
  discovery's patch and its reseal (`crosschain-watch.ts`), the card's `reconcileFuelConsumed`, and `discard`; they
  take it in 6.3, with the claim writer's first caller. The send flow's writes, which precede a record's claim, stay
  as they are (D82).
- `isRetirable` (journal pruning) and `resumeActionFor` call `claimRetired`; `isRetirable` keeps its cross-chain
  outcome rule on top. `backup.ts` validates the top-level `claimAttempt` (boolean) and `claimAttemptAt` (finite
  number), as it does the fuel block's.
- Tests: the first persist of a schema 2, 3 and 4 record writes; a write whose changed field, or whose claim identity,
  another writer moved between read and write refuses, and one that finds `next`'s value already stored writes; a claim
  write landing after a discovery write or a discard loses neither; a delta
  leaves `route`, `sealedEnvelope` and a discovery patch intact; a cleared field is deleted; a malformed imported latch
  is refused. The interleaving over the in-memory locks is tested in 6.3, with the writers that take them.
- Validation gate: base commands; `bun run test:all`. Layer: unit.

**Phase 6.3: the app's claims on the SDK (PR 2, with the close-out).**
- `useBridgeJournal.ts` keeps what is not the claim's: `claimTarget`, the malformed-hash and recipient guards, the
  token-block check and wallet grant (`prepareSendLane`), the unseal and its secret cache, the record lock and its
  release between receipt rounds, the generation, the resume selection, the claimed-by-other revalidation's stop,
  completion's side effects and the card's runtime. The run calls `claimToken` (`claimFuel` for intent `gas`) on
  `claimView(rec)` with:
  - the network from `bridgeNetwork()`. On a record with no claim sent, a refusal shows P7-02's sentence (item 8). On
    a record whose claim was sent, a node that does not answer narrates today's "node unreachable — retrying (n)"
    and the check runs again on the next poll; a mismatch shows its own message under today's template, as an
    unexpected failure does today;
  - the session wallet behind a decorator: `simulateTx` through `retryOnUnregistered` (today's quiet
    re-registration) and `sendTx` on the `aztec` lane (one prompt at a time across records); the SDK gains nothing
    for either;
  - `secrets` from the claim material (`claimSalt` from the sealed secret, `fuelSalt` from the envelope's salt); a
    run without material (a private record not unsealed) calls the SDK only to watch a sent claim, as today;
  - `watchOnly` when the run resumes a record this session did not start (today's prompt-free waits: a sent claim, a
    `claimedByOther` marker), and first on a click on a marked record: a marker the chain contradicts is dropped and
    the run stops, as today; one it confirms goes on to the leftover gas (item 2). A receipt round's re-entry keeps
    the mode of the run it continues;
  - `withoutGas` when the card's "Claim without fuel" was pressed (`fuelOverrideActive`);
  - `signal`: an abort on the record's generation bump, on a cross-chain record's deposit moving (the run restarts
    from the new facts, as today), on `deposit-recovery: waiting` (today's "retry in a minute"), and at the end of
    each receipt round (the wait after a hash's 45th poll): the run releases the record lock and re-enters as today,
    and the tenth round of a hash shows today's soft-cap note;
  - `persist`: `patchRecordDelta` under `locks.journal`, its base the record the SDK last persisted.
- `claim-narration.ts` (new) maps events to today's exact `step`/`stepDetail`, and outcomes to today's attention and
  note:
  - `deposit-recovery` searching / reading → `depositing` "looking for the deposit on Ethereum" / "checking the
    Ethereum deposit"; waiting → "waiting for the Ethereum confirmation", then the abort's note "The Ethereum deposit
    isn't confirmed yet — retry in a minute."
  - `arrival` → `syncing`: block and checkpoint counts and `syncBlock`, "waiting for the message to reach the L2",
    the two wallet-sync lines; on a record already claimable this session every arrival event maps to `sending`
    "checking the message".
  - `registration-requested`, `registration-sent`, `claim-requested` → today's hub-claim lines; `claim-sent` and
    `claim-waiting` → `confirming` "the claim is processing on Aztec" or "node unreachable — retrying (n)";
    `claim-proposed` → the landed dot; `claim-verifying` → today's two `verifying` lines, silent for a claim this
    process sent.
  - Control outcomes first: a round's, a generation's or a move's abort → today's re-entry or silent stop;
    `persist-failed` from a guard → a quiet stop, as today's snapshot guards; `needs-prompt` → no attention, except
    after `claim-landed`, where it is item 3's open card with today's gas sentence.
  - Then: `fee-stop` → `FEE_STOP_COPY[stop]` (item 1); `claim-dropped`, `claim-reverted`, `message-invalid`,
    `receipt-mismatch`, `deposit-not-found` (by `search`) and the gates' `message-timeout` → today's sentences and
    attentions; `claim-not-visible` for a latched claim or a sent registration → the SDK's sentence under today's
    template (item 7); any failure after `claim-landed` → "…Your tokens are unaffected — retry the gas claim from
    this card." (item 3); every other code (`user-rejected`, `deposit-reverted`, `read-failed`, `registration-*`) →
    its cause's message, humanized, under today's template, as the engine shows the underlying throw today.
- The card: "Claim your gas" runs `claimFuel` under the record lock (D78), so it never races the claim's own
  leftover gas claim, and on an unfinished `claimedByOther` record then finishes the record with a `watchOnly` claim,
  as today. The private claimed-by-other line becomes "…Your private gas is still in this record — press Claim to
  claim it.": item 2 names the "keep it" it replaces. A deployment-matching fee-juice record with no fuel block keeps
  today's `no-claimable-fuel` note.
- Removed: the engine's deposit-leg recovery, nullifier probes, gates, send and receipt classification,
  claimed-by-other completion; `launchStandaloneFuelClaim` and `claimFuelStandalone`; the hub and Fee Juice claim
  builders in `useSend.ts` and `deposit-flow.ts` and the journal deps only they used. Withdraw keeps its own.
- Tests: `claim-narration.test.ts` (every event and outcome to today's exact attention, step and note);
  `persisted-records.test.ts` (fixtures of schema 2 fee-juice, 3 and 4 records at each stage, a gas-only record left
  with only its fuel hash, a record with leaves but no deposit hash, resume through the view with no migration); the
  engine's suites re-pointed, the PR body mapping each removed case to its new home; the card's gas claim against a
  running claim. No new browser scenario: the touched specs already drive every changed card state.
- After-shots of each card state that changes: the early fee-stop, a claimed-elsewhere token's gas claim and the new
  private line, the leftover gas claim and its failure, the latched-attempt wait, the trust-check refusal.
- Validation gate: `bun run audit:tools`; `bun run test:all`; the browser suite at retry 0 (recovery,
  registration-retry, fee-states, spike, exits, activity, l1-wallet, accounts, deposit-crosschain), wall-clock before
  and after; the sandbox integration suite. Layers: unit, integration, e2e.

## Decision ledger

Each row: the decision, its source, the rejected view with its reason.

- **D1 One new published package, bridge-core depends on it.** All three drafts. Rejected: publish bridge-core
  itself (it mixes app state, ops and protocol, and its barrel would become a public contract); bundle bridge-core
  into an SDK façade (the declarations would need a bundler and the boundary would stay unclear).
- **D2 The SDK takes the signers; `./protocol` keeps the pure builders.** All three. Against: Safe, account
  abstraction and custom pipelines want unsigned data. Rejected: the L2 claim is not one transaction (register-if-first
  by simulation, the private two-transaction claim, the race retry, the wallet-reading fee ladder), the L1 safety
  rules are ordering rules, and viem's `WalletClient` wraps any EIP-1193 source, so Safe or AA is a provider shim.
- **D3 Promises, not Effect 4.** All three. Against: concurrent polls with deadlines fit `Schedule` and `TestClock`.
  Rejected: the public API must be promise-first anyway, `sendTx`/`proveTx` cannot be interrupted, 4.x is a new major
  release, the loops already take injected sleeps, and `my-stack` advises against Effect around uncancellable promises.
- **D4 SDK v1 scope: ask5's flows.** Driver and Opus. Codex: move the cross-chain source leg too. Decided: the source
  leg (about 2,500 lines) would double the public contract and the security surface; cross-chain claims do run on the
  SDK (a4). Owner ask §4.
- **D5 Flows (1) and (3) are one fuel entry with two venues.** Opus (verified: cell 18 and the router's identity
  branch). Rejected: a separate direct-portal flow nobody calls today.
- **D6 Free functions per entry point.** Opus. Rejected: a `createBridge` object (driver, Codex). An object is not
  inherently eager (Codex, contradiction check); the reasons are statelessness (no signer or network held between
  calls) and one import per flow. The artifact isolation comes from the dynamic hub import and its import-graph test.
- **D7 The record is the app's protocol subset.** Opus. Codex: a neutral `RecoveryState` with an app adapter, so the
  browser journal schema is not the execution API. Decided: the SDK type holds protocol facts only (no UI state,
  seals or attention), with the field names stored records already use; this removes an adapter and a migration.
- **D8 Errors throw one `BridgeError` with `submission` and `retry`.** Opus's class with Codex's tri-state
  submission. Rejected: `Result<T>` returns (Codex), which every caller must unwrap for the same three fields.
- **D9 `tsc` emit with `.ts` specifiers and a staged `dist/package.json`.** Driver and Codex. Opus: `bun build`, which
  inlines the artifact. Decided: one tool; `stage.ts` copies the artifact and rewrites its one out-of-package
  specifier; a declaration bundler only if `pack:check` fails `NodeNext`.
- **D10 `FuelOnlyGate` over a router change or a real factory.** All three. A router change voids the testnet
  router's verification; a real factory without a hub mints portals that strand deposits. `Ownable2Step` with
  renounce refused, as `PortalFactory` (the first draft misread it as `Ownable`; Opus corrected it).
- **D11 Trust roots independent of the manifest.** Opus proposed a code-hash check; both audits showed that a hash
  compared with the manifest's own addresses passes a genuine router built on an attacker's Permit2; the final pass
  extended it to the registry and the portal implementation's Outbox. Known limit: an RPC that lies about code
  passes; bundled networks are the stronger root.
- **D12 The manifest gains `fuelRoute`, legal only with `bridge: null`.** All three (names differ). Rejected: making
  `bridge` fields optional, which weakens every existing derivation check.
- **D13 The ask3 cell drives the real app on a sandbox variant.** Opus and driver. Codex: a test-only page mounting
  `useFuelQuote` with a chain-1 fixture manifest, quote only, no send, no protocol change. Decided: the real app,
  CSP and send path are what failed; the sandbox exemption follows the existing `registerSandboxLifi` design.
- **D14 Owner-gated mainnet line.** Codex and Opus. The owner chooses (§3); the gate's breadth is D20.
- **D15 Arc order: the fuel route first.** Driver. Orchestrator and the drafts: SDK first. Decided: a1 has no
  interface dependency, so it uses the owner's review time; a2 then moves already-fixed modules.
- **D16 The stale follow-up.** Codex found it; verified. a1 removes the entry.
- **D17 Importers migrate; no re-export barrel.** Opus (contradiction check). Rejected: bridge-core re-exporting the
  moved symbols (the driver's first draft), which leaves two import paths for one symbol to drift apart.
- **D18 The execution modules are workspace-only (`./internal`).** Opus (contradiction check): bridge-core's scripts
  and sandbox call `runSend`, `claimViaHub` and `readRouterDeposit` for good. Rejected: publishing them in
  `./protocol`, which would make orchestration internals a semver contract.
- **D19 Probe and quote stay distinct.** Codex (contradiction check): a floorless probe sizes; an executable quote
  signs. Merging them would hide routes the real amount supports.
- **D20 The line gate refuses every mainnet deposit.** Both reviewers (contradiction check): refusing only claims and
  private deposits was option B under option A's name.
- **D21 The moved code takes its scan primitives, frozen ABIs and protocol types with it.** Codex (contradiction
  check): `deposit-reconcile.ts:10-23` and `send-flow.ts:29-31` import modules the first draft kept private.
- **D22 Publishing in two jobs.** Both audits: one job would run every dev dependency beside the OIDC token. The
  publish job holds the token and runs no repository code.
- **D23 Chain assert and re-quote before `persist`.** Opus audit: the app's persist is a seal prompt, and today a
  wrong chain costs no prompt (`useSend.ts:684-690`); the first order would have been a visible change.
- **D24 No `checkpoint`-shape support in a1.** Opus audit (proportion): under option A the shape is never parsed on a
  send; a later arc adds it only if the owner picks B or C. Moot since §3's answer: every network runs the line.
- **D26 `PRIVATE_FPC_ADDRESS` stays; the manifest's FPC is checked against its line.** Deviation from 1.2's "delete
  the export". The tree: the app registers and claims through the instance it derives from the installed artifact
  (`apps/tools/src/contracts/private-fpc.ts:28-33`), so on every supported line the manifest's FPC can only be the
  constant, and an unsupported line refuses every send before an FPC is used. Rewiring the twelve runtime users (and
  about twenty script sites the plan did not count) would change no behaviour, and the plan's "FPC differs" case cannot
  exist under its own parse-time check. The SDK's `parseNetwork` takes the manifest's validated value (a2).
- **D27 Mainnet runs the installed line.** Owner answer §3, verified read-only: the registry's `getCanonicalRollup` is
  `0xE37A…402f`, version 2070860440, whose node reports 6.0.0 and whose FeeJuicePortal is `0x5343…f3b3`; the 5.0.1
  rollup (4248422647, portal `0xaf73…691c`) is still listed. a1 re-pins every mainnet constant to the canonical rollup;
  the line gate (D20) becomes data-driven and refuses nothing today. Supersedes D14 and D20's mainnet refusal.
- **D28 The mainnet gate's owner is the pinned mainnet signer** (owner answer §5); the conductor refuses any other.
- **D29 `fuelRoute` names its registry.** The registry keeps the 5.0.1 rollup listed and its portal still takes
  deposits, so a route bound to it would strand every fuel leg. The conductor, `verify-l1` and `live-intent` check
  the portal's `ROLLUP()` against `registry.getCanonicalRollup()`; the manifest carries the registry those checks read,
  and `live-intent` pins it to `MAINNET_REGISTRY`.
- **D30 `fuelRoute.fuel` carries `fjPerTx`** (lane mainnet-1's coordination note): the gas share sizes the claim from
  it. `calibrate` writes it into a route (no `fjRegister`: a route registers nothing), and `live-intent` refuses a
  route candidate whose `fjPerTx` is 0.
- **D31 The mainnet route's canary is not in a1.** No script sends through a candidate route from a pinned mainnet
  canary key, and that key is unpinned; Branch F documents the step and stops before calibration until both exist
  (`follow-ups.md`). The calibration input it would produce is the step mainnet-1 needs.
- **D32 A mainnet intent is a `live-intent` network profile, not a second tool.** Mainnet has no reset baseline: its
  node is pinned against the committed `mainnet-bridge.json` and `MAINNET_REGISTRY`, and the registry's canonical
  rollup is read on L1. The testnet path is unchanged; the node's absent `feeAssetHandler` is accepted only when the
  pin has none either.
- **D25 Tokens resolve once, through `resolveToken`.** Final Codex pass: a permissionless token's L2 address needs its
  words and decimals and an async derivation (`hub-token.ts:36`), which `capabilitiesFor(net, Address[])` lacked.
  Rejected: an async `capabilitiesFor` with `Reads`, which would resolve the token a second time beside the quote.

- **D33 A workspace-only `./l1` entry for Workers.** esbuild resolves every member of a barrel it reaches, so the
  testnet relayer's Worker could not import one ABI from `./protocol` without the Aztec graph (`tty`). `./l1` names the
  viem-only slice (the router and LI.FI ABIs, the LI.FI book and gas table); the SDK is `"sideEffects": false`.
  bridge-core's bundle guard walks whole SDK entries.
- **D34 bridge-core re-exports nothing it moved, the relayer included.** `across-fill`'s re-exports of
  `DEPOSIT_ROUTER_ABI` and `lifiBook` went with D17; the relayer imports them from `@unleashed/sdk/l1`.
- **D35 Workspace entries for the two artifacts.** `./artifacts` (the hub, eager) and `./private-fpc-artifact` (lazy)
  keep their split; which of them a published entry exposes is 2.2's staging decision.
- **D36 The frozen manifests stay bridge-core's fixtures.** The moved SDK tests that read
  `fixtures/sandbox-manifest.json` and `test/fixtures/mainnet-bridge.placeholder.json` read them by relative path;
  bridge-core's script tests are their other readers.
- **D37 The layout guarantee for the SDK is its own imports test.** `src/imports.test.ts` scans the shipped source:
  no Node built-in, and every bare import is a declared runtime dependency that resolves from the SDK. It replaces
  extending bridge-core's `layout-identity.test.ts`, which resolves assets rather than imports.
- **D38 `tsconfig.build.json` arrives with the build.** 2.1 lists it; it lands in 2.2 with `stage.ts`, its only user.
- **D39 Six error codes beyond the sketch.** `invalid-request` (a malformed argument), `invalid-network` (a `Network`
  `parseNetwork` did not build), `fetch-unavailable` (a LI.FI venue with no `fetch`), `read-failed` (an RPC read the
  run cannot do without), `approval-failed` (the Permit2 approval reverted or never confirmed) and `aborted` (the
  caller's signal, honoured only where nothing is in flight). Each carries `submission` and `retry` like the rest.
- **D40 `parseNetwork` runs every trust-root check.** The node anchoring, the derivations and the on-chain bindings
  and code pins all run at parse; a parsed `Network` is the proof (a module-private `WeakSet`), and every entry point
  refuses one it did not build. Re-parsing is how a long-lived integrator re-checks.
- **D41 Private gas ceilings price from the node until the caller says otherwise.** `quoteBridge` takes
  `gas.maxFees` (the integrator's wallet quote, `walletMaxFees` in the app) and otherwise the node's worst predicted
  fees; the claim re-prices from the wallet before it spends anything.
- **D42 `capabilitiesFor` is in the root entry, re-exported by `./bridge`.** A gas-only integrator needs a grant
  without loading the hub artifact. It grants claims only: no exit, no authwit.
- **D43 The tarball holds only what the five published entries reach.** `stage.ts` emits from those entries, copies
  the three JSON assets they import with their digests checked, and derives the peers (exact at the Aztec pins,
  `viem` a caret range) and `zod` as the one dependency. `./artifacts`, `./private-fpc-artifact`, `./l1` and
  `./internal` stay workspace-only. The consumer fixture installs frozen under the committed gate; only a relock
  re-checks it.
- **D44 Exits stay out of v1 (owner answer P3-05: only if modest).** They are not: an exit is the L2 burn under an
  authwit, a proving wait of up to an epoch, the Outbox witness, the L1 consume racing relayers (`consumedByOther`),
  a private exit's fee ceiling, and a record and resume for each step. That is a second lane the size of
  `claimToken` with its own sandbox cells, and no arc here moves the app's exit engine. The app keeps its exit code.
- **D45 `verify-l1` measures against the SDK's pins.** It hashes the deployed runtime with the SDK's `pinOfBuild` /
  `deployedHash` and also requires its fresh build to equal the SDK's `CODE_PINS`, so a deployment it passes is one
  `parseNetwork` accepts. The bindings it shares with `parseNetwork` come from the SDK's `trust-roots.ts`.
- **D46 `findDepositTx` filters on the payer for every record that names its signer.** A published secret hash can
  be replayed by anyone; without the filter, look-alikes past the candidate cap keep a token record's search
  incomplete just as they would a gas-only one's.
- **D47 A fee stop is a code; its words belong to the host.** The ladder throws `FeeStopError(stop)` and returns
  `{ kind: "stop", stop }`; the claims surface it as `BridgeError("fee-stop", …, { stop })`, retry "never" for the
  stops no wait lifts (a malformed hash, FPC drift, a missing salt or secret, a floor) and "after-wait" otherwise. The
  app maps each code to today's sentence in `fee-stop-copy.ts`, pinned by a table test.
- **D48 The claims persist through the caller, in call order.** The ladder writes through a store whose merge is
  synchronous; the SDK's store applies the patch to the claim's record at once and queues the caller's `persist`, and
  every hub seam (`onRegisterSend`, `onRegistered`, `onClaimSend`) is awaited, so the latch it writes is persisted
  before the wallet is asked. A failed persist surfaces at the next awaited one.
- **D49 A token claim settles only after the gas it bridged.** A public claim paid from held gas leaves the bridged Fee
  Juice unspent; `claimToken` claims it on its own before the record completes, so no completed record strands gas.
- **D50 The self-pay floor of a direct Fee Juice claim is `feeJuice.minFj`.** The route's `minFuelFj` is the send
  budget; the claim floor is the manifest's Fee Juice floor, as in the app.
- **D51 A code pin groups each immutable's copies.** The compiler writes an immutable at every place it is read;
  `deployedHash` masks them per immutable and refuses a runtime whose copies of one immutable disagree, which a
  genuine constructor never writes. `verify-l1` and `parseNetwork` share the rule.
- **D52 Secrets travel with every persist and never in a record.** `persist(record, secrets)` gets the run's secrets on
  every call, so a store that keeps the latest call alone never loses them. The ladder sees `fuelSalt` through a view;
  what it writes back drops it. A claim's failed persist is `persist-failed`, retry "safe": nothing was sent after the
  last record the caller holds.
- **D53 After the deposit hash is persisted, a deposit error is retry "never".** The money is on its way; calling
  `depositFuel` or `depositToken` again would send a second deposit. Its message names `claimFuel`/`claimToken`, which
  resume from the record.
- **D54 A token claim whose bridged gas can never be claimed settles, saying why.** A permanent failure of the
  leftover gas claim settles the record with `gasLeft`; a transient one keeps the record open and names the landed
  token claim.
- **D55 A claim attempt without a hash ages out.** A latch the SDK persisted before the wallet answered blocks a second
  send until the message's nullifier answers or `PRIVATE_ATTEMPT_STALE_MS` passes, for the token claim and for the
  public gas claim beside it.
- **D56 Only the SDK's own quotes and frozen networks reach a send.** `depositFuel`/`depositToken` refuse a quote
  `quoteFuel`/`quoteBridge` did not return, and every quote, resolved token, network, manifest and bundled pin is
  deep-frozen. The deposits are `async`, so a refusal rejects the promise and never throws past a `.catch`.
  `parseNetwork` refuses a route whose fuel floor is under the claim floor (D50), which no claim could pay from.
- **D58 Every registration is latched before its prompt.** One paid from held credit persists `claimAttempt` before
  the wallet is asked and lifts it with the hash; a gas attempt latched without its hash is settled by its message's
  nullifier on the private path too, so a claim pays from the credit a landed registration left.
- **D57 The SDK does not pin mainnet's guardian yet.** A hostile manifest can name a genuine-code generation someone
  else deployed, whose guardian can pause it (a delay, never a transfer). The owner's guardian is pinned once the
  mainnet generation exists (`follow-ups.md`, `OWNER-ASKS.md`).
- **D59 The app sends through `depositL1` with the reviewed plan.** The public `depositFuel`/`depositToken` take only
  the SDK's own quotes (D56), which size the gas slice and its floor afresh, so the numbers signed would not be the
  ones the review showed. The app calls the internal `depositL1` with the reviewed slice and floor: it re-quotes the
  slice, refuses `quote-moved` under the reviewed floor and signs that floor. It takes only a `parseNetwork` network,
  as the public entries do.
- **D60 Selection and the route probe keep their own reads.** `resolveToken` and `probeFuel` take a checked network,
  so the wizard would wait on the node before showing a token or a route. Both stay display reads, the probe through
  the SDK's `manifestFuelProvider`; the deposit runs under the checked network and re-quotes before the signature.
  `capabilities.ts` merges `claimCapabilities`' scopes into the app's list, which holds every one of them already.
- **D61 The app leaves the pause pre-check off.** `DepositPlan.pauseCheck: false`, internal only, keeps today's path:
  a paused route ends at the router's revert. The pre-check's refusal would be new copy (`OWNER-ASKS.md` §8).
- **D62 The Permit2 deadline is drawn at the signature.** `depositL1` read the deadline's block before the approval,
  so an approval that outlasted `PERMIT_DEADLINE_SECONDS` signed an expired witness. The block is now read after the
  approval, right before the signature, for the public deposits too.
- **D63 The approval reports `requested` and `waiting`.** The rail narrates the prompt and each receipt round as it
  does today; `waiting` carries the round.
- **D64 A send checks the network before its first prompt.** `bridgeNetwork` keeps one `parseNetwork` per page and
  forgets a rejection, so a node outage refuses the send and the next send checks again. The SDK re-checks the
  wallet's chain right before the signature: a wallet that left the chain after the seal stops there, its public row
  discarded and a private one kept and flagged, where the signature used to go out. Both failures read differently
  (`OWNER-ASKS.md` §9).
- **D65 The app stops waiting for the deposit's receipt after 180 s.** The SDK waits until its signal aborts; the app
  aborts at viem's default, the wait its sends always had, and the row keeps its hash for a resume.
- **D66 The sandbox's li.quest answer is a single-swap call.** The recorded mainnet quote calls LI.FI's multi-swap
  entry, which the sandbox's stand-in Diamond (`TestnetFuelSwapper`) does not speak; `fixtures/lifi-quote.ts` keeps
  the recording's venue, identity and swap leg and re-encodes them as the single-swap call. A `lifiQuote` option turns
  the answer on per file, so every other file still fails on a request to li.quest.

- **D67 a4 keeps the app's claim engine and asks the owner (option C).** Codex: C; a claim plan of app-only
  switches (option A) is a second claim policy inside the code that protects funds, and splitting the claim into
  steps the app composes moves its invariants onto the caller. Opus: C, plus the SDK fixes and events below; asking
  first and porting once is cheaper on either answer. Decided C. Seventeen gaps, eight of them visible (§10). The
  plan's 4.1 also had two defects: the card's "Claim your gas" has no SDK entry (`claimFuel` refuses a token + gas
  record, `claimToken` returns a completed one untouched), and `persist` = `patchRecord` writes the whole record over
  other writers (the card's gas claim, discovery) and drops a schema-4 record. A port needs a guarded field-delta
  writer and a schema-3 view of a cross-chain record.
- **D68 Gas a claimed-elsewhere token left is claimed, private gas included.** `claimToken` settled a private token +
  gas record whose token another submitter claimed with its gas unclaimed; the app prunes completed records after a
  week, and the sealed salt with them. The leftover claim now runs for private records as private credit. Gas the
  landed claim itself paid with (its hash is the fuel's) is spent without a read; a call without the gas salt stays
  open (`invalid-request`, retry "safe"), since a call with it can still claim.
- **D69 A gas leg's leaves are its leaf, its message key and the Fee Juice it carries.** A token + gas record holding
  only its token leaf skipped the receipt read, paid from held gas and settled with its gas unclaimed.
- **D70 The claim reports its prompts.** `registration-requested` and `claim-requested` come right before the Aztec
  wallet is asked, so an integrator can say "confirm in your wallet" as the app does (ask5).
- **D71 A resumed claim hash is not re-verified against its message.** A writer of the caller's storage who can plant
  a landed hash can delete the record outright; the app keeps its own check.
- **D72 The publish job checks the tarball against the pack job's output.** The digest travels as a job output, not
  in the artifact, so a swapped artifact cannot carry its own; `pack:check --out` hands over the exact tarball it
  checked. The job also runs only on `main` (the environment refuses other refs only once the owner configures it),
  takes npm from `setup-node` on Node 24 (trusted publishing needs npm 11.5.1+) with its cache off, and the checkout in
  the pack job keeps no credential.
- **D73 `pr-quick` gates `pack:check` on the SDK and every file its tarball stages from outside it.** The filter is
  derived from `stage.ts`'s `ASSETS` and `DOCUMENTS` by `behavior-gating.test.ts`; `publish-sdk.test.ts` pins D22.
- **D74 A resumed claim's success settles on its message's nullifier (reverses D71).** The card says "verifying" for a
  claim it did not send, and a landed receipt that is not this record's claim (a backup's stale hash, two tabs, a hand
  edit) must not complete it; D71's argument covers an attacker who can write storage, not these. A live nullifier
  keeps the watch going on its own budget (`claim-verifying: wallet-sync`); an invalid one is `message-invalid`; an
  unknown one (no salt at hand, a failed read) settles, as the app's engine does. A claim the call itself sent is not
  re-checked. The receipt and the nullifier are separate reads with no shared snapshot, and the app re-enters its own
  claims each receipt round, so its own claim is verified too where today's engine trusts it: a node whose nullifier
  state trails its receipts holds completion back, silently, until the nullifier shows. A node that stays behind past
  the round budget, where the card would show today's soft-cap note instead of completing, is a broken node: a closed
  `known-limit` issue.
- **D75 A dropped claim clears its hash and throws `claim-dropped`, resumed or sent.** Retry "safe"; the next call
  claims again. A resume that sent again asked the wallet for a claim nobody started in this session (§10 item 4).
- **D76 `ClaimOptions.watchOnly` never asks the wallet.** It recovers deposit facts, watches a sent claim, waits out a
  latched one and reads the nullifiers; where the call would next price a fee or prompt (an unsent claim, the leftover
  gas after a landing) it throws `needs-prompt` (retry "safe") with nothing sent. A page that resumes records on load
  passes it.
- **D77 `claimedByOther` is persisted as read.** Set as soon as the token's nullifier says another submitter spent the
  message, before the leftover gas claim; cleared when a later read says live. A record whose gas claim then fails
  still says who claimed its tokens, and a resume finds it.
- **D78 `withoutGas`, and `claimFuel` on a token + gas record's gas.** `withoutGas` pays a public claim from the
  account's held gas (the ladder's `userOverride`, the card's "Claim without fuel") and settles without claiming the
  bridged gas; the private ladder ignores it, as today. `claimFuel` claims a token + gas record's bridged gas (public
  Fee Juice, or private credit) once its tokens are done: `completedAt`, or a `claimedByOther` marker. It checks the
  chain, the recipient and the network's fuel route, never the token's registration or the hub, so a blocked or
  distrusted token record still recovers its gas, as the card's "Claim your gas" does today; it writes only the fuel
  block and the deposit facts it recovers (read through the token route, whose event carries the gas leaf), and never
  completes the record. Before the tokens are done it refuses: the token claim may pay with that gas.
- **D79 A gas-only claim in flight is its top-level hash.** A send writes it there and in the fuel block, and a drop
  clears both. A fuel block hash with no top-level one (today's engine latches the fuel hash first and clears only the
  top level when a claim drops) is read by its receipt as today's ladder reads it (`priorFuelClaimStop`): included is
  the `fuel-already-claimed` stop, pending or unread the `fuel-claim-pending` stop, dropped is cleared and claimed
  again. A latched attempt with no hash at all is settled as D55 settles one. A token + gas record's gas leg is its
  fuel block's hash; a reverted token claim leaves that gas to the ladder, whose receipt read marks a setup that spent
  it consumed. A gas-only claim is a carrier-less transaction with no app phase and no teardown, so it is included only
  when its setup claimed the Fee Juice: it cannot revert after that.
- **D80 `deposit-not-found` names its search's result** (`search: "none" | "ambiguous" | "incomplete"`), as `fee-stop`
  names its stop: discarding the record and trying later are different answers.
- **D81 `claimRetired(record)` is the one retirement rule.** Whether a record is complete and its claim material may be
  dropped; today's rule, unchanged: `completedAt` is set. `settledAlready`, journal pruning (`isRetirable` keeps its
  cross-chain outcome rule on top), the engine's claim target, its resume selection and its secret-cache drop read it.
  A completed record whose gas is open still offers "Claim your gas" until it is pruned, as today; that is the rule's
  next change.
- **D82 The port.** Two PRs: the SDK and the journal writer first, with no app behaviour change, then the port. The app
  keeps what is not the claim's (guards, unseal, locks, generation, resume selection, completion side effects,
  runtime) and maps events and outcomes to today's exact lines. `persist` is a field delta guarded on the claim's
  identity under the journal lock, which every writer that changes a record during its claim now takes (discovery and
  its reseal, the card's consumed flag, discard). The send flow's writes stay unlocked: they precede the claim, and
  the whole-array exposure they share with every unlocked writer across tabs is today's documented limit
  (`journal-locks.ts`), filed as an issue. Receipt watching stays in today's rounds, so the record lock is released
  between rounds as today. The session's quiet re-registration and its one-prompt-at-a-time lane wrap the wallet the
  SDK gets, not the SDK.
- **D83 The app aborts at the Ethereum confirmation wait.** `deposit-recovery: waiting` lets an integrator show the
  wait; the app aborts there and keeps today's "retry in a minute" (§10 item 6 is outside the budget).
- **D84 `claim-landed` comes before the leftover gas claim.** Every error after it is the gas leg's, whatever step
  failed (pricing, the nullifier read, the send), so a caller can say the tokens are safe.
- **D85 A message that reads invalid refuses before any fee.** The token nullifier read already runs before the ladder;
  "invalid" now throws `message-invalid` there, as the app's engine stops before building the claim.
- **D86 No difference outside the budget is reachable, so 6.3 waits for no answer.** Checked against the tree: a gas-only
  claim cannot revert after its setup, and a record holding only its fuel hash keeps today's receipt reading (D79);
  today's engine latches a gas-only claim's fuel hash before its top-level one, so a reloaded gas-only claim already
  completes without the wallet's simulate (`priorFuelClaimStop`) and the SDK's node read changes no line; no legacy token record can hold open gas on a card (none could complete since trunk's first
  commit, and completed records are pruned after a week); the private claimed-by-other line is the "keep it" that item 2
  replaces; a sent registration the wallet does not show yet is waited out instead of registered again, which is item
  7's "a wait instead of a second prompt", with no second fee; D74's held-back completion shows no line, short of a
  broken node. A difference found
  while building stops 6.3 for an `OWNER-ASKS.md` entry.
- **D87 Deposit facts are searched for only when the leaves are missing.** A record holding its leaves but no deposit
  hash claims, as today's engine does; the search and the receipt read run only for a record that cannot claim
  without them.

## Audit verdicts

Codex ran `gpt-6.1-sol` at high; every finding was verified against the tree and accepted. `lessons/phase-0.md` logs
each consult.

- **Contradiction check, Codex (drafting session resumed): reject pending 8 corrections.** Private imports (D21); a
  Diamond-only verifier against the sandbox swapper (1.3); eager hub loading (dynamic import, import-graph test);
  gas-only `findDepositTx` (2.4); the registration-hash resume (data flow step 6); private-send parity (3.1); probe
  versus quote (D19); option B inside option A (D20).
- **Contradiction check, Opus 5.5 (drafting agent resumed): holds after 10 fixes.** `Ownable2Step` (D10); the
  sandbox's missing `privateFpc` and boot-time rollup version (1.2); `./internal` (D18); migrate, not re-export (D17);
  the artifact specifier (D9); `allowImportingTsExtensions` (2.1); D11 phased (2.3); three dropped error codes; the
  line gate (D20); "fork-tested" overstated (§3). Orchestrator notes meanwhile: relayer-1's seam and Worker core.
- **Double audit, Codex (resumed): reject, 2 High and 4 Medium.** Manifest trust roots (D11); OIDC beside dependency
  code (D22); the `@aztec-labs/ethereum` peer; the fee budget's global cache (2.4); the placeholder failing
  `parseNetwork` (3.1); `capabilitiesFor` and permissionless tokens.
- **Double audit, fresh Opus 5.5: conditional approve, 1 High, 4 Medium, 5 Low.** Wider trust roots (`SWAP_TARGET`,
  `FEE_ASSET`, the factory hash, a slippage cap; D11); publish environment and fixture lockfile (D22, 2.2); step order
  (D23); twelve `PRIVATE_FPC_ADDRESS` users (1.2); the cache (2.4); the network's chain on send; the payer filter
  (2.4); peer ranges; contract-gate preconditions (1.1); no `checkpoint` support (D24).

- **Final pass, Codex (fresh session): reject, 1 High, 1 Medium, 1 Low; all verified and accepted.** A genuine factory
  on a hostile registry freezes a foreign Outbox (`PortalFactory.sol:46`, `TokenPortalImpl.sol:45, :107`), so the
  token route's trust roots now anchor the registry and the implementation's bindings (D11, Key interfaces, 2.3);
  `capabilitiesFor` lacked a permissionless token's derivation inputs (D25, `OWNER-ASKS.md` §1); the 3.2 gate
  verified two targets against one `dist/` (paired builds). It confirmed the persist-before-sign order and D22.
- **Final pass, verification (same session resumed): approve.** All three fixes hold; no new material finding.

Arc a1, the implementation (`git diff fb90e36..HEAD`):

- **Round 1, Codex (fresh session): 2 Medium, 1 Low.** A first route's journal stamp failed its own intent's
  `verify` (fixed: the stamp may open the journal and must name the intent's network and signer); a deploy that
  lands before its journal line is redeployed on resume (inherited from `deployOrAdopt`; the fix is write-ahead state:
  known limit #30); strict `verify-l1` passed a paused gate (fixed: `--strict` fails it).
- **Round 1, Opus 5.5 (beside it): 1 Medium, 3 Low.** The same journal stamp; promotion bounds (fixed: `minFuelFj`
  0 refused, and Branch F seeds `fjPerTx` at 0 so only a calibrated route promotes; slippage stays with a2's
  `parseNetwork` cap); the portal check trusted the portal's own `ROLLUP()` (fixed: the canonical rollup's
  `getFeeAssetPortal()` must name it, verified on mainnet); a promoted route cannot be replaced (fails closed: known
  limit #31). It found the testnet `live-intent` path unchanged.
- **Round 2, Codex (same session resumed, after `origin/main` merged): no new material finding.** It exercised
  each fix's guard and its negative test, read `getFeeAssetPortal()` on mainnet's canonical rollup through the
  installed ABI, and accepted #30 and #31 as known limits. Converged.
- **Round 3, Codex (same session): no new material finding** on the one fix after round 2 (strict `verify-l1` refused
  `FuelOnlyGate`'s artifact, which records no immutables; an absent map is now an empty mask). It tightened the fix's
  comment. Closed at the three-round cap.

Arc a2, the implementation (`git diff origin/main...HEAD`):

- **Round 1, Codex (fresh session): 2 High, 3 Medium; all verified and fixed with tests.** The private fuel salt
  reached persisted records (D52); a hashless public gas attempt blocked a token claim for good (D55); recovery
  refused a first deposit's frozen metadata (the token block is rebuilt from the factory's registration when no
  registration was persisted); the standalone gas claim sent before persisting its attempt; a claim's failed persist
  said retry "never" (D52).
- **Round 1, Opus 5.5 (beside it): 3 High, 1 Medium, 4 Low.** Immutable copies that disagree passed a pin (D51); two
  deposit errors after the hash said retry "safe" (D53); the secrets left the record after the first persist (D52);
  quote and network objects were mutable between check and send (D56); the packaged manifest lacked `license` and
  `repository`, and `pack-check` passed the whole environment to its subprocesses (fixed). The mainnet guardian
  is not pinned (D57). Known limits: #43 (the reconcile window), #44 (one dropped registration read), #45 (retired
  routers' leaves). A sub-reviewer found no drift in the moved fee ladder.
- **Round 2, Codex (same session resumed): 1 High, 2 Medium; all verified and fixed with tests.** A private gas attempt
  whose registration landed without its hash re-minted the spent message for good (D58); a registration paid from held
  credit was prompted before anything was persisted (D58); a quote's nested gas leg stayed writable (D56). Fixing them
  found two more: the deposits threw their refusals synchronously, and the token claim handed the fee ladder the record
  as the call opened it. All five round-1 fixes held.
- **Round 3, Codex (same session): no new material finding.** All three round-2 fixes hold. Converged.

Arc a4, the implementation (`git diff 556af41..HEAD`):

- **Round 1, Codex (the panel session resumed): no fund loss or app-visible change; 2 Moderate, 2 Low.** Both new
  tests overclaimed (an argument-blind builder mock; one case removing three fields at once): the builder's payment,
  salt and PrivateFPC are now asserted and each missing gas field is its own case. A lost public registration race
  sends its plain claim without a second `claim-requested` (documented: once per attempt). Two sentences promised
  more than the code (the leftover comment, §10 item 2): qualified.
- **Round 1, Opus 5.5 (beside it): 1 Low regression, 2 Low docs.** A private claim its own gas paid, resumed without
  secrets, settled with a false `missing-salt`: the leftover claim now counts the landed claim's own fee as the
  spend, and a missing salt keeps the record open (D68). `gasLeft`'s TSDoc and §10 item 5 corrected.
- **Round 2, Codex (same session): no new material finding.** The fixes hold and their tests fail without them; the
  hash-equality shortcut matches only a landed claim that paid with the gas (a registration's hash, a cleared or
  hashless claim cannot match); a missing salt is caller input, so retry "safe". Converged.

Arc a6, the plan amendment (both legs read the tree):

- **Round 1, Codex: APPROVE WITH CHANGES, 4 High, 6 Medium.** A field CAS alone lets stale evidence complete a record
  (guard the claim identity, never `updatedAt`); the writer is atomic only under `locks.journal`, which discovery
  skipped; `claimFuel` on a token + gas record must not need the token's registration or `completedAt`; a fresh
  invalid message must refuse before the ladder (D85); one 30-minute watch inside the record lock is visible
  (rounds kept); a contradicted marker stops today; the gas-only hash windows are reachable; SDK wording must not reach
  notes; the `aztec` prompt lane; the top-level latch's validation.
- **Opus 5.5 (beside it): APPROVE WITH CHANGES, 4 Medium, 6 Low.** P7-02's "Nothing was sent." on a sent claim's
  resume; "Claim your gas" racing the leftover gas claim (record lock); re-entries keep their mode, and `needs-prompt`
  after a landing is item 3's open card; a CAS that finds `next` already stored writes; deposit facts searched only
  without leaves (D87); no SDK call without material for a marked private record; the private line is item 2's;
  legacy shapes; `resumeActionFor` reads `claimRetired`.
- **Round 2, Codex: APPROVE WITH CHANGES, 3 High, 3 Medium.** Owner entries must hold 6.3, not ship beside it (D86 now
  finds none reachable); the identity guard compares views; locking extended to discovery's reseal, the card's
  consumed flag and discard, the send flow left as today's documented limit (accepted); per-poll `claim-waiting`; the
  same-poll verification claim was unproven; control outcomes map first; the registration wait is item 7's.
- **Round 3, Codex: APPROVE WITH CHANGES, 1 High, 2 Medium.** A fuel-hash-only gas-only record keeps today's receipt
  reading (D79); D74's delay is unbounded on a lagging node (a closed `known-limit` issue, reopened by observed
  receipt/nullifier divergence through the watch budget on a healthy supported endpoint); the first unreachable read
  is reported by its own poll.
- **Round 4, Codex: APPROVE.**

Arc a6, PR 1 (`git diff 890edac..HEAD`):

- **Round 1, Codex: REJECT, 1 High, 3 Medium; all verified and fixed with tests.** `claimFuel` on a token + gas record
  recovered a lost gas leaf through the fuel route, which has no token portals (now the token route; D78 names the
  facts it writes); an abort from an event or during a read still settled (the signal is checked after each); a
  resumed claim's live reading kept a stale `claimedByOther`; `wallet-sync` was deduplicated to one event.
- **Opus 5.5 (beside it): 2 Medium, 6 Low.** The leftover gas claim ignored an aborted signal before its latch and
  prompt; a claim value that does not derive the record's secret hash read the message as live (refused now); a resumed
  gas-only hash that reverted with its message live settled (cleared, `claim-reverted`); a recovery with no gas leaf
  reported success (`receipt-mismatch`); `watchOnly` still reads through the wallet (documented); three tests could
  not fail. Kept: a gas-only fuel hash whose receipt is included stops with `fuel-already-claimed` (D79, today's card).
- **Round 2, Codex (same session): APPROVE WITH CHANGES, 2 Medium; fixed with tests.** An abort from the event that
  reports a recovered read still settled (checked after that event too); an abort while a latch was written still
  opened the prompt (checked right before each wallet send, the known-unsent latch lifted).

Arc a5, the implementation (`git diff 54de731..HEAD`):

- **Round 1, Codex: the publish pipeline is sound; 4 Moderate, all in the docs.** bb.js fetches its WebAssembly from a
  `data:` URL, so `connect-src` needs `data:`; a new npm trusted-publisher entry allows only `npm stage publish`
  until direct publishing is enabled, and expires unused after two days; a deposit's reads before its signature
  surface unwrapped errors, so the README's "every failure is a `BridgeError`" is now scoped; `minFj` bounds the
  bridged Fee Juice, before the claim's fee.
- **Round 1, Opus 5.5 (beside it): 1 Medium-High, 1 Medium, 4 Low, all in the docs and an example.** A claim refused
  before it reads anything reports `submission: "none"` on a sent deposit, so a handler that drops `none` records
  would strand a public claim secret: the README and `BridgeError`'s TSDoc now say `submission` describes the failing
  call and a claim's `none` never licenses a drop. The `never` row now says a sent deposit is finished with its claim;
  a mined revert (`submitted`) is the drop case, an `unknown` one is kept; the 50,000-block search window, the
  `payer` labels and a stray example comment corrected.
- **Round 2, Codex (same session): the round-1 fixes hold; 1 High, 1 Moderate, both in the docs.** A mined revert is
  not final: a reorg can re-land the same signed deposit, so dropping its record could lose a public claim secret; the
  README now drops it only once the block is final. Redefining `submission` as the failing call's was wrong too: after
  `openClaim` a claim reports `submitted` for its deposit with no claim sent; the TSDoc keeps "for this transfer" with
  the preflight `none` named as the one exception.
- **Round 3, Codex (same session): no new material finding.** Deletion now waits for finality, and `submitted` is no
  longer read as a claim broadcast. Converged.

## Delivery

Seven sequential PRs against `main`, no stacking (a6 ships two). a1 works on `worktree-sdk-1` (it carries this plan); each later arc
starts after the previous one merged: `git fetch origin main && git checkout -b sdk-1-a<n> origin/main && bun install`.
`code_review: off`. PR bodies: what changed and why, the gates with outcomes, the browser wall-clock before and after,
`Delivers ask3` (a3) and `Delivers ask5` (a5, once the SDK ships end to end). Merge order: relayer-1, then sdk-1; each
arc merges `origin/main` before its last gate run. a1 and a2 share only `manifest-v2.ts` and `send-flow.ts`, and a2
waits for the owner, so parallel lanes are not recommended.

| Arc | Phases | Depends on | Delivers |
|---|---|---|---|
| a1 | 1.1–1.4 | plan approval | the mainnet fuel route (ask5, deploy path) |
| a2 | 2.1–2.5 | the owner's interface answer, a1 merged | the SDK (ask5) |
| a3 | 3.1–3.2 | a2 | ask3; the send lanes (ask5) |
| a4 | 4.1 | a3 | the claim lanes (ask5) |
| a5 | 5.1 | a4 | publish setup (ask5) |
| a6 PR 1 | 6.1–6.2 | a5, ask26 | the SDK's claims for every integrator (ask26) |
| a6 PR 2 | 6.3 + close-out | a6 PR 1 | the app's claims on the SDK (ask5, ask26) |

## Post-implementation

Per arc, after its last phase gate passes:

1. **Codex fix loop.** `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with
   the arc's diff against its base, this plan and the ledger, the arc map ("arc n of 5; later arcs build X"), the
   adversarial ask, and these two rules verbatim:
   - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra
     configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works
     and is clear, leave it alone."*
   - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does,
     restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence
     works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments
     are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
   Triage (verify every claim against the tree), fix, commit, log the round in `lessons/phase-N.md`, resume with
   `resume-codex.sh` on the fix diff. Stop when a round has no new material finding; at three rounds, stop and
   surface. One same-family review (`Agent`, `model: "opus"`, `general-purpose`) runs beside round 1. A fix that adds
   persistent state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop.
2. **Delivery.** Run the arc's gates once more on the final head; push; `gh pr create` with the body above; `gh pr
   checks <n> --watch` once, bounded; a known flake gets one rerun.
3. **Close-out** (a6's second PR, final commits): the `## Outcome` block after the front matter (date, status, shipped with PR
   numbers, dropped and why, `Known limits:`, `Open items:`, the seeds retired); promote generalizable lessons into
   `implementations-plan/lessons.md` (dedupe, retire, date-stamp); file open work as GitHub issues (a suspected
   exploitable weakness as a private draft advisory; a known limit as a closed `known-limit` issue); merge `origin/main`
   first and read what changed in `index.md` and `lessons.md`; delete `STATUS.md`; `git mv implementations-plan/sdk-1
   implementations-plan/archive/sdk-1` in its own commit, repair links, add one line to `archive/index.md`.
4. **Teardown after the close-out merges** (`git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/sdk-1/plan.md`): `agent-worktree done sdk-1 --merged`; relay a refusal,
   never force.

While implementing: comments to the repository's bar as you write; a lessons entry per meaningful attempt; `agent-
worktree status sdk-1 "<phase> green: <next>"` at each gate; three failures on one step stop the arc.

Open work: inside the arc → this plan and the PR; a bug, gap or deferred refactor → a GitHub issue with a domain label
and a `Record` link; a product call or outside wait → an `owner-decision` or `blocked:external` issue; a suspected
exploitable weakness → a private draft advisory; unsupported conditions or no consequence → a closed `known-limit`
issue; rejected or done → a disposition line in the Outcome; a lesson that prevents a repeat → `lessons.md`.

## Seeds (draft; run none; the orchestrator owns implementation sessions)

```
/goal Arc a<n> of implementations-plan/sdk-1/plan.md is delivered: every phase of the arc marked ✓ in plan.md, each backed by its validation gate reported passing in the transcript; LESSONS_FILE=implementations-plan/sdk-1/lessons/phase-N.md printed per phase; the Codex fix loop on the arc's diff converged (a resumed pass with no new material finding quoted); the arc's PR exists against main with `gh pr view` output in the transcript; bun run lint and bun run test:all exit 0.
```

```
/loop 15m Drive arc a<n> of implementations-plan/sdk-1/plan.md. Each firing: read plan.md and lessons/ (not the chat); pick the next unticked phase of the arc; after each edit run bun run lint and the touched package's tests; at a phase's end run its validation gate exactly and tick it; at the arc's end run the Post-implementation steps 1–2; never merge, deploy, publish or run a keyed command; stop and report after three failures on one step.
```
