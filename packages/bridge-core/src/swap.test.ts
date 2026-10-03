import { type Abi, encodeAbiParameters, keccak256, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { hashRoute, type PoolKey } from "./l1"
import { runSwapBridge, type SwapBridgeParams } from "./flows"

// Minimal router ABI: just the BridgeWithFuel event, so parseEventLogs decodes the leaf indices.
const ROUTER_ABI = [
	{
		type: "event",
		name: "BridgeWithFuel",
		inputs: [
			{ name: "aztecRecipient", type: "bytes32", indexed: true },
			{ name: "tokenKey", type: "bytes32", indexed: false },
			{ name: "tokenIndex", type: "uint256", indexed: false },
			{ name: "tokenAmount", type: "uint256", indexed: false },
			{ name: "tokenSecretHash", type: "bytes32", indexed: false },
			{ name: "fuelKey", type: "bytes32", indexed: false },
			{ name: "fuelIndex", type: "uint256", indexed: false },
			{ name: "fuelAmount", type: "uint256", indexed: false },
			{ name: "fuelSecretHash", type: "bytes32", indexed: false },
			{ name: "isPrivate", type: "bool", indexed: false },
		],
	},
] as const satisfies Abi

const ZERO32 = `0x${"0".repeat(64)}` as const

// Hand-built BridgeWithFuel log: tokenIndex 7, fuelIndex 8, fuelAmount 1000.
const bridgeLog = {
	address: "0x00000000000000000000000000000000000000aa",
	topics: [
		keccak256(toHex("BridgeWithFuel(bytes32,bytes32,uint256,uint256,bytes32,bytes32,uint256,uint256,bytes32,bool)")),
		ZERO32, // aztecRecipient (indexed)
	],
	data: encodeAbiParameters(
		[
			{ type: "bytes32" }, // tokenKey
			{ type: "uint256" }, // tokenIndex
			{ type: "uint256" }, // tokenAmount
			{ type: "bytes32" }, // tokenSecretHash
			{ type: "bytes32" }, // fuelKey
			{ type: "uint256" }, // fuelIndex
			{ type: "uint256" }, // fuelAmount
			{ type: "bytes32" }, // fuelSecretHash
			{ type: "bool" }, // isPrivate
		],
		[ZERO32, 7n, 90n, ZERO32, ZERO32, 8n, 1000n, ZERO32, false],
	),
	blockNumber: 1n,
	blockHash: ZERO32,
	logIndex: 0,
	transactionHash: ZERO32,
	transactionIndex: 0,
	removed: false,
}

const PATH: PoolKey[] = [
	{
		currency0: "0x0000000000000000000000000000000000000005",
		currency1: "0x00000000000000000000000000000000000000f1",
		fee: 3000,
		tickSpacing: 60,
		hooks: "0x0000000000000000000000000000000000000000",
	},
]

const params = (): SwapBridgeParams => ({
	router: "0x00000000000000000000000000000000000000aa",
	routerAbi: ROUTER_ABI,
	permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
	tokenPortal: "0x00000000000000000000000000000000000000bb",
	bridgeToken: "0x0000000000000000000000000000000000000005",
	totalAmount: 100n,
	fuelAmount: 10n,
	// 0x..0a (value 10) is a valid Grumpkin point; 0x..03 is NOT — runSwapBridge now rejects invalid
	// recipients before signing (an invalid recipient would strand the deposit in an undecryptable note).
	aztecRecipient: `0x${"a".padStart(64, "0")}`,
	fuelRecipient: `0x${"4".padStart(64, "0")}`,
	minFuelOutput: 900n,
	path: PATH,
	zeroForOnes: [true],
	isPrivate: false,
	swapTarget: "0x00000000000000000000000000000000000000bb",
	nonce: 1n,
	deadline: 2n ** 64n,
	chainId: 31337,
})

const makeL1 = () => ({
	account: { address: "0x00000000000000000000000000000000000000ac" },
	pub: { waitForTransactionReceipt: vi.fn(async (_a: unknown) => ({ logs: [bridgeLog] })) },
	wallet: {
		chain: { id: 31337 },
		signTypedData: vi.fn(async (_a: unknown) => "0xsig"),
		writeContract: vi.fn(async (_a: unknown) => "0xhash"),
	},
})

describe("flows — runSwapBridge (one-tx swap+fuel)", () => {
	it("signs the witness-bound permit, calls bridgeWithFuel, returns secrets + leaf indices", async () => {
		const l1 = makeL1()
		const stages: string[] = []
		const onSecrets = vi.fn()
		const onBridged = vi.fn()
		const p = params()

		const result = await runSwapBridge(l1 as never, p, (s) => stages.push(s), { onSecrets, onBridged })

		// Leaf indices come from the BridgeWithFuel event, not deposit-order guessing.
		expect(result.tokenLeafIndex).toBe(7n)
		expect(result.fuelLeafIndex).toBe(8n)
		expect(result.fuelReceived).toBe(1000n)
		expect(result.tokenSecretHex).toMatch(/^0x[0-9a-f]+$/)
		expect(result.fuelSecretHex).not.toBe(result.tokenSecretHex) // two distinct secrets

		// The signed permit binds the route + the bridge intent (cross-pinned witness).
		const signed = vi.mocked(l1.wallet.signTypedData).mock.calls[0][0] as unknown as {
			primaryType: string
			message: { spender: string; witness: { routeHash: string; totalAmount: bigint; isPrivate: boolean } }
		}
		expect(signed.primaryType).toBe("PermitWitnessTransferFrom")
		expect(signed.message.spender).toBe(p.router)
		expect(signed.message.witness.routeHash).toBe(hashRoute(p.path, p.zeroForOnes))
		expect(signed.message.witness.totalAmount).toBe(100n)

		// bridgeWithFuel called with the params + the signed permit.
		const call = vi.mocked(l1.wallet.writeContract).mock.calls[0][0] as unknown as {
			functionName: string
			args: [{ totalAmount: bigint; fuelAmount: bigint; isPrivate: boolean }, { nonce: bigint; signature: string }]
		}
		expect(call.functionName).toBe("bridgeWithFuel")
		expect(call.args[0].totalAmount).toBe(100n)
		expect(call.args[0].fuelAmount).toBe(10n)
		expect(call.args[1]).toMatchObject({ nonce: 1n, signature: "0xsig" })

		expect(onSecrets).toHaveBeenCalledOnce()
		expect(onBridged).toHaveBeenCalledWith({ tokenLeafIndex: 7n, fuelLeafIndex: 8n })
		expect(stages).toEqual(["signing", "swapping", "syncing", "done"])
	})

	it("throws if no BridgeWithFuel event was emitted", async () => {
		const l1 = makeL1()
		l1.pub.waitForTransactionReceipt = vi.fn(async (_a: unknown) => ({ logs: [] }))
		await expect(runSwapBridge(l1 as never, params())).rejects.toThrow(/no BridgeWithFuel event/)
	})
})
