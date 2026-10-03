# Phase 4 — Dual build + CI plumbing

**Status:** code ✓ (CF second-project + hook remain owner/dashboard steps).

## What changed
- **Per-target CSP** — `FaucetTarget.cspConnectSrc`; a `headersPlugin(target)` writes `dist/_headers`
  at build with the target's `connect-src`. The static `public/_headers` is **removed** (generated
  now). **The real bug this fixes:** the pre-existing CSP allowed `*.aztec-labs.com` (testnet node)
  but NOT `lb.drpc.live` (the Alpha node) — so a mainnet build's CSP would have blocked its own node.
  Testnet CSP kept verbatim; mainnet = `'self' data: blob: https://lb.drpc.live wss://lb.drpc.live`.
- **Manifest isolation** — `buildMetaPlugin` closeBundle strips every `*-bridge.json` from `dist`
  except the active target's (both are build-inlined; no need to serve the placeholder).
- **`scripts/verify-build-target.ts`** (new, `verify:build-target`) — the D20 gate: asserts
  `dist/build.json`'s `target`/`chainId`/`manifestDigest` match the target + `sha256(bundled manifest)`
  (the digest EMITTED in the artifact, not a recomputed one).
- **`_build-faucet.yml`** — `target` input; builds `build:<target>`; sets
  `BRIDGE_MANIFEST=public/<target>-bridge.json` so `verify:deployments` runs its OFFLINE bridge gate;
  then `verify:build-target`. Artifact renamed `faucet-dist-<target>` (only caller pr-quick doesn't
  download by name).
- **`pr-quick.yml`** — `build-faucet` is now a `[testnet, mainnet]` matrix → PRs verify BOTH builds.

## Gate (all ✓, local)
- Both targets build; `dist/_headers` connect-src correct per target; `dist` carries ONLY the active
  manifest; `verify:build-target` + `verify:deployments` (offline, `BRIDGE_MANIFEST` set) pass for
  both; actionlint 0; faucet typecheck 0 / 514 tests; lint 0.

## Notes / owner steps
- `verify:deployments` + `verify:build-target` are **fully offline** (pure address re-derivation +
  digest) — no RPC, so CI stays hermetic (the owner-trim, D20). Live readbacks are deploy-time only.
- The placeholder `mainnet-bridge.json` PASSES `verify:deployments` (its L2 records are internally
  consistent) — correct: verify-deployments checks address-derivation, NOT chain identity. The
  chain-identity mismatch is caught by the runtime build-integrity assertion (Phase 3b), not here.
- **Owner/dashboard, not code:** create the second Cloudflare Pages project for `app.unleashed.systems` +
  its deploy hook/build-command (A7), and (optionally) a CF Access service token if automated
  mainnet verify-live is wanted (A6 — otherwise the hostname layer + manual smoke cover it).
