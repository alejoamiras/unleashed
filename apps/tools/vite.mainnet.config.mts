import { MAINNET_TARGET } from "./src/lib/network-targets"
import { makeToolsConfig } from "./vite.config"

// Mainnet/Alpha build → app.unleashed.systems. Bundles public/mainnet-bridge.json; the startup assertion
// fails closed if that manifest's chain identity ever mismatches the mainnet target.
export default makeToolsConfig(MAINNET_TARGET)
