import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { ExitPlan, GasLegPlan, ResolvedToken, SendPlan } from "@/lib/send-model"

// The route's currencies are named against this network's WETH and Fee Juice.
vi.mock("@/contracts/bridge-generation", () => ({
	SWAP: { weth: "0x00000000000000000000000000000000000000e7" },
	FEE_JUICE: { asset: "0x000000000000000000000000000000000000fee0" },
}))
import { TESTIDS } from "@/lib/testids"
import ReviewDetails, { type PortalState } from "./ReviewDetails.vue"

const sel = (t: string) => `[data-testid="${t}"]`

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const ACCOUNT = "0x2b1c4f3a9d8e7c6b5a4938271605f4e3d2c1b0a9"

function token(kind: "registered" | "portal-only" | "first-time" = "registered"): ResolvedToken {
	return {
		chainId: 1,
		address: USDC,
		symbol: "USDC",
		name: "USD Coin",
		decimals: 6,
		source: "manifest",
		logoKey: `1:${USDC}`,
		state: kind === "first-time" ? { kind } : { kind, registration: {}, l2Token: "0x01" },
		portal: "0x94752ef7cf8f037f78ee7722a9387ef95c819fc8",
		words: { nameWord: "0x01", symbolWord: "0x02" },
		l2Token: "0x01",
	} as unknown as ResolvedToken
}

const WETH = "0x00000000000000000000000000000000000000e7"
const FJ = "0x000000000000000000000000000000000000fee0"
const OTHER = "0x0000000000000000000000000000000000000abc"

/** USDC → ETH → Fee Juice: the token enters the first pool as currency0, ETH the second as currency1. */
function gas(hops: number): GasLegPlan {
	const path = [
		{ currency0: USDC, currency1: WETH, fee: 500, tickSpacing: 10, hooks: OTHER },
		{ currency0: FJ, currency1: WETH, fee: 3000, tickSpacing: 60, hooks: OTHER },
	].slice(0, hops)
	return {
		fuelAmount: 1_000_000n,
		fuelFj: 1n,
		quote: 1n,
		minFuelOutput: 1n,
		route: { path, zeroForOnes: [true, false].slice(0, hops) },
		capped: null,
	} as unknown as GasLegPlan
}

const DEPOSIT: SendPlan = { direction: "l1-to-l2", intent: "token", token: token(), amount: 5_000_000n, isPrivate: true }
const EXIT = {
	direction: "l2-to-l1",
	token: token(),
	amount: 5_000_000n,
	isPrivate: true,
	recipientL1: ACCOUNT,
} as unknown as ExitPlan

function details(over: Partial<{ plan: SendPlan | ExitPlan; portalVerified: PortalState; slippageBps: number | null }> = {}) {
	return mount(ReviewDetails, {
		props: {
			plan: DEPOSIT,
			portalVerified: "verified" as PortalState,
			account: ACCOUNT,
			signatureValiditySeconds: 1_800,
			slippageBps: 50,
			...over,
		},
	})
}

async function open(w: ReturnType<typeof details>) {
	await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
	return w
}

