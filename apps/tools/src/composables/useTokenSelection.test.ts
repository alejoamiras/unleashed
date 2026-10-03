// @vitest-environment node
/**
 * Node environment: the preview derivations run bb.js's sync poseidon, which throws std::bad_cast
 * under jsdom, and half of what this suite proves is that the previewed L2 address IS the address
 * the hub derives.
 *
 * The live `public/testnet-bridge.json` is still the previous schema, so the generation reader is
 * mocked from the sandbox fixture — a real v2 manifest whose USDC/USDT are registered and whose
 * PXO is portal-only.
 */
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { ERC20_ABI, type Registration } from "@unleashed/bridge-core"
import { type Address, encodeFunctionData, type Hex, numberToHex, pad, type PublicClient, stringToHex } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import rawManifest from "../../../../packages/bridge-core/fixtures/sandbox-manifest.json"
import type { SelectableToken } from "@/lib/send-model"
import { useTokenSelection } from "./useTokenSelection"

vi.mock("@/contracts/bridge-generation", async () => {
	const bc = await import("@unleashed/bridge-core")
	const { AztecAddress } = await import("@aztec-labs/aztec.js/addresses")
	const m = bc.parseManifestV2((await import("../../../../packages/bridge-core/fixtures/sandbox-manifest.json")).default)
	const bridge = m.bridge
	if (!bridge) throw new Error("the sandbox fixture must carry a bridge")
	const hub = AztecAddress.fromStringUnsafe(bridge.l2.hub.address)
	return {
		SEND_GENERATION: bc.sendGenerationOf(m, bridge),
		rebuildHubTokenInstance: (erc20: string, words: { nameWord: string; symbolWord: string; decimals: number }) =>
			bc.deriveHubTokenInstance(hub, erc20, words, bridge.l2.tokenClassId),
	}
})

// The chain guard is the send composable's; here it is the one knob `makePub` answers.
vi.mock("@/composables/useSend", () => ({
	assertL1Chain: async (l1: { publicClient: { getChainId: () => Promise<number> } }) => {
		const live = await l1.publicClient.getChainId()
		if (live !== 31337) throw new Error(`Your Ethereum wallet is on chain ${live}, but this bridge lives on chain 31337.`)
	},
}))

const FIXTURE = rawManifest.bridge.tokens
const USDC = FIXTURE[0]
const USDT = FIXTURE[1]
const PXO = FIXTURE[2]

const ZERO_WORD = `0x${"0".repeat(64)}` as Hex
const ZERO_ADDRESS = `0x${"0".repeat(40)}`
const L1_ACCOUNT = `0x${"1".repeat(40)}` as Address
const L2_ACCOUNT = `0x${"2".repeat(64)}`

const NAME_DATA = encodeFunctionData({ abi: ERC20_ABI, functionName: "name" })
const SYMBOL_DATA = encodeFunctionData({ abi: ERC20_ABI, functionName: "symbol" })
const DECIMALS_DATA = encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals" })

type FixtureToken = (typeof FIXTURE)[number]

const selectable = (t: FixtureToken): SelectableToken => ({
	chainId: 31337,
	address: t.erc20.toLowerCase() as Address,
	symbol: t.displaySymbol,
	name: t.displayName,
	decimals: t.decimals,
	source: "manifest",
	logoKey: `31337:${t.erc20.toLowerCase()}`,
})

/** A row from the remote token list: its symbol, name and decimals are a claim, not a fact. */
const listed = (t: FixtureToken, over: Partial<SelectableToken> = {}): SelectableToken => ({ ...selectable(t), source: "list", ...over })

const pastedToken = (address: string): SelectableToken => ({
	chainId: 31337,
	address: address.toLowerCase() as Address,
	symbol: "",
	name: "",
	decimals: -1,
	source: "pasted",
	logoKey: `31337:${address.toLowerCase()}`,
})

const registrationOf = (t: FixtureToken): Registration => ({
	portal: t.portal as Address,
	decimals: t.decimals,
	registerIndex: 3n,
	nameWord: t.nameWord as Hex,
	symbolWord: t.symbolWord as Hex,
	registerKey: ZERO_WORD,
})

