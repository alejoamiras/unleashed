import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"

type SponsoredFpcInstance = Awaited<ReturnType<typeof getContractInstanceFromInstantiationParams>>

let cached: SponsoredFpcInstance | null = null

/**
 * Computes the deterministic SponsoredFPC contract instance from the
 * protocol-pinned salt. The result is cached per-tab - the salt is constant
 * across all Aztec environments and the computation is hash-only (no I/O),
 * so a single warm-up is sufficient.
 *
 * Used as `feePayer: instance.address` in the tools app's drip exec payload.
 * The Nulo wallet materializes the embedded fee path on its own side;
 * the dApp never needs to `wallet.registerContract(sponsoredFpc, ...)`.
 */
export async function getSponsoredFpcInstance(): Promise<SponsoredFpcInstance> {
	if (cached) return cached
	cached = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
		salt: new Fr(SPONSORED_FPC_SALT),
	})
	return cached
}
