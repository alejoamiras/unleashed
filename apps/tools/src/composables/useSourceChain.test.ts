import { flushPromises } from "@vue/test-utils"
import type { Address, Chain, Hex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { type AppSource, NETWORK, readChainOf } from "@/lib/network"
import { BASE_SEPOLIA, DEST_USDC, SRC_USDC, USER } from "@/test/crosschain"

vi.mock("@/lib/network", async (actual) => {
	const real = await actual<typeof import("@/lib/network")>()
	return { ...real, sourcesOf: vi.fn(real.sourcesOf) }
})

import { sourcesOf } from "@/lib/network"
import { __resetSourcesForTests, appSources, nativeKeyOf, type SourceReader, useSourceChain } from "./useSourceChain"

const ARBITRUM = 42161
const ARB_WETH: Address = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
const OTHER: Address = `0x${"7".repeat(40)}`
const DELEGATED: Hex = `0xef0100${"ab".repeat(20)}`

const source = (chainId: number, token: Address, symbol: string): AppSource => ({
	chainId,
	name: symbol,
	nativeSymbol: "ETH",
	l1ChainId: NETWORK.l1ChainId,
	rpcUrls: [],
	rail: "acrossV4",
	tokens: [{ address: token, symbol, decimals: 6, destToken: DEST_USDC }],
	chain: readChainOf(chainId)?.chain as Chain,
})
const SOURCES = [source(BASE_SEPOLIA, SRC_USDC, "USDC"), source(ARBITRUM, ARB_WETH, "WETH")]

interface Stub {
	native: bigint
	token?: bigint
	code?: Hex
	down?: boolean
}

/** One stub reader per chain; counts the code reads so the cache can be seen. */
function readers(chains: Record<number, Stub>) {
	const codeReads: number[] = []
	const reader = (chainId: number): SourceReader | undefined => {
		const stub = chains[chainId]
		if (!stub) return undefined
		const fail = () => Promise.reject(new Error(`chain ${chainId} is down`))
		return {
			nativeBalance: async () => (stub.down ? fail() : stub.native),
			tokenBalance: async () => (stub.down ? fail() : (stub.token ?? 0n)),
			code: async () => {
				codeReads.push(chainId)
				return stub.code
			},
		}
	}
	return { reader, codeReads }
}

function mountWith(chains: Record<number, Stub>, owner = ref<Address | undefined>(USER)) {
	const { reader, codeReads } = readers(chains)
	const handle = useSourceChain({
		owner: () => owner.value,
		walletChainId: () => BASE_SEPOLIA,
		switchChain: async () => true,
		reader,
		sources: () => SOURCES,
	})
	return { handle, codeReads, owner }
}

afterEach(() => {
	vi.restoreAllMocks()
	__resetSourcesForTests()
})

describe("useSourceChain — what the token step offers besides Ethereum", () => {
	it("reads each source chain's token and native balance and Ethereum's native one; a chain that fails reads nothing", async () => {
		const { handle } = mountWith({
			[BASE_SEPOLIA]: { native: 8n, token: 1_240_500_000n },
			[ARBITRUM]: { native: 6n, down: true },
			[NETWORK.l1ChainId]: { native: 40n },
		})
		vi.spyOn(console, "debug").mockImplementation(() => {})
		await flushPromises()
		expect(handle.rows.map((r) => r.logoKey)).toEqual([
			`${BASE_SEPOLIA}:${SRC_USDC.toLowerCase()}`,
			`${ARBITRUM}:${ARB_WETH.toLowerCase()}`,
		])
		expect(handle.balances.value).toEqual({
			[handle.rows[0]?.logoKey ?? ""]: 1_240_500_000n,
			[nativeKeyOf(BASE_SEPOLIA)]: 8n,
			[nativeKeyOf(NETWORK.l1ChainId)]: 40n,
		})
		handle.dispose()
	})

	it("refuses an owner with contract code, never an EOA or an EIP-7702 delegation, and reads code once per chain and owner", async () => {
		const { handle, codeReads, owner } = mountWith({
			[BASE_SEPOLIA]: { native: 0n, code: "0x6080604052" },
			[ARBITRUM]: { native: 0n, code: DELEGATED },
		})
		await flushPromises()
		expect(handle.contractChains.value).toEqual([BASE_SEPOLIA])
		await expect(handle.contractAccount(ARBITRUM)).resolves.toBe(false)
		await handle.refresh()
		expect(codeReads).toEqual([BASE_SEPOLIA, ARBITRUM])

		owner.value = OTHER
		await flushPromises()
		expect(codeReads).toEqual([BASE_SEPOLIA, ARBITRUM, BASE_SEPOLIA, ARBITRUM])
		handle.dispose()
	})

	it("offers no source when the registry cannot be read", async () => {
		vi.mocked(sourcesOf).mockImplementationOnce(() => {
			throw new Error("network.ts: no viem Chain for source chain 1")
		})
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(appSources()).toEqual([])
		expect(logged).toHaveBeenCalledOnce()
		const { reader, codeReads } = readers({ [NETWORK.l1ChainId]: { native: 1n } })
		const handle = useSourceChain({ owner: () => USER, walletChainId: () => null, switchChain: async () => true, reader })
		await flushPromises()
		expect(handle.rows).toEqual([])
		expect(handle.balances.value).toEqual({})
		expect(codeReads).toEqual([])
		handle.dispose()
	})
})
