import { mount } from "@vue/test-utils"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { type Component, ref } from "vue"
import type { LookupState } from "@/composables/useAddressLookup"
import type { ExitPlan, GasLegPlan, ResolvedToken, SendPlan, SelectableToken } from "@/lib/send-model"
import { TESTIDS } from "@/lib/testids"

// The mint strip is the one step component that reaches a wallet and the manifest; both are stood
// in for so its buttons render and the sweep can reach them.
vi.mock("@/composables/useL1Wallet", () => ({
	useL1Wallet: () => ({ address: ref("0xef4d9e1f4e9e2dd9e747b53f4be3d04bfa935f2d"), publicClient: {}, ensureWalletClient: () => null }),
}))
vi.mock("@/contracts/bridge-generation", () => ({
	MANIFEST_TOKENS: [
		{ erc20: "0x70e0ba845a1a0f2da3359c97e0285013525ffc49", decimals: 6, displaySymbol: "USDC", source: "permissionless-mint" },
	],
	FEE_JUICE: { asset: "0x000000000000000000000000000000000000fee0" },
	SWAP: undefined,
}))

/**
 * E2E selects only by `data-testid`, so an interactive element or focus target (`[tabindex]`) without
 * one is unreachable to the suite the moment copy or structure changes. Every send-step component is mounted and swept; the
 * two orchestrators (SendWizard, SendView) compose children rather than emitting controls of their
 * own, so they are swept at the template level instead of dragging the whole service graph in.
 */
const INTERACTIVE = 'button, input, select, textarea, [role="tab"], [role="option"], a[href], [tabindex]'

import AmountStep from "./AmountStep.vue"
import ChoiceCards from "./ChoiceCards.vue"
import DirectionSegment from "./DirectionSegment.vue"
import GasBreakdown from "./GasBreakdown.vue"
import MintStrip from "./MintStrip.vue"
import ReviewDetails from "./ReviewDetails.vue"
import ReviewStep from "./ReviewStep.vue"
import StepStrip from "./StepStrip.vue"
import TokenList from "./TokenList.vue"
import TokenMark from "./TokenMark.vue"
import TokenStep from "./TokenStep.vue"
import TokenTile from "./TokenTile.vue"
import WizardShell from "./WizardShell.vue"

const TOKEN: SelectableToken = {
	chainId: 11155111,
	address: "0x70e0ba845a1a0f2da3359c97e0285013525ffc49",
	symbol: "USDC",
	name: "Test USDC",
	decimals: 6,
	source: "manifest",
	logoKey: "11155111:0x70e0ba845a1a0f2da3359c97e0285013525ffc49",
}

const RESOLVED: ResolvedToken = {
	...TOKEN,
	state: { kind: "registered" } as ResolvedToken["state"],
	portal: "0x94752ef7cf8f037f78ee7722a9387ef95c819fc8",
	words: { nameWord: `0x${"1".repeat(64)}`, symbolWord: `0x${"2".repeat(64)}` },
	l2Token: `0x${"c".repeat(64)}`,
}

const GAS: GasLegPlan = {
	fuelAmount: 1_000_000n,
	fuelFj: 20_000_000_000_000_000_000n,
	quote: 20_000_000_000_000_000_000n,
	minFuelOutput: 19_000_000_000_000_000_000n,
	route: { path: [], zeroForOnes: [] } as GasLegPlan["route"],
	capped: null,
}

const PLAN: SendPlan = { direction: "l1-to-l2", intent: "token+gas", token: RESOLVED, amount: 5_000_000n, isPrivate: true, gas: GAS }
const EXIT: ExitPlan = { direction: "l2-to-l1", token: RESOLVED, amount: 5_000_000n, isPrivate: true, recipientL1: TOKEN.address }
const BALANCES = { l1: 9_000_000n, l2Public: 1n, l2Private: 2n }
const LOOKUP: LookupState = {
	status: "found",
	address: "0x779877a7b0d9e8603169ddbd7836e478b4624789",
	logoKey: "11155111:0x779877a7b0d9e8603169ddbd7836e478b4624789",
	identity: { symbol: "LINK", name: "ChainLink Token", decimals: 18 },
}
const TOKEN_STEP = {
	direction: "l1-to-l2",
	tokens: [TOKEN],
	search: "",
	loading: false,
	catalogError: null,
	lookup: null,
	addError: null,
	selected: TOKEN,
	selectionError: null,
}
const REVIEW = {
	plan: PLAN,
	portalVerified: "verified",
	account: `0x${"a".repeat(64)}`,
	signatureValiditySeconds: 600,
	slippageBps: 300,
}

