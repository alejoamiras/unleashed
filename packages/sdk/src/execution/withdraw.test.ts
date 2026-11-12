import { describe, expect, it, vi } from "vitest"

// consumeWithdrawal calls these two aztec.js helpers; mock them so the orchestration
// (witness → portal.withdraw) is exercised without a node. ContractBase is type-only
// (erased), so a full mock of /contracts only needs waitForProven.
vi.mock("@aztec-labs/aztec.js/contracts", () => ({ waitForProven: vi.fn() }))
vi.mock("@aztec-labs/stdlib/messaging", () => ({ computeL2ToL1MembershipWitness: vi.fn(), getL2ToL1MessageLeafId: vi.fn(() => 77n) }))
// 5.0: consumeWithdrawal constructs an OutboxContract (L1 roots reader) — mock it; getRoots is
// only invoked inside the mocked computeL2ToL1MembershipWitness, so a bare mock suffices.
vi.mock("@aztec-labs/ethereum/contracts", () => ({ OutboxContract: vi.fn() }))

import { waitForProven } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { OutboxContract } from "@aztec-labs/ethereum/contracts"
import { computeL2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging"
import { encodeFunctionData, type Hex, type ReplacementReturnType } from "viem"
import { TOKEN_PORTAL_ABI } from "../protocol/factory-abi.ts"
import { consumeWithdrawal, isOutboxMessageConsumed, sameWithdrawCall } from "./flows.ts"

type WaitArgs = { hash: Hex; onReplaced?: (r: ReplacementReturnType) => void }

const makeL1 = () => ({
	account: { address: "0xL1ACC" },
	pub: {
		simulateContract: vi.fn(async (_a: unknown) => ({ request: { sentinel: true } })),
		waitForTransactionReceipt: vi.fn(async ({ hash }: WaitArgs) => ({ transactionHash: hash, status: "success" })),
	},
	wallet: { writeContract: vi.fn(async () => "0xhash") },
})

const PORTAL = "0x00000000000000000000000000000000000000a1"
const RECIPIENT = "0x00000000000000000000000000000000000000c0"
const withdrawArgs = (amount = 40n) => [RECIPIENT, amount, false, 5n, 3n, 9n, [`0x${"11".repeat(32)}`]] as const
const withdrawInput = (amount?: bigint) =>
	encodeFunctionData({ abi: TOKEN_PORTAL_ABI, functionName: "withdraw", args: withdrawArgs(amount) })
const call = (input: Hex, to: string | null = PORTAL) => ({ to: to as Hex | null, input })

/** A node and witness that let the consume reach its L1 send. */
function reachSend() {
	vi.mocked(waitForProven).mockResolvedValue(undefined as never)
	vi.mocked(computeL2ToL1MembershipWitness).mockResolvedValue({
		epochNumber: 5,
		numCheckpointsInEpoch: 3,
		leafIndex: 9n,
		siblingPath: { toBufferArray: () => [] },
	} as never)
	return {
		getTxEffect: vi.fn(async () => ({ data: { l2ToL1Msgs: ["0xMSG"] } })),
		getNodeInfo: vi.fn(async () => ({ l1ContractAddresses: { outboxAddress: "0xOUTBOX" } })),
	}
}

describe("flows — consumeWithdrawal (L2→L1 finalization)", () => {
	it("waits for proof, builds the witness, consumes on L1 with the witness args", async () => {
		vi.mocked(waitForProven).mockResolvedValue(undefined as never)
		const node = {
			getTxEffect: vi.fn(async () => ({ data: { l2ToL1Msgs: ["0xMSG"] } })),
			getNodeInfo: vi.fn(async () => ({ l1ContractAddresses: { outboxAddress: "0xOUTBOX" } })),
		}
		vi.mocked(computeL2ToL1MembershipWitness).mockResolvedValue({
			epochNumber: 5,
			numCheckpointsInEpoch: 3,
			leafIndex: 9n,
			siblingPath: { toBufferArray: () => [Buffer.from("aa", "hex"), Buffer.from("bb", "hex")] },
		} as never)
		const l1 = makeL1()
		const stages: string[] = []

		await consumeWithdrawal(
			l1 as never,
			node as never,
			{ txHash: "0xTX" },
			{ recipientL1: "0xRECIP", amount: 40n, portal: "0xPORTAL", portalAbi: [] },
			(s) => stages.push(s),
		)

		// 5.0: OutboxRootsReader (OutboxContract) is the new 2nd arg.
		expect(vi.mocked(computeL2ToL1MembershipWitness)).toHaveBeenCalledWith(node, expect.anything(), "0xMSG", "0xTX", 0)
		const sim = vi.mocked(l1.pub.simulateContract).mock.calls[0][0] as unknown as { args: unknown[]; functionName: string }
		expect(sim.functionName).toBe("withdraw")
		// 5.0 withdraw args: (recipient, amount, withCaller, epoch, numCheckpointsInEpoch, leafIndex, path).
		expect(sim.args).toEqual(["0xRECIP", 40n, false, 5n, 3n, 9n, ["0xaa", "0xbb"]])
		expect(l1.wallet.writeContract).toHaveBeenCalledWith({ sentinel: true })
		expect(stages).toEqual(["proving", "consuming", "done"])
	})

	it("journals the consume hash before its receipt is awaited: an onSent that persists asynchronously is waited for", async () => {
		vi.mocked(waitForProven).mockResolvedValue(undefined as never)
		const node = {
			getTxEffect: vi.fn(async () => ({ data: { l2ToL1Msgs: ["0xMSG"] } })),
			getNodeInfo: vi.fn(async () => ({ l1ContractAddresses: { outboxAddress: "0xOUTBOX" } })),
		}
		vi.mocked(computeL2ToL1MembershipWitness).mockResolvedValue({
			epochNumber: 5,
			numCheckpointsInEpoch: 3,
			leafIndex: 9n,
			siblingPath: { toBufferArray: () => [] },
		} as never)
		const l1 = makeL1()
		let persisted = () => {}
		const onSent = vi.fn(() => new Promise<void>((r) => (persisted = r)))
		const consuming = consumeWithdrawal(
			l1 as never,
			node as never,
			{ txHash: "0xTX" },
			{
				recipientL1: "0xRECIP",
				amount: 40n,
				portal: "0xPORTAL",
				portalAbi: [],
				onSent,
			},
		)
		await vi.waitFor(() => expect(onSent).toHaveBeenCalledWith("0xhash"))
		expect(l1.pub.waitForTransactionReceipt).not.toHaveBeenCalled()
		persisted()
		await expect(consuming).resolves.toEqual({ consumeTxHash: "0xhash", mined: { txHash: "0xhash", status: "success" } })
		expect(l1.pub.waitForTransactionReceipt).toHaveBeenCalledWith(expect.objectContaining({ hash: "0xhash" }))
	})

	it.each([
		{
			by: "a sped-up copy of the call",
			replacement: call(withdrawInput()),
			receiptHash: "0xreplacement",
			status: "success",
			replacedBy: "same-finish",
		},
		{
			by: "a cancel",
			replacement: call("0x", "0x00000000000000000000000000000000000000ac"),
			receiptHash: "0xreplacement",
			status: "success",
			replacedBy: "other",
		},
		{
			by: "another withdraw",
			replacement: call(withdrawInput(41n)),
			receiptHash: "0xreplacement",
			status: "reverted",
			replacedBy: "other",
		},
		// viem reports the sent transaction as its own replacement when its receipt read lags the block holding it.
		{ by: "itself", replacement: call(withdrawInput()), receiptHash: "0xhash", status: "success", replacedBy: undefined },
	] as const)(
		"a finish replaced by $by returns the receipt it resolved with and whether another transaction still pays this withdraw",
		async ({ replacement, receiptHash, status, replacedBy }) => {
			const l1 = makeL1()
			l1.pub.waitForTransactionReceipt.mockImplementation(async ({ onReplaced }: WaitArgs) => {
				onReplaced?.({ replacedTransaction: call(withdrawInput()), transaction: replacement } as never)
				return { transactionHash: receiptHash, status }
			})
			const out = await consumeWithdrawal(
				l1 as never,
				reachSend() as never,
				{ txHash: "0xTX" },
				{
					recipientL1: RECIPIENT,
					amount: 40n,
					portal: PORTAL,
					portalAbi: TOKEN_PORTAL_ABI as never,
				},
			)
			expect(out).toEqual({ consumeTxHash: "0xhash", mined: { txHash: receiptHash, status, replacedBy } })
		},
	)

	it("throws when the exit produced no L2→L1 message", async () => {
		vi.mocked(waitForProven).mockResolvedValue(undefined as never)
		const node = { getTxEffect: vi.fn(async () => ({ data: { l2ToL1Msgs: [] } })) }
		await expect(
			consumeWithdrawal(
				makeL1() as never,
				node as never,
				{ txHash: "0xTX" },
				{
					recipientL1: "0x",
					amount: 1n,
					portal: "0x",
					portalAbi: [],
				},
			),
		).rejects.toThrow(/no L2→L1 message/)
	})
})

describe("flows — sameWithdrawCall", () => {
	const sent = call(withdrawInput())

	it.each([
		{ what: "the same bytes", replacement: call(withdrawInput()), same: true },
		{ what: "the same call encoded with trailing bytes", replacement: call(`${withdrawInput()}${"00".repeat(32)}`), same: true },
		{
			what: "the same call on another target",
			replacement: call(withdrawInput(), "0x00000000000000000000000000000000000000a2"),
			same: false,
		},
		{ what: "no target", replacement: call(withdrawInput(), null), same: false },
		{
			what: "another portal function",
			replacement: call(
				encodeFunctionData({ abi: TOKEN_PORTAL_ABI, functionName: "depositToAztecPrivate", args: [40n, `0x${"22".repeat(32)}`] }),
			),
			same: false,
		},
		{ what: "other withdraw arguments", replacement: call(withdrawInput(41n)), same: false },
		{ what: "undecodable calldata", replacement: call("0xdeadbeef"), same: false },
	] as const)("$what: $same", ({ replacement, same }) => {
		expect(sameWithdrawCall(sent, replacement, TOKEN_PORTAL_ABI as never)).toBe(same)
	})
})

describe("flows — isOutboxMessageConsumed", () => {
	const PORTAL = "0x00000000000000000000000000000000000000a1"
	const BOUND = "0x00000000000000000000000000000000000000b0"
	const EXPECTED = new Fr(0x5eedn)

	/** Every Outbox reports every message consumed, so only the address and message the read picks decide. */
	function setup(reported: Fr) {
		const outboxes: string[] = []
		vi.mocked(OutboxContract).mockImplementation(function (_pub: unknown, address: string) {
			outboxes.push(address)
			return { hasMessageBeenConsumedAtEpoch: vi.fn(async () => true) }
		} as never)
		vi.mocked(computeL2ToL1MembershipWitness).mockResolvedValue({ epochNumber: 5 } as never)
		const readContract = vi.fn(async (_a: unknown) => BOUND)
		const node = {
			getTxEffect: vi.fn(async () => ({ data: { l2ToL1Msgs: [reported] } })),
			getNodeInfo: vi.fn(async () => ({ l1ContractAddresses: { outboxAddress: "0x00000000000000000000000000000000000000ee" } })),
		}
		const l1 = { pub: { readContract }, wallet: {}, account: {} }
		const consumed = () =>
			isOutboxMessageConsumed(l1 as never, node as never, { txHash: "0xTX" }, { portal: PORTAL, messageHash: EXPECTED.toString() })
		return { consumed, readContract, node, outboxes }
	}

	it("reads the Outbox the portal names, for the record's own message", async () => {
		const { consumed, readContract, node, outboxes } = setup(EXPECTED)
		await expect(consumed()).resolves.toBe(true)
		expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: PORTAL, functionName: "OUTBOX" }))
		expect(outboxes).toEqual([BOUND])
		expect(vi.mocked(computeL2ToL1MembershipWitness).mock.calls.at(-1)?.[2]).toEqual(EXPECTED)
		expect(node.getNodeInfo).not.toHaveBeenCalled()
	})

	it("a transaction whose message is not the record's never reads as consumed", async () => {
		const { consumed, readContract, outboxes } = setup(new Fr(0xbadn))
		await expect(consumed()).resolves.toBe(false)
		expect(readContract).not.toHaveBeenCalled()
		expect(outboxes).toEqual([])
	})
})
