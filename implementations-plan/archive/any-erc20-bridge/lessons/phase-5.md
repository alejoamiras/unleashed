# Phase 5 — bridge-core: schema, journal, flows, discovery, scripts

Arc 3, stacked on Arc 2.

## What shipped

- `src/manifest-v2.ts` — `schema: 2` generation manifest: `bridge` block nullable (a placeholder network is `bridge: null`, and every operator entrypoint refuses it by name through `requireBridge`); strict everywhere (`.strict()` on every object, so a v1 key is a parse error, not a silent pass-through); self-deriving — `superRefine` recomputes every token's portal with `predictPortal(factory, implementation, erc20)` and pins the hub's `constructorArgs` to `[tokenClassId, factory, guardian]`; hooked pools are unroutable at the schema; `assertManifestTokensDerive` re-derives every `l2Token` from the hub + words (the L2 half of the self-derivation, async because it needs the artifact).
- `src/journal.ts` schema 3 — `SendDepositRecord` / `SendWithdrawRecord` carry a `JournalTokenBlock` (erc20, portal, l2Token, words, decimals, displaySymbol, registerIndex) so a restore never needs the token list; `deriveSendDepositStage` gains `registering`. `backup.ts` validates the new records with the same hostile-input stance as the old ones (`validateAnyBackupRecord` exported for the wizard).
- `src/send-flow.ts` — one `runSend` for every intent × privacy shape. `sendPortalFor`/`sendEntrypoint` encode the router's rule (portal derived from the token; the fee asset's public gas-only is a plain `bridge()` into the FeeJuicePortal; every other shape is the fueled entrypoint). Leaf indices come from the router's events, never from order. After the receipt the factory registration is read back and turned into the token block.
- `src/hub-l2.ts` — `claimViaHub`: a registered token is a plain claim; an unregistered one is `register_and_claim_public` (one tx) or `register_token` + `claim_private` (two txs); a lost registration race (`No non-nullified L1 to L2 message`, duplicate nullifier) falls back to the plain claim. `preflightHubExit` simulates the exit before the wallet is asked to sign.
- `src/factory-registry.ts`, `src/erc20.ts`, `src/token-list.ts` (fresh → cache → fallback, cache keyed per chain), `src/route-discovery.ts` (`route | identity | no-route | unavailable` — the grammar check refuses any path that does not end in Fee Juice through WETH), `src/gas-share.ts`, `src/quote.ts` Multicall3-batched quotes.
- `scripts/script-bootstrap.ts` — `loadManifestV2FromConfigArg` + `requireBridge`; every operator script goes through them.

## Gotchas

- `aztec.js` 5.x `.send()` resolves to `{ receipt: { txHash } }` — `txHashOf` unwraps it; `AztecAddress.fromString` does not exist (`fromStringUnsafe`).
- Biome's cognitive budget bit three fresh functions (`validateSendRecord` 18, `readSendResult` 17, `claimViaHub` 17); split into `readLeaves`, `plainClaim`/`firstPublicClaim`/`firstPrivateClaim` — no suppressions.
- The live `apps/faucet/public/*.json` manifests stay v1 until the wizard lands (D19); the scripts therefore have no v2 file to run against until the sandbox conductor writes one. Acceptance for the script migration is typecheck + biome + unit tests; the sandbox smoke (P6) is the first execution.
- The `mainnet-bridge.json → bridge: null` stub in the Arc-3 list would break the faucet's v1 reader at runtime while the faucet is still v1 — deferred to the same PR that retires the v1 reader (P8), noted here so P6 does not ship it early.

## Script migration (three parallel agents, one file set each; integrated + gated by the main session)

