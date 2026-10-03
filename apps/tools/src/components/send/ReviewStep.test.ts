import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { ExitPlan, GasLegPlan, ResolvedToken, SendPlan } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"
import type { PortalState } from "./ReviewDetails.vue"
import ReviewStep from "./ReviewStep.vue"

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

const GAS = {
	fuelAmount: 2_000_000n,
	fuelFj: 300_000_000_000_000_000n,
	quote: 300_000_000_000_000_000n,
	minFuelOutput: 285_000_000_000_000_000n,
	route: { path: [{}, {}], zeroForOnes: [] },
	capped: null,
} as unknown as GasLegPlan

const DEPOSIT: SendPlan = { direction: "l1-to-l2", intent: "token", token: token(), amount: 10_000_000n, isPrivate: true }
const EXIT = {
	direction: "l2-to-l1",
	token: token(),
	amount: 10_000_000n,
	isPrivate: true,
	recipientL1: ACCOUNT,
} as unknown as ExitPlan

type Props = {
	plan: SendPlan | ExitPlan
	portalVerified: PortalState
	estimate: { takes: string; networkFee: string | null; networkFeeNote: string; txCovered: number | null }
	grant: "idle" | "pending" | "declined"
	busy: boolean
	error: string | null
}

function review(over: Partial<Props> = {}) {
	return mount(ReviewStep, {
		props: {
			plan: DEPOSIT,
			portalVerified: "verified" as PortalState,
			account: ACCOUNT,
			signatureValiditySeconds: 1_800,
			slippageBps: 50,
			estimate: {
				takes: "about 12 minutes",
				networkFee: null,
				networkFeeNote: "paid from the gas you already hold on Aztec",
				txCovered: null,
			},
			grant: "idle",
			busy: false,
			error: null,
			...over,
		},
	})
}

