// @vitest-environment node
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { type SendWithdrawRecord, withdrawContentHash } from "@unleashed/bridge-core"
import { describe, expect, it, vi } from "vitest"
import {
	type AttachBlock,
	type AttachNode,
	type ExitSearchOptions,
	exitMessageHash,
	findExitTx,
	findVerifiedExitTx,
	verifyExitTx,
} from "./exit-attach"

const HUB = `0x00${"1a".repeat(31)}`
const PORTAL = "0x8fa7ffaf818b7157823340cbf3e0c5b3f0a5a0c0"
const RECIPIENT_L1 = "0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"
const CHAIN = 31337
const VERSION = 7
const GENESIS_TS = 1_000_000n
const BLOCK_SECONDS = 36n

function record(over: Partial<SendWithdrawRecord> = {}): SendWithdrawRecord {
	return {
		schema: 3,
		id: "wd-pending-1",
		direction: "withdraw",
		isPrivate: true,
		intent: "token",
		token: {
			erc20: "0x70e0ba845a1a0f2da3359c97e0285013525ffc49",
			portal: PORTAL,
			l2Token: "0xl2",
			nameWord: "0x1",
			symbolWord: "0x2",
			decimals: 6,
			displaySymbol: "USDC",
		},
		amount: "5000000",
		createdAt: Number(GENESIS_TS + 500n * BLOCK_SECONDS) * 1000,
		updatedAt: 1,
		recipientL1: RECIPIENT_L1,
		chainId: CHAIN,
		portal: PORTAL,
		bridge: HUB,
		...over,
	} as SendWithdrawRecord
}

const identity = { chainId: CHAIN, rollupVersion: VERSION }

interface FakeTx {
	hash: string
	block: number
	msgs: string[]
}

/** A chain of `latest` blocks at 36s each from GENESIS_TS, holding the given transactions. */
function fakeNode(
	txs: FakeTx[],
	over: Partial<{
		latest: number
		info: { l1ChainId: number; rollupVersion: number }
		pruneBelow: number
		/** The tip's hash as a function of the reads so far — a reorg mid-scan, placed by the caller. */
		tipHash: (reads: readonly string[]) => string
	}> = {},
) {
	const latest = over.latest ?? 1_000
	const info = over.info ?? { l1ChainId: CHAIN, rollupVersion: VERSION }
	const reads: string[] = []
	const block = (n: number, withBody: boolean): AttachBlock => {
		// The hash is fixed at read time, as a node answer is.
		const hash = n === latest && over.tipHash ? over.tipHash(reads) : `0xblock${n}`
		return blockAt(n, hash, withBody)
	}
	const blockAt = (n: number, hash: string, withBody: boolean): AttachBlock => ({
		number: n,
		hash: { toString: () => hash },
		header: { globalVariables: { timestamp: GENESIS_TS + BigInt(n) * BLOCK_SECONDS } },
		...(withBody
			? {
					body: {
						txEffects: txs
							.filter((t) => t.block === n)
							.map((t) => ({ txHash: { toString: () => t.hash }, l2ToL1Msgs: t.msgs.map((m) => ({ toString: () => m })) })),
					},
				}
			: {}),
	})
	const node: AttachNode = {
		getNodeInfo: async () => {
			reads.push("info")
			return info
		},
		getBlockNumber: async () => {
			reads.push("latest")
			return latest
		},
		getBlocks: async (from, limit, options) => {
			reads.push(`blocks:${from}+${limit}${options?.includeTransactions ? ":tx" : ""}`)
			const out: AttachBlock[] = []
			for (let n = from; n < from + limit && n <= latest; n++)
				if (n >= (over.pruneBelow ?? 0)) out.push(block(n, !!options?.includeTransactions))
			return out
		},
		getTxEffect: async (hash) => {
			reads.push(`effect:${hash}`)
			const t = txs.find((x) => x.hash === hash)
			return t ? { data: { l2ToL1Msgs: t.msgs.map((m) => ({ toString: () => m })) } } : undefined
		},
	}
	return { node, reads }
}

const opts = (over: Partial<ExitSearchOptions> = {}): ExitSearchOptions => ({ ...identity, ...over })

