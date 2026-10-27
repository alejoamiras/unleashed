import { encodeAbiParameters, keccak256, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { readLegacySendLeaves } from "./legacy-router"

const ROUTER = "0x1111111111111111111111111111111111111111" as const
const TOKEN = "0x00000000000000000000000000000000000e2c20" as const
const FACTORY = "0x3333333333333333333333333333333333333333" as const
const RECIPIENT = `0x${"a".padStart(64, "0")}` as const
const ZERO32 = `0x${"0".repeat(64)}` as const
const KEY = `0x${"b".repeat(64)}` as const

const meta = { blockNumber: 1n, blockHash: ZERO32, transactionHash: ZERO32, transactionIndex: 0, removed: false }

function bridgeLog(index: bigint, emitter: string = ROUTER, logIndex = 0, amount = 500n) {
	return {
		...meta,
		address: emitter,
		logIndex,
		topics: [keccak256(toHex("Bridge(bytes32,bytes32,uint256,uint256,bytes32,bool)")), RECIPIENT],
		data: encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }],
			[KEY, index, amount, ZERO32, false],
		),
	}
}

function bridgeWithFuelLog(tokenIndex: bigint, fuelIndex: bigint, fuelAmount: bigint) {
	const words = [
		{ type: "bytes32" },
		{ type: "uint256" },
		{ type: "uint256" },
		{ type: "bytes32" },
		{ type: "bytes32" },
		{ type: "uint256" },
		{ type: "uint256" },
		{ type: "bytes32" },
		{ type: "bool" },
	] as const
	return {
		...meta,
		address: ROUTER,
		logIndex: 0,
		topics: [
			keccak256(toHex("BridgeWithFuel(bytes32,bytes32,uint256,uint256,bytes32,bytes32,uint256,uint256,bytes32,bool)")),
			RECIPIENT,
		],
		data: encodeAbiParameters(words, [
			`0x${"1".repeat(64)}`,
			tokenIndex,
			60n,
			ZERO32,
			`0x${"2".repeat(64)}`,
			fuelIndex,
			fuelAmount,
			ZERO32,
			false,
		]),
	}
}

describe("readLegacySendLeaves", () => {
	it("reads each intent's leaves from the router's own event, ignoring a first deposit's register leaf", () => {
		const registerLeaf = {
			...meta,
			address: FACTORY,
			logIndex: 0,
			topics: [keccak256(toHex("MessageSent(bytes32,uint256,bytes32,uint256)"))],
			data: "0x",
		}
		expect(readLegacySendLeaves(ROUTER, "token", ZERO32, [registerLeaf, bridgeLog(41n, ROUTER, 1)] as never)).toEqual({
			tokenLeafIndex: 41n,
			tokenMessageHashHex: KEY,
		})
		// The fee asset's public gas-only went through the plain entrypoint: its message is the gas leg.
		expect(readLegacySendLeaves(ROUTER, "gas", ZERO32, [bridgeLog(3n, ROUTER, 0, 16n)] as never)).toEqual({
			fuelLeafIndex: 3n,
			fuelMessageHashHex: KEY,
			fuelReceived: 16n,
		})
		expect(readLegacySendLeaves(ROUTER, "token+gas", ZERO32, [bridgeWithFuelLog(7n, 8n, 123n)] as never)).toMatchObject({
			tokenLeafIndex: 7n,
			fuelLeafIndex: 8n,
			fuelReceived: 123n,
		})
	})

	it("counts only the router's own event — a same-signature log the token emitted during the pull is ignored", () => {
		const forged = { ...bridgeLog(999n, TOKEN, 0), data: bridgeLog(999n).data }
		expect(readLegacySendLeaves(ROUTER, "token", ZERO32, [forged, bridgeLog(9n, ROUTER, 1)] as never).tokenLeafIndex).toBe(9n)
		expect(() => readLegacySendLeaves(ROUTER, "token", ZERO32, [forged] as never)).toThrow(/emitted 0 Bridge events/)
	})
})
