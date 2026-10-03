# Phase 5/6 — frontend + sandbox e2e (lessons)

## What's proven
- **deposit-public driven GREEN through the bridge-app via Playwright** against the local sandbox — the in-browser dual-wallet works: L1 viem (anvil account0) + an in-browser L2 PXE (`EmbeddedWallet`, prover off), reading `/sandbox.json` + `/token_bridge.json`. Success snapshot captured (`deposit-success`: "Bridged 50 USDC to L2 (leaf …)").
- bridge-core 4-flow smoke (deposit pub/priv + withdraw pub/priv) green on a **settled** sandbox; swap forge-proven; codex audit fully addressed.

## Local aztec sandbox — hard-won e2e requirements
1. **Launch command is `aztec start --local-network`** (4.2.0 stable, `~/.aztec/current`). There is NO `--sandbox` flag in this CLI; `--local-network` is the all-in-one (own anvil :8545 + node :8080 + deploys the rollup + funds test accounts).
2. **MUST build empty blocks for e2e: `--sequencer.minTxsPerBlock 0`.** The default `minTxsPerBlock:1` only mints an L2 block when a tx arrives. Our claim is a *poll of simulations* (no tx) until the L1→L2 message is consumable — so with the default, no txs ⇒ no blocks ⇒ the inbox never advances ⇒ `claim_*` retries forever ("never succeeded"). A long-running sandbox masks this because other activity keeps minting blocks.
3. **Clear the deploy PXE store per sandbox instance.** `deploy-sandbox.ts` (EmbeddedWallet) persists `pxe_data_*` / `wallet_data_*` in `packages/bridge-core/`. Pointed at a *different* chain, the stale state throws `Block hash … not found when querying world state … a reorg has occurred` / `No local block hash for block N`. `rm -rf pxe_data_* wallet_data_*` before deploying against a new/restarted sandbox.
4. **A freshly-started sandbox is reorg-unstable in its early blocks.** Observed: the node prunes/reorgs (`Chain pruned to block 8`) repeatedly for the first many blocks, un-mining the deposit tx — `claim_*` can't finalize. A long-running/settled sandbox is past this. A fresh-sandbox e2e harness needs a **settling wait** (let the chain stabilize well past the early-reorg window) before driving flows, OR a persistent data-directory.
5. `aztecSlotDuration` defaults to **72s** under `--local-network` — so a claim takes ≥1 inbox-lag epoch (~144s). The claim retry budget is raised to **200×3s (~10 min)** in `flows.ts` + the smoke; harmless on a fast/settled sandbox (resolves in the first retries).
6. The app **reads RPC ports** (`l1Rpc`/`nodeUrl`) from `sandbox.json` (`bridge-app/src/lib/sandbox.ts`), so it targets any sandbox (fresh, restarted, or ephemeral-port).

## For the reliable e2e:agent harness
Combine the above: ephemeral ports + a fresh `aztec start --local-network --sequencer.minTxsPerBlock 0` per run + a settling wait + `rm -rf pxe_data_*` + deploy (writes `sandbox.json` with the run's ports) + the Playwright drives. The sandbox-stability + empty-block requirements are the non-obvious parts.

## Operational note
Re-driving deposit-private / withdraw / swap through the app is wired + the code is correct (the 4-flow bridge-core smoke proved the orchestration; deposit-public proved the full app path). It only needs a **stable** sandbox — re-run `bun run --cwd packages/bridge-core deploy:sandbox --smoke` then drive via Playwright once one is up.
