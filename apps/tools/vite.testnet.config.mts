import { TESTNET_TARGET } from "./src/lib/network-targets"
import { makeToolsConfig } from "./vite.config"

// Explicit testnet build → testnet.app.unleashed.systems. (The bare `vite.config.ts` default is also testnet,
// so `vite build` and `vite build --config vite.testnet.config.mts` are equivalent.)
export default makeToolsConfig(TESTNET_TARGET)
