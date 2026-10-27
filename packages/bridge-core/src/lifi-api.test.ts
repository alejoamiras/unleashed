import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, decodeAbiParameters, type Hex, slice } from "viem"
import { describe, expect, it, vi } from "vitest"
import { lifiFuelProvider } from "./fuel-quote"
import { LIFI_BRIDGE_DATA_COMPONENTS } from "./lifi-abi"
import { LIFI_INTEGRATOR, lifiContractCallQuote, lifiQuoteSchema, lifiSameChainQuote, lifiStatus } from "./lifi-api"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

/** li.quest's responses verbatim, recorded by `scripts/lifi-fixtures-mainnet.ts`. */
const RAW: Record<"deadlineFree" | "rfq" | "weth" | "baseUsdc" | "arbitrumWeth", Record<string, unknown>> = fixture("mainnet.raw.json")
const MAINNET = fixture("mainnet.json") as {
	router: Address
	user: Address
	ethereum: { diamond: Address; usdc: Address; aztec: Address }
	base: { usdc: Address }
	crossChain: { baseUsdc: { routerCalldata: Hex } }
}

const clone = <T>(v: T): T => structuredClone(v)

function serving(body: unknown, status = 200) {
	return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
}

const sameChainRequest = {
	chainId: 1,
	fromToken: MAINNET.ethereum.usdc,
	toToken: MAINNET.ethereum.aztec,
	fromAmount: 10_000_000n,
	router: MAINNET.router,
	slippageBps: 100,
}

const contractCallRequest = {
	fromChain: 8453,
	fromToken: MAINNET.base.usdc,
	user: MAINNET.user,
	toChain: 1,
	toToken: MAINNET.ethereum.usdc,
	toAmount: 100_000_000n,
	router: MAINNET.router,
	routerCalldata: MAINNET.crossChain.baseUsdc.routerCalldata,
}

/** A live `/v1/status` answer for a Base → chain 4663 Across transfer, trimmed to what this client reads plus extras. */
const STATUS_DONE = {
	transactionId: "0xde5ed983519df73efd2fdb136626d215ea8dc9ea71c8bf5034f7fd482431fbf0",
	sending: {
		txHash: "0xc92721d50a3ee21523a9aac87a571c0f8c973b5911aa89337ef983e099f599de",
		chainId: 8453,
		amount: "99125000",
		token: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chainId: 8453, symbol: "USDC", decimals: 6 },
	},
	receiving: {
		txHash: "0xd6558d403b13ed3e210daa0e27c3e2c88dc7503b9058af5f0a4928b83fca3dcb",
		chainId: 4663,
		amount: "3994621639239879568297",
	},
	lifiExplorerLink: "https://scan.li.fi/tx/0xc92721d50a3ee21523a9aac87a571c0f8c973b5911aa89337ef983e099f599de",
	tool: "across",
	status: "DONE",
	substatus: "COMPLETED",
	substatusMessage: "The transfer is complete.",
	metadata: { integrator: "metamask-bridge" },
}

/**
 * What li.quest answered for `txHash = 0xabab…ab, fromChain = 8453`: someone else's transfer on chain 4663 whose
 * caller-chosen `transactionId` is that word.
 */
const STATUS_FOREIGN = {
	transactionId: `0x${"ab".repeat(32)}`,
	sending: { txHash: "0x836f9e53891089a344f7f9415efe8952ee051ff79b8bbf8fbb40a61f5375e16b", chainId: 4663 },
	receiving: { txHash: "0x836f9e53891089a344f7f9415efe8952ee051ff79b8bbf8fbb40a61f5375e16b", chainId: 4663 },
	tool: "kyberswap",
	status: "DONE",
	substatus: "COMPLETED",
}

describe("li.quest schemas", () => {
	it("parse every recorded quote, same-chain and contract-call, and keep the fields the decoder and UI read", () => {
		for (const raw of Object.values(RAW)) expect(lifiQuoteSchema.safeParse(raw).error).toBeUndefined()

		const q = lifiQuoteSchema.parse(RAW.baseUsdc)
		const raw = RAW.baseUsdc as {
			transactionRequest: { data: Hex; value: string; gasLimit: string }
			includedSteps: { tool: string }[]
			estimate: { executionDuration: number; feeCosts: { name: string; amount: string; included: boolean }[] }
		}
		expect(q.transactionRequest).toEqual({
			to: MAINNET.ethereum.diamond,
			data: raw.transactionRequest.data,
			value: BigInt(raw.transactionRequest.value),
			chainId: 8453,
			gasLimit: BigInt(raw.transactionRequest.gasLimit),
		})
		expect(q.includedSteps.map((s) => s.tool)).toEqual(raw.includedSteps.map((s) => s.tool))
		expect(q.estimate.executionDuration).toBe(raw.estimate.executionDuration)
		expect(q.estimate.feeCosts.map((f) => [f.name, f.amount, f.included])).toEqual(
			raw.estimate.feeCosts.map((f) => [f.name, BigInt(f.amount), f.included]),
		)
	})
})

