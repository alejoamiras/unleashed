import { describe, expect, it, vi } from "vitest"
import { minOutputForSlippage, type QuoteClient, QuoteUnavailableError, quoteFuelPath } from "./quote"
import { buildFuelRoute } from "./route"

const ROUTE = buildFuelRoute({
	token: "0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68",
	weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
	feeJuice: "0x762C132040fdA6183066Fa3B14d985ee55aA3C18",
	tokenWeth: { fee: 500, tickSpacing: 10 },
	ethFj: { fee: 987, tickSpacing: 10 },
})
const QUOTER = "0x61b3f2011A92d183C7dbaDBdA940a7555Ccf9227" as const

function clientReturning(outputs: bigint[]): QuoteClient & { calls: unknown[] } {
	const calls: unknown[] = []
	let i = 0
	return {
		calls,
		readContract: vi.fn(async (args: unknown) => {
			calls.push(args)
			return [outputs[i++], 0n] as const
		}) as never,
	}
}

describe("quoteFuelPath", () => {
	it("chains the hops: hop-1 output becomes hop-2 exactAmount", async () => {
		const client = clientReturning([2_500_000_000_000_000n, 500_000_000_000_000_000_000n])
		const out = await quoteFuelPath(client, QUOTER, ROUTE, 250_000_000_000_000_000n)
		expect(out).toBe(500_000_000_000_000_000_000n)
		const second = client.calls[1] as { args: readonly [{ exactAmount: bigint; zeroForOne: boolean }] }
		expect(second.args[0].exactAmount).toBe(2_500_000_000_000_000n)
		expect(second.args[0].zeroForOne).toBe(true)
	})

	it("a hop quoting to zero throws QuoteUnavailableError (dust or drained pool)", async () => {
		const client = clientReturning([0n, 0n])
		await expect(quoteFuelPath(client, QUOTER, ROUTE, 10n)).rejects.toBeInstanceOf(QuoteUnavailableError)
	})

	it("a quoter revert is wrapped with the failing hop, cause preserved", async () => {
		const boom = new Error("0x486aa307") // V4 quoter revert selector blob
		const client: QuoteClient = { readContract: vi.fn().mockRejectedValue(boom) as never }
		const err = await quoteFuelPath(client, QUOTER, ROUTE, 1_000n).catch((e) => e)
		expect(err).toBeInstanceOf(QuoteUnavailableError)
		expect(err.message).toMatch(/hop 1/)
		expect(err.cause).toBe(boom)
	})

	it("rejects a non-positive input before any network call", async () => {
		const client = clientReturning([])
		await expect(quoteFuelPath(client, QUOTER, ROUTE, 0n)).rejects.toBeInstanceOf(QuoteUnavailableError)
		expect(client.readContract).not.toHaveBeenCalled()
	})
})

describe("minOutputForSlippage", () => {
	it("applies the bps haircut (300 bps = 3%)", () => {
		expect(minOutputForSlippage(1_000_000n, 300)).toBe(970_000n)
	})

	it("never returns zero - a zero floor signs the slice away", () => {
		expect(minOutputForSlippage(1n, 300)).toBe(1n)
		expect(() => minOutputForSlippage(0n, 300)).toThrow(QuoteUnavailableError)
	})

	it("rejects out-of-range bps", () => {
		expect(() => minOutputForSlippage(100n, 10_000)).toThrow(/bps/)
		expect(() => minOutputForSlippage(100n, -1)).toThrow(/bps/)
	})
})