describe("exitMessageHash — the record's own L2→L1 message", () => {
	it("is the siloed hash of (hub → portal, withdraw(recipient, amount, no caller), version, chain)", async () => {
		const content = await withdrawContentHash(RECIPIENT_L1, 5000000n, `0x${"0".repeat(40)}`)
		const expected = computeL2ToL1MessageHash({
			l2Sender: AztecAddress.fromStringUnsafe(HUB),
			l1Recipient: EthAddress.fromString(PORTAL),
			content: Fr.fromString(content),
			rollupVersion: new Fr(VERSION),
			chainId: new Fr(CHAIN),
		}).toString()
		await expect(exitMessageHash(record(), identity)).resolves.toBe(expected)
		// Every input moves it.
		for (const over of [
			{ amount: "1" },
			{ recipientL1: PORTAL },
			{ bridge: `0x00${"2b".repeat(31)}` },
		] as Partial<SendWithdrawRecord>[]) {
			expect(await exitMessageHash(record(over), identity)).not.toBe(expected)
		}
		expect(await exitMessageHash(record(), { chainId: CHAIN, rollupVersion: VERSION + 1 })).not.toBe(expected)
		expect(await exitMessageHash(record({ token: { ...record().token, portal: RECIPIENT_L1 } }), identity)).not.toBe(expected)
	})
})

describe("findExitTx — the exit transaction behind a hash-less exit record", () => {
	it("finds the one transaction whose FIRST L2→L1 message is the record's, inside the window", async () => {
		const hash = await exitMessageHash(record(), identity)
		const { node, reads } = fakeNode([
			{ hash: "0xearly", block: 100, msgs: [hash] }, // before the window
			{ hash: "0xmine", block: 520, msgs: [hash] },
			{ hash: "0xsecond", block: 530, msgs: ["0xother", hash] }, // index 1 is not this app's exit shape
			{ hash: "0xnoise", block: 540, msgs: ["0xother"] },
		])
		await expect(findExitTx(record(), node, new Set(), opts())).resolves.toEqual({
			exitTxHash: "0xmine",
			exitBlock: 520,
			messageHash: hash,
		})
		// The 10-minute slack is ~17 blocks: nothing before ~480 is scanned with bodies.
		expect(reads.filter((r) => r.endsWith(":tx")).every((r) => Number(r.slice(7).split("+")[0]) >= 480)).toBe(true)
	})

	it("a hash the journal already holds is excluded; two fresh matches are ambiguous; none is none", async () => {
		const hash = await exitMessageHash(record(), identity)
		const two = fakeNode([
			{ hash: "0xa", block: 520, msgs: [hash] },
			{ hash: "0xb", block: 600, msgs: [hash] },
		]).node
		await expect(findExitTx(record(), two, new Set(), opts())).resolves.toBe("ambiguous")
		await expect(findExitTx(record(), two, new Set(["0xa"]), opts())).resolves.toMatchObject({ exitTxHash: "0xb", exitBlock: 600 })
		await expect(findExitTx(record(), two, new Set(["0xa", "0xb"]), opts())).resolves.toBe("none")
		await expect(findExitTx(record(), fakeNode([]).node, new Set(), opts())).resolves.toBe("none")
	})

	describe("incomplete — the search could not cover the window", () => {
		it("a node or record on another chain or rollup version", async () => {
			const hash = await exitMessageHash(record(), identity)
			const tx = { hash: "0xa", block: 520, msgs: [hash] }
			await expect(
				findExitTx(record(), fakeNode([tx], { info: { l1ChainId: 1, rollupVersion: VERSION } }).node, new Set(), opts()),
			).resolves.toBe("incomplete")
			await expect(
				findExitTx(record(), fakeNode([tx], { info: { l1ChainId: CHAIN, rollupVersion: VERSION + 1 } }).node, new Set(), opts()),
			).resolves.toBe("incomplete")
			await expect(findExitTx(record({ chainId: 1 }), fakeNode([tx]).node, new Set(), opts())).resolves.toBe("incomplete")
		})

		it("a node whose tip predates the window, or a tip reorged while the window was scanned", async () => {
			const ahead = record({ createdAt: Number(GENESIS_TS + 100_000n * BLOCK_SECONDS) * 1000 })
			const hash = await exitMessageHash(ahead, identity)
			await expect(
				findExitTx(ahead, fakeNode([{ hash: "0xlate", block: 1_000, msgs: [hash] }]).node, new Set(), opts()),
			).resolves.toBe("incomplete")
			const mine = await exitMessageHash(record(), identity)
			const reorged = fakeNode([{ hash: "0xa", block: 520, msgs: [mine] }], {
				tipHash: (reads) => (reads.length > 3 ? "0xreorged" : "0xtip"),
			})
			await expect(findExitTx(record(), reorged.node, new Set(), opts())).resolves.toBe("incomplete")
		})

		it("a window the block cap cannot reach back to, or pruned history inside it", async () => {
			const early = record({ createdAt: Number(GENESIS_TS) * 1000 })
			await expect(findExitTx(early, fakeNode([], { latest: 50_000 }).node, new Set(), opts({ maxBlocks: 1_000 }))).resolves.toBe(
				"incomplete",
			)
			const hash = await exitMessageHash(record(), identity)
			const pruned = fakeNode([{ hash: "0xa", block: 520, msgs: [hash] }], { pruneBelow: 500 }).node
			await expect(findExitTx(record(), pruned, new Set(), opts())).resolves.toBe("incomplete")
		})

		it("a failed read, a read that never settles, too many reads, or too many candidates", async () => {
			const hash = await exitMessageHash(record(), identity)
			const failing = fakeNode([{ hash: "0xa", block: 520, msgs: [hash] }])
			failing.node.getBlocks = async () => {
				throw new Error("node down")
			}
			await expect(findExitTx(record(), failing.node, new Set(), opts())).resolves.toBe("incomplete")

			vi.useFakeTimers()
			try {
				const hanging = fakeNode([])
				hanging.node.getBlocks = () => new Promise(() => {})
				const result = findExitTx(record(), hanging.node, new Set(), opts({ deadlineMs: 1_000, now: () => Date.now() }))
				await vi.advanceTimersByTimeAsync(1_100)
				await expect(result).resolves.toBe("incomplete")
			} finally {
				vi.useRealTimers()
			}

			await expect(findExitTx(record(), fakeNode([]).node, new Set(), opts({ maxReads: 3 }))).resolves.toBe("incomplete")
			const many = Array.from({ length: 9 }, (_, i) => ({ hash: `0x${i}`, block: 520 + i, msgs: [hash] }))
			await expect(findExitTx(record(), fakeNode(many).node, new Set(), opts({ maxCandidates: 8 }))).resolves.toBe("incomplete")
		})
	})
})

