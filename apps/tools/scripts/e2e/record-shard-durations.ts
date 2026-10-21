/**
 * Rewrites `tests/browser/shard-durations.json` from the log of a green CI run of the browser suite:
 *
 *   gh run view <run-id> --log | bun scripts/e2e/record-shard-durations.ts
 */
import { readFileSync, writeFileSync } from "node:fs"
import { recordDurations } from "./shard-plan"

const out = new URL("../../tests/browser/shard-durations.json", import.meta.url)
const record = recordDurations(readFileSync(0, "utf8"))
writeFileSync(out, `${JSON.stringify(record, null, "\t")}\n`)
const files = Object.keys(record).length
const minutes = Object.values(record).reduce((sum, entry) => sum + entry.seconds, 0) / 60
console.log(`recorded ${files} spec files, ${minutes.toFixed(1)} min in all → ${out.pathname}`)
