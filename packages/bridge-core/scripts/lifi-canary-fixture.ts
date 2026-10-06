/**
 * The canary tests' doubles, network-free: the testnet manifest as it stood before the router-only promotion, with a
 * router, a swapper and an Across route added; chains that answer only the read surface and log every member touched; and an Across that
 * prices the request it receives.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Abi, Address } from "viem"
import { depositWitness, hashDepositWitness } from "../src/l1"
import { lifiBook } from "../src/lifi-addresses"
import type { RouterIntent } from "../src/lifi-decode"
import { type ManifestToken, type ManifestV2, parseManifestV2 } from "../src/manifest-v2"
import type { AcrossClient } from "./lifi-canary-across"
import type { ChainReads } from "./lifi-canary-run"

export const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
export const SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238"
export const ROUTER = `0x${"d1".repeat(20)}` as Address
export const SWAPPER = `0x${"f5".repeat(20)}` as Address
export const NOW_S = 1_900_000_000
/** The swapper's fixed rate: one 6-decimal unit buys 1e14 FJ. */
export const FJ_PER_UNIT = 10n ** 14n

/** The testnet manifest before the router-only promotion: the base every router-only transform starts from. */
export function preLifiTestnetManifest(): ManifestV2 {
	return parseManifestV2(JSON.parse(readFileSync(join(import.meta.dirname, "../test/fixtures/testnet-bridge.pre-lifi.json"), "utf8")))
}

export function routedManifest(): ManifestV2 {
	const live = preLifiTestnetManifest()
	const bridge = live.bridge!
	const usdc: ManifestToken = { ...(bridge.tokens[0] as ManifestToken), erc20: SEPOLIA_USDC }
	const fuel = {
		slippageBps: 100,
		crossChainSlippageBps: 300,
		minFuelFj: "10000000000000000000",
		fjPerTx: "2000000000000000000",
		fjRegister: "4000000000000000000",
	}
	return {
		...live,
		bridge: {
			...bridge,
			l1: { ...bridge.l1, depositRouter: ROUTER, fuelSwapper: SWAPPER, fuel },
			tokens: [...bridge.tokens, usdc],
			routing: {
				provider: "lifi",
				sources: [
					{
						chainId: 84532,
						rail: "acrossV4",
						tokens: [{ address: BASE_SEPOLIA_USDC, symbol: "USDC", decimals: 6, destToken: SEPOLIA_USDC }],
					},
				],
			},
		},
	}
}

export interface FakeChain extends ChainReads {
	/** Every member the run read off this chain, in order. */
	touched: string[]
}

const READ_SURFACE = new Set(["getChainId", "getBlock", "getBalance", "readContract"])

/**
 * A chain that serves the read surface from `contract` and throws on any other member, so a run that reached
 * for a write would fail here even through an untyped path.
 */
export function fakeChain(chainId: number, contract: (functionName: string, args: readonly unknown[]) => unknown): FakeChain {
	const touched: string[] = []
	const reads: ChainReads = {
		getChainId: async () => chainId,
		getBlock: async () => ({ number: 1_000n, timestamp: BigInt(NOW_S) }),
		getBalance: async () => 10n ** 18n,
		readContract: async (a: { abi: Abi; functionName: string; args?: readonly unknown[] }) => contract(a.functionName, a.args ?? []),
	}
	return new Proxy(reads as FakeChain, {
		get(target, member) {
			if (member === "touched") return touched
			if (typeof member === "string" && member !== "then") {
				touched.push(member)
				if (!READ_SURFACE.has(member)) throw new Error(`the run reached for ${member}`)
			}
			return Reflect.get(target, member)
		},
	})
}

/** Sepolia: the router's swap target and witness hash, the swapper's rate, and ample balances. */
export const ethereumChain = (swapTarget: Address = SWAPPER, chainId = 11_155_111) =>
	fakeChain(chainId, (fn, args) => {
		if (fn === "SWAP_TARGET") return swapTarget
		if (fn === "quote") return (args[1] as bigint) * FJ_PER_UNIT
		if (fn === "hashWitness") return hashDepositWitness(depositWitness(args[0] as RouterIntent, args[1] as `0x${string}`))
		if (fn === "balanceOf") return 10n ** 12n
		throw new Error(`no fake for ${fn}`)
	})

export const sourceChain = (chainId = 84_532) =>
	fakeChain(chainId, (fn) => {
		if (fn === "balanceOf") return 10n ** 12n
		throw new Error(`no fake for ${fn}`)
	})

export interface FakeAcross extends AcrossClient {
	requests: { url: URL; method: string }[]
}

/** Across pricing a 24% relay fee within `limits`; `refuse` answers every request with that error code instead. */
export function fakeAcross(o: { limits?: [bigint, bigint]; refuse?: string } = {}): FakeAcross {
	const [min, max] = o.limits ?? [4_890_000n, 5_000_000n]
	const requests: FakeAcross["requests"] = []
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input))
		requests.push({ url, method: init?.method ?? "GET" })
		if (o.refuse) return new Response(JSON.stringify({ type: "AcrossApiError", code: o.refuse }), { status: 400 })
		const q = url.searchParams
		const body = {
			outputAmount: ((BigInt(q.get("amount") ?? "0") * 76n) / 100n).toString(),
			timestamp: String(NOW_S),
			fillDeadline: String(NOW_S + 7_200),
			isAmountTooLow: false,
			estimatedFillTimeSec: 12,
			spokePoolAddress: lifiBook(84_532).acrossSpokePool,
			destinationSpokePoolAddress: lifiBook(11_155_111).acrossSpokePool,
			inputToken: { address: q.get("inputToken"), chainId: Number(q.get("originChainId")) },
			outputToken: { address: q.get("outputToken"), chainId: Number(q.get("destinationChainId")) },
			limits: { minDeposit: min.toString(), maxDeposit: max.toString() },
		}
		return new Response(JSON.stringify(body), { status: 200 })
	}
	return { fetch: fetch as typeof globalThis.fetch, base: "https://across.test/api", requests }
}
