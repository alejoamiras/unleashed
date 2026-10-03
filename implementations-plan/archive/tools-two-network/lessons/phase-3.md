# Phase 3 — Schema + build integrity

## Phase 3a — Atomic `l1.fuel` core/swap split (the codex round-3 HIGH)

**Status:** ✓ (bridge-core typecheck 0 / 185 tests; faucet typecheck 0 / 509; lint 0).

### The split (derived from real field consumption, not the plan's guess)
- **`core`** (required when `fuel` present) = `router`, `permit2`, `swapTarget`, **`feeJuicePortal`**.
  `feeJuicePortal` is a *router constructor arg* (`verify-l1` `routerArgs = [permit2, feeJuicePortal,
  swapTarget]`), so it's a core dep — the plan had it unplaced.
- **`swap`** (optional; testnet-only) = `poolManager`, `quoter`, `weth`, `feeJuice`, `pools`,
  `slippageBps`, `minFuelFj`.
- `feeJuice.feeAssetHandler` → optional (mainnet BYO-$AZTEC, no permissionless handler).

### Migrated in ONE commit (the "atomic" requirement)
- **Typed consumers** (compiler-caught): `candidate-schema.ts` (the split), `live-intent.ts`
  (fuel.core.* + guarded the now-optional feeAssetHandler checks), `bridge-deployments.ts` (reads
  `core`, flattens core+swap into the unchanged `BRIDGE_FUEL` — so the **9 app consumers are
  untouched** and `BRIDGE_FUEL` auto-hides when swap absent), + the two colocated tests.
- **Untyped consumers** (grep-caught — codex round-3's misses, invisible to typecheck because they
  `JSON.parse`): `verify-l1.ts` (router always verified; UniswapFuelSwap verify gated on `swap`),
  `deploy-bridge-testnet.ts` (the rollup-coupled + env overrides now land INSIDE `core`),
  `fuel-testnet.ts` + `smoke-swap-existing-testnet.ts` (extract `core`/`swap` + guard swap present),
  `verify-deployments.ts` (`m.l1.fuel?.core?.*`).
- **Live `testnet-bridge.json`** migrated via a python round-trip (addresses preserved exactly).

### Gate
- **grep-completeness**: `\b(fuel|l1.fuel?).(router|swapTarget|permit2|feeJuicePortal|poolManager|
  quoter|weth|feeJuice|pools|slippageBps|minFuelFj)\b` minus `.core`/`.swap` → **zero hits**.
- Schema tests: live manifest still parses; a **bridge-only (core-only, no swap/no feeAssetHandler)
  manifest parses**; `fuel` without `core` rejects; the mutation-path tests moved to core/swap.
- The compiler-guided strategy worked exactly: typecheck listed every typed break; grep listed the
  untyped ones. Do NOT rely on "live manifest parses" alone — it's true while a untyped `JSON.parse`
  consumer still reads a moved field (that's why the grep gate exists).

### Gotchas
- `bridge-deployments.ts`'s `BRIDGE_FUEL` presence now keys off `fuel?.swap` (not `fuel`), so a
  bridge-only mainnet manifest yields `BRIDGE_FUEL === undefined` → swap UI hidden. The CORE fields
  are exported separately (`BRIDGE_ROUTER`/`PERMIT2`/`SWAP_TARGET`) for the `bridge()` path.
- `CandidateManifest.l1.fuel` in `deploy-manifest.ts` is deliberately `Record<string,unknown>` (loose
  — the schema is the strict gate), so a test reading `manifest.l1.fuel.core.x` needs a cast.
- biome flags `delete` in tests as an INFO (non-blocking); the existing schema test already used it,
  so the new mainnet-shape/missing-core tests keep the same `delete` style for consistency.

## Phase 3b — Config factory + build integrity ✓

### 3b.1 — additive schema + mainnet constants
- `chain-constants.ts`: `MAINNET_{L1_CHAIN_ID=1,ROLLUP_VERSION=4248422647,WALLET_CHAIN_ID=4248422646}`
  (mirrors the wallet; Node-safe).
- Schema (all additive/optional → live manifest still parses): top-level `l1ChainId`/`walletChainId`;
  token `source` (`permissionless-mint`|`circle-proxy`) + `maxWholePerTx` now conditional via `.refine`
  (required unless circle-proxy → a mainnet manifest need not lie); optional `privateFpc` block.
- Populated live `testnet-bridge.json` with chain identity + `token.source=permissionless-mint`.

### 3b.2 — the config factory (codex round-1 Critical)
- `network-targets.ts` (Node-safe): `FaucetTarget` + `TESTNET_TARGET`/`MAINNET_TARGET` +
  `resolveFaucetTarget()` (reads `import.meta.env.VITE_FAUCET_TARGET`, testnet fallback).
- `vite.config.ts` → `makeFaucetConfig(target)`: `define`s the target key + the target's bridge
  manifest into `import.meta.env`; `buildMetaPlugin(target)` writes `build.json`
  `{target,chainId,manifestDigest}` in **Node scope** (a vite alias can't reach here — the whole
  reason for the factory). Default export = testnet, so `vite build` + vitest are unchanged.
- `vite.{testnet,mainnet}.config.mts` thin wrappers + `build:{testnet,mainnet}` scripts.
- App is target-driven: `NETWORK` + `readChainInfo` via `resolveFaucetTarget()`; `bridge-deployments`
  consumes the injected manifest (static testnet fallback under vitest). `network.ts` maps
  `l1ChainId → viem Chain` ({sepolia, mainnet}); the lookup is what guarantees `viemChain.id===l1ChainId`.
- **build-integrity gate** (`main.ts`, before mount): fails CLOSED on target↔manifest mismatch,
  missing manifest identity, or a mis-hosted build (layers 2-sync + 5). Pure `checkBuildIntegrity`
  unit-tested incl. the exact placeholder-mainnet case.
- **Placeholder `mainnet-bridge.json`**: bridge-only/circle-proxy SHAPE but TESTNET chain identity →
  the mainnet build compiles but fails the assertion until Phase 8 promotes the real manifest.

### Gate (all ✓)
- **Both targets build**; `build.json` correctly distinct: testnet `{target:testnet, chainId:1816023401,
  digest c28b…}`, mainnet `{target:mainnet, chainId:4248422646, digest ebfb…}` (= the placeholder).
- bridge-core typecheck 0 / 185; faucet typecheck 0 / **514** (+5 build-integrity); lint 0.
- `viem/chains` ban still holds (network.ts is the only importer; `mainnet` added there).

### Deferred (with a clear home, NOT dropped)
- `assertNodeChainMatches` (the manifest↔**node** async half) is written + unit-tested + exported but
  wired in **Phase 5**, which owns the app's node-connection lifecycle — there is no clean startup
  node-info fetch today (the wallet-sdk handshake already uses the target-driven `readChainInfo`, and
  the only `getNodeInfo` call is per-op in `useWithdraw`). The load-bearing sync gate is wired.

### Gotcha
- **Do NOT put backticks in a double-quoted `git commit -m` under zsh** — they command-substitute
  (a `` `vite build` `` in the message ran `vite` → "command not found" and silently blanked that
  span). Use `git commit -F <file>` for messages with backticks/braces. Fixed via `--amend -F`.
