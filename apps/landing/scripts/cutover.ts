/**
 * The unleashed.systems cutover through the Cloudflare API. It runs only as an owner-approved keyed
 * run with the token from `cloudflare-cutover.env.example`, never in CI.
 *   inventory   read-only: records the zone's current state under ~/.cache, changes nothing
 */
import { cloudflare, tokenFromEnv } from "./cutover/api.ts"
import { failedReads, findZone, readInventory, saveRecord, summarize } from "./cutover/inventory.ts"

async function inventory(): Promise<number> {
	const api = cloudflare(tokenFromEnv())
	const zone = await findZone(api)
	const record = await readInventory(api, zone)
	for (const line of summarize(record)) console.log(line)
	if (record.redirects.ok) console.log(`REDIRECT_RULESET=${JSON.stringify(record.redirects.value)}`)
	console.log(`record: ${saveRecord("inventory", record)}`)
	const failed = failedReads(record)
	for (const line of failed) console.error(`cutover: ${line}`)
	return failed.length ? 3 : 0
}

const mode = process.argv[2]
if (mode !== "inventory") {
	console.error(`cutover: usage: cutover.ts inventory, got '${mode ?? ""}'`)
	process.exit(2)
}
try {
	process.exit(await inventory())
} catch (error) {
	console.error(`cutover: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
