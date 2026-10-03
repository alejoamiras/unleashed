/**
 * Uploads the built testnet dist/ as a preview version under the branch's alias. Workers Builds
 * runs it as the non-production deploy command. Only a testnet build runs at a preview host, so
 * any other dist/ is stopped here instead of served.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { TESTNET_TARGET } from "../src/lib/network-targets"
import { PRODUCTION_BRANCH, previewAlias, workerOf } from "../src/lib/preview-hosts"

function fail(message: string): never {
	console.error(`upload-preview: ${message}`)
	process.exit(1)
}

const branch = process.env.WORKERS_CI_BRANCH
if (!branch || branch === PRODUCTION_BRANCH) fail(`WORKERS_CI_BRANCH must name a preview branch, got '${branch ?? ""}'`)

const alias = previewAlias(branch, workerOf(TESTNET_TARGET.workersDevHost ?? ""))
const meta = JSON.parse(readFileSync("dist/build.json", "utf8")) as { target?: string }
if (meta.target !== "testnet") fail(`dist/ is not a testnet build: ${JSON.stringify(meta)}`)

const upload = spawnSync("wrangler", ["versions", "upload", "-c", "wrangler.testnet.jsonc", "--preview-alias", alias], { stdio: "inherit" })
process.exit(upload.status ?? 1)
