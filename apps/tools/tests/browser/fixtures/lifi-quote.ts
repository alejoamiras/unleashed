/**
 * li.quest's same-chain quote, answered on the sandbox from the recorded mainnet one (`deadlineFree`, a sushiswap
 * route). The sandbox's LI.FI Diamond is `TestnetFuelSwapper`, which speaks LI.FI's single-swap call alone, so the
 * recorded swap leg is re-encoded as that call: the request's chain, tokens, amount and router, and the swapper's own
 * `quote()` as the estimate it then pays out. Nothing the SDK checks is relaxed; `hostile` points the call at a
 * contract that is not the Diamond, and must be refused before any prompt.
 */
import { readFileSync } from "node:fs"
import { SWAP_TOKENS_MULTIPLE_V3_ABI, SWAP_TOKENS_SINGLE_V3_ABI } from "@unleashed/sdk/protocol"
import { type Address, decodeFunctionData, encodeFunctionData, erc20Abi, type Hex, parseAbi, type PublicClient } from "viem"

/** `recorded`: the route as LI.FI answered it. `hostile`: the same route, its call aimed elsewhere. */
export type LifiQuoteFixture = "recorded" | "hostile"

const RECORDED = new URL("../../../../../contracts/bridge/evm/test/fixtures/lifi/mainnet.raw.json", import.meta.url)
/** Not the Diamond: any other `to` is a quote that would spend the router's approval on someone else's call. */
const HOSTILE_TO: Address = "0x000000000000000000000000000000000000dEaD"
const QUOTE_ABI = parseAbi(["function quote(address token, uint256 amountIn) view returns (uint256)"])

interface Recorded {
	tool: string
	transactionRequest: { data: Hex; gasLimit: string }
}

const recorded = (JSON.parse(readFileSync(RECORDED, "utf8")) as { deadlineFree: Recorded }).deadlineFree

/** The recorded call's identity and its swap leg; the fee-collection leg before it has no stand-in on the sandbox. */
function recordedSwap() {
	const { args } = decodeFunctionData({ abi: SWAP_TOKENS_MULTIPLE_V3_ABI, data: recorded.transactionRequest.data })
	const [transactionId, integrator, referrer, , , legs] = args
	const swap = legs.at(-1)
	if (!swap) throw new Error("lifi-quote: the recorded quote has no swap leg")
	return { transactionId, integrator, referrer, swap }
}

/** The bytes32 the recorded call carries; the swapper's `Swapped` event echoes it, proving the quote reached the chain. */
export const RECORDED_TRANSACTION_ID: Hex = recordedSwap().transactionId

export interface LifiQuoteDeps {
	pub: Pick<PublicClient, "readContract">
	/** The router's swap target, standing in for LI.FI's Diamond. */
	swapper: Address
}

async function tokenOf(pub: LifiQuoteDeps["pub"], address: Address, chainId: number) {
	const [symbol, decimals] = await Promise.all([
		pub.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
		pub.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
	])
	return { address, chainId, symbol, decimals }
}

/** `GET /v1/quote` as li.quest answers it, for the request the SDK sent; LI.FI's 404 when the recorded venue is not
 *  one the request allows. */
export async function answerLifiQuote(
	url: URL,
	deps: LifiQuoteDeps,
	fixture: LifiQuoteFixture,
): Promise<{ status: number; body: unknown }> {
	const q = url.searchParams
	if (!q.getAll("allowExchanges").includes(recorded.tool)) {
		return { status: 404, body: { message: "No available quotes for the requested transfer", code: 1002 } }
	}
	const chainId = Number(q.get("fromChain"))
	const fromToken = q.get("fromToken") as Address
	const toToken = q.get("toToken") as Address
	const fromAmount = BigInt(q.get("fromAmount") ?? "0")
	const router = q.get("fromAddress") as Address
	const slippage = Number(q.get("slippage"))
	const toAmount = await deps.pub.readContract({
		address: deps.swapper,
		abi: QUOTE_ABI,
		functionName: "quote",
		args: [fromToken, fromAmount],
	})
	const toAmountMin = (toAmount * BigInt(Math.round((1 - slippage) * 10_000))) / 10_000n
	const r = recordedSwap()
	const data = encodeFunctionData({
		abi: SWAP_TOKENS_SINGLE_V3_ABI,
		functionName: "swapTokensSingleV3ERC20ToERC20",
		args: [
			r.transactionId,
			r.integrator,
			r.referrer,
			router,
			toAmountMin,
			{ ...r.swap, sendingAssetId: fromToken, receivingAssetId: toToken, fromAmount, requiresDeposit: true },
		],
	})
	const [from, to] = await Promise.all([tokenOf(deps.pub, fromToken, chainId), tokenOf(deps.pub, toToken, chainId)])
	const action = {
		fromChainId: chainId,
		toChainId: chainId,
		fromToken: from,
		toToken: to,
		fromAmount: `${fromAmount}`,
		fromAddress: router,
		toAddress: router,
	}
	const estimate = { fromAmount: `${fromAmount}`, toAmount: `${toAmount}`, toAmountMin: `${toAmountMin}`, executionDuration: 0 }
	return {
		status: 200,
		body: {
			tool: recorded.tool,
			action: { ...action, slippage },
			estimate: { ...estimate, approvalAddress: deps.swapper, feeCosts: [], gasCosts: [] },
			includedSteps: [{ type: "swap", tool: recorded.tool, action, estimate }],
			transactionRequest: {
				to: fixture === "hostile" ? HOSTILE_TO : deps.swapper,
				data,
				value: "0x0",
				chainId,
				gasLimit: recorded.transactionRequest.gasLimit,
			},
		},
	}
}
