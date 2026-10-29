import {
	type Chain,
	createPublicClient,
	createWalletClient,
	custom,
	defineChain,
	encodeFunctionData,
	erc20Abi,
	getAddress,
	type Hex,
	keccak256,
	parseTransaction,
	toHex,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { boundedGasTerms, withGasTerms } from "./gas-terms"

const ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`)
const SEPOLIA_ID = 11_155_111
const TOKEN = getAddress("0x1c7d4b196cb0c7b01d743fbc6116a902379c7238")
const POOL = getAddress("0x5ef6c01e11889d86803e0b23e3cb3f9e9d97b662")
const GWEI = 10n ** 9n

const sepolia = (extra: Partial<Chain> = {}): Chain =>
	defineChain({
		id: SEPOLIA_ID,
		name: `chain-${SEPOLIA_ID}`,
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: ["http://node.invalid"] } },
		...extra,
	})

const block = {
	number: "0x100",
	hash: `0x${"ab".repeat(32)}`,
	parentHash: `0x${"cd".repeat(32)}`,
	timestamp: "0x1",
	baseFeePerGas: toHex(GWEI),
	gasLimit: "0x1c9c380",
	gasUsed: "0x0",
	miner: `0x${"00".repeat(20)}`,
	extraData: "0x",
	logsBloom: `0x${"00".repeat(256)}`,
	transactions: [],
	uncles: [],
}

/** A Sepolia endpoint recording every method. Its `eth_fillTransaction` answer, which a send that asked for it would sign,
 *  names chain 1, nonce 7 and 10^7 gas at 10^6 gwei with a fee payer signature. */
function endpoint(o: { estimate?: bigint; priority?: bigint; pending?: () => number } = {}) {
	const methods: string[] = []
	const raws: Hex[] = []
	const transport = custom(
		{
			async request({ method, params }: { method: string; params?: unknown }) {
				methods.push(method)
				const [first] = (params ?? []) as [unknown]
				switch (method) {
					case "eth_chainId":
						return toHex(SEPOLIA_ID)
					case "eth_estimateGas":
						return toHex(o.estimate ?? 80_000n)
					case "eth_getBlockByNumber":
						return block
					case "eth_maxPriorityFeePerGas":
						return toHex(o.priority ?? GWEI)
					case "eth_getTransactionCount":
						return toHex(o.pending ? o.pending() : 7)
					case "eth_fillTransaction": {
						const r = first as Record<string, string>
						const fee = toHex(10n ** 15n)
						return {
							raw: "0x",
							tx: {
								...{ from: r.from, to: r.to, input: r.data, value: "0x0", type: "0x2", chainId: "0x1", nonce: "0x7" },
								...{ gas: toHex(10n ** 7n), maxFeePerGas: fee, maxPriorityFeePerGas: fee },
								feePayerSignature: { r: "0x1", s: "0x1", yParity: "0x0" },
							},
						}
					}
					case "eth_sendRawTransaction":
						raws.push(first as Hex)
						return keccak256(first as Hex)
				}
				throw new Error(`unexpected ${method}`)
			},
			// One answer per request, so a failed read fails its send instead of being retried.
		},
		{ retryCount: 0 },
	)
	const bounded = (chain = sepolia(), charge: (worstWei: bigint) => void = () => {}) =>
		withGasTerms(
			createWalletClient({ account: ACCOUNT, chain, transport }),
			boundedGasTerms(createPublicClient({ chain, transport }), charge),
		)
	return { methods, raws, bounded, signed: () => raws.map((raw) => parseTransaction(raw)) }
}

describe("withGasTerms", () => {
	it("signs each bounded send with the wallet's chain id, the pending nonce and the charged terms", async () => {
		const node = endpoint()
		const charged: bigint[] = []
		const wallet = node.bounded(sepolia(), (worst) => charged.push(worst))
		await wallet.writeContract({ address: TOKEN, abi: erc20Abi, functionName: "approve", args: [POOL, 5n], account: ACCOUNT })
		await wallet.sendTransaction({ to: POOL, data: "0x1234", value: 3n, feePayer: true } as never)

		const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [POOL, 5n] })
		const sent = [
			{ to: TOKEN.toLowerCase(), data: approve },
			{ to: POOL.toLowerCase(), data: "0x1234", value: 3n },
		]
		expect(node.signed()).toMatchObject(
			sent.map((call) => ({ ...call, chainId: SEPOLIA_ID, nonce: 7, type: "eip1559", gas: 100_000n, maxPriorityFeePerGas: GWEI })),
		)
		expect(node.signed().map((tx) => (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n))).toEqual(charged)
		expect(node.methods).not.toContain("eth_fillTransaction")

		// A caller's nonce is signed as given; a zero tip, no value and no data, which the signed bytes omit, still match.
		const quiet = endpoint({ priority: 0n })
		await quiet.bounded().sendTransaction({ to: POOL, nonce: 9 })
		expect(quiet.signed()).toMatchObject([{ chainId: SEPOLIA_ID, nonce: 9, to: POOL.toLowerCase() }])
		expect(quiet.methods).not.toContain("eth_getTransactionCount")

		// A refused charge reads no nonce and sends nothing; a failed nonce read fails its send alone.
		const costly = endpoint({ estimate: 10n ** 7n })
		const ceiling = (worst: bigint) => {
			if (worst > 10n ** 15n) throw new Error("over the ceiling")
		}
		await expect(costly.bounded(sepolia(), ceiling).sendTransaction({ to: POOL, data: "0x1234" })).rejects.toThrow(/over the ceiling/)
		expect(costly.methods).not.toContain("eth_getTransactionCount")
		let reads = 0
		const flaky = endpoint({
			pending: () => {
				reads += 1
				if (reads === 1) throw new Error("backend unavailable")
				return 7
			},
		})
		await expect(flaky.bounded().sendTransaction({ to: POOL, data: "0x1234" })).rejects.toThrow()
		expect(flaky.raws).toHaveLength(0)
		await flaky.bounded().sendTransaction({ to: POOL, data: "0x1234" })
		expect(flaky.signed()).toMatchObject([{ chainId: SEPOLIA_ID, nonce: 7 }])
		expect([costly, flaky].flatMap((n) => n.methods)).not.toContain("eth_fillTransaction")
	})

	it("refuses before broadcast a send it cannot sign as checked", async () => {
		// A chain's own request hook, editing one field after the terms are priced.
		const edited = (edit: Record<string, unknown>, runAt = ["beforeFillTransaction"]) =>
			sepolia({ prepareTransactionRequest: [async (r: object) => ({ ...r, ...edit }), { runAt }] } as never)
		const edits: [string, Chain][] = [
			["chainId", edited({ chainId: 1 })],
			["gas", edited({ gas: 100_001n })],
			["maxFeePerGas", edited({ maxFeePerGas: 2_200_000_001n })],
			["maxPriorityFeePerGas", edited({ maxPriorityFeePerGas: GWEI + 1n })],
			["to", edited({ to: TOKEN })],
			["data", edited({ data: "0xdead" })],
			["value", edited({ value: 1n })],
			["nonce", edited({ nonce: 9 }, ["afterFillParameters"])],
		]
		for (const [field, chain] of edits) {
			const node = endpoint()
			await expect(node.bounded(chain).sendTransaction({ to: POOL, data: "0x1234" })).rejects.toThrow(
				new RegExp(`signature carries ${field} `),
			)
			expect(node.raws).toHaveLength(0)
		}

		const node = endpoint()
		await expect(node.bounded().sendTransaction({ to: POOL, account: ACCOUNT.address })).rejects.toThrow(/local account/)
		await expect(node.bounded().sendTransaction({ to: POOL, chain: { ...sepolia(), id: 1 } })).rejects.toThrow(
			/signs for chain 11155111, not 1/,
		)
		expect(node.methods).toEqual([])
	})
})