const ZERO_REGISTRATION: Registration = {
	portal: ZERO_ADDRESS as Address,
	decimals: 0,
	registerIndex: 0n,
	nameWord: ZERO_WORD,
	symbolWord: ZERO_WORD,
	registerKey: ZERO_WORD,
}

interface Metadata {
	name: string
	symbol: string
	decimals: number
}

interface PubBehaviour {
	chainId?: number
	registrations?: Map<string, Registration>
	metadata?: Metadata
	l1Balance?: bigint
	throws?: boolean
	gates?: Map<string, Promise<void>>
}

/** `name()`/`symbol()` answered in the bytes32 style the metadata reader accepts, `decimals()` as one word. */
function metadataReturn(meta: Metadata | undefined, data: Hex): Hex | undefined {
	if (!meta) return undefined
	if (data === NAME_DATA) return stringToHex(meta.name, { size: 32 })
	if (data === SYMBOL_DATA) return stringToHex(meta.symbol, { size: 32 })
	if (data === DECIMALS_DATA) return pad(numberToHex(meta.decimals), { size: 32 })
	return undefined
}

function makePub(b: PubBehaviour) {
	const readContract = vi.fn(async (args: { args: readonly [Address] }) => {
		const erc20 = String(args.args[0]).toLowerCase()
		const gate = b.gates?.get(erc20)
		if (gate) await gate
		if (b.throws) throw new Error("registry unreachable")
		return b.registrations?.get(erc20) ?? ZERO_REGISTRATION
	})
	const call = vi.fn(async (args: { data: Hex }) => ({ data: metadataReturn(b.metadata, args.data) }))
	const multicall = vi.fn(async () => [{ status: "success", result: b.l1Balance ?? 0n }])
	const getChainId = vi.fn(async () => b.chainId ?? 31337)
	return { readContract, call, multicall, getChainId } as unknown as PublicClient
}

function makeBindingReader(bindings: Map<string, string>) {
	const readBinding = vi.fn(async (erc20: string) => bindings.get(erc20.toLowerCase()))
	return { readBinding }
}

function makeTokenContract(pub: bigint | Error, priv: bigint | Error) {
	const method = (v: bigint | Error) => () => ({
		simulate: async () => {
			if (v instanceof Error) throw v
			return { result: v }
		},
	})
	return { methods: { balance_of_public: method(pub), balance_of_private: method(priv) } } as unknown as ContractBase
}

