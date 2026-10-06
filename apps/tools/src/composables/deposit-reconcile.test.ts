import { DEPOSIT_ROUTER_ABI, PRIVATE_FPC_ADDRESS, type SendDepositRecord, SWAP_BRIDGE_ROUTER_ABI } from "@unleashed/bridge-core"
import { encodeFunctionData } from "viem"
import { describe, expect, it, vi } from "vitest"
import { type DepositSearchOptions, findDepositTx, type ReconcileL1Client } from "./deposit-reconcile"

type Hex = `0x${string}`

/** The retired `SwapBridgeRouter` most cases search, beside the deposit router. */
const ROUTER = "0x1111111111111111111111111111111111111111" as Hex
const DEPOSIT_ROUTER = "0x5555555555555555555555555555555555555555" as Hex
const ERC20 = "0x70e0ba845a1a0f2da3359c97e0285013525ffc49" as Hex
const CLONE = "0x2222222222222222222222222222222222222222" as Hex
const RECIPIENT = `0x${"2b".repeat(32)}` as Hex
const SECRET_HASH = `0x00${"4d".repeat(31)}` as Hex
const FUEL_SECRET_HASH = `0x00${"5e".repeat(31)}` as Hex
const ZERO32 = `0x${"0".repeat(64)}` as Hex
const CHAIN = 31337
const GENESIS_TS = 1_000_000n

function record(over: Partial<SendDepositRecord> = {}): SendDepositRecord {
	return {
		schema: 3,
		id: SECRET_HASH,
		direction: "deposit",
		isPrivate: false,
		intent: "token",
		token: { erc20: ERC20, portal: CLONE, l2Token: "0xl2", nameWord: "0x1", symbolWord: "0x2", decimals: 6, displaySymbol: "USDC" },
		amount: "100000000",
		createdAt: Number(GENESIS_TS + 500n * 12n) * 1000,
		updatedAt: 1,
		recipient: RECIPIENT,
		secret: "0xsecret",
		secretHashHex: SECRET_HASH,
		chainId: CHAIN,
		portal: CLONE,
		bridge: "0xhub",
		...over,
	} as SendDepositRecord
}

const FUEL = { amount: "10", secret: "0xfs", secretHashHex: FUEL_SECRET_HASH, minOutput: "9" }

const permit = { nonce: 0n, deadline: 0n, signature: "0x" as Hex }

function bridgeCalldata(
	over: Partial<{ tokenPortal: Hex; bridgeToken: Hex; amount: bigint; aztecRecipient: Hex; secretHash: Hex; isPrivate: boolean }> = {},
) {
	return encodeFunctionData({
		abi: SWAP_BRIDGE_ROUTER_ABI,
		functionName: "bridge",
		args: [
			{
				tokenPortal: CLONE,
				bridgeToken: ERC20,
				amount: 100000000n,
				aztecRecipient: RECIPIENT,
				secretHash: SECRET_HASH,
				isPrivate: false,
				...over,
			},
			permit,
		],
	})
}

function bridgeWithFuelCalldata(over: Record<string, unknown> = {}) {
	return encodeFunctionData({
		abi: SWAP_BRIDGE_ROUTER_ABI,
		functionName: "bridgeWithFuel",
		args: [
			{
				tokenPortal: CLONE,
				bridgeToken: ERC20,
				totalAmount: 100000010n,
				fuelAmount: 10n,
				aztecRecipient: RECIPIENT,
				fuelRecipient: RECIPIENT,
				tokenSecretHash: SECRET_HASH,
				fuelSecretHash: FUEL_SECRET_HASH,
				minFuelOutput: 9n,
				path: [],
				zeroForOnes: [],
				isPrivate: false,
				...over,
			},
			permit,
		],
	})
}

interface FakeTx {
	hash: Hex
	block: bigint
	to?: Hex
	input: Hex
	status?: "success" | "reverted"
	/** The event the router emitted for it, with its decoded args. */
	event: { name: "Bridge" | "BridgeWithFuel" | "Deposited"; args: Record<string, unknown> }
	/** The router that emitted it; the legacy one unless named. */
	emitter?: Hex
}

/** A chain: blocks 0..latest at 12s each from GENESIS_TS, the given router transactions, and the
 *  reads counted so a budget can be asserted. `getLogs` decodes nothing — it answers with the args the
 *  fake was given, one event name per call, as viem does. */
