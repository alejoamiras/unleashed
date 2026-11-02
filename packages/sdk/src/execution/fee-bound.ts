/**
 * The highest max fee per gas a private-fee transaction may commit, read from the rollup on Ethereum rather than from
 * an Aztec node or the wallet that quotes the fee. The PrivateFPC keeps a transaction's whole `gasLimits · maxFees`,
 * so this is the most any one transaction can set aside.
 */
import { RegistryAbi, RollupAbi } from "@aztec-foundation/l1-artifacts"
import type { Address } from "viem"
import type { Network, Reads } from "../network.ts"
import type { MaxFees } from "./wallet-fee-budget.ts"

/** Headroom over the rollup's own minimum: measured wallet quotes sit at 1.135× (a wallet that commits the proposed
 *  cap) and 1.70× (a stock wallet's 1.5 padding over a congestion-grown prediction). */
export const FEE_BOUND_MULTIPLE = 3n

/**
 * DA 0 and L2 `FEE_BOUND_MULTIPLE ×` the highest of the canonical rollup's `getManaMinFeeAt` two slots before, at and
 * two slots after the latest Ethereum block, every read pinned to that block. The rollup accepts no block whose DA
 * fee is not 0. Its L1-fee oracle queues each sample two slots ahead and keeps the previous value until then, so the
 * earlier sample covers a node still pricing before a fall and the later one a queued rise.
 * Throws when `r.l1` is not on `net`'s chain or any read fails.
 */
export async function feeBoundOf(net: Network, r: Pick<Reads, "l1">): Promise<MaxFees> {
	const chainId = await r.l1.getChainId()
	if (chainId !== net.l1ChainId) throw new Error(`the fee bound's Ethereum reads are on chain ${chainId}, not ${net.l1ChainId}`)
	const block = await r.l1.getBlock({ blockTag: "latest" })
	const at = { blockNumber: block.number }
	const rollup = (await r.l1.readContract({
		address: net.fuel.registry,
		abi: RegistryAbi,
		functionName: "getCanonicalRollup",
		...at,
	})) as Address
	const slot = (await r.l1.readContract({ address: rollup, abi: RollupAbi, functionName: "getSlotDuration", ...at })) as bigint
	const w = 2n * slot
	const samples = (await Promise.all(
		[block.timestamp - w, block.timestamp, block.timestamp + w].map((t) =>
			r.l1.readContract({ address: rollup, abi: RollupAbi, functionName: "getManaMinFeeAt", args: [t, true], ...at }),
		),
	)) as bigint[]
	const m = samples.reduce((a, b) => (b > a ? b : a))
	return { feePerDaGas: 0n, feePerL2Gas: FEE_BOUND_MULTIPLE * m }
}
