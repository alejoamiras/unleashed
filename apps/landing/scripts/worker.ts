/**
 * Workers Builds' deploy commands. `deploy` publishes a production build of main; `preview` uploads a
 * preview version of any other branch. Each refuses the other channel's dist/, so a preview build can
 * never reach production, nor a production build a preview host.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const COMMANDS = {
	deploy: { channel: "production", args: ["deploy", "-c", "wrangler.jsonc"] },
	preview: { channel: "preview", args: ["versions", "upload", "-c", "wrangler.jsonc"] },
} as const

const mode = process.argv[2]
if (mode !== "deploy" && mode !== "preview") {
	console.error(`worker: usage: worker.ts deploy|preview, got '${mode ?? ""}'`)
	process.exit(2)
}
const { channel, args } = COMMANDS[mode]
const meta = JSON.parse(readFileSync(join(import.meta.dirname, "..", "dist", "build.json"), "utf8")) as { channel?: string }
if (meta.channel !== channel) {
	console.error(`worker: ${mode} needs a ${channel} build, but dist/ is '${meta.channel ?? "unknown"}'`)
	process.exit(1)
}
const run = spawnSync("wrangler", args, { stdio: "inherit", cwd: join(import.meta.dirname, "..") })
process.exit(run.status ?? 1)
