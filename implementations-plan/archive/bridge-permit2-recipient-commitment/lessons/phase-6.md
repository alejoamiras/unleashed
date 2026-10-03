# Phase 6 — testnet candidate deploy (live)

Status: ✓ DONE (candidate deployed + verified). The blocker below was resolved by the user
funding the shared SponsoredFPC; the retry completed end-to-end.

## Resolution + deployed candidate (attempt 2, after FPC funded)

The user funded the shared SponsoredFPC. The retry (clean journal, forge on PATH) completed in 7.4m with
EVERY read-back ✓:

| Contract | Address |
|---|---|
| L1 forked portal (fresh) | `0xbd071af9172e9d1d39912c64bb8ca26d4b1ebd8b` |
| L1 AZLO token (REUSED) | `0x457f9cdb972e036b07f49c23cee78d0c689cd389` |
| L2 TokenMinterProxy | `0x2da8ce14b1aa5780f01d2afaa4cf0dc7b02f932f5c5a24c845f5137eaaae62dd` |
| L2 Token | `0x2dcbe24280f183f0976810b44bd4d14389411dfce5d5ae561c84d828b361b31c` |
| L2 TokenBridge | `0x0f137a7ac7af4598a80d49d01a344cd947ec1a2bd73ff186dbe4f054390be98e` |

Read-backs ✓: portal.underlying, portal.l2Bridge, portal.rollup == registry canonical, portal runtime
code-hash == pin, proxy.get_token, proxy.get_bridge, router.swapTarget. L1 sources Etherscan-verified.
Candidate manifest verifier (`BRIDGE_MANIFEST=public/testnet-bridge.candidate.json`) GREEN — all three
L2 instances rebuild to the committed addresses; router/permit2/swapTarget present; `privateClaimMode:
"salt-v2"` present. Live `testnet-bridge.json` untouched (git clean) + still lacks `privateClaimMode`.

**Gate: PASS.** Next = Phase 7 canaries (dust real-money), STOP before the promotion (user gate).

---

## Original blocker log (attempt 1 — resolved)

## Pre-flight (all green)

- Deployer `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5`: **8.78 ETH** on Sepolia.
- Reuse targets valid (WIPE reuses L1 token + B2 fuel, per A-3/A-5): live AZLO `0x457f…d389` =
  `AZLO`/18-dec; fuel router `0x4c3f…4068` `swapTarget()` matches + witness type string has `swapTarget`
  (⇒ the B2/F-004/F-006 build). Aztec node reachable (Sepolia, rollupVersion 2787991301).
- Pre-deploy gate: forge fork 12/12 PASS (0 skipped), bridge-core 149, typecheck clean, clean start.
- Env for the WIPE-reuse path: `EXISTING_L1_TOKEN=0x457f…d389`, `FUEL_ROUTER=0x4c3f…4068`,
  `FUEL_SWAP=0xab3a…0eb8`, plus `PRIVATE_KEY`/`SEPOLIA_RPC_URL`/`AZTEC_NODE_URL` from `packages/bridge-core/.env`.

## Two failures on the live run

1. **`forge not found`** — the deploy rebuilds+verifies the portal bytecode via `forge`, but the
   background shell doesn't inherit an interactive PATH. FIX: run with `export PATH="$HOME/.foundry/bin:$PATH"`
   AND `export FORGE_BIN="$HOME/.foundry/bin/forge"` (the script probes `FORGE_BIN` → `forge` on PATH →
   `~/.aztec/current/bin/forge`). Failed BEFORE any on-chain action — clean.

2. **`Invalid tx: Insufficient fee payer balance (required=3.7225 FJ, available=3.4342 FJ)`** — the
   shared **SponsoredFPC** (`0x1969…44d7`) that pays L2 deploy gas is underfunded, and a SINGLE
   account-deploy tx costs **3.72 FJ** (abnormally high → the testnet L2 base fee is spiking). The whole
   deploy is ~6 L2 txs (account + proxy + token + bridge + set_token + set_bridge), so it needs ~20+ FJ
   the shared FPC doesn't have. NOT a code bug — a testnet fee/infra condition.

## On-chain state after the failure (harmless, no cleanup needed)

The generation journal recorded: portal **deployed + confirmed** at `0x998706c7d09e0961385bc4c3e0ef12cdfcc741ef`
(tx `0xa896…fc6a`), then the L2 account deploy failed. Verified the portal is **UNINITIALIZED**
(`rollupVersion() == 0`) — a bare, empty portal not married to any bridge, holding no funds (~cents of
Sepolia gas wasted). Archived the partial journal → `testnet-bridge.journal.attempt-1-abandoned.jsonl`
so a fresh retry runs clean (a partial landing can't `--from-journal` resume — the script says archive +
restart). A clean retry mints a NEW portal; `0x998706c7` is abandoned.

## Blocked on a decision (fee strategy) — options

- **(a) Fund the shared SponsoredFPC** with ~20+ FJ (bridge FJ L1→L2 to `0x1969…44d7`, ~10-15 min
  settle). Downside: shared → drainable by others before our deploy; if the fee spike persists 20 FJ may
  not suffice.
- **(b) Wait for the L2 fee spike to subside** (3.72 FJ/tx is abnormally high) + retry. Zero cost, clean
  state, unpredictable timing.
- **(c) Change the deploy fee strategy** to self-fund the deployer's own L2 account (deploy-script change
  — scope + risk).

Recommendation: (b) then (a) — the state is clean, so retry after the spike; fund only if it persists.
