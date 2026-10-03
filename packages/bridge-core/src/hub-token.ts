/**
 * The L2 Token instance a `TokenBridgeHub` derives for an ERC-20: the aztec-standards `Token`
 * class, `deployer = hub`, `salt = erc20`, initialized by `constructor_with_minter(name, symbol,
 * decimals, hub, ZERO)` where name/symbol are the factory-attested words. Pinned against the hub's
 * in-circuit `derive_token` by a fixed vector; the class id is pinned separately
 * (`noir-artifact-classids.test.ts`).
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type ContractInstanceWithAddress, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { wordToNoirString } from "./register-hash"

export interface HubTokenWords {
	nameWord: string
	symbolWord: string
	decimals: number
}

export function hubTokenSalt(erc20: string): Fr {
	if (!/^0x[0-9a-fA-F]{40}$/.test(erc20)) throw new Error("erc20 must be a 20-byte hex address")
	return new Fr(BigInt(erc20))
}

/** The constructor args exactly as the hub enqueues them (the words as 31-char strings). */
export function hubTokenConstructorArgs(hub: AztecAddress, words: HubTokenWords): unknown[] {
	return [wordToNoirString(words.nameWord), wordToNoirString(words.symbolWord), words.decimals, hub, AztecAddress.ZERO]
}

/**
 * The derivation binds the INSTALLED aztec-standards Token class; `tokenClassId` is the class the
 * hub was constructed with (the manifest's). A mismatch derives addresses the hub will never mint
 * to, so it is refused rather than returned.
 */
export async function deriveHubTokenInstance(
	hub: AztecAddress,
	erc20: string,
	words: HubTokenWords,
	tokenClassId: string,
): Promise<ContractInstanceWithAddress> {
	const inst = await getContractInstanceFromInstantiationParams(TokenContractArtifact, {
		constructorArgs: hubTokenConstructorArgs(hub, words),
		constructorArtifact: "constructor_with_minter",
		salt: hubTokenSalt(erc20),
		deployer: hub,
		publicKeys: PublicKeys.default(),
	})
	if (inst.currentContractClassId.toString() !== tokenClassId) {
		throw new Error(
			`hub Token class mismatch: manifest says ${tokenClassId}, installed aztec-standards derives ${inst.currentContractClassId.toString()}`,
		)
	}
	return inst
}
