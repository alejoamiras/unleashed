import { signedMinFuelOutput, type TokenState } from "@unleashed/bridge-core"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type GasShareOutcome, type UseGasShareHandle, useGasShare } from "./useGasShare"

/** The generation's swap block; `undefined` stands in for a network with no venue. */
const h = vi.hoisted(() => ({ swap: { value: undefined as unknown } }))

vi.mock("@/contracts/bridge-generation", () => ({
	get SWAP() {
		return h.swap.value
	},
}))
vi.mock("@/lib/network", () => ({ NETWORK: { nodeUrl: "http://node.test" } }))
// The network's predicted fees, as the node answers them (a private slice is priced from these).
vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({
		getCurrentMinFees: async () => ({ feePerDaGas: 10n, feePerL2Gas: 20n }),
	}),
}))

const FJ_PER_TX = 100_000_000_000_000_000n
const FJ_REGISTER = 500_000_000_000_000_000n
const MIN_FUEL_FJ = 1_000_000_000_000_000_000n
const SLIPPAGE_BPS = 100

const SWAP_FIXTURE = {
	poolManager: "0x0000000000000000000000000000000000000001",
	quoter: "0x0000000000000000000000000000000000000002",
	multicall3: "0x0000000000000000000000000000000000000003",
	weth: "0x0000000000000000000000000000000000000004",
	feeJuice: "0x0000000000000000000000000000000000000005",
	tiers: [{ fee: 3000, tickSpacing: 60 }],
	ethFj: { fee: 3000, tickSpacing: 60 },
	slippageBps: SLIPPAGE_BPS,
	minFuelFj: MIN_FUEL_FJ.toString(),
	fjPerTx: FJ_PER_TX.toString(),
	fjRegister: FJ_REGISTER.toString(),
}

const REGISTRATION = {
	portal: "0x0000000000000000000000000000000000000009",
	decimals: 6,
	registerIndex: 1n,
	nameWord: `0x${"0".repeat(64)}`,
	symbolWord: `0x${"0".repeat(64)}`,
	registerKey: `0x${"0".repeat(64)}`,
} as const

const REGISTERED: TokenState = { kind: "registered", registration: REGISTRATION, l2Token: `0x${"1".repeat(64)}` }
const FIRST_TIME: TokenState = { kind: "first-time" }
const PORTAL_ONLY: TokenState = { kind: "portal-only", registration: REGISTRATION }

/** One whole token buys one whole Fee Juice — the arithmetic stays legible in the assertions. */
const RATE = { probeIn: 1_000_000n, probeOut: 1_000_000_000_000_000_000n }
const AMOUNT = 1_000_000_000n

/** The public-slice tests never see "pricing": narrow it away so the assertions read the result. */
function sizedGasShare(): Omit<UseGasShareHandle, "propose"> & {
	propose: (i: Parameters<UseGasShareHandle["propose"]>[0]) => Exclude<GasShareOutcome, "pricing">
} {
	const share = useGasShare()
	return {
		...share,
		propose: (i) => {
			const r = share.propose(i)
			return r === "pricing" ? null : r
		},
	}
}

