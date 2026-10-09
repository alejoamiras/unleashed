/**
 * Offline guard over apps/landing/dist/. Prints DIST_SHA256 on success.
 *   --expect <hex>                  fail unless dist/ is exactly that artifact
 *   --channel production|preview    fail unless dist/ is that channel's build
 * A keyed deploy runs this file directly (never through `bun run`, which also runs pre/post hooks),
 * so it imports only node: built-ins and ./dist-checks.ts.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { channelOfDist, checkDist, type Dist, distDigest } from "./dist-checks.ts"

const DIST = join(import.meta.dirname, "..", "dist")

function fail(errors: readonly string[]): never {
	for (const error of errors) console.error(`verify-build: ${error}`)
	process.exit(1)
}

// wrangler follows a symlink and uploads its target, which the digest would never see.
function readDist(dir: string): Dist {
	const entries = readdirSync(dir, { recursive: true, withFileTypes: true })
	const odd = entries.filter((entry) => !entry.isFile() && !entry.isDirectory())
	if (odd.length) fail(odd.map((entry) => `not a plain file: ${relative(dir, join(entry.parentPath, entry.name))}`))
	const files = entries.filter((entry) => entry.isFile())
	return new Map(
		files.map((entry) => [
			relative(dir, join(entry.parentPath, entry.name)),
			new Uint8Array(readFileSync(join(entry.parentPath, entry.name))),
		]),
	)
}

const FLAGS: Readonly<Record<string, RegExp>> = { "--expect": /^[0-9a-f]{64}$/, "--channel": /^(production|preview)$/ }

/** Each flag once, with a well-formed value: a flag that silently drops out would skip its check. */
function parseFlags(args: readonly string[]): Map<string, string> {
	const flags = new Map<string, string>()
	for (let i = 0; i < args.length; i += 2) {
		const [name, value] = [args[i], args[i + 1]]
		const shape = Object.hasOwn(FLAGS, name) ? FLAGS[name] : undefined
		if (!shape || flags.has(name)) fail([`unknown or repeated argument '${name}'`])
		if (value === undefined || !shape.test(value)) fail([`${name} needs a value matching ${shape}, got '${value ?? ""}'`])
		flags.set(name, value)
	}
	return flags
}

const flags = parseFlags(process.argv.slice(2))
const dist = readDist(DIST)
const errors = checkDist(dist)
const digest = distDigest(dist)
const expect = flags.get("--expect")
const channel = flags.get("--channel")
if (expect !== undefined && expect !== digest) errors.push(`digest ${digest} is not the expected ${expect}`)
if (channel !== undefined && channel !== channelOfDist(dist)) errors.push(`dist/ is a '${channelOfDist(dist)}' build, not '${channel}'`)
if (errors.length) fail(errors)
console.log(`DIST_SHA256=${digest}`)
