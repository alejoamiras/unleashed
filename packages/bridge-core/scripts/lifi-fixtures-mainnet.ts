/**
 * The mainnet half of `lifi-fixtures.ts`: five li.quest quotes (three same-chain AZTEC buys at the fixture router,
 * two cross-chain contract calls into it) and the three source heads, written to
 * `contracts/bridge/evm/test/fixtures/lifi/mainnet.json` (trimmed, what the forks read) and `mainnet.raw.json`
 * (the responses verbatim, for the decoder tests). Keyless: the public li.quest tier is enough for five calls.
 */

import { type Address, encodeFunctionData, getAddress, type Hex, keccak256, slice, toHex } from "viem"
import { DEPOSIT_ROUTER_ABI } from "../src/deposit-router-abi"
import { LIFI_DENY_EXCHANGES, LIFI_TO_CONTRACT_GAS_LIMIT } from "../src/lifi-gas"
import privateFpcMainnet from "../src/private-fpc-canonical-mainnet.json" with { type: "json" }

const LI_QUEST = "https://li.quest/v1"
const QUOTE_TIMEOUT_MS = 30_000
export const MAINNET_RECORDER = "lifi-fixtures.ts mainnet v1"

/** lifinance/contracts `deployments/{mainnet,base,arbitrum}.json`, Across's and Aztec's docs; code-checked on fork. */
export const MAINNET = {
	ethereum: {
		chainId: 1,
		diamond: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
		executor: "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88",
		receiverAcrossV4: "0x07Cc0a0b41641D349240e1988169Fa11b31FC24E",
		receiverStargateV2: "0xB539B40793171211DCA8834da044fC14bCe64BDC",
		spokePool: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
		registry: "0x35b22e09Ee0390539439E24f06Da43D83f90e298",
		feeJuicePortal: "0xaf73dd51d1eb8a079bb097f39c832cdd00ac691c",
		aztec: "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2",
		usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
		permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	},
	base: {
		chainId: 8453,
		diamond: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
		usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	},
	arbitrum: {
		chainId: 42161,
		diamond: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
		weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
	},
} as const

const EXPIRING_RFQ_EXCHANGES = LIFI_DENY_EXCHANGES
const TO_CONTRACT_GAS_LIMIT = LIFI_TO_CONTRACT_GAS_LIMIT

/** The largest slice the app is expected to swap for gas: the price-impact and warp cases run at it. */
export const SLICE_USDC = 10_000_000n
export const SLICE_WETH = 4_000_000_000_000_000n
/** The cross-chain token amounts the contract-call quotes ask LI.FI to deliver (`toAmount`). */
export const CROSS_USDC = 100_000_000n
export const CROSS_WETH = 50_000_000_000_000_000n
export const SAME_CHAIN_SLIPPAGE = 0.01
/**
 * Stargate delivers more than `toAmount` (LI.FI sent `amountLD` 1.09 % above it for 100 USDC); `maxPull = T + T·s`
 * lets the router take that surplus into the deposit instead of the Executor forwarding it to the user's L1 address.
 */
export const CROSS_CHAIN_SLIPPAGE_BPS = 150n

/** BN254 field elements, as the Inbox requires; distinct so a crossed leg shows in the forks. */
const TOKEN_SECRET_HASH: Hex = "0x000000000000000000000000000000000000000000000000000000000005ec7e"
const FUEL_SECRET_HASH: Hex = "0x00000000000000000000000000000000000000000000000000000000000f5ec7"

export function mainnetLabel(name: string): Address {
	return getAddress(slice(keccak256(toHex(`unleashed:lifi-mainnet:${name}`)), 12))
}

/** The router's address on every mainnet fork: `toAddress` of the same-chain quotes and the contract calls' target. */
export const FIXTURE_ROUTER = mainnetLabel("router")
export const FIXTURE_USER = mainnetLabel("user")

type Json = Record<string, unknown>

async function liQuest(path: string, init?: RequestInit): Promise<Json> {
	const res = await fetch(`${LI_QUEST}${path}`, {
		...init,
		headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
		signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
		redirect: "error",
	})
	const body = (await res.json()) as Json
	if (!res.ok) throw new LiQuestRefusal(path, res.status, body)
	return body
}

