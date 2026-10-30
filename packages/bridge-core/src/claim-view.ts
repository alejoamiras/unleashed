import type { DepositRecord } from "@unleashed/sdk"
import type { AnyJournalRecord } from "./journal"

/**
 * A stored record as the SDK's claims read it: a schema-3 deposit as stored, a schema-4 one without its `route`, a
 * legacy schema-2 Fee Juice deposit as a gas-only send. Undefined for a record no SDK claim takes (a withdraw, a
 * schema-1 record, a schema-2 token deposit). Nested blocks are shared with `rec`, except a legacy public Fee Juice
 * record's gas block, which takes the record's claim secret.
 */
export function claimView(rec: AnyJournalRecord): DepositRecord | undefined {
	if (rec.direction !== "deposit") return undefined
	if (rec.schema === 3) return { ...rec }
	if (rec.schema === 4) {
		const { route: _route, ...rest } = rec
		return { ...rest, schema: 3 }
	}
	if (rec.schema === 2 && rec.assetKind === "fee-juice" && rec.fuel) {
		const { assetKind: _assetKind, ...rest } = rec
		// Its claim secret is the record's own; the gas-only claim reads the block, whose copy it outranks.
		const fuel = !rec.isPrivate && rec.secret !== undefined ? { ...rec.fuel, secret: rec.secret } : rec.fuel
		return { ...rest, fuel, schema: 3, intent: "gas" }
	}
	return undefined
}

/** The facts a claim is built from. A record whose view no longer holds them is another deposit, or one discovery
 *  found again at another leaf, and a claim's progress must not land on it. */
const CLAIM_IDENTITY_FIELDS = [
	"id",
	"direction",
	"schema",
	"intent",
	"isPrivate",
	"amount",
	"recipient",
	"secretHashHex",
	"leafIndex",
	"messageHash",
	"chainId",
	"portal",
	"bridge",
] as const satisfies readonly (keyof DepositRecord)[]

const FUEL_IDENTITY_FIELDS = ["secretHashHex", "leafIndex", "messageHash"] as const

/** Whether two views name the same claim: the top-level identity and the gas leg's secret hash, leaf and message. */
export function sameClaimIdentity(a: DepositRecord, b: DepositRecord): boolean {
	return CLAIM_IDENTITY_FIELDS.every((k) => a[k] === b[k]) && FUEL_IDENTITY_FIELDS.every((k) => a.fuel?.[k] === b.fuel?.[k])
}
