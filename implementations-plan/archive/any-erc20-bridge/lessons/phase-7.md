# Phase 7 — wizard foundation: composables, grants, journal

Arc 4, stacked on Arc 3.

## Shape

- `src/contracts/bridge-generation.ts` — the v2 reader (`GENERATION: BridgeBlock | null`, `SEND_GENERATION`, `HUB`, `TOKEN_CLASS_ID`, `MANIFEST_TOKENS`, `SWAP`, `rebuildHubInstance`, `rebuildHubTokenInstance`) beside the v1 `bridge-deployments.ts`, which dies with its 40 importers in the retire step (D19 keeps `typecheck:all` green per arc). It parses at module init; the live `public/testnet-bridge.json` stays v1 through this phase, so every test that imports it mocks it from the sandbox fixture (`packages/bridge-core/fixtures/sandbox-manifest.json`).
- `src/lib/send-model.ts` — the one vocabulary every composable and step speaks: `SelectableToken → ResolvedToken` (state, portal, words, `l2Token` — a PREVIEW for a first-time token), `SendPlan`/`ExitPlan`, `GasLegPlan`, `GrantOutcome`.
- `sendGenerationOf` moved from the operator scripts into bridge-core `src/send-generation.ts` so the app builds its `SendGeneration` from the same code the sandbox smoke uses.
- Three composable clusters, built in parallel against the kernel: (A) the wallet-grant seam — `buildSendManifest`/`buildCombinedManifest` over `hub + tokens[]`, the session's `grantedContracts`, `useWalletConnection`'s requested-token set, `useTokenGrant` (serialized prompts, selection epoch, returned-scope verification); (B) discovery + pricing — `useTokenCatalog` (manifest ∪ list ∪ pasted), `useTokenSelection` (metadata, registration, `token_for`, three-way state, preview words/portal/`l2Token`, balances), `useRouteQuote`, `useGasShare`; (C) execution — `useSend` over `runSend` with the pre-signature grant and the post-receipt re-derivation, `useHubExit` with both pause preflights, the journal's per-token `deploymentMatches` + token-block validation against the factory, the `register` phase.

## Gotchas

- **Hub views are `#[external("public")] #[view]`**, so `token_for`/`portal_for`/`exits_paused` are granted under `simulation.transactions`, not `simulation.utilities` (a utility scope would fail at runtime with "Function artifact not found") — the same rule as `balance_of_public`.
- **A manifest token is granted from the first connect and never re-prompted**, so `ensureGranted` short-circuits for it and `finishSetup` is the only place its instance can reach the wallet: `registerHubContracts` registers the manifest's tokens ∪ the requested set (the first integration run missed the manifest half).
- The journal engine takes its generation facts as injected deps (`sendBinding`, `validateTokenBlock`, `ensureTokenGrant`, `claimSend`, `consumeSend`) instead of importing the v2 reader: that import would break ~28 unmodified test files at module init while the live manifest is still v1.
- **A first deposit's receipt carries two Inbox `MessageSent` leaves** (the factory's register leaf first). Recovery of a send record therefore reads the router's own event (`readSendReceiptLeaves`, emitter-filtered), never `MessageSent[0]`; the `Bridge` event's `amount` is what a receipt-only recovery has for `fuelReceived`.
- Additive bridge-core changes the wizard needed: `onSecrets` also reports the secret hashes (the pre-signature record id), `consumeWithdrawal` returns the consume hash and takes `onSent`, `JournalBase.blocked` (terminal, persisted).
- `useTokenSelection` reads L2 balances only for a registered token AND the exit direction (deposits never need them); a pasted token starts with empty metadata (`decimals: -1`) until selection fills it.
- The sandbox fixture has no `swap` block — route/gas tests supply a schema-shaped SWAP.
- `theme-vars.test.ts` resolves `packages/design/src/base.css` off `process.cwd()`: it fails when vitest is run from the repo root with `--root apps/faucet` and passes under `bun run --cwd apps/faucet test`, the real command.

## Carried into P8

- `useBridgeBackup` still takes `getRetainedSealKey` from `useDeposit` (a same-session send export costs one extra signature until the retention moves to `useSend`); `useDeposit`/`useFuel`/`useWithdraw` and the v1 reader die in the retire step with their forms.
- `stepperPhases` keeps the baselined `depositPhases` byte-identical beside the new `sendDepositPhases`; the copy table collapses when the v1 phases go.

## Gate

fast ✓ (`bun run lint` exit 0, faucet typecheck 0) · `bun run test:faucet` ✓ 72 files / 852 tests · composables: `useTokenGrant` 12 (grant flow: short-circuit, prompt → granted, declined, stale epoch discarded, serialized concurrent prompts, rejected prompt survives), `useTokenCatalog` 12, `useTokenSelection` 12, `useRouteQuote` 12, `useGasShare` 12, `useSend` 14, `useHubExit` 12.