describe("ReviewDetails", () => {
	it("is collapsed until asked for", () => {
		const w = details()
		expect(w.find(sel(TESTIDS.sendReviewDetails)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewDetailsToggle)).attributes("aria-expanded")).toBe("false")
		w.unmount()
	})

	it("opens and closes again", async () => {
		const w = await open(details())
		expect(w.find(sel(TESTIDS.sendReviewDetails)).exists()).toBe(true)
		expect(w.find(sel(TESTIDS.sendReviewDetailsToggle)).attributes("aria-expanded")).toBe("true")
		await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
		expect(w.find(sel(TESTIDS.sendReviewDetails)).exists()).toBe(false)
		w.unmount()
	})

	it("names the currencies a gas leg swaps through, in order, and counts the pools", async () => {
		const w = await open(details({ plan: { ...DEPOSIT, intent: "token+gas", gas: gas(2) } }))
		expect(w.find(sel(TESTIDS.sendReviewRoute)).text()).toContain("USDC → ETH → Fee Juice on Uniswap v4 (2 pools)")
		const one = await open(details({ plan: { ...DEPOSIT, intent: "token+gas", gas: gas(1) } }))
		expect(one.find(sel(TESTIDS.sendReviewRoute)).text()).toContain("USDC → ETH on Uniswap v4 (1 pool)")
		w.unmount()
		one.unmount()
	})

	it("shows neither Route nor Slippage for a token-only send — there is nothing swapped to describe", async () => {
		const w = await open(details())
		expect(w.find(sel(TESTIDS.sendReviewRoute)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewSlippage)).exists()).toBe(false)
		// The fee asset's gas leg swaps through no pool at all: a route line, saying so.
		const direct = await open(details({ plan: { ...DEPOSIT, intent: "token+gas", gas: gas(0) } }))
		expect(direct.find(sel(TESTIDS.sendReviewRoute)).text()).toContain("no swap")
		w.unmount()
		direct.unmount()
	})

	it("describes an exit as a burn and a release", async () => {
		const w = await open(details({ plan: EXIT }))
		expect(w.find(sel(TESTIDS.sendReviewRoute)).text()).toContain("burns")
		w.unmount()
	})

	it("prints slippage as a percentage on a send that buys gas", async () => {
		const w = await open(details({ plan: { ...DEPOSIT, intent: "token+gas", gas: gas(1) }, slippageBps: 125 }))
		expect(w.find(sel(TESTIDS.sendReviewSlippage)).text()).toContain("1.25%")
		w.unmount()
	})

	it("distinguishes a verified portal from one this send will create", async () => {
		const verified = await open(details())
		expect(verified.find(sel(TESTIDS.sendReviewPortal)).attributes("data-portal")).toBe("verified")
		expect(verified.find(sel(TESTIDS.sendReviewPortal)).text()).toContain("verified")
		verified.unmount()

		const fresh = await open(details({ portalVerified: "absent", plan: { ...DEPOSIT, token: token("first-time") } }))
		expect(fresh.find(sel(TESTIDS.sendReviewPortal)).text()).toContain("created by this send")
		fresh.unmount()
	})

	it("a read that never came back claims neither a clone nor a creation", async () => {
		const w = await open(details({ portalVerified: "unknown", plan: { ...DEPOSIT, token: token("first-time") } }))
		const row = w.find(sel(TESTIDS.sendReviewPortal))
		expect(row.attributes("data-portal")).toBe("unknown")
		expect(row.text()).toContain("not readable")
		expect(row.text()).not.toContain("created by this send")
		expect(row.text()).not.toContain("verified")
		w.unmount()
	})

	it("a clone at another address is a warning, never the creation copy", async () => {
		const w = await open(details({ portalVerified: "mismatch" }))
		const row = w.find(sel(TESTIDS.sendReviewPortal))
		expect(row.attributes("data-portal")).toBe("mismatch")
		expect(row.text()).toContain("holds a different address")
		expect(row.text()).not.toContain("created by this send")
		w.unmount()
	})

	it("the token and the portal are links to the Ethereum explorer, on their full checksummed addresses", async () => {
		const w = await open(details())
		const tokenLink = w.find(sel(TESTIDS.sendReviewTokenLink))
		expect(tokenLink.attributes("href")).toMatch(/\/address\/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48$/)
		expect(tokenLink.attributes("rel")).toContain("noopener")
		const portalLink = w.find(sel(TESTIDS.sendReviewPortalLink))
		expect(portalLink.attributes("href")).toMatch(/\/address\/0x94752ef7Cf8f037F78EE7722a9387ef95c819fC8$/)
		expect(portalLink.text()).toBe("0x94752ef7Cf8f037F78EE7722a9387ef95c819fC8")
		w.unmount()
	})

	it("says when the send also registers the token", async () => {
		const w = await open(details({ plan: { ...DEPOSIT, token: token("portal-only") } }))
		expect(w.find(sel(TESTIDS.sendReviewPortal)).text()).toContain("registers the token")
		w.unmount()
	})

	it("prints the token's contract address in full, checksummed and never elided", async () => {
		const w = await open(details())
		const row = w.find(sel(TESTIDS.sendReviewToken))
		expect(row.text()).toContain("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
		expect(row.text()).not.toContain("…")
		w.unmount()
	})

	it("trims the account but keeps the full value reachable", async () => {
		const w = await open(details())
		const row = w.find(sel(TESTIDS.sendReviewAccount))
		expect(row.text()).toContain("…")
		expect(row.find("dd").attributes("title")).toBe(ACCOUNT)
		w.unmount()
	})

	it("states how long the signature stays good", async () => {
		const minutes = await open(details())
		expect(minutes.find(sel(TESTIDS.sendReviewSignature)).text()).toContain("30 min")
		minutes.unmount()

		const seconds = await open(
			mount(ReviewDetails, {
				props: { plan: DEPOSIT, portalVerified: "verified", account: ACCOUNT, signatureValiditySeconds: 45, slippageBps: null },
			}),
		)
		expect(seconds.find(sel(TESTIDS.sendReviewSignature)).text()).toContain("45s")
		seconds.unmount()
	})
})