class LiQuestRefusal extends Error {
	constructor(
		path: string,
		readonly status: number,
		readonly body: Json,
	) {
		super(`li.quest ${path.split("?")[0]} ${status}: ${String(body.message ?? "")}`)
	}
}

/** LI.FI's per-path reasons for "no available quotes", kept as the fixture's evidence that a route does not exist. */
function refusal(err: unknown): { available: false; message: string; reasons: unknown } {
	if (!(err instanceof LiQuestRefusal) || err.status !== 404) throw err
	const errors = (err.body.errors ?? {}) as { filteredOut?: unknown; failed?: unknown }
	return { available: false, message: String(err.body.message ?? ""), reasons: errors.filteredOut ?? errors.failed ?? [] }
}

interface SameChainRequest {
	fromToken: Address
	fromAmount: bigint
	exchanges: { deny: readonly string[] } | { allow: readonly string[] }
}

/** A same-chain buy of AZTEC paid and received by the fixture router, as `fuel-quote.ts` will request it. */
async function sameChainQuote(r: SameChainRequest): Promise<Json> {
	const q = new URLSearchParams({
		fromChain: "1",
		toChain: "1",
		fromToken: r.fromToken,
		toToken: MAINNET.ethereum.aztec,
		fromAmount: r.fromAmount.toString(),
		fromAddress: FIXTURE_ROUTER,
		toAddress: FIXTURE_ROUTER,
		slippage: String(SAME_CHAIN_SLIPPAGE),
	})
	if ("deny" in r.exchanges) q.set("denyExchanges", r.exchanges.deny.join(","))
	else q.set("allowExchanges", r.exchanges.allow.join(","))
	return liQuest(`/quote?${q}`)
}

/** Worst destination shape: private token leg, fuel to the PrivateFPC (both legs' deposits plus the swap). */
function worstIntent(token: Address, slice: bigint, minFuelOutput: bigint) {
	return {
		token,
		aztecRecipient: `0x${"0".repeat(64)}` as Hex,
		tokenSecretHash: TOKEN_SECRET_HASH,
		isPrivate: true,
		fuelSlice: slice,
		fuelRecipient: privateFpcMainnet.expectedAddress as Hex,
		fuelSecretHash: FUEL_SECRET_HASH,
		minFuelOutput,
	}
}

interface CrossChainRequest {
	fromChain: number
	fromToken: Address
	toToken: Address
	toAmount: bigint
	swap: Json
}

function routerCall(req: CrossChainRequest) {
	const tx = req.swap.transactionRequest as { data: Hex }
	const estimate = req.swap.estimate as { toAmountMin: string }
	const slice = BigInt((req.swap.action as { fromAmount: string }).fromAmount)
	const intent = worstIntent(req.toToken, slice, BigInt(estimate.toAmountMin))
	const minReceived = req.toAmount
	const maxPull = req.toAmount + (req.toAmount * CROSS_CHAIN_SLIPPAGE_BPS) / 10_000n
	const calldata = encodeFunctionData({
		abi: DEPOSIT_ROUTER_ABI,
		functionName: "bridgeFromCaller",
		args: [intent, tx.data, minReceived, maxPull],
	})
	return { intent, minReceived, maxPull, calldata }
}

async function contractCallsQuote(req: CrossChainRequest, call: ReturnType<typeof routerCall>): Promise<Json> {
	return liQuest("/quote/contractCalls", {
		method: "POST",
		body: JSON.stringify({
			fromChain: req.fromChain,
			fromToken: req.fromToken,
			fromAddress: FIXTURE_USER,
			toChain: 1,
			toToken: req.toToken,
			toAmount: req.toAmount.toString(),
			toFallbackAddress: FIXTURE_USER,
			contractCalls: [
				{
					fromAmount: req.toAmount.toString(),
					fromTokenAddress: req.toToken,
					toContractAddress: FIXTURE_ROUTER,
					toContractCallData: call.calldata,
					toContractGasLimit: TO_CONTRACT_GAS_LIMIT.toString(),
				},
			],
		}),
	})
}

