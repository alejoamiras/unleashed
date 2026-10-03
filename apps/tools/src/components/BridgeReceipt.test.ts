import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { TESTIDS } from "@/lib/testids"
import BridgeReceipt, { type ReceiptSnapshot } from "./BridgeReceipt.vue"
// A snapshot with no token block renders under asset-label's generic fallback; Fee Juice is always 18-dec.
const BRIDGE_TOKEN_DECIMALS = 18
const BRIDGE_TOKEN_SYMBOL = "TOKEN"
const UNIT = 10n ** BigInt(BRIDGE_TOKEN_DECIMALS)

const sel = (t: string) => `[data-testid="${t}"]`
const L1 = `0x${"ab".repeat(32)}`
const L2 = `0x${"cd".repeat(32)}`
const AZTEC = `0x${"2b".repeat(32)}`
// The EIP-55 specification's own vector, stored lower-case as a wallet may hand it over.
const ETH = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"
const ETH_SHORT = "0x5aAe…eAed"

const deposit = (over: Partial<ReceiptSnapshot> = {}): ReceiptSnapshot => ({
	direction: "deposit",
	recipient: AZTEC,
	amount: (100n * UNIT).toString(),
	isPrivate: true,
	...over,
})
const exit = (over: Partial<ReceiptSnapshot> = {}): ReceiptSnapshot => ({
	direction: "withdraw",
	recipient: ETH,
	amount: (40n * UNIT).toString(),
	isPrivate: false,
	...over,
})
const render = (snapshot: ReceiptSnapshot, props: { ctaLabel?: string; addTokenBusy?: boolean } = {}) =>
	mount(BridgeReceipt, { props: { snapshot, ...props } })
const textOf = (w: ReturnType<typeof render>, id: string) => w.find(sel(id)).text()