- **Deleted**: `deploy-bridge-{testnet,mainnet}.ts`, `smoke-existing-mainnet.ts`, `build-portal-artifact.ts`, `portal-artifact.ts` (+ test — no TS consumer once `verify-l1` compares against the forge build), `restore-swap.ts` (its premise is gone: the v2 swap block is token-independent, per-token pools live in `tokens[i].pools`, and the conductor owns manifest writing), `src/reuse-token.ts` (+ test), `script-l1.deposit.test.ts` (covered `depositViaRouter`, replaced by `runSend`), `assertSaltV2` (the v2 schema pins `privateClaimMode: "salt-v2"`, so the interlock is the parser).
- **Shared**: `scripts/script-send.ts` — `selectToken` (`--token <erc20>`, default first), `sendGenerationOf`, `requireSwap`, `planFuelLeg` (route discovery + signed floor), `claimTokenBlock` (refuses a read-back whose derived L2 token is not the manifest's).
- **`script-l2.ts`**: `deriveInstance(art, args, ctor, salt: Fr, deployer)`, `registerHub`, `registerHubToken`, `claimTokensUntilSynced` → `claimViaHub` (retries only the not-yet-synced class; every other revert surfaces on attempt 1 — the old helper swallowed everything for 300 tries).
- **`deploy-manifest.ts`**: `openDeployJournal` over a zod discriminated union of generation steps (`classes-published` … `candidate-written`), `writeCandidateAtomically` validates before the temp file exists, `readCandidate`.
- **`script-l1.ts`**: `assertFactoryPortal` (local CREATE2 AND the factory's own `predictPortal` must equal the manifest), operator-only `ROUTER_CONSTANTS_ABI`/`FACTORY_CONSTANTS_ABI` — the brief's getter names were wrong: the router exposes `permit2()` (not `PERMIT2()`), `BRIDGE_WITNESS_TYPEHASH` is internal, the factory has no `REGISTRY()`/`guardian()` (guardian IS `owner()`; the registry is observable only through `INBOX`/`ROLLUP_VERSION`).
- **`verify-l1.ts`**: code at all six generation addresses, factory/router cross-bindings, per-token portal + registration + live `decimals()` + word re-derivation, immutables-masked runtime-code-hash compare against `contracts/bridge/evm/out` (builds if absent; skips with a line if forge is unavailable). Etherscan source verification left the repo with the fork artifact — the conductor's forge `--verify` is its replacement (P6).
- **`live-intent.ts`**: v2 both sides, `--drop-swap`/`--restore-swap` gone, L1 readbacks (owners printed, factory owner bound to guardian), L2 hub instance/salt/class-published; `l1_factory`/`token_class_id` readbacks need a wallet → deferred with an explicit "skipped" line.
- **`promotion.ts`**: `assertFaucetCandidateShape` = strict v2 parse + non-null bridge + ≥1 token; `assertZeroSeed` refuses network/chain-id moves, a factory change (a new generation is its own flow), and a bridge drop.
- `fee-juice-canary-testnet`, `smoke-swap-existing-testnet`, `fuel-testnet` (prints `minFuelFj`, an `fjPerTx` line from the landed claim's `transactionFee`, and an `fjRegister` hint from the register-vs-plain delta), `deposit-testnet` (now the bidirectional gate: send → hub claim → `exitViaHub` → `consumeWithdrawal` on the clone), `discover-mainnet-fuel` (batched quotes, prints the v2 `swap` half), `relay-claim-testnet` (`--public`, `--register-index`), `smoke-existing-testnet` (two-token lanes, public + private, factory registration + `token_for` asserted). `check-fpc-version`, `drip-canary-testnet`, the private-FPC deployers read no bridge manifest and are untouched.
- `send-flow.ts` now derives `l2Token` inside the registration read-back (`SendGeneration` carries `hub` + `tokenClassId`), so a journal token block is complete at its source instead of patched by every caller.
- The faucet's `fuel-claim-state.ts` schema literal widened to `1 | 2 | 3` (`>= 2` for the fueled-schema test) — the one v1-side touch, type-level, needed because `BridgeJournalRecord` now includes the send records and `typecheck:all` must stay green per arc.
- Complexity baseline: net shrink (7 directives removed across `discover-mainnet-fuel`, `live-intent`, `relay-claim-testnet`, `deposit-testnet`; 0 inserted).

## Deferred to P6 (all landed there — see `lessons/phase-6.md`)

- Hub `exits_paused()` view (the hub had only `set_exits_paused` + the internal assert; the smoke's preflight had to simulate an exit and match the string).
- `SeedTokenPool.s.sol` imported `PoolSetupHelper` from the fixture deploy script slated for deletion.
- The `mainnet-bridge.json → bridge: null` stub (see Gotchas) — stays deferred to P8.

## Gate

`typecheck:all` exit 0 · `bun run lint` exit 0 (complexity-baseline check OK) · bridge-core 43 files / 327 tests · faucet 64 files / 711 tests · zero legacy manifest readers under `packages/bridge-core/scripts/` (`grep -lE 'parseCandidateManifest|\.l1\.fuel|\.l1\.usdc|\.l2\.bridge|\.l2\.proxy|tokenBridgeArtifact|bridgeProxyArtifact' scripts/*.ts` → none).