describe("verifyExitTx — the re-read before the re-key", () => {
	it("true only when the transaction's first message is still the expected one", async () => {
		const { node } = fakeNode([
			{ hash: "0xa", block: 1, msgs: ["0xhash"] },
			{ hash: "0xb", block: 1, msgs: ["0xother", "0xhash"] },
		])
		await expect(verifyExitTx(node, "0xa", "0xhash")).resolves.toBe(true)
		await expect(verifyExitTx(node, "0xb", "0xhash")).resolves.toBe(false)
		await expect(verifyExitTx(node, "0xmissing", "0xhash")).resolves.toBe(false)
		node.getTxEffect = async () => {
			throw new Error("node down")
		}
		await expect(verifyExitTx(node, "0xa", "0xhash")).resolves.toBe(false)
	})
})

describe("findVerifiedExitTx — the search plus the re-read before the re-key", () => {
	it("a re-read that never settles is incomplete on the search's own budget", async () => {
		vi.useFakeTimers()
		try {
			const hash = await exitMessageHash(record(), identity)
			const { node } = fakeNode([{ hash: "0xa", block: 520, msgs: [hash] }])
			node.getTxEffect = () => new Promise(() => {})
			const result = findVerifiedExitTx(record(), node, new Set(), opts({ deadlineMs: 1_000, now: () => Date.now() }))
			await vi.advanceTimersByTimeAsync(1_100)
			await expect(result).resolves.toBe("incomplete")
		} finally {
			vi.useRealTimers()
		}
	})

	it("a reorg during the re-read is incomplete even when the candidate survives it", async () => {
		const hash = await exitMessageHash(record(), identity)
		const { node } = fakeNode([{ hash: "0xa", block: 520, msgs: [hash] }], {
			tipHash: (reads) => (reads.some((r) => r.startsWith("effect:")) ? "0xreorged" : "0xtip"),
		})
		await expect(findVerifiedExitTx(record(), node, new Set(), opts())).resolves.toBe("incomplete")
		// The plain search never reads the effect, so the same fake sees no reorg there.
		await expect(findExitTx(record(), node, new Set(), opts())).resolves.toMatchObject({ exitTxHash: "0xa" })
	})

	it("a zero-match scan that crosses a reorg is incomplete, never none", async () => {
		const { node } = fakeNode([], { tipHash: (reads) => (reads.length > 3 ? "0xreorged" : "0xtip") })
		await expect(findVerifiedExitTx(record(), node, new Set(), opts())).resolves.toBe("incomplete")
	})

	it("returns the match only while its first message still reads as this record's", async () => {
		const hash = await exitMessageHash(record(), identity)
		const { node } = fakeNode([{ hash: "0xa", block: 520, msgs: [hash] }])
		await expect(findVerifiedExitTx(record(), node, new Set(), opts())).resolves.toMatchObject({ exitTxHash: "0xa", exitBlock: 520 })
		node.getTxEffect = async () => ({ data: { l2ToL1Msgs: [{ toString: () => "0xother" }] } })
		await expect(findVerifiedExitTx(record(), node, new Set(), opts())).resolves.toBe("incomplete")
		await expect(findVerifiedExitTx(record(), fakeNode([]).node, new Set(), opts())).resolves.toBe("none")
	})
})