function fakeChain(
	txs: FakeTx[],
	over: Partial<{ latest: bigint; chainId: () => number; blockHash: (n: bigint, read: number) => Hex }> = {},
) {
	const latest = over.latest ?? 1_000n
	const reads: string[] = []
	const chainIdOf = over.chainId ?? (() => CHAIN)
	const blockHash = (n: bigint) => (over.blockHash ?? ((k: bigint) => `0x${k.toString(16).padStart(64, "0")}` as Hex))(n, reads.length)
	const client: ReconcileL1Client = {
		getChainId: async () => {
			reads.push("chainId")
			return chainIdOf()
		},
		getBlockNumber: async () => {
			reads.push("blockNumber")
			return latest
		},
		getBlock: async ({ blockNumber }) => {
			reads.push(`block:${blockNumber}`)
			return { number: blockNumber, timestamp: GENESIS_TS + blockNumber * 12n, hash: blockHash(blockNumber) }
		},
		getLogs: async ({ address, event, fromBlock, toBlock }) => {
			reads.push(`logs:${fromBlock}-${toBlock}`)
			const name = (event as { name: string }).name
			// A foreign `to` is caught by the calldata check in production, never by this filter.
			return txs
				.filter((t) => (t.emitter ?? ROUTER) === address && t.event.name === name && t.block >= fromBlock && t.block <= toBlock)
				.map((t) => ({ transactionHash: t.hash, args: t.event.args }))
		},
		getTransaction: async ({ hash }) => {
			reads.push(`tx:${hash}`)
			const t = txs.find((x) => x.hash === hash)
			return t ? { to: t.to ?? t.emitter ?? ROUTER, input: t.input } : null
		},
		getTransactionReceipt: async ({ hash }) => {
			reads.push(`receipt:${hash}`)
			const t = txs.find((x) => x.hash === hash)
			return t ? { status: t.status ?? "success", blockNumber: t.block, blockHash: blockHash(t.block) } : null
		},
	}
	return { client, reads }
}

const bridgeTx = (hash: Hex, block: bigint, over: Partial<FakeTx> = {}): FakeTx => ({
	hash,
	block,
	input: bridgeCalldata(),
	event: { name: "Bridge", args: { aztecRecipient: RECIPIENT, secretHash: SECRET_HASH, amount: 100000000n, isPrivate: false } },
	...over,
})

const opts = (over: Partial<DepositSearchOptions> = {}): DepositSearchOptions => ({
	chainId: CHAIN,
	router: DEPOSIT_ROUTER,
	legacyRouters: [ROUTER],
	...over,
})

type IntentFields = {
	token: Hex
	aztecRecipient: Hex
	tokenSecretHash: Hex
	isPrivate: boolean
	fuelSlice: bigint
	fuelRecipient: Hex
	fuelSecretHash: Hex
	minFuelOutput: bigint
}

const TOKEN_INTENT: IntentFields = {
	token: ERC20,
	aztecRecipient: RECIPIENT,
	tokenSecretHash: SECRET_HASH,
	isPrivate: false,
	fuelSlice: 0n,
	fuelRecipient: ZERO32,
	fuelSecretHash: ZERO32,
	minFuelOutput: 0n,
}

const FUELED_INTENT: IntentFields = {
	...TOKEN_INTENT,
	fuelSlice: 10n,
	fuelRecipient: RECIPIENT,
	fuelSecretHash: FUEL_SECRET_HASH,
	minFuelOutput: 9n,
}

function permitCalldata(intent: IntentFields, amount: bigint): Hex {
	return encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeWithPermit", args: [intent, "0x1234", amount, permit] })
}

/** A deposit-router send: its `Deposited` indexes both secret hashes, the calldata carries the intent. */
const depositTx = (hash: Hex, block: bigint, intent: IntentFields, amount: bigint): FakeTx => ({
	hash,
	block,
	emitter: DEPOSIT_ROUTER,
	input: permitCalldata(intent, amount),
	event: { name: "Deposited", args: { tokenSecretHash: intent.tokenSecretHash, fuelSecretHash: intent.fuelSecretHash } },
})

