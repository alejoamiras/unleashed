import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { PRIVATE_FPC_SALT } from "@unleashed/bridge-core"

type PrivateFpcInstance = Awaited<ReturnType<typeof getContractInstanceFromInstantiationParams>>

let cached: { instance: PrivateFpcInstance; artifact: ContractArtifact } | null = null

/**
 * The canonical PrivateFPC instance (salt `PRIVATE_FPC_SALT`, deployer ZERO — the derivation
 * `PRIVATE_FPC_ADDRESS` pins) + its loaded artifact. Nothing publishes it on testnet; a wallet holds
 * it only through a local registration.
 *
 * Registered at connect time (`useWalletConnection`). The wallet auto-registers the FPC when a tx
 * actually USES it as the fee payer (`fpc/service.ts`), but the no-fuel claim gate reads the private
 * Fee-Juice balance BEFORE any such tx, so at read time the FPC is not yet registered — and under
 * 5.0.1's `registerContract` conformance change (dev #288) the on-the-fly `Contract.at()` in that read
 * no longer registers the artifact into the reading PXE. Pre-registering it here closes that gap so the
 * balance read succeeds instead of tripping the fail-closed gate.
 */
export async function getPrivateFpc(): Promise<{ instance: PrivateFpcInstance; artifact: ContractArtifact }> {
	if (cached) return cached
	const { PrivateFPCContractArtifact } = await import("@unleashed/bridge-core/private-fpc-artifact")
	const artifact = loadContractArtifact(PrivateFPCContractArtifact as never)
	const instance = await getContractInstanceFromInstantiationParams(artifact, {
		salt: Fr.fromHexString(PRIVATE_FPC_SALT),
		deployer: AztecAddress.ZERO,
	})
	cached = { instance, artifact }
	return cached
}
