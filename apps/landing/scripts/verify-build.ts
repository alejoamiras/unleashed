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

function readDist(dir: string): Dist {
	const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
	return new Map(
		files.map((entry) => [
			relative(dir, join(entry.parentPath, entry.name)),
			new Uint8Array(readFileSync(join(entry.parentPath, entry.name))),
		]),
	)
}

function flag(name: string): string | undefined {
	const at = process.argv.indexOf(name)
	return at === -1 ? undefined : process.argv[at + 1]
}

function fail(errors: readonly string[]): never {
	for (const error of errors) console.error(`verify-build: ${error}`)
	process.exit(1)
}

const dist = readDist(DIST)
const errors = checkDist(dist)
const digest = distDigest(dist)
const expect = flag("--expect")
const channel = flag("--channel")
if (expect !== undefined && expect !== digest) errors.push(`digest ${digest} is not the expected ${expect}`)
if (channel !== undefined && channel !== channelOfDist(dist)) errors.push(`dist/ is a '${channelOfDist(dist)}' build, not '${channel}'`)
if (errors.length) fail(errors)
console.log(`DIST_SHA256=${digest}`)