const CASES: Array<[string, Component, Record<string, unknown>]> = [
	[
		"AmountStep",
		AmountStep,
		{
			direction: "l1-to-l2",
			token: RESOLVED,
			balances: BALANCES,
			intent: "token+gas",
			amount: "1",
			isPrivate: true,
			gas: GAS,
			routeKind: "route",
			routeLoading: false,
			txTarget: 3,
			fjPerTx: 100_000_000_000_000_000n,
			gasError: null,
		},
	],
	["ChoiceCards", ChoiceCards, { intent: "token", exitOnly: false, feeAsset: false, gasBlock: null, txTarget: 2 }],
	["DirectionSegment", DirectionSegment, { direction: "l1-to-l2", locked: false }],
	[
		"GasBreakdown",
		GasBreakdown,
		{ token: RESOLVED, amount: 5_000_000n, intent: "token+gas", gas: GAS, txTarget: 3, fjPerTx: 1n, loading: false, error: null },
	],
	[
		"GasBreakdown (gas)",
		GasBreakdown,
		{ token: RESOLVED, amount: 5_000_000n, intent: "gas", gas: GAS, txTarget: 3, fjPerTx: 1n, loading: false, error: null },
	],
	["MintStrip", MintStrip, {}],
	["ReviewDetails", ReviewDetails, REVIEW],
	[
		"ReviewStep",
		ReviewStep,
		{
			...REVIEW,
			estimate: { takes: "3-8 min", networkFee: "≈ 0.1 FJ", networkFeeNote: "taken from the gas that arrives", txCovered: 3 },
			grant: "idle",
			busy: false,
			error: null,
		},
	],
	[
		"ReviewStep (exit)",
		ReviewStep,
		{
			...REVIEW,
			plan: EXIT,
			estimate: {
				takes: "long",
				networkFee: null,
				networkFeeNote: "your Aztec wallet's own fee, then Ethereum gas to finish",
				txCovered: null,
			},
			grant: "declined",
			busy: false,
			error: "nope",
		},
	],
	[
		"StepStrip",
		StepStrip,
		{
			steps: [
				{ key: "token", label: "Token" },
				{ key: "amount", label: "Amount" },
				{ key: "review", label: "Review" },
			],
			active: 0,
			completed: 2,
		},
	],
	["TokenList", TokenList, { tokens: [TOKEN], selected: TOKEN, balances: { [TOKEN.logoKey]: 1n }, loading: false, empty: false }],
	["TokenMark", TokenMark, { token: TOKEN }],
	["TokenStep", TokenStep, TOKEN_STEP],
	["TokenStep (lookup)", TokenStep, { ...TOKEN_STEP, lookup: LOOKUP }],
	["TokenTile", TokenTile, { token: TOKEN, selected: false }],
	["WizardShell", WizardShell, { direction: "l1-to-l2", step: 0, completed: 2, canSwitchDirection: true }],
]

/** Every element the sweep can reach, including whatever a disclosure reveals when opened. */
async function sweep(w: ReturnType<typeof mount>): Promise<{ missing: string[]; seen: number }> {
	const found = () => [...w.element.parentElement!.querySelectorAll(INTERACTIVE)]
	const missing = () =>
		found()
			.filter((el) => !el.getAttribute("data-testid"))
			.map((el) => el.outerHTML.slice(0, 120))
	const first = missing()
	let seen = found().length
	for (const btn of w.findAll("button[data-testid]")) await btn.trigger("click")
	seen += found().length
	return { missing: [...first, ...missing()], seen }
}

describe("send-step testid coverage", () => {
	it.each(CASES)("%s gives every interactive element a data-testid", async (name, component, props) => {
		const { missing, seen } = await sweep(mount(component, { props, attachTo: document.body }))
		expect(missing).toEqual([])
		// A selector that stops matching would otherwise pass silently; only the gas-only card (two
		// read-only lines) and the token mark are inert.
		expect(seen > 0 || name === "GasBreakdown (gas)" || name === "TokenMark").toBe(true)
	})

	it("the phone's gas hint button carries its testid", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} }))
		try {
			const props = { intent: "token+gas" as const, exitOnly: false, feeAsset: false, gasBlock: null, txTarget: 2, breakdownId: "b" }
			const w = mount(ChoiceCards, { props, attachTo: document.body })
			expect(w.find(`[data-testid="${TESTIDS.sendGasDisclosure}"]`).exists()).toBe(true)
			expect((await sweep(w)).missing).toEqual([])
			w.unmount()
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("the orchestrators own no bare controls of their own", () => {
		const here = dirname(fileURLToPath(import.meta.url))
		const sources = [join(here, "SendWizard.vue"), join(here, "..", "..", "views", "SendView.vue")]
		for (const file of sources) {
			const template = readFileSync(file, "utf8").split("<template>")[1] ?? ""
			for (const tag of template.matchAll(/<(button|input|select|textarea|a)\b([^>]*)>/g)) {
				expect(`${file}: ${tag[0]}`).toContain("data-testid")
			}
		}
	})

	it("covers every component in this directory", () => {
		const files = readdirSync(dirname(fileURLToPath(import.meta.url)))
			.filter((f) => f.endsWith(".vue") && f !== "SendWizard.vue")
			.map((f) => f.replace(".vue", ""))
		expect(files.sort()).toEqual([...new Set(CASES.map(([n]) => n.split(" ")[0]))].sort())
	})
})
