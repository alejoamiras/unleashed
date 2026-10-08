import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, createPublicClient, getAddress, type Hex, http, isAddress, keccak256 } from "viem"
import { describe, expect, it } from "vitest"
import { START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR } from "./across-v4"
import { SWAP_TOKENS_MULTIPLE_V3_SELECTOR, SWAP_TOKENS_SINGLE_V3_SELECTOR } from "./lifi-abi"
import {
	LIFI_BOOK,
	type LifiChainBook,
	type LifiCodeHashes,
	lifiBook,
	registerSandboxLifi,
	type StargatePool,
	stargatePoolFor,
} from "./lifi-addresses"
import {
	START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
	STARGATE_POOL_ABI,
	STARGATE_TOKEN_MESSAGING_ABI,
	SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR,
} from "./stargate"

const EVM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm")
const FIXTURES = join(EVM, "test", "fixtures", "lifi")
/** The forge lib CI installs at the pinned commit; a fresh checkout may not have it. */
const LIFI_LIB = join(EVM, "lib", "lifi-contracts")
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"))

const CHAINS = Object.values(LIFI_BOOK)
const LIB_NAMES: Record<number, string> = {
	1: "mainnet",
	8453: "base",
	42161: "arbitrum",
	10: "optimism",
	11155111: "sepolia",
	84532: "basesepolia",
}
const FACET_NAMES: Record<Hex, string> = {
	[START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR]: "AcrossFacetV4",
	[SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR]: "StargateFacetV2",
	[START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR]: "StargateFacetV2",
	[SWAP_TOKENS_SINGLE_V3_SELECTOR]: "GenericSwapFacetV3",
	[SWAP_TOKENS_MULTIPLE_V3_SELECTOR]: "GenericSwapFacetV3",
}

const lower = (a: string | undefined) => a?.toLowerCase()

function addressesOf(b: LifiChainBook): Address[] {
	return [
		b.diamond,
		b.executor,
		b.receiverAcrossV4,
		b.feeForwarder,
		b.acrossSpokePool,
		...(b.receiverStargateV2 ? [b.receiverStargateV2] : []),
		...Object.values(b.facets),
		...(b.stargate ? [b.stargate.tokenMessaging, ...b.stargate.pools.flatMap((p) => [p.pool, p.token])] : []),
		...(b.layerZero ? [b.layerZero.endpointV2] : []),
	]
}

describe("lifi-addresses", () => {
	it("covers exactly the six chains and refuses any other", () => {
		expect(CHAINS.map((b) => b.chainId).sort((a, b) => a - b)).toEqual([1, 10, 8453, 42161, 84532, 11155111])
		for (const b of CHAINS) expect(lifiBook(b.chainId)).toBe(b)
		expect(() => lifiBook(137)).toThrow(/no LI.FI book for chain 137/)
	})

	it("books a sandbox's contracts on its two anvils only, and never shadows a live chain", () => {
		const at = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
		const sandbox = (src: number, eth: number) => ({
			source: { chainId: src, diamond: at(1), spokePool: at(2) },
			ethereum: { chainId: eth, executor: at(3), receiverAcrossV4: at(4), spokePool: at(5) },
		})
		const sepolia = lifiBook(11155111)
		expect(() => registerSandboxLifi(sandbox(31338, 11155111))).toThrow(/chain 11155111 is not a sandbox chain/)
		expect(() => registerSandboxLifi(sandbox(84532, 31337))).toThrow(/chain 84532 is not a sandbox chain/)
		expect(() => lifiBook(31337), "a refused pair books neither chain").toThrow(/no LI.FI book/)
		expect(lifiBook(11155111)).toBe(sepolia)

		registerSandboxLifi(sandbox(31338, 31337))
		expect(lifiBook(31338)).toMatchObject({
			diamond: at(1),
			acrossSpokePool: at(2),
			facets: { [START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR]: at(1) },
		})
		expect(lifiBook(31337)).toMatchObject({ executor: at(3), receiverAcrossV4: at(4), acrossSpokePool: at(5), facets: {} })
		expect(Object.keys(LIFI_BOOK)).toHaveLength(6)
	})

	it("holds only checksummed addresses, 32-byte code hashes, and a code hash for every receiver it lists", () => {
		for (const b of CHAINS) {
			for (const a of addressesOf(b)) expect(isAddress(a, { strict: true }) && getAddress(a) === a, `${b.chainId} ${a}`).toBe(true)
			for (const h of Object.values(b.codeHashes)) expect(h).toMatch(/^0x[0-9a-f]{64}$/)
			expect(b.codeHashes.receiverStargateV2 === undefined).toBe(b.receiverStargateV2 === undefined)
		}
	})

	it("agrees with every address the recorded fixtures were made against", () => {
		const rail = readJson(join(FIXTURES, "testnet-rail.json"))
		const mainnet = readJson(join(FIXTURES, "mainnet.json"))
		const compose = readJson(join(FIXTURES, "mainnet.compose.json"))
		const [baseSepolia, sepolia, ethereum, base] = [84532, 11155111, 1, 8453].map(lifiBook)
		expect([rail.source.diamond, rail.source.spokePool]).toEqual([baseSepolia.diamond, baseSepolia.acrossSpokePool])
		expect([rail.destination.executor, rail.destination.receiverAcrossV4, rail.destination.spokePool]).toEqual([
			sepolia.executor,
			sepolia.receiverAcrossV4,
			sepolia.acrossSpokePool,
		])
		const e = mainnet.ethereum
		expect([e.diamond, e.executor, e.receiverAcrossV4, e.receiverStargateV2, e.spokePool]).toEqual([
			ethereum.diamond,
			ethereum.executor,
			ethereum.receiverAcrossV4,
			ethereum.receiverStargateV2,
			ethereum.acrossSpokePool,
		])
		expect(lower(compose.base.pool)).toBe(lower(stargatePoolFor(base, mainnet.base.usdc)?.pool))
		expect(lower(compose.base.endpoint)).toBe(lower(base.layerZero?.endpointV2))
		expect(compose.srcEid).toBe(base.layerZero?.eid)
		expect(compose.dstEid).toBe(ethereum.layerZero?.eid)
	})

	describe.skipIf(!existsSync(join(LIFI_LIB, "deployments")))("against the pinned lifinance/contracts lib", () => {
		it.each(CHAINS.map((b) => [b.chainId, b] as const))("chain %i matches deployments/ and config/", (_, b) => {
			const name = LIB_NAMES[b.chainId]
			const dep = readJson(join(LIFI_LIB, "deployments", `${name}.json`))
			const facets = readJson(join(LIFI_LIB, "deployments", `${name}.diamond.json`)).LiFiDiamond.Facets as Record<
				string,
				{ Name: string }
			>
			const across = readJson(join(LIFI_LIB, "config", "across.json"))[name]
			const stargate = readJson(join(LIFI_LIB, "config", "stargateV2.json"))
			expect([dep.LiFiDiamond, dep.Executor, dep.ReceiverAcrossV4, dep.FeeForwarder, across.acrossSpokePool]).toEqual([
				b.diamond,
				b.executor,
				b.receiverAcrossV4,
				b.feeForwarder,
				b.acrossSpokePool,
			])
			expect(lower(dep.ReceiverStargateV2 || undefined)).toBe(lower(b.receiverStargateV2))
			expect(lower(stargate.tokenMessaging[name])).toBe(lower(b.stargate?.tokenMessaging))
			expect(lower(stargate.endpointV2[name])).toBe(lower(b.layerZero?.endpointV2))
			const byAddress = new Map(Object.entries(facets).map(([a, f]) => [a.toLowerCase(), f.Name]))
			for (const [selector, facet] of Object.entries(b.facets))
				expect(byAddress.get(facet.toLowerCase())).toBe(FACET_NAMES[selector as Hex])
		})
	})
})

