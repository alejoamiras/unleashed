/**
 * Bridge status polling → the loading bar. L1→L2 deposits have no clean block
 * count (time-based estimate); L2→L1 withdraws poll the node's proven block for
 * a genuine "N blocks remaining" bar (the reference bridge's weak point we set
 * out to fix). Both feed the shared `computeProgress` model.
 */
import { type BridgeProgress, computeProgress } from "./progress"

/** Minimal node surface withdraw-status polling needs (mockable in tests). */
export interface ProvenBlockSource {
	getProvenBlockNumber(): Promise<bigint | number>
}

/** Deposit (L1→L2) progress — time-based (default ~4 min inclusion estimate). */
export function depositStatus(createdAtMs: number, maxWaitMs = 240_000, nowMs: number = Date.now()): BridgeProgress {
	return computeProgress({ elapsedMs: Math.max(0, nowMs - createdAtMs), maxWaitMs })
}

/**
 * Withdraw (L2→L1) progress — block-based. Consumable on L1 once the node's
 * proven block reaches the L2 block the burn landed in (`neededBlock`).
 */
export async function withdrawStatus(
	node: ProvenBlockSource,
	neededBlock: number,
	startBlock: number,
	secondsPerBlock = 36,
): Promise<BridgeProgress> {
	const provenBlock = Number(await node.getProvenBlockNumber())
	return computeProgress({ provenBlock, neededBlock, startBlock, elapsedMs: 0, maxWaitMs: 0, secondsPerBlock })
}
