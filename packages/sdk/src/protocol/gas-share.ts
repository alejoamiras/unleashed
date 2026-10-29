/**
 * Gas-share math: how much of a deposit to divert into Fee Juice so the recipient can actually
 * transact on L2, and the output floor that diversion is signed against. Integer arithmetic
 * throughout — these are base units, and a float round-trip silently mis-sizes a real swap.
 */

const BPS = 10_000n

/** Enough headroom for a first session (claim, register, a handful of transfers) without over-diverting. */
const DEFAULT_TX_TARGET = 20

export interface GasShareInput {
	/** The user's total, in token base units. */
	amount: bigint
	/** Display only — the ratio below is decimals-free because probeIn and probeOut are both base units. */
	decimals: number
	txTarget?: number
	fjPerTx: bigint
	/** Added when the token has no L2 registration yet: that first tx costs more than a transfer. */
	fjRegister?: bigint
	/** Fee Juice the claim path forfeits to committed fee ceilings before any per-transaction gas: a
	 *  claim paid through the PrivateFPC keeps the LIMIT of every transaction it pays, not the charge.
	 *  Replaces `fjRegister`, which prices a registration at its charge. */
	fjCeilings?: bigint
	minFuelFj: bigint
	/** A dust quote: `probeOut` FeeJuice came out for `probeIn` token in. */
	rate: { probeIn: bigint; probeOut: bigint }
	slippageBps: number
	/** The most of `amount` the slice may take. Half of it when omitted, so a swap never diverts most
	 *  of a deposit. */
	maxFuelAmount?: bigint
}

export interface GasShareResult {
	/** Token base units to route through the fuel swap. */
	fuelAmount: bigint
	/** The FeeJuice target that amount is sized to buy. */
	fuelFj: bigint
	/** `half` and `max`: the slice was clamped to its cap and buys less than `fuelFj`. */
	capped: "min" | "half" | "max" | null
}

function assertSlippage(bps: number): void {
	if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new Error("gas-share: slippageBps must be an integer in [0, 10000)")
}

export function proposeGasShare(i: GasShareInput): GasShareResult {
	const txTarget = i.txTarget ?? DEFAULT_TX_TARGET
	assertSlippage(i.slippageBps)
	if (i.amount <= 0n) throw new Error("gas-share: amount must be positive")
	if (i.rate.probeOut <= 0n) throw new Error("gas-share: probeOut must be positive")
	if (i.rate.probeIn <= 0n) throw new Error("gas-share: probeIn must be positive")
	if (!Number.isInteger(txTarget) || txTarget < 1) throw new Error("gas-share: txTarget must be an integer >= 1")

	const target = BigInt(txTarget) * i.fjPerTx + (i.fjCeilings ?? i.fjRegister ?? 0n)
	const minBinding = i.minFuelFj > target
	const fuelFj = minBinding ? i.minFuelFj : target

	// The floor the swap is signed against is quote × (1 − s), so the quote must reach target ÷ (1 − s)
	// (sizing by × (1 + s) leaves the floor at target × (1 − s²), below the target) — and the input
	// must reach THAT quote. Two ceilings, not one: folded into a single division, the quote's own
	// floor can land one unit under the floor's.
	const keep = BPS - BigInt(i.slippageBps)
	const quoteNeeded = (fuelFj * BPS + keep - 1n) / keep
	const needed = (quoteNeeded * i.rate.probeIn + i.rate.probeOut - 1n) / i.rate.probeOut

	// The cap outranks the min floor: whichever term sized it, the clamp is what shipped.
	const cap = i.maxFuelAmount ?? i.amount / 2n
	if (needed > cap) return { fuelAmount: cap, fuelFj, capped: i.maxFuelAmount === undefined ? "half" : "max" }
	return { fuelAmount: needed, fuelFj, capped: minBinding ? "min" : null }
}

/**
 * The largest transaction target in [1, limit] whose slice its cap leaves whole, or 0 when even one
 * transaction's is clamped. The slice never shrinks as the target grows, so the edge is found by
 * bisection.
 */
export function maxUncappedTxTarget(i: Omit<GasShareInput, "txTarget">, limit: number): number {
	const fits = (txTarget: number): boolean => {
		const { capped } = proposeGasShare({ ...i, txTarget })
		return capped !== "half" && capped !== "max"
	}
	let lo = 0
	let hi = limit
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (fits(mid)) lo = mid
		else hi = mid - 1
	}
	return lo
}

/**
 * The floor the user signs for the fuel leg. Never below the claim minimum: a lower floor lets the
 * swap succeed with Fee Juice too small to claim on L2, stranding it — better the L1 swap reverts.
 */
export function signedMinFuelOutput(quote: bigint, slippageBps: number, minFuelFj: bigint): bigint {
	assertSlippage(slippageBps)
	if (quote <= 0n) throw new Error("gas-share: cannot derive a floor from an empty quote")
	const floor = (quote * (BPS - BigInt(slippageBps))) / BPS
	return floor > minFuelFj ? floor : minFuelFj
}