describe("useGasShare", () => {
	beforeEach(() => {
		h.swap.value = SWAP_FIXTURE
	})

	it("sizes a registered token's slice to txTarget × fjPerTx", () => {
		const { txTarget, propose } = sizedGasShare()
		expect(txTarget.value).toBe(20)
		const result = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		expect(result?.fuelFj).toBe(20n * FJ_PER_TX)
		expect(result?.capped).toBeNull()
	})

	it("adds fjRegister for a token the hub has not registered yet", () => {
		const { propose } = sizedGasShare()
		const registered = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		const firstTime = propose({ amount: AMOUNT, decimals: 6, state: FIRST_TIME, rate: RATE })
		expect(firstTime?.fuelFj).toBe(20n * FJ_PER_TX + FJ_REGISTER)
		expect(firstTime?.fuelAmount).toBeGreaterThan(registered?.fuelAmount ?? 0n)
	})

	it("adds fjRegister for a portal-only token too — its first claim still registers", () => {
		const { propose } = sizedGasShare()
		expect(propose({ amount: AMOUNT, decimals: 6, state: PORTAL_ONLY, rate: RATE })?.fuelFj).toBe(20n * FJ_PER_TX + FJ_REGISTER)
	})

	it("a private slice is priced from live fees: pending until they arrive, then the claim's ceiling replaces fjRegister, plus a registration's for a first-time token", async () => {
		// Fees 10/20 → claim ceiling 2M·20 + 100k·10 = 41M; register ceiling 4M·20 + 100k·10 = 81M.
		const share = useGasShare()
		expect(share.ceilingsFor(REGISTERED)).toBeNull()
		expect(share.fuelClaimCeiling()).toBeNull()
		expect(share.propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE, isPrivate: true })).toBe("pricing")
		await share.prime()
		expect(share.ceilingsFor(REGISTERED)).toBe(41_000_000n)
		expect(share.ceilingsFor(FIRST_TIME)).toBe(122_000_000n)
		// A gas-only send's standalone fuel claim: 4M·20 + 100k·10.
		expect(share.fuelClaimCeiling()).toBe(81_000_000n)
		const registered = share.propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE, isPrivate: true })
		const firstTime = share.propose({ amount: AMOUNT, decimals: 6, state: FIRST_TIME, rate: RATE, isPrivate: true })
		expect(registered).toMatchObject({ fuelFj: 20n * FJ_PER_TX + 41_000_000n })
		expect(firstTime).toMatchObject({ fuelFj: 20n * FJ_PER_TX + 122_000_000n })
		// A public slice never prices ceilings: the calibrated registration charge stays.
		expect(share.propose({ amount: AMOUNT, decimals: 6, state: FIRST_TIME, rate: RATE })).toMatchObject({
			fuelFj: 20n * FJ_PER_TX + FJ_REGISTER,
		})
	})

	it("prices what a claim from held gas sets aside: a public claim's own ceiling, a private first-time token's two", async () => {
		// Fees 10/20 → public claim 3M·20 + 100k·10 = 61M, registering 3.5M·20 + 100k·10 = 71M; private 41M + 81M.
		const share = useGasShare()
		expect(share.ownGasCeilingFor(REGISTERED, false)).toBeNull()
		await share.prime()
		expect(share.ownGasCeilingFor(REGISTERED, false)).toBe(61_000_000n)
		expect(share.ownGasCeilingFor(FIRST_TIME, false)).toBe(71_000_000n)
		expect(share.ownGasCeilingFor(REGISTERED, true)).toBe(41_000_000n)
		expect(share.ownGasCeilingFor(PORTAL_ONLY, true)).toBe(122_000_000n)
	})

	it("buys at least the claim minimum when the tx target asks for less", () => {
		const { txTarget, propose } = sizedGasShare()
		txTarget.value = 1
		const result = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		expect(result?.fuelFj).toBe(MIN_FUEL_FJ)
		expect(result?.capped).toBe("min")
	})

	it("never diverts more than half the deposit", () => {
		const { propose } = sizedGasShare()
		const result = propose({ amount: 10n, decimals: 6, state: REGISTERED, rate: RATE })
		expect(result?.fuelAmount).toBe(5n)
		expect(result?.capped).toBe("half")
	})

	it("sizes the input so the signed floor still reaches the Fee Juice target", () => {
		const { propose } = sizedGasShare()
		const result = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		const quote = ((result?.fuelAmount ?? 0n) * RATE.probeOut) / RATE.probeIn
		expect(signedMinFuelOutput(quote, SLIPPAGE_BPS, MIN_FUEL_FJ)).toBeGreaterThanOrEqual(result?.fuelFj ?? 0n)
	})

	it("re-proposes a bigger slice when the tx target moves", () => {
		const { txTarget, propose } = sizedGasShare()
		const before = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		txTarget.value = 40
		const after = propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })
		expect(after?.fuelFj).toBe(40n * FJ_PER_TX)
		expect(after?.fuelAmount).toBeGreaterThan(before?.fuelAmount ?? 0n)
	})

	it("floors a quote at quote × (1 − slippage)", () => {
		const { floorFor } = sizedGasShare()
		expect(floorFor(10n * MIN_FUEL_FJ)).toBe((10n * MIN_FUEL_FJ * 9900n) / 10_000n)
	})

	it("never floors below the claim minimum", () => {
		const { floorFor } = sizedGasShare()
		expect(floorFor(MIN_FUEL_FJ)).toBe(MIN_FUEL_FJ)
	})

	it("proposes nothing and refuses a floor when the network has no swap venue", () => {
		h.swap.value = undefined
		const { propose, floorFor } = sizedGasShare()
		expect(propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: RATE })).toBeNull()
		expect(() => floorFor(MIN_FUEL_FJ)).toThrow(/no swap venue/)
	})

	it("propagates bridge-core's input validation rather than inventing a slice", () => {
		const { propose, floorFor } = sizedGasShare()
		expect(() => propose({ amount: 0n, decimals: 6, state: REGISTERED, rate: RATE })).toThrow(/amount must be positive/)
		expect(() => propose({ amount: AMOUNT, decimals: 6, state: REGISTERED, rate: { probeIn: 1n, probeOut: 0n } })).toThrow(
			/probeOut must be positive/,
		)
		expect(() => floorFor(0n)).toThrow(/empty quote/)
	})

	it("dispose returns the tx target to its default", () => {
		const { txTarget, dispose } = sizedGasShare()
		txTarget.value = 99
		dispose()
		expect(txTarget.value).toBe(20)
	})
})
