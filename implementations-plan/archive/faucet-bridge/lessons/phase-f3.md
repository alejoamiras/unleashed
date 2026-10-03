# F3 — generalize the Aztec wallet session + bridge manifest ✅

Two pieces: the bridge capability manifest + the session factory.

## Part 1 — bridge manifest
`buildBridgeManifest` (capabilities.ts): `canCreateAuthWit:true` (exit_to_l1 burn auth-wit), `contracts=[bridge,token,proxy]`, tx-scope = claim/exit (both privacies) + token burns + sponsor, sim-scope = token balance reads. Widened `AccountsCapability.canCreateAuthWit` (literal `false` → `boolean`); renamed the `FaucetManifest` type → `AppManifest` (shared shape). 5 mirrored tests. The scope set is refined in F4 once flows run through the app.

## Part 2 — session factory (`createAztecWalletSession`)
`useWalletConnection` was a MODULE-LEVEL SINGLETON ("one tab = one connection") — the bridge needs its OWN session (codex: two independent sessions, not one shared connection). Extracted the session core into `createAztecWalletSession(config)` where `config = { appId, buildManifest, registerContracts }`. `useWalletConnection` is now a thin faucet wrapper around it with an IDENTICAL public API (`useWalletConnection` / `__resetWalletConnectionForTests` / `extractGrantedAccounts` / `ConnectStatus` / `GrantedAccount`) — so the faucet + its tests are untouched.

- **128 tests green** (123 + 5 bridge manifest), incl. `useWalletConnection.test` → the refactor is faithful.
- The wallet's schema-patch side-effect import moved into the factory (still first import → runs before wallet-sdk loads).

## F3/F4 boundary
F3 = the GENERALIZATION (factory + manifest). The bridge's USE of it — `useBridgeWallet` (a session created with `buildBridgeManifest` + `registerBridgeContracts`) — moves to F4, because it needs the testnet bridge ADDRESSES + contract instances. `deposit-testnet.ts` deploys fresh contracts per run, so F4 starts with a one-time **persistent testnet bridge deploy** → a bridge config (addresses + instance-rebuild params) → `useBridgeWallet` + the deposit flow + the block-countdown bar.
