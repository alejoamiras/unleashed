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
}

export interface GasShareResult {
	/** Token base units to route through the fuel swap. */
	fuelAmount: bigint
	/** The FeeJuice target that amount is sized to buy. */
	fuelFj: bigint
	capped: "min" | "half" | null
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

	// The half cap outranks the min floor: whichever term sized it, the clamp is what shipped.
	const half = i.amount / 2n
	if (needed > half) return { fuelAmount: half, fuelFj, capped: "half" }
	return { fuelAmount: needed, fuelFj, capped: minBinding ? "min" : null }
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