describe("ReviewStep", () => {
	it("states the four lines a send is judged on", () => {
		const w = review()
		expect(w.find(sel(TESTIDS.sendReviewSend)).text()).toContain("10.00 USDC")
		expect(w.find(sel(TESTIDS.sendReviewArrives)).text()).toContain("10.00 USDC")
		expect(w.find(sel(TESTIDS.sendReviewGas)).exists()).toBe(false)
		// With no figure to state, the fee row is the note alone.
		expect(w.find(sel(TESTIDS.sendReviewNetworkFee)).find("dd").text()).toBe("paid from the gas you already hold on Aztec")
		expect(w.find(sel(TESTIDS.sendReviewTakes)).text()).toContain("about 12 minutes")
		w.unmount()
	})

	it("lists both legs of what arrives: the token less its slice, and the gas with what it covers", () => {
		const w = review({
			plan: { ...DEPOSIT, intent: "token+gas", gas: GAS },
			estimate: {
				takes: "about 12 minutes",
				networkFee: "≈ 0.1 FJ",
				networkFeeNote: "taken from the gas that arrives",
				txCovered: 3,
			},
		})
		const arrives = w.find(sel(TESTIDS.sendReviewArrives)).text()
		expect(arrives).toContain("8.00 USDC")
		expect(w.find(sel(TESTIDS.sendReviewGas)).text()).toBe("≈ 0.3 FJ gas for ≈ 3 transactions")
		expect(w.find(sel(TESTIDS.sendReviewNetworkFee)).text()).toBe("Fee≈ 0.1 FJ taken from the gas that arrives")
		w.unmount()
	})

	it("a gas-only send arrives as gas alone", () => {
		const w = review({
			plan: { ...DEPOSIT, intent: "gas", amount: 2_000_000n, gas: GAS },
			estimate: {
				takes: "about 12 minutes",
				networkFee: "≈ 0.1 FJ",
				networkFeeNote: "taken from the gas that arrives",
				txCovered: 3,
			},
		})
		const arrives = w.find(sel(TESTIDS.sendReviewArrives)).text()
		expect(arrives).not.toContain("USDC")
		expect(arrives).toContain("≈ 0.3 FJ")
		w.unmount()
	})

	it("states the visibility choice on its own row, in the toggle's words, never on the amounts", () => {
		const priv = review()
		const row = priv.find(sel(TESTIDS.sendReviewVisibility))
		expect(row.attributes("data-visibility")).toBe("private")
		expect(row.text()).toContain("Private — only you can see it")
		expect(row.find("dd svg").exists()).toBe(true)
		expect(priv.find(sel(TESTIDS.sendReviewArrives)).text()).not.toMatch(/private|public/)
		priv.unmount()
		const pub = review({ plan: { ...DEPOSIT, isPrivate: false } })
		expect(pub.find(sel(TESTIDS.sendReviewVisibility)).text()).toContain("Public — visible on Aztec")
		expect(pub.find(sel(TESTIDS.sendReviewVisibility)).find("dd svg").exists()).toBe(true)
		pub.unmount()
	})

	it("an exit arrives at the Ethereum recipient, has no visibility row, and its fee is the view's own line", () => {
		const w = review({
			plan: EXIT,
			estimate: {
				takes: "long",
				networkFee: null,
				networkFeeNote: "your Aztec wallet's own fee, then Ethereum gas to finish",
				txCovered: null,
			},
		})
		expect(w.find(sel(TESTIDS.sendReviewArrives)).text()).toContain("on Ethereum")
		expect(w.find(sel(TESTIDS.sendReviewGas)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewVisibility)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewNetworkFee)).text()).toContain("Ethereum gas to finish")
		w.unmount()
	})

	it("warns about a first-time token without naming an address", () => {
		const w = review({ plan: { ...DEPOSIT, token: token("first-time") } })
		const soft = w.find(sel(TESTIDS.sendReviewFirstTime))
		expect(soft.text()).toContain("takes a little longer")
		expect(soft.text()).not.toContain("0x")
		w.unmount()
	})

	it("warns for a token that is only half set up too", () => {
		const w = review({ plan: { ...DEPOSIT, token: token("portal-only") } })
		expect(w.find(sel(TESTIDS.sendReviewFirstTime)).exists()).toBe(true)
		w.unmount()
	})

	it("says nothing about first times for a token that is ready", () => {
		const w = review()
		expect(w.find(sel(TESTIDS.sendReviewFirstTime)).exists()).toBe(false)
		w.unmount()
	})

	it("tells an exit that the tokens leave before the last step", () => {
		const w = review({ plan: EXIT })
		expect(w.find(sel(TESTIDS.sendReviewBurnNote)).text()).toContain("leave Aztec as soon as you sign")
		w.unmount()
	})

	it("shows no burn line on a deposit, and no first-time line on an exit", () => {
		const deposit = review()
		expect(deposit.find(sel(TESTIDS.sendReviewBurnNote)).exists()).toBe(false)
		deposit.unmount()
		const exit = review({ plan: { ...EXIT, token: token("first-time") } as ExitPlan })
		expect(exit.find(sel(TESTIDS.sendReviewFirstTime)).exists()).toBe(false)
		exit.unmount()
	})

	it("reports the grant the wallet is being asked for", async () => {
		const w = review({ grant: "pending" })
		expect(w.find(sel(TESTIDS.sendGrantPending)).text()).toContain("Confirm the request")
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).attributes("disabled")).toBeDefined()
		await w.setProps({ grant: "declined" })
		expect(w.find(sel(TESTIDS.sendGrantDeclined)).text()).toContain("declined")
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).attributes("disabled")).toBeUndefined()
		w.unmount()
	})

	it("shows a small amount as it is, never rounded to zero", () => {
		const w = review({ plan: { ...DEPOSIT, amount: 5_000n } })
		expect(w.find(sel(TESTIDS.sendReviewSend)).text()).toContain("0.005 USDC")
		expect(w.find(sel(TESTIDS.sendReviewArrives)).text()).toContain("0.005 USDC")
		w.unmount()
	})

	it("refuses to sign against a portal that is not the derived one", () => {
		const w = review({ portalVerified: "mismatch" })
		expect(w.find(sel(TESTIDS.sendReviewPortalWarning)).text()).toContain("cannot continue")
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("an unread portal check warns nobody and blocks nothing", () => {
		const w = review({ portalVerified: "unknown" })
		expect(w.find(sel(TESTIDS.sendReviewPortalWarning)).exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).attributes("disabled")).toBeUndefined()
		w.unmount()
	})

	it("names the disagreement when the contract contradicts the list that labelled it", () => {
		const contradicted = {
			...token(),
			metadataConflict: {
				listed: { symbol: "USDC", name: "USD Coin", decimals: 6 },
				live: { symbol: "PSTL", name: "Pastel", decimals: 18 },
			},
		} as unknown as ResolvedToken
		const w = review({ plan: { ...DEPOSIT, token: contradicted } })
		const warn = w.find(sel(TESTIDS.sendReviewMetadataWarning))
		expect(warn.text()).toContain("PSTL")
		expect(warn.text()).toContain("USDC")
		w.unmount()
	})

	it("says nothing about metadata when the list and the contract agree", () => {
		const w = review()
		expect(w.find(sel(TESTIDS.sendReviewMetadataWarning)).exists()).toBe(false)
		w.unmount()
	})

	it("strips and caps a listed symbol before it reaches the amount lines", () => {
		const hostile = { ...token(), symbol: `US${String.fromCodePoint(0x202e)}DC${"X".repeat(60)}` } as unknown as ResolvedToken
		const w = review({ plan: { ...DEPOSIT, token: hostile } })
		const line = w.find(sel(TESTIDS.sendReviewSend)).text()
		expect(line).not.toContain(String.fromCodePoint(0x202e))
		expect(line).toContain("…")
		w.unmount()
	})

	it("surfaces a flow error, and a wallet's own text only stripped of bidi controls and capped", () => {
		const w = review({ error: "The signature expired." })
		expect(w.find(sel(TESTIDS.sendReviewError)).text()).toBe("The signature expired.")
		w.unmount()
		const remote = review({ error: `‮liar⁦ ${"x".repeat(500)}` })
		const shown = Array.from(remote.find(sel(TESTIDS.sendReviewError)).text())
		expect(shown.join("")).toMatch(/^liar x+…$/)
		expect(shown).toHaveLength(241)
		remote.unmount()
	})

	it("confirms and goes back", async () => {
		const w = review()
		await w.find(sel(TESTIDS.sendReviewConfirm)).trigger("click")
		await w.find(sel(TESTIDS.sendReviewBack)).trigger("click")
		expect(w.emitted("confirm")).toHaveLength(1)
		expect(w.emitted("back")).toHaveLength(1)
		w.unmount()
	})

	it("locks both buttons while the send is running, and drops the key glyph for the busy pixels", async () => {
		const w = review()
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).find("svg").exists()).toBe(true)
		await w.setProps({ busy: true })
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).text()).toContain("Sending")
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).find("svg").exists()).toBe(false)
		expect(w.find(sel(TESTIDS.sendReviewConfirm)).attributes("disabled")).toBeDefined()
		expect(w.find(sel(TESTIDS.sendReviewBack)).attributes("disabled")).toBeDefined()
		w.unmount()
	})

	it("keeps mechanism vocabulary inside the details it collapses", async () => {
		const w = review({ plan: { ...DEPOSIT, token: token("first-time") }, portalVerified: "absent" })
		expect(w.text().toLowerCase()).not.toMatch(/portal|register/)
		await w.find(sel(TESTIDS.sendReviewDetailsToggle)).trigger("click")
		expect(w.find(sel(TESTIDS.sendReviewDetails)).text().toLowerCase()).toContain("portal")
		w.unmount()
	})

	it("the closed details name the rows they hold, route and slippage only where those rows exist, never the portal", () => {
		const cases: [SendPlan | ExitPlan, string][] = [
			[DEPOSIT, "Token, account, signature"],
			[{ ...DEPOSIT, intent: "token+gas", gas: GAS }, "Token, route, slippage, account, signature"],
			[EXIT, "Token, route, account, signature"],
		]
		for (const [plan, hint] of cases) {
			const w = review({ plan })
			const toggle = w.find(sel(TESTIDS.sendReviewDetailsToggle)).text()
			expect(toggle).toBe(`Details${hint}`)
			expect(toggle.toLowerCase()).not.toMatch(/portal/)
			w.unmount()
		}
	})
})