describe("lifiSameChainQuote / lifiContractCallQuote", () => {
	it("asks for a same-chain quote paid and received by the router, as us, on the proven venues only", async () => {
		const f = serving(RAW.deadlineFree)
		const res = await lifiSameChainQuote({ fetch: f }, sameChainRequest)

		expect(res.ok && res.value.tool).toBe(RAW.deadlineFree.tool)
		const [url, init] = vi.mocked(f).mock.calls[0] as unknown as [string, RequestInit]
		const u = new URL(url)
		expect(`${u.origin}${u.pathname}`).toBe("https://li.quest/v1/quote")
		expect([...u.searchParams]).toEqual([
			["fromChain", "1"],
			["toChain", "1"],
			["fromToken", MAINNET.ethereum.usdc],
			["toToken", MAINNET.ethereum.aztec],
			["fromAmount", "10000000"],
			["fromAddress", MAINNET.router],
			["toAddress", MAINNET.router],
			["slippage", "0.01"],
			["integrator", LIFI_INTEGRATOR],
			["allowExchanges", "nordstern"],
			["allowExchanges", "sushiswap"],
		])
		expect(init.headers).toEqual({ accept: "application/json" })
	})

	it("posts our router call for exactly T, under the measured gas limit, falling back to the user", async () => {
		const f = serving(RAW.baseUsdc)
		const res = await lifiContractCallQuote({ fetch: f }, { ...contractCallRequest, allowBridges: ["stargateV2"] })

		expect(res.ok && res.value.tool).toBe("stargateV2")
		const [url, init] = vi.mocked(f).mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe("https://li.quest/v1/quote/contractCalls")
		expect(init.method).toBe("POST")
		expect(JSON.parse(init.body as string)).toEqual({
			fromChain: 8453,
			fromToken: MAINNET.base.usdc,
			fromAddress: MAINNET.user,
			toChain: 1,
			toToken: MAINNET.ethereum.usdc,
			toAmount: "100000000",
			toFallbackAddress: MAINNET.user,
			integrator: "unleashed",
			allowBridges: ["stargateV2"],
			contractCalls: [
				{
					fromAmount: "100000000",
					fromTokenAddress: MAINNET.ethereum.usdc,
					toContractAddress: MAINNET.router,
					toContractCallData: MAINNET.crossChain.baseUsdc.routerCalldata,
					toContractGasLimit: "1000000",
				},
			],
		})
	})

	const withoutCalldata = () => {
		const raw = clone(RAW.deadlineFree) as { transactionRequest: { data?: string } }
		raw.transactionRequest.data = undefined
		return raw
	}
	const numericAmount = () => {
		const raw = clone(RAW.deadlineFree) as { estimate: { toAmount: unknown } }
		raw.estimate.toAmount = 578.5
		return raw
	}

	it.each([
		["byte cap", serving(RAW.deadlineFree), { byteCap: 4096 }, { reason: "byte-cap" }],
		[
			"redirect",
			vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://evil.invalid/" } })),
			{},
			{ reason: "redirect" },
		],
		["timeout", vi.fn(() => new Promise<Response>(() => {})), { timeoutMs: 20 }, { reason: "timeout" }],
		[
			"schema miss (missing calldata)",
			serving(withoutCalldata()),
			{},
			{ reason: "schema", issues: ["transactionRequest.data: Invalid input: expected string, received undefined"] },
		],
		["schema miss (ill-typed amount)", serving(numericAmount()), {}, { reason: "schema" }],
	])("fails closed on %s", async (_, f, client, refusal) => {
		const res = await lifiSameChainQuote({ fetch: f as unknown as typeof fetch, ...client }, sameChainRequest)
		expect(res).toMatchObject({ ok: false, ...refusal })
	})

	it("refuses a quote that answers another request, naming the first field that differs", async () => {
		const res = await lifiSameChainQuote({ fetch: serving(RAW.deadlineFree) }, { ...sameChainRequest, fromAmount: 5_000_000n })
		expect(res).toEqual({ ok: false, reason: "mismatch", field: "action.fromAmount" })
		const payer = await lifiContractCallQuote({ fetch: serving(RAW.baseUsdc) }, { ...contractCallRequest, user: MAINNET.router })
		expect(payer).toEqual({ ok: false, reason: "mismatch", field: "action.fromAddress" })
	})

	it("keeps LI.FI's per-path reasons when a quote has no route, and any other status as itself", async () => {
		const noRoute = {
			message: "No available quotes for the requested transfer.",
			code: 1002,
			errors: {
				filteredOut: [{ overallPath: "42161:WETH-stargateV2-1:ETH", reason: "Destination call requires a signature" }],
				failed: [
					{
						overallPath: "42161:WETH-across-1:WETH",
						subpaths: {
							"42161:WETH-across-1:WETH": [
								{ errorType: "NO_QUOTE", code: "AMOUNT_TOO_LOW", tool: "across", message: "Too small." },
							],
						},
					},
					{ unexpected: true },
				],
			},
		}
		expect(await lifiContractCallQuote({ fetch: serving(noRoute, 404) }, contractCallRequest)).toEqual({
			ok: false,
			reason: "no-route",
			message: "No available quotes for the requested transfer.",
			code: 1002,
			paths: [
				{ kind: "filteredOut", path: "42161:WETH-stargateV2-1:ETH", message: "Destination call requires a signature" },
				{ kind: "failed", path: "42161:WETH-across-1:WETH", message: "Too small.", tool: "across", code: "AMOUNT_TOO_LOW" },
			],
		})
		const limited = await lifiSameChainQuote({ fetch: serving({ message: "Rate limit exceeded" }, 429) }, sameChainRequest)
		expect(limited).toEqual({ ok: false, reason: "status", status: 429, message: "Rate limit exceeded" })
	})
})

