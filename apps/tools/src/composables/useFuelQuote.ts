/**
 * Whether a deposit of one token can buy Fee Juice on the way in, and through which venue: a probe of the
 * manifest's fuel provider at one whole unit, which the gas share scales to the slice. The slice itself is quoted
 * again right before the signature (`sliceSwapData`), and the floor the user reviewed is the one signed.
 */
import { type FuelProvider, type FuelQuoteReads, manifestFuelProvider, withFuelFloor } from "@unleashed/bridge-core"
import { type Address, BaseError, ContractFunctionRevertedError, type Hex, type PublicClient } from "viem"
import { type ComputedRef, computed, type Ref } from "vue"
import { FUEL_ASSET, MANIFEST, SEND_GENERATION } from "@/contracts/bridge-generation"
import { type GasLegPlan, NO_GAS_ROUTE } from "@/lib/send-model"
import { latestQuote } from "./latest-quote"

const DEBOUNCE_MS = 400

export type FuelOutcome =
	/** The fee asset itself: bridged one for one, no swap. */
	| { kind: "identity" }
	| { kind: "route"; probeOut: bigint; venue: FuelProvider }
	| { kind: "no-route" }
	| { kind: "unavailable"; reason: "config" | "rpc" }

/** An outcome carries the question it answers: a token switch inside the debounce must never leave the previous
 *  token's rate readable. */
export interface QuotedFuel {
	readonly token: Address
	readonly probeAmount: bigint
	readonly outcome: FuelOutcome
}

export interface UseFuelQuoteHandle {
	readonly quoted: ComputedRef<QuotedFuel | null>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	quote: (token: Address, probeAmount: bigint) => Promise<void>
	dispose: () => void
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const isRevert = (e: unknown): boolean => e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null

/** The provider reads through `pub`, remembering whether the last failure was the contract refusing (a token
 *  without a rate) rather than the transport failing: the first is an answer, the second is not. A cross-chain
 *  route passes its `lifiTxId`, which the swap's event carries. */
export function fuelProviderOn(pub: Pick<PublicClient, "readContract">, transactionId?: Hex) {
	let reverted = false
	const reads: FuelQuoteReads = {
		readContract: (args) =>
			pub.readContract(args).catch((e: unknown) => {
				reverted = isRevert(e)
				throw e
			}),
	}
	const provider = SEND_GENERATION ? manifestFuelProvider(MANIFEST, reads, transactionId ? { transactionId } : {}) : undefined
	return { provider, reverted: () => reverted }
}

async function probeFuel(pub: PublicClient | undefined, token: Address, probeAmount: bigint) {
	if (sameAddress(token, FUEL_ASSET)) return { answer: { kind: "identity" } as FuelOutcome, error: null }
	if (!pub) {
		const answer: FuelOutcome = { kind: "unavailable", reason: "rpc" }
		return { answer, error: "Connect your Ethereum wallet to price the gas route." }
	}
	const { provider, reverted } = fuelProviderOn(pub)
	if (!provider) return { answer: { kind: "unavailable", reason: "config" } as FuelOutcome, error: NO_GAS_ROUTE }
	const res = await provider.probe(token, probeAmount)
	if (res.ok && res.probe.probeOut > 0n) {
		const venue: FuelProvider = res.probe.tool ? { provider: "lifi", tool: res.probe.tool } : { provider: "testnetSwapper" }
		return { answer: { kind: "route", probeOut: res.probe.probeOut, venue } as FuelOutcome, error: null }
	}
	const transport = !res.ok && res.reason === "provider" && !reverted()
	return { answer: (transport ? { kind: "unavailable", reason: "rpc" } : { kind: "no-route" }) as FuelOutcome, error: null }
}

export function useFuelQuote(deps: { pub: () => PublicClient | undefined }): UseFuelQuoteHandle {
	const core = latestQuote((q: { token: Address; probeAmount: bigint }) => probeFuel(deps.pub(), q.token, q.probeAmount), {
		debounceMs: DEBOUNCE_MS,
	})
	const quoted = computed<QuotedFuel | null>(() => {
		const a = core.answered.value
		return a ? { ...a.question, outcome: a.answer } : null
	})
	return {
		quoted,
		loading: core.loading,
		error: core.error,
		quote: (token, probeAmount) => core.ask({ token, probeAmount }),
		dispose: core.dispose,
	}
}

/** The swap bytes for the reviewed slice: a fresh quote at exactly `gas.fuelAmount`, carrying the floor the user
 *  reviewed. Refuses when the venue now quotes under that floor, so the signature never binds a swap that would
 *  revert or a floor the user did not see. The fee asset needs no swap. */
export async function sliceSwapData(
	pub: PublicClient,
	token: Address,
	gas: Pick<GasLegPlan, "fuelAmount" | "minFuelOutput">,
): Promise<Hex> {
	if (sameAddress(token, FUEL_ASSET)) return "0x"
	const { provider } = fuelProviderOn(pub)
	if (!provider) throw new Error(NO_GAS_ROUTE)
	const res = await provider.quote(token, gas.fuelAmount)
	if (!res.ok || res.quote.expectedOut < gas.minFuelOutput) throw new Error(GAS_QUOTE_MOVED)
	return withFuelFloor(res.quote.swapData, gas.minFuelOutput)
}

export const GAS_QUOTE_MOVED = "The gas price moved since you reviewed this send — go back and review it again. Nothing was sent."