describe("findDepositTx — the deposit router", () => {
	it("finds a token send, and a fueled one by both secret hashes and the summed amount", async () => {
		await expect(
			findDepositTx(record(), fakeChain([depositTx("0xa1", 520n, TOKEN_INTENT, 100000000n)]).client, opts()),
		).resolves.toEqual({
			txHash: "0xa1",
		})
		const rec = record({ intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		await expect(findDepositTx(rec, fakeChain([depositTx("0xa2", 600n, FUELED_INTENT, 100000010n)]).client, opts())).resolves.toEqual({
			txHash: "0xa2",
		})
	})

	it("a private send publishes a zero recipient and binds its fuel to the PrivateFPC", async () => {
		const rec = record({ isPrivate: true, intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		const intent = { ...FUELED_INTENT, aztecRecipient: ZERO32, fuelRecipient: PRIVATE_FPC_ADDRESS as Hex, isPrivate: true }
		await expect(findDepositTx(rec, fakeChain([depositTx("0xa3", 610n, intent, 100000010n)]).client, opts())).resolves.toEqual({
			txHash: "0xa3",
		})
	})

	it.each([
		["another amount", FUELED_INTENT, 100000011n],
		["another fuel slice", { ...FUELED_INTENT, fuelSlice: 11n }, 100000010n],
		["another fuel floor", { ...FUELED_INTENT, minFuelOutput: 8n }, 100000010n],
		["another fuel recipient", { ...FUELED_INTENT, fuelRecipient: ZERO32 }, 100000010n],
		["another token", { ...FUELED_INTENT, token: CLONE }, 100000010n],
		["another recipient", { ...FUELED_INTENT, aztecRecipient: ZERO32 }, 100000010n],
		["the private flag", { ...FUELED_INTENT, isPrivate: true }, 100000010n],
	] as const)("a fueled record rejects a candidate with %s at the calldata", async (_label, intent, amount) => {
		const rec = record({ intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		const tx = { ...depositTx("0xa4", 600n, intent, amount), event: depositTx("0xa4", 600n, FUELED_INTENT, 0n).event }
		await expect(findDepositTx(rec, fakeChain([tx]).client, opts())).resolves.toBe("none")
	})

	it("a token record never matches a fueled intent carrying its hash", async () => {
		const tx = { ...depositTx("0xa5", 520n, { ...FUELED_INTENT, fuelSecretHash: ZERO32 }, 100000000n) }
		await expect(findDepositTx(record(), fakeChain([tx]).client, opts())).resolves.toBe("none")
	})

	it("one verified send on each router is ambiguous, not a guess", async () => {
		const both = fakeChain([depositTx("0xa6", 520n, TOKEN_INTENT, 100000000n), bridgeTx("0xa7", 530n)])
		await expect(findDepositTx(record(), both.client, opts())).resolves.toBe("ambiguous")
		const legacyOnly = fakeChain([bridgeTx("0xa7", 530n)])
		await expect(findDepositTx(record(), legacyOnly.client, opts())).resolves.toEqual({ txHash: "0xa7" })
		await expect(findDepositTx(record(), legacyOnly.client, opts({ legacyRouters: [] }))).resolves.toBe("none")
	})
})

describe("findDepositTx — a retired router", () => {
	it("finds the one `bridge` transaction whose calldata is this record's send, after the window start", async () => {
		// createdAt is block 500 (12s blocks); the 10-minute slack is 50 blocks, so the window starts near 450.
		const { client, reads } = fakeChain([bridgeTx("0xaa", 520n), bridgeTx("0xbb", 100n)])
		await expect(findDepositTx(record(), client, opts())).resolves.toEqual({ txHash: "0xaa" })
		expect(reads.filter((r) => r.startsWith("logs:")).every((r) => Number(r.slice(5).split("-")[0]) >= 440)).toBe(true)
		expect(reads.filter((r) => r === "chainId")).toHaveLength(2)
	})

	it("finds a `bridgeWithFuel` transaction for a token+gas record by both secret hashes and the summed amount", async () => {
		const tx: FakeTx = {
			hash: "0xcc",
			block: 600n,
			input: bridgeWithFuelCalldata(),
			event: { name: "BridgeWithFuel", args: { tokenSecretHash: SECRET_HASH, fuelSecretHash: FUEL_SECRET_HASH } },
		}
		const rec = record({ intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		await expect(findDepositTx(rec, fakeChain([tx]).client, opts())).resolves.toEqual({ txHash: "0xcc" })
		const wrongTotal = { ...tx, input: bridgeWithFuelCalldata({ totalAmount: 100000011n }) }
		await expect(findDepositTx(rec, fakeChain([wrongTotal]).client, opts())).resolves.toBe("none")
		const wrongFuelSecret = {
			...tx,
			event: { name: "BridgeWithFuel" as const, args: { tokenSecretHash: SECRET_HASH, fuelSecretHash: ZERO32 } },
		}
		await expect(findDepositTx(rec, fakeChain([wrongFuelSecret]).client, opts())).resolves.toBe("none")
	})

	it("a PRIVATE deposit publishes a zero recipient: found by its secret hash, its fuel bound to the PrivateFPC", async () => {
		const rec = record({ isPrivate: true, intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		const input = bridgeWithFuelCalldata({ aztecRecipient: ZERO32, fuelRecipient: PRIVATE_FPC_ADDRESS, isPrivate: true })
		const tx: FakeTx = {
			hash: "0xdd",
			block: 610n,
			input,
			event: { name: "BridgeWithFuel", args: { tokenSecretHash: SECRET_HASH, fuelSecretHash: FUEL_SECRET_HASH } },
		}
		await expect(findDepositTx(rec, fakeChain([tx]).client, opts())).resolves.toEqual({ txHash: "0xdd" })
		// The same secret hashes on a public-flagged call are not this record's send.
		const publicFlagged = {
			...tx,
			input: bridgeWithFuelCalldata({ aztecRecipient: ZERO32, fuelRecipient: PRIVATE_FPC_ADDRESS, isPrivate: false }),
		}
		await expect(findDepositTx(rec, fakeChain([publicFlagged]).client, opts())).resolves.toBe("none")
	})

	it.each([
		["another fuel amount", bridgeWithFuelCalldata({ fuelAmount: 11n })],
		["another minimum fuel output", bridgeWithFuelCalldata({ minFuelOutput: 8n })],
		["another token secret hash in the calldata", bridgeWithFuelCalldata({ tokenSecretHash: ZERO32 })],
		["another fuel recipient", bridgeWithFuelCalldata({ fuelRecipient: ZERO32 })],
		["another fuel secret hash in the calldata", bridgeWithFuelCalldata({ fuelSecretHash: ZERO32 })],
		["the plain entrypoint", bridgeCalldata()],
	])("a fueled record rejects a candidate with %s at the calldata", async (_label, input) => {
		const rec = record({ intent: "token+gas", fuel: FUEL } as Partial<SendDepositRecord>)
		const tx: FakeTx = {
			hash: "0xff",
			block: 600n,
			input,
			event: { name: "BridgeWithFuel", args: { tokenSecretHash: SECRET_HASH, fuelSecretHash: FUEL_SECRET_HASH } },
		}
		await expect(findDepositTx(rec, fakeChain([tx]).client, opts())).resolves.toBe("none")
	})

	it("scans every chunk without a gap: matches on both sides of a chunk boundary are both seen", async () => {
		// The window starts at 450; with 100-block chunks the boundaries fall on 549|550.
		const { client } = fakeChain([bridgeTx("0xleft", 549n), bridgeTx("0xright", 550n)])
		await expect(findDepositTx(record(), client, opts({ chunkBlocks: 100 }))).resolves.toBe("ambiguous")
	})

	it.each([
		["another token", bridgeCalldata({ bridgeToken: "0x3333333333333333333333333333333333333333" })],
		["another portal", bridgeCalldata({ tokenPortal: "0x4444444444444444444444444444444444444444" })],
		["another amount", bridgeCalldata({ amount: 1n })],
		["another recipient", bridgeCalldata({ aztecRecipient: ZERO32 })],
		["the fueled entrypoint", bridgeWithFuelCalldata()],
	])("a copied secret hash on %s is rejected at the calldata", async (_label, input) => {
		const { client } = fakeChain([bridgeTx("0xee", 520n, { input })])
		await expect(findDepositTx(record(), client, opts())).resolves.toBe("none")
	})

	it("a transaction to another contract, a reverted one, or one whose calldata does not decode never counts", async () => {
		const elsewhere = bridgeTx("0x01", 520n, { to: "0x9999999999999999999999999999999999999999" })
		const reverted = bridgeTx("0x02", 521n, { status: "reverted" })
		const garbage = bridgeTx("0x03", 522n, { input: "0xdeadbeef" })
		await expect(findDepositTx(record(), fakeChain([elsewhere, reverted, garbage]).client, opts())).resolves.toBe("none")
	})

	it("two verified transactions are ambiguous, not a guess", async () => {
		const { client } = fakeChain([bridgeTx("0xaa", 520n), bridgeTx("0xab", 530n)])
		await expect(findDepositTx(record(), client, opts())).resolves.toBe("ambiguous")
	})

	it("a gas-only record has no router token deposit to find", async () => {
		const rec = record({ intent: "gas", token: undefined } as Partial<SendDepositRecord>)
		await expect(findDepositTx(rec, fakeChain([bridgeTx("0xaa", 520n)]).client, opts())).resolves.toBe("none")
	})

	describe("incomplete — the search could not cover the window", () => {
		it("a window the block cap cannot reach back to", async () => {
			const rec = record({ createdAt: Number(GENESIS_TS) * 1000 })
			await expect(findDepositTx(rec, fakeChain([], { latest: 100_000n }).client, opts({ maxBlocks: 1_000 }))).resolves.toBe(
				"incomplete",
			)
		})

		it("a chain whose tip predates the window", async () => {
			const ahead = record({ createdAt: Number(GENESIS_TS + 100_000n * 12n) * 1000 })
			await expect(findDepositTx(ahead, fakeChain([bridgeTx("0xlate", 1_000n)]).client, opts())).resolves.toBe("incomplete")
		})

		it("a chain that is not the record's, before or after the scan", async () => {
			await expect(findDepositTx(record(), fakeChain([bridgeTx("0xaa", 520n)], { chainId: () => 1 }).client, opts())).resolves.toBe(
				"incomplete",
			)
			await expect(findDepositTx(record({ chainId: 1 }), fakeChain([]).client, opts())).resolves.toBe("incomplete")
			let calls = 0
			const switching = fakeChain([bridgeTx("0xaa", 520n)], { chainId: () => (calls++ === 0 ? CHAIN : 1) })
			await expect(findDepositTx(record(), switching.client, opts())).resolves.toBe("incomplete")
		})

		it("a failed read, a read that never settles (the deadline), or too many reads", async () => {
			const failing = fakeChain([bridgeTx("0xaa", 520n)])
			failing.client.getLogs = async () => {
				throw new Error("rpc down")
			}
			await expect(findDepositTx(record(), failing.client, opts())).resolves.toBe("incomplete")

			vi.useFakeTimers()
			try {
				const hanging = fakeChain([bridgeTx("0xaa", 520n)])
				hanging.client.getLogs = () => new Promise(() => {})
				const result = findDepositTx(record(), hanging.client, opts({ deadlineMs: 1_000, now: () => Date.now() }))
				await vi.advanceTimersByTimeAsync(1_100)
				await expect(result).resolves.toBe("incomplete")
			} finally {
				vi.useRealTimers()
			}

			await expect(findDepositTx(record(), fakeChain([bridgeTx("0xaa", 520n)]).client, opts({ maxReads: 3 }))).resolves.toBe(
				"incomplete",
			)
		})

		it("a chain switched away and back during the scan, or a tip reorged past what was scanned", async () => {
			let epoch = 0
			const flapping = fakeChain([bridgeTx("0xaa", 520n)])
			const logs = flapping.client.getLogs
			flapping.client.getLogs = async (args) => {
				epoch++ // the wallet switched away and back while the logs were read: both chain checks still agree
				return logs(args)
			}
			await expect(findDepositTx(record(), flapping.client, opts({ chainEpoch: () => epoch }))).resolves.toBe("incomplete")

			// A switch reported during the LAST read — the closing chain assertion — must count too.
			let lateEpoch = 0
			const late = fakeChain([bridgeTx("0xaa", 520n)])
			const chainId = late.client.getChainId
			late.client.getChainId = async () => {
				const answer = await chainId()
				if (late.reads.filter((r) => r === "chainId").length === 2) lateEpoch = 1
				return answer
			}
			await expect(findDepositTx(record(), late.client, opts({ chainEpoch: () => lateEpoch }))).resolves.toBe("incomplete")
			expect(late.reads.filter((r) => r === "chainId")).toHaveLength(2)

			// The tip's hash differs between the first read (before the scan) and the last (after it).
			const reorged = fakeChain([bridgeTx("0xaa", 520n)], {
				blockHash: (n, read) =>
					n === 1_000n && read > 3 ? (`0x${"e".repeat(64)}` as Hex) : (`0x${n.toString(16).padStart(64, "0")}` as Hex),
			})
			await expect(findDepositTx(record(), reorged.client, opts())).resolves.toBe("incomplete")
		})

		it("too many candidates, or a receipt the canonical chain no longer holds", async () => {
			const many = Array.from({ length: 9 }, (_, i) => bridgeTx(`0x${(i + 16).toString(16)}` as Hex, 520n + BigInt(i)))
			await expect(findDepositTx(record(), fakeChain(many).client, opts({ maxCandidates: 8 }))).resolves.toBe("incomplete")
			const reorged = fakeChain([bridgeTx("0xaa", 520n)], {
				blockHash: (n) => (n === 520n ? ZERO32 : (`0x${n.toString(16).padStart(64, "1")}` as Hex)),
			})
			// The receipt names block 520 under a hash the fake's block read no longer agrees with.
			reorged.client.getTransactionReceipt = async ({ hash }) => ({
				status: "success",
				blockNumber: 520n,
				blockHash: `0x${"f".repeat(64)}` as Hex,
				...(hash ? {} : {}),
			})
			await expect(findDepositTx(record(), reorged.client, opts())).resolves.toBe("incomplete")
		})
	})
})
