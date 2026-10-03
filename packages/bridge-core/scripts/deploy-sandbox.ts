/**
 * Deploys ONE bridge generation onto a private local network and, with `--smoke`, drives every
 * flow through it. Kept as the historical entry point; the harness lives in `./sandbox/`.
 *
 * Run: bun scripts/deploy-sandbox.ts [--smoke] [--keep]   (from packages/bridge-core)
 *   --smoke  run the flow battery after the deploy
 *   --keep   leave the network up and print how to re-attach
 * Env: SANDBOX_L1_RPC + SANDBOX_NODE_URL (both) attach to a running network instead of booting one.
 */
import { main } from "./sandbox/cli"

process.argv.splice(2, 0, "run")
main()
