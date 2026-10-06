// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { ref, shallowRef } from "vue"
import { type AppSource, readChainOf } from "@/lib/network"
import { PRIVATE_SLICE_SHORT, type ResolvedToken, type SelectableToken } from "@/lib/send-model"
import { BASE_SEPOLIA, DEST_TOKEN, DEST_USDC, OUT, routeDeps, SRC_USDC, USER } from "@/test/crosschain"
import { ROUTE_TTL_MS } from "./useCrossChainRoute"
import { type CrossChainSendDeps, useCrossChainSend } from "./useCrossChainSend"
import type { UseTokenSelectionHandle } from "./useTokenSelection"

vi.mock(import("@/contracts/bridge-generation"), async (actual) => ({
	...(await actual()),
	FUEL: { slippageBps: 300, fjPerTx: "1", fjRegister: "1", minFuelFj: "1", swapTarget: "0x" } as never,
}))
vi.mock("@/contracts/hub-binding", () => ({ readHubBinding: async () => undefined }))

const SOURCE: AppSource = {
	chainId: BASE_SEPOLIA,
	name: "Base Sepolia",
	nativeSymbol: "ETH",
	l1ChainId: 11155111,
	rpcUrls: [],
	rail: "acrossV4",
	tokens: [{ address: SRC_USDC, symbol: "USDC", decimals: 6, destToken: DEST_USDC }],
	chain: readChainOf(BASE_SEPOLIA)?.chain as AppSource["chain"],
}
const ROW: SelectableToken = {
	chainId: BASE_SEPOLIA,
	address: SRC_USDC.toLowerCase() as SelectableToken["address"],
	symbol: "USDC",
	name: "USDC",
	decimals: 6,
	source: "manifest",
	logoKey: `${BASE_SEPOLIA}:${SRC_USDC.toLowerCase()}`,
}

/** The delivered token resolves at once, as a selection over the pinned Ethereum reader would. */
function destSelection(): UseTokenSelectionHandle {
	const selected = shallowRef<ResolvedToken | null>(null)
	return {
		selected,
		balances: ref({}),
		loading: ref(false),
		error: ref(null),
		epoch: () => 0,
		select: vi.fn(async () => {
			selected.value = DEST_TOKEN
		}),
		refreshBalances: async () => {},
		dispose: vi.fn(),
	}
}

function setup(over: Partial<CrossChainSendDeps> = {}) {
	const now = ref(Date.now())
	const quoting = ref(true)
	const ceilings = ref<bigint | null>(null)
	const gasShare = {
		propose: vi.fn(() => ({ fuelAmount: 1_000_000n, fuelFj: 0n, capped: "half" as const })),
		ceilingsFor: vi.fn(() => ceilings.value),
		txTarget: ref(20),
	}
	const h = useCrossChainSend({
		row: () => ROW,
		amount: () => 5_000_000n,
		intent: () => "token+gas",
		isPrivate: () => false,
		user: () => USER,
		recipient: () => `0x${"0a".repeat(32)}`,
		quoting: () => quoting.value,
		gasShare,
		sources: () => [SOURCE],
		routeDeps: (slice) => ({ ...routeDeps(), slice }),
		selection: destSelection,
		now,
		...over,
	})
	return { h, now, quoting, ceilings, gasShare }
}

describe("useCrossChainSend", () => {
	it("quotes the registry's route with the gas share's slice, and quotes again once the answer expires", async () => {
		const { h, now, quoting, gasShare } = setup()
		await vi.waitFor(() => expect(h.route.value).not.toBeNull(), { timeout: 10_000 })
		expect(gasShare.propose).toHaveBeenCalledWith(expect.objectContaining({ amount: OUT, decimals: 6, state: DEST_TOKEN.state }))
		expect(h.gas.value).toMatchObject({ fuelAmount: 1_000_000n, capped: "half" })
		expect(h.figures.value).toMatchObject({ delivered: OUT, relayFee: 5_000_000n - OUT, tokenArrives: OUT - 1_000_000n })
		expect(h.ready.value).toBe(true)
		const first = h.quoted.value
		// The review keeps its answer past the TTL; the amount step quotes a fresh one.
		quoting.value = false
		now.value += ROUTE_TTL_MS + 1
		await Promise.resolve()
		expect(h.quoted.value).toBe(first)
		quoting.value = true
		now.value += 1_000
		await vi.waitFor(() => expect(h.quoted.value).not.toBe(first), { timeout: 10_000 })
		h.dispose()
	}, 30_000)

	it("refuses a private slice whose floor cannot cover the claim's ceilings", async () => {
		const { h, ceilings } = setup({ isPrivate: () => true })
		ceilings.value = 10n ** 30n
		await vi.waitFor(() => expect(h.route.value).not.toBeNull(), { timeout: 10_000 })
		expect(h.gasError.value).toBe(PRIVATE_SLICE_SHORT)
		expect(h.ready.value).toBe(false)
		h.dispose()
	}, 30_000)
})