describe("lifiStatus", () => {
	const ours = { txHash: STATUS_DONE.sending.txHash as Hex, fromChain: 8453, toChain: 4663 }

	it("returns an answer bound to the queried source transaction, and NOT_FOUND for LI.FI's 404", async () => {
		const f = serving(STATUS_DONE)
		const res = await lifiStatus({ fetch: f }, ours)
		expect(res).toEqual({
			ok: true,
			value: {
				status: "DONE",
				substatus: "COMPLETED",
				sending: { txHash: ours.txHash, chainId: 8453 },
				receiving: { txHash: STATUS_DONE.receiving.txHash, chainId: 4663 },
			},
		})
		const [url] = vi.mocked(f).mock.calls[0] as unknown as [string]
		expect(url).toBe(`https://li.quest/v1/status?txHash=${ours.txHash}&fromChain=8453&toChain=4663`)

		const missing = { message: `Transaction hash '${ours.txHash}' not found on chain '8453'`, code: 1003 }
		expect(await lifiStatus({ fetch: serving(missing, 404) }, ours)).toEqual({ ok: true, value: { status: "NOT_FOUND" } })
	})

	it("refuses an answer about another transfer, such as one whose chosen transactionId equals our hash", async () => {
		const res = await lifiStatus(
			{ fetch: serving(STATUS_FOREIGN) },
			{ txHash: STATUS_FOREIGN.transactionId as Hex, fromChain: 8453, toChain: 1 },
		)
		expect(res).toEqual({ ok: false, reason: "mismatch", field: "sending.txHash" })
		const elsewhere = await lifiStatus({ fetch: serving(STATUS_DONE) }, { ...ours, toChain: 1 })
		expect(elsewhere).toEqual({ ok: false, reason: "mismatch", field: "receiving.chainId" })
	})
})

/**
 * Real li.quest, opt-in (`LIFI_LIVE=1`), keyless, three calls: a same-chain fuel quote meets every pin
 * `fuel-quote.ts` holds it to, a contract-call quote for the recorded router call parses and carries our integrator in `BridgeData`,
 * and a known transfer's status binds to its source transaction.
 */
describe.skipIf(!process.env.LIFI_LIVE)("li.quest, live", () => {
	const client = { fetch: globalThis.fetch.bind(globalThis), timeoutMs: 30_000 }

	it("quotes fuel at the router that meets every pin", async () => {
		const provider = lifiFuelProvider({
			client,
			chainId: 1,
			diamond: MAINNET.ethereum.diamond,
			router: MAINNET.router,
			feeAsset: MAINNET.ethereum.aztec,
			slippageBps: 100,
			minFuelFj: 1n,
		})
		const res = await provider.quote(MAINNET.ethereum.usdc, 10_000_000n)
		expect(res).toMatchObject({ ok: true, quote: { provider: "lifi", amountIn: 10_000_000n } })
	}, 60_000)

	it("quotes the recorded router call over Stargate with our integrator in BridgeData", async () => {
		const res = await lifiContractCallQuote(client, { ...contractCallRequest, allowBridges: ["stargateV2"] })
		if (!res.ok) throw new Error(`li.quest refused: ${JSON.stringify(res)}`)
		expect(res.value.tool).toBe("stargateV2")
		// Every LI.FI bridge entrypoint takes `BridgeData` first.
		const [bridgeData] = decodeAbiParameters(
			[{ type: "tuple", components: LIFI_BRIDGE_DATA_COMPONENTS }],
			slice(res.value.transactionRequest.data, 4),
		)
		expect(bridgeData.integrator).toBe(LIFI_INTEGRATOR)
	}, 60_000)

	it("binds a known transfer's status to its source transaction", async () => {
		const res = await lifiStatus(client, { txHash: STATUS_DONE.sending.txHash as Hex, fromChain: 8453, toChain: 4663 })
		expect(res).toMatchObject({ ok: true, value: { status: "DONE", receiving: { txHash: STATUS_DONE.receiving.txHash } } })
	}, 60_000)
})
