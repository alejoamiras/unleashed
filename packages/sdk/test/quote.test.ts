import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type Address, slice } from "viem"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { BridgeError } from "../src/errors.ts"
import { swapDataFor } from "../src/execution/fuel-venue.ts"
import { depositFuel, probeFuel, quoteFuel } from "../src/fuel/index.ts"
import { parseNetwork } from "../src/network.ts"
import { mainnetFuelRoute, readsOf, type Step, testnet, walletOf, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const { syntheticPins } = await import("./fakes.ts")
	return { ...real, CODE_PINS: syntheticPins(real.pinOfBuild) }
})

const LIFI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const RAW = JSON.parse(readFileSync(join(LIFI, "mainnet.raw.json"), "utf8")).deadlineFree
const BOOK = JSON.parse(readFileSync(join(LIFI, "mainnet.json"), "utf8")) as { router: Address; ethereum: { usdc: Address } }
/** The recorded quote's slice: 10 USDC. */
const RECORDED_IN = 10_000_000n

let recipient: string
beforeAll(async () => {
	recipient = (await AztecAddress.random()).toString()
})
afterEach(() => vi.unstubAllGlobals())

const failure = (p: Promise<unknown>) =>
	p.then(
		() => undefined,
		(e: unknown) => e as BridgeError,
	)

describe("fuel quotes", () => {
	it("refuses a deposit whose venue now quotes under the reviewed floor, before any prompt or persist", async () => {
		const w = worldOf(testnet())
		const swapper = w.m.bridge?.l1.fuelSwapper as string
		const token = w.m.bridge?.tokens.find((t) => t.erc20.toLowerCase() !== w.m.feeJuice.asset.toLowerCase())?.erc20 as Address
		let rate = 10n ** 13n
		w.reads.set(`${swapper.toLowerCase()}:quote`, (args: readonly unknown[]) => (args[1] as bigint) * rate)
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const quote = await quoteFuel(net, r, { token, amount: 10_000_000n, recipient, privacy: "public" })
		expect(quote.minFj).toBeGreaterThan(0n)
		rate /= 2n
		const log: Step[] = []
		const persist = vi.fn(async () => {})
		const e = await failure(depositFuel(net, r, walletOf(log, net.l1ChainId), quote, { persist }))
		expect(e?.code).toBe("quote-moved")
		expect(e?.submission).toBe("none")
		expect(persist).not.toHaveBeenCalled()
		expect(log).toEqual([])
	})

	it("signs the reviewed floor, not a fresh one, when the venue now quotes the exact slice above it", async () => {
		const w = worldOf(testnet())
		const swapper = w.m.bridge?.l1.fuelSwapper as string
		const token = w.m.bridge?.tokens.find((t) => t.erc20.toLowerCase() !== w.m.feeJuice.asset.toLowerCase())?.erc20 as Address
		w.reads.set(`${swapper.toLowerCase()}:quote`, (args: readonly unknown[]) => (args[1] as bigint) * 10n ** 13n)
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		const data = await swapDataFor(net, r, token, 10_000_000n, 7n)
		expect(BigInt(slice(data, 132, 164)), "_minAmountOut").toBe(7n)
		expect(await swapDataFor(net, r, w.m.feeJuice.asset as Address, 10_000_000n, 7n)).toBe("0x")
	})

	it("on a LI.FI venue with no fetch at all, refuses with fetch-unavailable, never a missing route", async () => {
		const w = worldOf(mainnetFuelRoute(BOOK.router))
		const r = readsOf(w)
		const net = await parseNetwork(w.m, r)
		vi.stubGlobal("fetch", undefined)
		const e = await failure(quoteFuel(net, r, { token: BOOK.ethereum.usdc, amount: RECORDED_IN, recipient, privacy: "public" }))
		expect(e?.code).toBe("fetch-unavailable")
	})

	it("a probe below a pool's minimum does not block a quote that clears it", async () => {
		const w = worldOf(mainnetFuelRoute(BOOK.router))
		const fetch = vi.fn(async (url: string) =>
			new URL(url).searchParams.get("fromAmount") === RECORDED_IN.toString()
				? new Response(JSON.stringify(RAW), { status: 200 })
				: new Response(JSON.stringify({ message: "No available quotes for the requested transfer", code: 1002 }), { status: 404 }),
		) as unknown as typeof globalThis.fetch
		const r = readsOf(w, { fetch })
		const net = await parseNetwork(w.m, r)
		const probe = await failure(probeFuel(net, r, BOOK.ethereum.usdc, 1_000n))
		expect(probe?.code).toBe("no-fuel-route")
		const quote = await quoteFuel(net, r, { token: BOOK.ethereum.usdc, amount: RECORDED_IN, recipient, privacy: "public" })
		expect(quote.venue).toBe("lifi")
		expect(quote.expectedFj).toBe(BigInt(RAW.estimate.toAmount))
		expect(quote.minFj).toBe((BigInt(RAW.estimate.toAmount) * 9_900n) / 10_000n)
	})
})
