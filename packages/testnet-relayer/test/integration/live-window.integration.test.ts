/**
 * The chain facts the scan window rests on, read live from the Worker's default endpoints: keyless, read-only, and
 * only with RELAYER_LIVE=1. Base Sepolia's block time keeps the window under half the cap, PublicNode serves a full
 * `getLogs` chunk on both chains, and Sepolia's fill-log span still covers the window.
 */
import { BASE_SEPOLIA_RPC_DEFAULT, FILLED_RELAY, FUNDS_DEPOSITED, retried, SEPOLIA_RPC_DEFAULT } from "@unleashed/bridge-core/across-fill"
import { lifiBook } from "@unleashed/sdk/l1"
import { createPublicClient, http } from "viem"
import { describe, expect, it } from "vitest"
import { CHUNK_BLOCKS, FILL_LOG_BLOCKS } from "../../src/run"
import { MAX_SCAN_BLOCKS, SCAN_WINDOW_S, scanWindow } from "../../src/window"

describe.skipIf(process.env.RELAYER_LIVE !== "1")("the scan window on the live testnets", () => {
	it("spans 7,800 s of Base Sepolia by timestamps, under half the cap, in chunks both endpoints serve", {
		timeout: 120_000,
	}, async () => {
		const source = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_DEFAULT) })
		const destination = createPublicClient({ transport: http(SEPOLIA_RPC_DEFAULT) })
		// Two blocks below the head, as a pass reads: not every load-balanced backend has the newest.
		const [head, sepolia] = await Promise.all([
			source.getBlockNumber().then((n) => n - 2n),
			destination.getBlock({ blockNumber: (await destination.getBlockNumber()) - 2n }),
		])
		const stamp = async (blockNumber: bigint) => (await retried(() => source.getBlock({ blockNumber }))).timestamp
		const since = sepolia.timestamp - SCAN_WINDOW_S
		const { from } = await scanWindow(stamp, head, since)
		expect(await stamp(from)).toBeGreaterThanOrEqual(since)
		expect(await stamp(from - 1n)).toBeLessThan(since)
		expect(head - from).toBeLessThan(MAX_SCAN_BLOCKS / 2n)
		const chunk = (top: bigint) => ({ fromBlock: top - CHUNK_BLOCKS + 1n, toBlock: top })
		await source.getLogs({ address: lifiBook(84532).acrossSpokePool, event: FUNDS_DEPOSITED, ...chunk(head) })
		await destination.getLogs({ address: lifiBook(11155111).acrossSpokePool, event: FILLED_RELAY, ...chunk(sepolia.number) })
		const fillFloor = await destination.getBlock({ blockNumber: sepolia.number - FILL_LOG_BLOCKS })
		expect(sepolia.timestamp - fillFloor.timestamp).toBeGreaterThanOrEqual(SCAN_WINDOW_S)
	})
})