describe("BridgeReceipt", () => {
	it("deposit: header route and elapsed, an Arrived h2 naming the section, the hero, both links, the two-link note", async () => {
		const w = render(deposit({ l1TxHash: L1, l2TxHash: L2, startedAt: 1_000, completedAt: 223_000 }))
		const section = w.find(sel(TESTIDS.receipt))
		const h2 = w.find("h2")
		expect(h2.text()).toBe("Arrived")
		expect(section.attributes("aria-labelledby")).toBe(h2.attributes("id"))
		expect(w.text()).not.toContain("✓")
		expect(w.text()).toContain("Ethereum → Aztec · private · 3m 42s")
		// Epoch-era times read as a date, in whichever zone the runner sits.
		expect(w.find(".stamp").text()).toMatch(/^\d{1,2} (Jan|Dec) \d\d:\d\d$/)
		expect(w.text()).toContain(`100.00 ${BRIDGE_TOKEN_SYMBOL}`)
		const links = w.findAll(sel(TESTIDS.receiptLink))
		expect(links).toHaveLength(2)
		expect(links[0].attributes("href")).toBe(`https://sepolia.etherscan.io/tx/${L1}`)
		expect(links[1].attributes("href")).toContain(`/tx-effects/${L2}`)
		expect(w.find(".note").text()).toBe("This bridge is finished. Its record stays in Activity with both transactions.")
		await w.find(sel(TESTIDS.receiptNewBridge)).trigger("click")
		expect(w.emitted("new-bridge")).toHaveLength(1)
	})

	it("one link (a junk hash renders none) never claims both transactions", () => {
		const w = render(exit({ l1TxHash: "junk", l2TxHash: L2 }))
		expect(w.findAll(sel(TESTIDS.receiptLink))).toHaveLength(1)
		expect(w.find(".note").text()).toBe("This bridge is finished. Its record stays in Activity.")
	})

	it("withdraw: Aztec → Ethereum, token only, the Ethereum account line checksummed with the whole address in title", () => {
		const w = render(exit())
		expect(w.text()).toContain("Aztec → Ethereum")
		expect(w.find(".stamp").exists()).toBe(false)
		expect(w.text()).toContain(`40.00 ${BRIDGE_TOKEN_SYMBOL}`)
		// A withdraw never carries gas back to Ethereum — no FJ anywhere.
		expect(w.text()).not.toContain("FJ")
		const account = w.find(sel(TESTIDS.sendReceiptAccount))
		expect(account.text()).toBe(`On Ethereum · ${ETH_SHORT}`)
		expect(account.find("[title]").attributes("title")).toBe("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")
	})

	it("the deposit account line uses the alias when there is one, stripped of bidi marks, else the address alone", () => {
		const aliased = render(deposit({ recipientAlias: "ma‮in" }))
		expect(textOf(aliased, TESTIDS.sendReceiptAccount)).toBe("In your Aztec account main · 0x2b2b…2b2b")
		expect(aliased.text()).not.toContain("‮")
		expect(textOf(render(deposit()), TESTIDS.sendReceiptAccount)).toBe("In your Aztec account · 0x2b2b…2b2b")
	})

	it("From shows the stored sender of the sending chain's shape, and nothing when absent or malformed", () => {
		expect(textOf(render(deposit({ sender: ETH })), TESTIDS.sendReceiptFrom)).toBe(`Ethereum · ${ETH_SHORT}`)
		expect(textOf(render(exit({ sender: AZTEC })), TESTIDS.sendReceiptFrom)).toBe("Aztec · 0x2b2b…2b2b")
		for (const snapshot of [deposit(), deposit({ sender: AZTEC }), deposit({ sender: `${ETH}‮` }), exit({ sender: ETH })]) {
			const w = render(snapshot)
			expect(w.find(sel(TESTIDS.sendReceiptFrom)).exists()).toBe(false)
			expect(w.text()).not.toContain("From")
		}
	})

	it("Visibility on every direction, and an exit never calls its Ethereum side private", () => {
		const read = (s: ReceiptSnapshot) => textOf(render(s), TESTIDS.sendReceiptVisibility)
		expect(read(deposit({ isPrivate: true }))).toBe("Private — others on Aztec see static")
		expect(read(deposit({ isPrivate: false }))).toBe("Public — visible on Aztec")
		const privateExit = read(exit({ isPrivate: true }))
		expect(privateExit).toBe("Sent from your private Aztec balance · arrives publicly on Ethereum")
		expect(read(exit({ isPrivate: false }))).toBe("Public — visible on Aztec and Ethereum")
		expect(privateExit).not.toMatch(/private on Ethereum|Ethereum.*private/i)
	})

	it("private token + gas deposit: one Gas bridged row with the review's quote, its transactions and before claim fees", () => {
		const w = render(deposit({ amount: "150000000000000000", gasQuote: "840000000000000000", txCovered: 2 }))
		expect(textOf(w, TESTIDS.receiptFuel)).toBe("≈ 0.84 Private FJ · 2 transactions · before claim fees")
		// The quote is gross: the claim's fee comes out of it, so nothing calls it ready, used or got.
		for (const word of ["Gas ready", "Gas used"]) expect(w.text()).not.toContain(word)
		expect(w.text()).toContain("Gas bridged")
		expect(w.findAll(sel(TESTIDS.receiptFuel))).toHaveLength(1)
	})

	it("public token + gas deposit: gas reads FJ, and a quote with no transaction count reads without one", () => {
		const w = render(deposit({ amount: "150000000000000000", isPrivate: false, gasQuote: "53000000000000000000" }))
		expect(textOf(w, TESTIDS.receiptFuel)).toBe("≈ 53 FJ · before claim fees")
		expect(w.text()).not.toContain("Private FJ")
		expect(w.text()).not.toContain("transaction")
	})

	it("no-fuel deposit: no gas row", () => {
		const w = render(deposit())
		expect(w.text()).toContain(`100.00 ${BRIDGE_TOKEN_SYMBOL}`)
		expect(w.text()).not.toContain("Gas bridged")
		expect(w.text()).not.toContain("before claim fees")
	})

	// Fuel variant (assetKind "fee-juice"): the amount IS Fee Juice (18-dec) — it gets the SAME hero treatment.
	it("fuel (private) receipt: Arrived hero in Private FJ, New fuel cta, no token leak, one receiptFuel", async () => {
		const w = render(
			deposit({
				assetKind: "fee-juice",
				amount: (20n * 10n ** 18n).toString(),
				gasQuote: (21n * 10n ** 18n).toString(),
				l1TxHash: L1,
				l2TxHash: L2,
			}),
			{ ctaLabel: "New fuel" },
		)
		expect(textOf(w, TESTIDS.receiptFuel)).toBe("20.00 Private FJ")
		expect(w.text()).toContain("bridged · before claim fees")
		expect(w.text()).not.toContain("AZLO")
		expect(w.text()).not.toContain("Bridged")
		// The Fee-Juice amount IS the hero, so the receiptFuel marker sits on the hero — exactly one.
		expect(w.findAll(sel(TESTIDS.receiptFuel))).toHaveLength(1)
		expect(textOf(w, TESTIDS.sendReceiptReviewSaid)).toBe("≈ 21 · bridged 20.00")
		for (const word of ["Gas ready", "you got"]) expect(w.text()).not.toContain(word)
		expect(textOf(w, TESTIDS.receiptNewBridge)).toBe("New fuel")
		await w.find(sel(TESTIDS.receiptNewBridge)).trigger("click")
		expect(w.emitted("new-bridge")).toHaveLength(1)
	})

	it("fuel (public) receipt: reads FJ, not Private FJ, and a floor reads ≥", () => {
		const fuel = { assetKind: "fee-juice" as const, amount: "12500000000000000000", isPrivate: false }
		const w = render(deposit(fuel))
		expect(w.text()).toContain("12.50 FJ")
		expect(w.text()).not.toContain("Private FJ")
		expect(w.text()).not.toContain("≥")
		expect(render(deposit({ ...fuel, atLeast: true })).text()).toContain("≥ 12.50 FJ")
	})

	// Schema-3 sends carry their own token identity; the receipt must never format an 8-dec WBTC
	// amount at the single-token bridge's decimals.
	it("send receipt: the record's own symbol + decimals, grouped, send-specific ids, review-said and the add CTA", async () => {
		const w = render(
			deposit({
				amount: "100000000000",
				token: { displaySymbol: "WBTC", decimals: 8 },
				reviewedAmount: "100000000000",
				reviewedDecimals: 8,
				gasQuote: "5000000000000000000",
				addTokenLabel: "Add WBTC to wallet",
			}),
			{ ctaLabel: "New send" },
		)
		expect(textOf(w, TESTIDS.sendReceiptToken)).toBe("1,000.00 WBTC")
		expect(textOf(w, TESTIDS.sendReceiptGas)).toContain("≈ 5 Private FJ")
		// The send ids REPLACE receiptFuel on a send, so neither surface can double up.
		expect(w.findAll(sel(TESTIDS.receiptFuel))).toHaveLength(0)
		expect(textOf(w, TESTIDS.sendReceiptReviewSaid)).toBe("1,000.00 · you got 1,000.00")
		expect(textOf(w, TESTIDS.sendReceiptAddToken)).toBe("Add WBTC to wallet")
		await w.find(sel(TESTIDS.sendReceiptAddToken)).trigger("click")
		expect(w.emitted("add-token")).toHaveLength(1)
	})

	// "Review said X · you got Y" is only a check the reader can make if Y is written the way X was.
	it("send receipt: a sub-cent amount reads back at full precision, not as zero", () => {
		const w = render(
			deposit({
				amount: "5000",
				isPrivate: false,
				token: { displaySymbol: "USDC", decimals: 6 },
				reviewedAmount: "5000",
				reviewedDecimals: 6,
			}),
		)
		expect(textOf(w, TESTIDS.sendReceiptToken)).toBe("0.005 USDC")
		expect(textOf(w, TESTIDS.sendReceiptReviewSaid)).toBe("0.005 · you got 0.005")
	})

	it("send receipt: no add CTA without a token to add, and the CTA disables while adding", () => {
		const base = deposit({ amount: "100000000", isPrivate: false, token: { displaySymbol: "WBTC", decimals: 8 } })
		expect(render(base).find(sel(TESTIDS.sendReceiptAddToken)).exists()).toBe(false)
		const w = render({ ...base, addTokenLabel: "Add WBTC to wallet" }, { addTokenBusy: true })
		expect(w.find(sel(TESTIDS.sendReceiptAddToken)).attributes("disabled")).toBeDefined()
	})

	// A pathological (valid-by-interface) gas-only snapshot that also carries a gas quote must not grow
	// the token + gas row beside its hero and duplicate the receiptFuel testid.
	it("never renders two receiptFuel nodes (the gas row and the gas-only hero are mutually exclusive)", () => {
		const w = render(deposit({ assetKind: "fee-juice", amount: "20000000000000000000", gasQuote: "5000000000000000000", txCovered: 3 }))
		expect(w.findAll(sel(TESTIDS.receiptFuel))).toHaveLength(1)
		expect(w.text()).not.toContain("Gas bridged")
	})

	it("figures a storage update could have replaced with impossible strings read as dashes or not at all", () => {
		const w = render(
			deposit({
				amount: "150000000000000000",
				isPrivate: false,
				reviewedAmount: "12abc",
				reviewedDecimals: 18,
				gasQuote: "9".repeat(90),
				startedAt: 0,
				completedAt: 1_000,
			}),
		)
		expect(textOf(w, TESTIDS.sendReceiptReviewSaid)).toBe("— · you got 0.15")
		expect(w.text()).not.toContain("Gas bridged")
		expect(w.text()).not.toContain("9".repeat(20))
	})

	it("a completion time no Date can hold shows no stamp, never NaN", () => {
		const w = render(exit({ completedAt: 1e20 }))
		expect(w.find(".stamp").exists()).toBe(false)
		expect(w.text()).not.toContain("NaN")
	})
})
