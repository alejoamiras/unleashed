import { type Hex, hashStruct, keccak256 } from "viem"
import { describe, expect, it } from "vitest"
import {
	DEPOSIT_WITNESS_PERMIT_TYPES,
	DEPOSIT_WITNESS_TYPE,
	DEPOSIT_WITNESS_TYPE_STRING,
	DEPOSIT_WITNESS_TYPEHASH,
	depositWitness,
	depositWitnessPermitTypedData,
	hashDepositWitness,
	ensurePermit2Allowance,
	PERMIT_DEADLINE_SECONDS,
} from "./l1"

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`
const b32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`

// contracts/bridge/evm/test/DepositWitness.t.sol's shared vector: the same inputs through DepositRouter.hashWitness.
const DEPOSIT_TYPEHASH = "0x106905f54299d4971393cc302e6e9a86a81a2925c8fb4d2a00597a2551eb5745"
const DEPOSIT_WITNESS_HASH = "0xcda2e450d719bcba586bd091421030f02d669556fb96588ed276ce120b2c5d12"
const DEPOSIT_VECTOR = {
	aztecRecipient: b32(0x1234),
	tokenSecretHash: b32(0x5ec7),
	isPrivate: false,
	fuelSlice: 100_000n,
	fuelRecipient: b32(0x5678),
	fuelSecretHash: b32(0xfee),
	minFuelOutput: 1_000_000_000_000_000_000n,
}
const DEPOSIT_VECTOR_SWAP_DATA = "0x4666fc80000000000000000000000000000000000000000000000000000000000000007d"

describe("DepositWitness (pinned to DepositRouter)", () => {
	it("typehash, type string and the shared vector match the Solidity router", () => {
		expect(DEPOSIT_WITNESS_TYPEHASH).toBe(DEPOSIT_TYPEHASH)
		expect(DEPOSIT_WITNESS_TYPE_STRING).toBe(
			"DepositWitness witness)DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)TokenPermissions(address token,uint256 amount)",
		)
		expect(hashDepositWitness(depositWitness(DEPOSIT_VECTOR, DEPOSIT_VECTOR_SWAP_DATA))).toBe(DEPOSIT_WITNESS_HASH)
	})

	it("the EIP-712 struct hash viem signs equals the router's, and binds every swapData byte", () => {
		const w = depositWitness(DEPOSIT_VECTOR, DEPOSIT_VECTOR_SWAP_DATA)
		expect(hashStruct({ data: { ...w }, primaryType: "DepositWitness", types: DEPOSIT_WITNESS_PERMIT_TYPES })).toBe(
			DEPOSIT_WITNESS_HASH,
		)
		const inner = DEPOSIT_WITNESS_TYPE.replace(/^DepositWitness\(/, "").replace(/\)$/, "")
		expect(DEPOSIT_WITNESS_PERMIT_TYPES.DepositWitness).toEqual(
			inner.split(",").map((f) => {
				const [type, name] = f.trim().split(/\s+/)
				return { name, type }
			}),
		)
		const mutated: Hex = `0x${DEPOSIT_VECTOR_SWAP_DATA.slice(2, -1)}e`
		expect(hashDepositWitness(depositWitness(DEPOSIT_VECTOR, mutated))).not.toBe(DEPOSIT_WITNESS_HASH)
		expect(depositWitness(DEPOSIT_VECTOR, "0x").swapDataHash).toBe(keccak256("0x"))
	})

	it("depositWitnessPermitTypedData builds the Permit2 domain + message", () => {
		const witness = depositWitness(DEPOSIT_VECTOR, DEPOSIT_VECTOR_SWAP_DATA)
		const transfer = { permitted: { token: addr(0x2222), amount: 1_000_000n }, spender: addr(0x99), nonce: 7n, deadline: 123n }
		const td = depositWitnessPermitTypedData(transfer, witness, addr(0x22d3), 11155111)
		expect(td.domain).toEqual({ name: "Permit2", chainId: 11155111, verifyingContract: addr(0x22d3) })
		expect(td.primaryType).toBe("PermitWitnessTransferFrom")
		expect(td.message).toEqual({ ...transfer, witness })
	})
})

describe("ensurePermit2Allowance — the one approval state machine (app + smokes)", () => {
	const HASH = "0xabc" as `0x${string}`

	it("short-circuits when the allowance is already sufficient (no tx)", async () => {
		let approved = 0
		const r = await ensurePermit2Allowance({
			allowance: async () => 100n,
			approveMax: async () => {
				approved++
				return HASH
			},
			waitReceipt: async () => ({ status: "success" }),
			needed: 50n,
		})
		expect(r).toEqual({ approved: false })
		expect(approved).toBe(0)
	})

	it("approves max, waits, re-reads, and reports the txHash", async () => {
		const reads = [0n, 10n ** 30n]
		const statuses: string[] = []
		const r = await ensurePermit2Allowance({
			allowance: async () => reads.shift() as bigint,
			approveMax: async () => HASH,
			waitReceipt: async () => ({ status: "success" }),
			needed: 50n,
			onStatus: (st) => statuses.push(st),
		})
		expect(r).toEqual({ approved: true, txHash: HASH })
		expect(statuses).toEqual(["approving", "waiting", "approved"])
	})

	it("throws on a REVERTED approval receipt", async () => {
		await expect(
			ensurePermit2Allowance({
				allowance: async () => 0n,
				approveMax: async () => HASH,
				waitReceipt: async () => ({ status: "reverted" }),
				needed: 1n,
			}),
		).rejects.toThrow(/reverted/)
	})

	it("throws when the allowance is STILL insufficient after a successful approve (wrong wiring)", async () => {
		await expect(
			ensurePermit2Allowance({
				allowance: async () => 0n,
				approveMax: async () => HASH,
				waitReceipt: async () => ({ status: "success" }),
				needed: 1n,
			}),
		).rejects.toThrow(/still insufficient/)
	})
})

describe("PERMIT_DEADLINE_SECONDS", () => {
	it("is pinned to a bounded MEV window - neither dust nor a half-hour market window", () => {
		// The deadline bounds how long a signed fuel-leg intent stays executable against the quote
		// it was derived from. 60s floor: congestion must not strand signatures mid-flight.
		// 900s ceiling: a "convenience" bump toward an effectively-unbounded window trips this.
		expect(PERMIT_DEADLINE_SECONDS >= 60n).toBe(true)
		expect(PERMIT_DEADLINE_SECONDS <= 900n).toBe(true)
	})
})