interface Deferred {
	promise: Promise<void>
	release: () => void
}
function deferred(): Deferred {
	let release: () => void = () => undefined
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe("useTokenSelection", () => {
	let registrations: Map<string, Registration>
	let bindings: Map<string, string>

	beforeEach(() => {
		registrations = new Map([
			[USDC.erc20.toLowerCase(), registrationOf(USDC)],
			[USDT.erc20.toLowerCase(), registrationOf(USDT)],
			[PXO.erc20.toLowerCase(), registrationOf(PXO)],
		])
		bindings = new Map([
			[USDC.erc20.toLowerCase(), USDC.l2Token],
			[USDT.erc20.toLowerCase(), USDT.l2Token],
		])
	})

	function harness(pub: PublicClient, over: Partial<Parameters<typeof useTokenSelection>[0]> = {}) {
		const { readBinding } = makeBindingReader(bindings)
		const selection = useTokenSelection({
			pub: () => pub,
			l1Account: () => L1_ACCOUNT,
			readBinding,
			l2Account: () => L2_ACCOUNT,
			tokenContract: () => makeTokenContract(11n, 22n),
			...over,
		})
		return { selection, readBinding }
	}

	it("a viem-wrapped transport error surfaces as its plain sentence, not the wrapper", async () => {
		const pub = makePub({ registrations })
		const wrapped = Object.assign(
			new Error("An unknown RPC error occurred. Details: Connect your Ethereum wallet first. Version: viem@2.55.17"),
			{
				details: "Connect your Ethereum wallet first.",
				shortMessage: "An unknown RPC error occurred.",
			},
		)
		;(pub as unknown as { getChainId: () => Promise<number> }).getChainId = async () => {
			throw wrapped
		}
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.selected.value).toBeNull()
		expect(selection.error.value).toBe("Connect your Ethereum wallet first.")
	})

	it("a wallet on another chain resolves nothing - no registration read, no metadata, an error", async () => {
		const pub = makePub({ registrations, chainId: 1 })
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.selected.value).toBeNull()
		expect(selection.error.value).toMatch(/on chain 1/)
		expect((pub as unknown as { readContract: { mock: { calls: unknown[] } } }).readContract.mock.calls).toHaveLength(0)
	})

	it("resolves a registered token to the hub's own binding", async () => {
		const pub = makePub({ registrations, l1Balance: 500n })
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.error.value).toBeNull()
		expect(selection.selected.value).toMatchObject({
			state: { kind: "registered" },
			portal: USDC.portal,
			l2Token: USDC.l2Token,
			decimals: USDC.decimals,
			words: { nameWord: USDC.nameWord, symbolWord: USDC.symbolWord },
		})
		expect(selection.balances.value.l1).toBe(500n)
		expect(selection.loading.value).toBe(false)
	})

	it("fills a pasted token's symbol, name and decimals from the chain", async () => {
		const address = "0x00000000000000000000000000000000000000ab"
		const pub = makePub({ metadata: { name: "Pasted Token", symbol: "PST", decimals: 8 } })
		const { selection } = harness(pub)
		await selection.select(pastedToken(address), "l1-to-l2")
		expect(selection.selected.value).toMatchObject({ symbol: "PST", name: "Pasted Token", decimals: 8, source: "pasted" })
	})

	it("keeps the LIVE identity when a list entry claims a symbol the contract does not answer to", async () => {
		const pub = makePub({ registrations, metadata: { name: "Pastel", symbol: "PSTL", decimals: 18 } })
		const { selection } = harness(pub)
		await selection.select(listed(USDC), "l1-to-l2")
		expect(selection.selected.value).toMatchObject({ symbol: "PSTL", name: "Pastel" })
		expect(selection.selected.value?.metadataConflict).toEqual({
			listed: { symbol: USDC.displaySymbol, name: USDC.displayName, decimals: USDC.decimals },
			live: { symbol: "PSTL", name: "Pastel", decimals: 18 },
		})
		// The bridge still spends the decimals the factory froze; the conflict is what the review says.
		expect(selection.selected.value?.decimals).toBe(USDC.decimals)
	})

	it("reports no conflict when the list and the contract agree", async () => {
		const pub = makePub({ registrations, metadata: { name: USDC.displayName, symbol: USDC.displaySymbol, decimals: USDC.decimals } })
		const { selection } = harness(pub)
		await selection.select(listed(USDC), "l1-to-l2")
		expect(selection.selected.value?.metadataConflict).toBeUndefined()
	})

	it("a list entry whose metadata cannot be read is still selectable under its listed strings", async () => {
		const pub = makePub({ registrations })
		const { selection } = harness(pub)
		await selection.select(listed(USDC), "l1-to-l2")
		expect(selection.error.value).toBeNull()
		expect(selection.selected.value).toMatchObject({ symbol: USDC.displaySymbol })
		expect(selection.selected.value?.metadataConflict).toBeUndefined()
	})

	it("the manifest's own tokens are never re-read or contradicted", async () => {
		const pub = makePub({ registrations, metadata: { name: "Pastel", symbol: "PSTL", decimals: 18 } })
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.selected.value).toMatchObject({ symbol: USDC.displaySymbol, name: USDC.displayName })
		expect(selection.selected.value?.metadataConflict).toBeUndefined()
	})

	it("previews a first-time token at the address the hub will derive", async () => {
		const pub = makePub({ metadata: { name: PXO.displayName, symbol: PXO.displaySymbol, decimals: PXO.decimals } })
		const { selection } = harness(pub)
		await selection.select(selectable(PXO), "l1-to-l2")
		expect(selection.selected.value).toMatchObject({
			state: { kind: "first-time" },
			// The factory has no record yet, so the portal is its CREATE2 prediction.
			portal: PXO.portal,
			words: { nameWord: PXO.nameWord, symbolWord: PXO.symbolWord },
			l2Token: PXO.l2Token,
		})
	})

	it("treats a portal without a hub binding as portal-only and still derives its L2 token", async () => {
		const pub = makePub({ registrations })
		const { selection } = harness(pub)
		await selection.select(selectable(PXO), "l1-to-l2")
		expect(selection.selected.value?.state.kind).toBe("portal-only")
		expect(selection.selected.value?.l2Token).toBe(PXO.l2Token)
	})

	it("reads the hub's binding without an Aztec account — a registered token is never a first send on a plain wallet", async () => {
		const pub = makePub({ registrations })
		const { selection, readBinding } = harness(pub, { l2Account: () => undefined })
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(readBinding).toHaveBeenCalledWith(USDC.erc20.toLowerCase())
		expect(selection.selected.value?.state.kind).toBe("registered")
		expect(selection.selected.value?.l2Token).toBe(USDC.l2Token)
	})

	it("asks for no binding on a token the factory has not registered", async () => {
		const pub = makePub({ registrations: new Map(), metadata: { name: "Fresh", symbol: "FRS", decimals: 18 } })
		const { selection, readBinding } = harness(pub)
		await selection.select(selectable(PXO), "l1-to-l2")
		expect(readBinding).not.toHaveBeenCalled()
		expect(selection.selected.value?.state.kind).toBe("first-time")
	})

	it("drops a superseded selection however late it lands", async () => {
		const slow = deferred()
		const pub = makePub({ registrations, gates: new Map([[USDC.erc20.toLowerCase(), slow.promise]]) })
		const { selection } = harness(pub)
		expect(selection.epoch()).toBe(0)
		const first = selection.select(selectable(USDC), "l1-to-l2")
		const second = selection.select(selectable(USDT), "l1-to-l2")
		await second
		expect(selection.epoch()).toBe(2)
		expect(selection.selected.value?.address).toBe(USDT.erc20.toLowerCase())
		slow.release()
		await first
		expect(selection.selected.value?.address).toBe(USDT.erc20.toLowerCase())
	})

	it("clears the selection when the registry cannot be read", async () => {
		const pub = makePub({ throws: true })
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.selected.value).toBeNull()
		expect(selection.error.value).toMatch(/registry unreachable/)
		expect(selection.loading.value).toBe(false)
	})

	it("reads L2 balances only for a registered token, and only for an exit", async () => {
		const pub = makePub({ registrations })
		const { selection } = harness(pub)
		await selection.select(selectable(USDC), "l2-to-l1")
		expect(selection.balances.value).toMatchObject({ l2Public: 11n, l2Private: 22n })
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.balances.value.l2Public).toBeUndefined()
		await selection.select(selectable(PXO), "l2-to-l1")
		expect(selection.balances.value.l2Public).toBeUndefined()
	})

	it("keeps one side of the L2 balance when the other is unreadable", async () => {
		const pub = makePub({ registrations })
		const { selection } = harness(pub, { tokenContract: () => makeTokenContract(11n, new Error("no private state")) })
		await selection.select(selectable(USDC), "l2-to-l1")
		expect(selection.balances.value).toMatchObject({ l2Public: 11n })
		expect(selection.balances.value.l2Private).toBeUndefined()
		expect(selection.error.value).toBeNull()
	})

	it("skips the L1 balance when no Ethereum account is connected", async () => {
		const pub = makePub({ registrations, l1Balance: 7n })
		const { selection } = harness(pub, { l1Account: () => undefined })
		await selection.select(selectable(USDC), "l1-to-l2")
		expect(selection.balances.value.l1).toBeUndefined()
	})

	it("refreshBalances re-reads under the direction the selection was made with", async () => {
		const pub = makePub({ registrations, l1Balance: 1n })
		let publicBalance = 11n
		const { selection } = harness(pub, { tokenContract: () => makeTokenContract(publicBalance, 22n) })
		await selection.select(selectable(USDC), "l2-to-l1")
		expect(selection.balances.value.l2Public).toBe(11n)
		publicBalance = 99n
		await selection.refreshBalances()
		expect(selection.balances.value.l2Public).toBe(99n)
	})

	it("dispose drops an in-flight selection and stops refreshing", async () => {
		const slow = deferred()
		const pub = makePub({ registrations, gates: new Map([[USDC.erc20.toLowerCase(), slow.promise]]) })
		const { selection } = harness(pub)
		const pending = selection.select(selectable(USDC), "l1-to-l2")
		selection.dispose()
		slow.release()
		await pending
		expect(selection.selected.value).toBeNull()
		expect(selection.loading.value).toBe(false)
		await selection.refreshBalances()
		expect(selection.balances.value).toEqual({})
	})
})
