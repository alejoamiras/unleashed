import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, decodeEventLog, encodeAbiParameters, encodeEventTopics, getAbiItem, type Hex, parseAbiItem, zeroHash } from "viem"
import { describe, expect, it } from "vitest"
import { DEPOSIT_ROUTER_ABI } from "../protocol/deposit-router-abi.ts"
import { type FuelRoute, readSendInbox, readSendReceiptLeaves } from "./send-flow.ts"

// A recorded Sepolia token+gas delivery: its real FeeJuicePortal event and Inbox `MessageSent` back the fuel leg below.
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), "utf8")) as T
type RawLog = { address: Address; topics: [Hex, ...Hex[]]; data: Hex }
const RAIL = fixture<{ router: { router: Address; feeJuicePortal: Address }; destination: { chainId: number } }>("testnet-rail.json")
const ROUTED = fixture<{ destination: { logs: RawLog[] } }>("testnet-rail.router.receipts.json")
const INBOX: Address = "0x816ce1861ec258F99279E75a3EE6B5Dfc9571E30"
const ROLLUP_VERSION = 2914217885n
const TX = `0x${"f".repeat(64)}` as Hex

const DEPOSITED = getAbiItem({ abi: DEPOSIT_ROUTER_ABI, name: "Deposited" })
const FJ_DEPOSIT = parseAbiItem(
	"event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
)
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The recorded logs with the router's token+gas `Deposited` rewritten as the gas-only one its fuel leg alone emits. */
function gasOnlyLogs() {
	const logs = ROUTED.destination.logs
	const at = logs.findIndex(
		(l) => eq(l.address, RAIL.router.router) && eq(l.topics[0], encodeEventTopics({ abi: [DEPOSITED] })[0] as Hex),
	)
	const d = decodeEventLog({ abi: [DEPOSITED], ...logs[at] }).args as Record<string, unknown>
	const args: Record<string, unknown> = {
		...d,
		tokenSecretHash: zeroHash,
		received: d.fuelIn,
		tokenAmount: 0n,
		tokenKey: zeroHash,
		tokenIndex: 0n,
	}
	const body = DEPOSITED.inputs.filter((i) => !i.indexed)
	const rewritten: RawLog = {
		address: RAIL.router.router,
		topics: encodeEventTopics({ abi: [DEPOSITED], args } as never) as RawLog["topics"],
		data: encodeAbiParameters(
			body,
			body.map((i) => args[i.name as string]),
		),
	}
	return { logs: logs.map((l, i) => (i === at ? rewritten : l)), fuelSecretHash: d.fuelSecretHash as Hex }
}

describe("a fuel-only route's receipt", () => {
	const route: FuelRoute = {
		router: RAIL.router.router,
		permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		feeJuicePortal: RAIL.router.feeJuicePortal,
		feeAsset: "0x0000000000000000000000000000000000000fee",
		chainId: RAIL.destination.chainId,
	}
	const pub = {
		readContract: async (req: { address: Address; functionName: string }) => {
			if (!eq(req.address, route.feeJuicePortal)) throw new Error(`unexpected read at ${req.address}`)
			return req.functionName === "INBOX" ? INBOX : ROLLUP_VERSION
		},
	}

	it("authenticates its fuel leaf against the Inbox the FeeJuicePortal names, and only that Inbox", async () => {
		const { logs, fuelSecretHash } = gasOnlyLogs()
		const fjDeposit = logs.find(
			(l) => eq(l.address, route.feeJuicePortal) && eq(l.topics[0], encodeEventTopics({ abi: [FJ_DEPOSIT] })[0] as Hex),
		)
		const recipient = decodeEventLog({ abi: [FJ_DEPOSIT], ...(fjDeposit as RawLog) }).args.to
		const expected = { l1ChainId: route.chainId, isPrivate: false, recipient, fuel: { secretHash: fuelSecretHash, recipient } }

		const inbox = await readSendInbox(pub as never, route)
		expect(inbox).toMatchObject({ address: INBOX, rollupVersion: ROLLUP_VERSION, l2Hub: zeroHash })
		const leaves = await readSendReceiptLeaves(route, inbox, expected, TX, logs as never)
		expect(leaves.fuelLeafIndex).toBeTypeOf("bigint")
		expect(leaves.tokenLeafIndex).toBeUndefined()

		const forged = logs.map((l) => (eq(l.address, INBOX) ? { ...l, address: route.router } : l))
		await expect(readSendReceiptLeaves(route, inbox, expected, TX, forged as never)).rejects.toThrow("the Inbox inserted no fuel leaf")
		const otherRollup = { ...inbox, rollupVersion: ROLLUP_VERSION + 1n }
		await expect(readSendReceiptLeaves(route, otherRollup, expected, TX, logs as never)).rejects.toThrow("leaf does not recompute")
	})
})
