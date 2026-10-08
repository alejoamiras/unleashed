/**
 * The slice of a `token+gas` deposit that goes to Fee Juice, and the output floor that slice is
 * signed against. Pure integer math over the generation's fuel budgets — no chain reads, so a
 * slider can call it on every frame. The one exception is a PRIVATE send: its claim is paid
 * through the PrivateFPC, which keeps each transaction's committed fee ceiling rather than its
 * charge, so the slice is sized from the network's predicted fees, priced once and refreshed in
 * the background.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import {
	type GasShareResult,
	type HubGas,
	PRIVATE_FUEL_CLAIM_GAS,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	ownGasTxs,
	predictedWorstMinFees,
	privateFpcFeeLimit,
	proposeGasShare,
	signedMinFuelOutput,
	type TokenState,
} from "@unleashed/bridge-core"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { ref, type Ref } from "vue"
import { FUEL } from "@/contracts/bridge-generation"
import { NETWORK } from "@/lib/network"
import { NO_GAS_ROUTE } from "@/lib/send-model"
import { clampGas, walletMaxFees } from "@/lib/wallet-fee-budget"

/** Enough for a first session on L2 without over-diverting the deposit. */
const DEFAULT_TX_TARGET = 20

/** Fees move every block: a price older than this is refreshed behind the next proposal, and one
 *  older than the stale bound is not used at all — the slice reads "pricing" until fresh fees land. */
const FEES_FRESH_MS = 60_000
const FEES_STALE_MS = 5 * 60_000

export interface GasShareProposal {
	/** The user's total, in the token's base units. */
	amount: bigint
	decimals: number
	state: TokenState
	/** A dust probe: `probeOut` Fee Juice came out for `probeIn` token in. */
	rate: { probeIn: bigint; probeOut: bigint }
	/** A private send's claim forfeits fee ceilings, sized from live fees instead of the calibration. */
	isPrivate?: boolean
}

/** `null` = this network has no fuel venue; "pricing" = a private slice awaits the network's fees. */
export type GasShareOutcome = GasShareResult | null | "pricing"

export interface UseGasShareHandle {
	readonly txTarget: Ref<number>
	propose: (input: GasShareProposal) => GasShareOutcome
	floorFor: (quote: bigint) => bigint
	/** The Fee Juice a private claim commits to fee ceilings — the claim's, plus a registration's for
	 *  a token the hub does not know yet — at the last priced fees; null until priced or once stale. */
	ceilingsFor: (state: TokenState) => bigint | null
	/** The Fee Juice a gas-only send's standalone private fuel claim commits to its fee ceiling, at
	 *  the last priced fees; null until priced or once stale. */
	fuelClaimCeiling: () => bigint | null
	/** What a claim paid from the gas the account already holds sets aside for this token — the fee
	 *  contract's ceiling of every transaction it makes — at the last priced fees; null until priced
	 *  or once stale. Asks for a fresh price behind a stale one. */
	ownGasCeilingFor: (state: TokenState, isPrivate: boolean) => bigint | null
	/** Price the ceilings from the network's predicted fees; true when a fresh price landed from THIS
	 *  call. Concurrent calls share one read. */
	prime: () => Promise<boolean>
	/** Drop the price and ask again — the wallet or account behind it changed. */
	invalidate: () => void
	/** Why the last pricing failed, while no usable price exists; null once one lands. */
	readonly pricingError: Ref<string | null>
	/** Back to the default target: a new send is sized from it, never from the last one's. */
	reset: () => void
	dispose: () => void
}

type MaxFees = { feePerDaGas: bigint; feePerL2Gas: bigint }

export interface GasShareDeps {
	/** The connected wallet and account: the ceilings are priced the way THAT wallet will submit
	 *  them, not from the network's prediction, which no stock wallet honors verbatim. */
	aztec?: () => unknown
	account?: () => string | undefined
}

