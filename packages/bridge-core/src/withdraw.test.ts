import { describe, expect, it, vi } from "vitest"

// consumeWithdrawal calls these two aztec.js helpers; mock them so the orchestration
// (witness → portal.withdraw) is exercised without a node. ContractBase is type-only
// (erased), so a full mock of /contracts only needs waitForProven.
vi.mock("@aztec-labs/aztec.js/contracts", () => ({ waitForProven: vi.fn() }))
vi.mock("@aztec-labs/stdlib/messaging", () => ({ computeL2ToL1MembershipWitness: vi.fn() }))
// 5.0: consumeWithdrawal constructs an OutboxContract (L1 roots reader) — mock it; getRoots is
// only invoked inside the mocked computeL2ToL1MembershipWitness, so a bare mock suffices.
vi.mock("@aztec-labs/ethereum/contracts", () => ({ OutboxContract: vi.fn() }))

import { waitForProven } from "@aztec-labs/aztec.js/contracts"
import { computeL2ToL1MembershipWitness } from "@aztec-labs/stdlib/messaging"
import { consumeWithdrawal } from "./flows"

const makeL1 = () => ({
	account: { address: "0xL1ACC" },
	pub: {
		simulateContract: vi.fn(async (_a: unknown) => ({ request: { sentinel: true } })),
		waitForTransactionReceipt: vi.fn(async () => ({})),
	},
	wallet: { writeContract: vi.fn(async () => "0xhash") },
})

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