/** Keyless providers: drpc for Ethereum, Base's own endpoint, PublicNode for the rest. */
const LIVE_RPC: Record<number, string> = {
	1: "https://eth.drpc.org",
	8453: "https://mainnet.base.org",
	42161: "https://arbitrum-one-rpc.publicnode.com",
	10: "https://optimism-rpc.publicnode.com",
	11155111: "https://ethereum-sepolia-rpc.publicnode.com",
	84532: "https://base-sepolia-rpc.publicnode.com",
}
const LOUPE_ABI = [
	{
		type: "function",
		name: "facetAddress",
		stateMutability: "view",
		inputs: [{ name: "selector", type: "bytes4" }],
		outputs: [{ name: "", type: "address" }],
	},
] as const
const EID_ABI = [{ type: "function", name: "eid", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint32" }] }] as const

/** One read at a time: the public endpoints rate-limit bursts and some refuse JSON-RPC batches. */
async function liveBook(b: LifiChainBook): Promise<Record<string, unknown>> {
	const client = createPublicClient({ transport: http(LIVE_RPC[b.chainId], { retryCount: 6, retryDelay: 2_000 }) })
	const hashes: Record<string, Hex> = {}
	for (const k of Object.keys(b.codeHashes)) {
		hashes[k] = keccak256((await client.getCode({ address: b[k as keyof LifiCodeHashes] as Address })) ?? "0x")
	}
	const facets: Record<string, Address> = {}
	for (const s of Object.keys(b.facets) as Hex[]) {
		facets[s] = await client.readContract({ address: b.diamond, abi: LOUPE_ABI, functionName: "facetAddress", args: [s] })
	}
	const pools: StargatePool[] = []
	for (const { assetId } of b.stargate?.pools ?? []) {
		const tm = b.stargate?.tokenMessaging as Address
		const pool = await client.readContract({
			address: tm,
			abi: STARGATE_TOKEN_MESSAGING_ABI,
			functionName: "stargateImpls",
			args: [assetId],
		})
		pools.push({ assetId, pool, token: await client.readContract({ address: pool, abi: STARGATE_POOL_ABI, functionName: "token" }) })
	}
	const eid = b.layerZero ? await client.readContract({ address: b.layerZero.endpointV2, abi: EID_ABI, functionName: "eid" }) : undefined
	return { chainId: await client.getChainId(), hashes, facets, pools, eid }
}

describe.skipIf(!process.env.LIFI_LIVE)("lifi-addresses, live", () => {
	it.each(CHAINS.map((b) => [b.chainId, b] as const))(
		"chain %i: code hashes, the facet behind each selector, Stargate pools and the endpoint id match the chain",
		async (_, b) => {
			expect(await liveBook(b)).toEqual({
				chainId: b.chainId,
				hashes: b.codeHashes,
				facets: b.facets,
				pools: b.stargate?.pools ?? [],
				eid: b.layerZero?.eid,
			})
		},
		60_000,
	)

	it("li.quest's /v1/chains names the same Diamond on every chain", async () => {
		const res = await fetch("https://li.quest/v1/chains", { redirect: "error", signal: AbortSignal.timeout(30_000) })
		const { chains } = (await res.json()) as { chains: { id: number; diamondAddress: string }[] }
		const diamonds = Object.fromEntries(chains.filter((c) => c.id in LIFI_BOOK).map((c) => [c.id, getAddress(c.diamondAddress)]))
		expect(diamonds).toEqual(Object.fromEntries(CHAINS.map((b) => [b.chainId, b.diamond])))
	}, 30_000)
})
