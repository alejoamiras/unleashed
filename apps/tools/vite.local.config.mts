import { loadLocalRunFromEnv } from "./src/lib/local-target-loader"
import { makeToolsConfig } from "./vite.config"

// The sandbox build: chain identity, node URL, manifest and web-wallet URLs all come from the run's
// artifacts (UNLEASHED_SANDBOX_ARTIFACTS) — nothing is committed, nothing is a Cloudflare variable.
// A production-MODE bundle on purpose: the same integrity layers the shipped builds run.
const run = loadLocalRunFromEnv()
export default makeToolsConfig(run.target, { manifestJson: run.manifestJson, localConfig: run.config })