/** The fields the forks read; amounts stay decimal strings, which `vm.parseJsonUint` accepts. */
function trimSameChain(name: string, q: Json) {
	const tx = q.transactionRequest as Json
	const est = q.estimate as Json
	const action = q.action as Json
	return {
		name,
		tool: q.tool,
		fromToken: (action.fromToken as Json).address,
		fromAmount: action.fromAmount,
		toAmount: est.toAmount,
		toAmountMin: est.toAmountMin,
		fromAmountUSD: est.fromAmountUSD ?? "",
		toAmountUSD: est.toAmountUSD ?? "",
		approvalAddress: est.approvalAddress,
		to: tx.to,
		data: tx.data,
		value: BigInt(String(tx.value ?? "0")).toString(),
		gasLimit: BigInt(String(tx.gasLimit ?? "0")).toString(),
	}
}

function trimCrossChain(name: string, q: Json, call: ReturnType<typeof routerCall>) {
	const tx = q.transactionRequest as Json
	const est = q.estimate as Json
	return {
		name,
		tool: q.tool,
		executionDuration: est.executionDuration,
		to: tx.to,
		data: tx.data,
		value: BigInt(String(tx.value ?? "0")).toString(),
		gasLimit: BigInt(String(tx.gasLimit ?? "0")).toString(),
		intent: { ...call.intent, fuelSlice: call.intent.fuelSlice.toString(), minFuelOutput: call.intent.minFuelOutput.toString() },
		minReceived: call.minReceived.toString(),
		maxPull: call.maxPull.toString(),
		routerCalldata: call.calldata,
		toContractGasLimit: TO_CONTRACT_GAS_LIMIT.toString(),
	}
}

export interface SourceHeads {
	ethereum: { block: number; timestamp: number }
	base: { block: number; timestamp: number }
	arbitrum: { block: number; timestamp: number }
}

/** Exactly five li.quest calls, sequential so a refusal stops the run before the next is spent. */
export async function recordMainnetQuotes(heads: SourceHeads): Promise<{ fixture: Json; raw: Json }> {
	const { usdc, weth } = MAINNET.ethereum
	const deadlineFree = await sameChainQuote({
		fromToken: usdc,
		fromAmount: SLICE_USDC,
		exchanges: { deny: EXPIRING_RFQ_EXCHANGES },
	})
	const rfq = await sameChainQuote({
		fromToken: usdc,
		fromAmount: SLICE_USDC,
		exchanges: { allow: EXPIRING_RFQ_EXCHANGES },
	})
	const wethSwap = await sameChainQuote({
		fromToken: weth,
		fromAmount: SLICE_WETH,
		exchanges: { deny: EXPIRING_RFQ_EXCHANGES },
	})
	const baseReq = { fromChain: 8453, fromToken: MAINNET.base.usdc, toToken: usdc, toAmount: CROSS_USDC, swap: deadlineFree }
	const baseCall = routerCall(baseReq)
	const baseUsdc = await contractCallsQuote(baseReq, baseCall)
	const arbReq = { fromChain: 42161, fromToken: MAINNET.arbitrum.weth, toToken: weth, toAmount: CROSS_WETH, swap: wethSwap }
	const arbCall = routerCall(arbReq)
	// Stargate delivers ETH natively; LI.FI then needs a destination wrap it will not quote for a contract call.
	const arbitrumWeth = await contractCallsQuote(arbReq, arbCall).catch(refusal)

	const fixture = {
		recorder: MAINNET_RECORDER,
		router: FIXTURE_ROUTER,
		user: FIXTURE_USER,
		ethereum: { ...MAINNET.ethereum, ...heads.ethereum },
		base: { ...MAINNET.base, ...heads.base },
		arbitrum: { ...MAINNET.arbitrum, ...heads.arbitrum },
		expiringRfqExchanges: EXPIRING_RFQ_EXCHANGES,
		sameChain: {
			deadlineFree: trimSameChain("deadlineFree", deadlineFree),
			rfq: trimSameChain("rfq", rfq),
			weth: trimSameChain("weth", wethSwap),
		},
		crossChain: {
			baseUsdc: trimCrossChain("baseUsdc", baseUsdc, baseCall),
			arbitrumWeth: "available" in arbitrumWeth ? arbitrumWeth : trimCrossChain("arbitrumWeth", arbitrumWeth, arbCall),
		},
	}
	return { fixture, raw: { deadlineFree, rfq, weth: wethSwap, baseUsdc, arbitrumWeth } }
}