/** `null` from `propose` (and a throw from `floorFor`) means this network has no fuel venue. */
export function useGasShare(deps: GasShareDeps = {}): UseGasShareHandle {
	const txTarget = ref(DEFAULT_TX_TARGET)
	const fees = ref<{ maxFees: MaxFees; at: number } | null>(null)
	const pricingError = ref<string | null>(null)
	let pricing: Promise<boolean> | null = null
	let generation = 0

	/** The wallet's figure when an account is connected, the node's prediction before that. */
	function readMaxFees(): Promise<MaxFees> {
		const aztec = deps.aztec?.()
		const account = deps.account?.()
		if (aztec && account) return walletMaxFees(aztec, AztecAddress.fromStringUnsafe(account), PRIVATE_HUB_CLAIM_GAS)
		return predictedWorstMinFees(createAztecNodeClient(NETWORK.nodeUrl))
	}

	function prime(): Promise<boolean> {
		if (pricing) return pricing
		const mine = generation
		pricing = readMaxFees()
			.then((predicted) => {
				// A read the wallet or account outran is nobody's price now.
				if (mine !== generation) return false
				const maxFees = { feePerDaGas: predicted.feePerDaGas, feePerL2Gas: predicted.feePerL2Gas }
				const same =
					fees.value?.maxFees.feePerDaGas === maxFees.feePerDaGas && fees.value?.maxFees.feePerL2Gas === maxFees.feePerL2Gas
				// An unchanged price only renews its age: everything sized from it stays as it is, and
				// nothing watching the slice sees a change that never happened.
				if (same && fees.value) fees.value.at = Date.now()
				else fees.value = { maxFees, at: Date.now() }
				pricingError.value = null
				return true
			})
			.catch((e: unknown) => {
				// Unpriced is a visible state (the slice reads "pricing", the error names why), never a
				// silently wrong slice; a still-fresh price keeps serving while a background refresh
				// failed — a caller that needs the price to be fresh NOW reads the false instead.
				if (mine === generation && priced() === null)
					pricingError.value = `Couldn't read Aztec's network fees to size the gas slice — ${e instanceof Error ? e.message : String(e)}`
				return false
			})
			.finally(() => {
				if (mine === generation) pricing = null
			})
		return pricing
	}

	/** The last price, unless it is too old to size anything with. */
	function priced(): MaxFees | null {
		const snap = fees.value
		return snap && Date.now() - snap.at <= FEES_STALE_MS ? snap.maxFees : null
	}

	// Every ceiling is priced from the CLAMPED limits the transactions are submitted under — what the
	// FPC actually keeps — never from the declared constants a smaller network cuts down.
	function feeLimitOf(txs: readonly HubGas[]): bigint | null {
		const maxFees = priced()
		if (!maxFees) return null
		return txs.reduce((sum, gas) => sum + privateFpcFeeLimit(clampGas(gas), maxFees), 0n)
	}

	function ceilingsFor(state: TokenState): bigint | null {
		return feeLimitOf(state.kind === "registered" ? [PRIVATE_HUB_CLAIM_GAS] : [PRIVATE_HUB_CLAIM_GAS, PRIVATE_HUB_REGISTER_GAS])
	}

	const fuelClaimCeiling = (): bigint | null => feeLimitOf([PRIVATE_FUEL_CLAIM_GAS])

	function ownGasCeilingFor(state: TokenState, isPrivate: boolean): bigint | null {
		if (!fees.value || Date.now() - fees.value.at > FEES_FRESH_MS) void prime()
		const txs = ownGasTxs({ isPrivate, registers: state.kind !== "registered" })
		return feeLimitOf(txs.register ? [txs.claim, txs.register] : [txs.claim])
	}

	/** A private slice's ceilings, or "pricing" while the fees are still on their way. */
	function privateCeilings(state: TokenState): bigint | "pricing" {
		if (!fees.value || Date.now() - fees.value.at > FEES_FRESH_MS) void prime()
		return ceilingsFor(state) ?? "pricing"
	}

	function propose(input: GasShareProposal): GasShareOutcome {
		const fuel = FUEL
		if (!fuel) return null
		const ceilings = input.isPrivate ? privateCeilings(input.state) : undefined
		if (ceilings === "pricing") return "pricing"
		return proposeGasShare({
			amount: input.amount,
			decimals: input.decimals,
			txTarget: txTarget.value,
			fjPerTx: BigInt(fuel.fjPerTx),
			// The first claim of an unregistered token also registers it, and that costs more than a transfer.
			fjRegister: input.state.kind === "registered" ? undefined : BigInt(fuel.fjRegister),
			fjCeilings: ceilings,
			minFuelFj: BigInt(fuel.minFuelFj),
			rate: input.rate,
			slippageBps: fuel.slippageBps,
		})
	}

	function floorFor(quote: bigint): bigint {
		const fuel = FUEL
		// Refusing beats returning a zero floor: a floor of zero lets the swap land Fee Juice too
		// small to claim, stranding it on L1.
		if (!fuel) throw new Error(NO_GAS_ROUTE)
		return signedMinFuelOutput(quote, fuel.slippageBps, BigInt(fuel.minFuelFj))
	}

	function reset(): void {
		txTarget.value = DEFAULT_TX_TARGET
	}

	/** Another wallet or account prices from scratch: its policy is not the last one's, and a read
	 *  still running for the last one is dropped rather than adopted. */
	function invalidate(): void {
		generation++
		pricing = null
		fees.value = null
		void prime()
	}

	// A re-entered wizard proposes from the default, never from the last session's target.
	const dispose = reset

	return { txTarget, propose, floorFor, ceilingsFor, fuelClaimCeiling, ownGasCeilingFor, prime, invalidate, pricingError, reset, dispose }
}
