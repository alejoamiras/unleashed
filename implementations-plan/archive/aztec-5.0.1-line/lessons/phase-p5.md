# Phase P5 — deploy-tooling hardening (lessons)

## P5 built + gate green in one pass (4 commits)

Much of the P5 surface already existed from the 5.0.0 arc (live-intent build/verify with signer
allowlist, spend-cap baseline enforcement, second-endpoint STOP, strict candidate schema,
committed-intent + tree-discipline checks) — the P5 work was the DELTA:

- **intent identity pinning**: build now loads the COMMITTED
  `implementations-plan/archive/aztec-5.0.0-stable/lessons/intent.json` and requires byte-equality on all
  five node-claimed L1 addresses + l1ChainId/rollupVersion (no-reset line). Authenticates the
  node's claims against history; the eth_getCode corroboration keeps authenticating them against
  the L1 itself.
- **faucet candidate-first** (also the tooling half of the P6 arity fix): deploy.ts
  passes the 5.0.1 Token's 5th `auth_contract` arg and records `authContract`; default output is
  now the CANDIDATE json; rebuilds are record-parameterized so `--config` proves candidates
  through the app's own derivation; pre-5.0.1 records fail with "redeploy required", not an
  arity crash.
- **promote subcommand** (in live-intent, so the digest pins + full verify are in
  scope): verify → symlink-reject → read-once buffers → strict validations (bridge manifest
  strict-zod; faucet shape requires authContract everywhere) → zero-seed (l1.fuel byte-carried
  from live) → same-dir temp+rename → re-hash vs source buffers → strict re-parse + spawning the
  REAL `verify-deployments` over the live file → receipt for the operator to commit. promote
  never runs git commit → a crash leaves only uncommitted tree changes, which the next verify's
  tree-discipline check surfaces.
- **reuse-token + portal preflight**: `--reuse-token <addr>` readback-verifies
  name/symbol/decimals before anything binds (malformed flag hard-stops — silent fresh-deploy
  would fork the token identity); the portal-init preflight reads live `l2Bridge()` and requires
  ZERO (an initialized portal = reuse = forbidden).

**Gate (real output)**: promotion 5/5, reuse-token 7/7, deployments-records 2/2 (the bb.js-in-
jsdom limitation keeps address DERIVATION out of vitest — the real verify-deployments run owns
it); bridge-core 148/148; faucet 428/428 + vue-tsc 0; `test:all` rc=0 twice.

**For P6**: the operator flow is now — `.env` sourced only around broadcasts; `live-intent build`
(pins vs committed history + code-presence + second endpoint if set); per-group `verify`;
`check-fpc-version --mode predeploy` → deploy FPC → `--mode require-deployed` before ANY
funding/canary; `deploy-bridge-testnet --reuse-token <azlo>` for the bridge leg;
`deploy.ts` (writes the faucet candidate); `verify-deployments --config` + `drip-canary --config`
against candidates; six canaries; `live-intent promote` (receipt); commit promoted files+receipt.
