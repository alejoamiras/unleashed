import { DomainSeparator } from "@aztec-labs/constants"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { STANDARD_HANDSHAKE_REGISTRY_ADDRESS } from "@aztec-labs/standard-contracts/handshake-registry/constants"
import { computeLogTag, computeSiloedPrivateLogFirstField } from "@aztec-labs/stdlib/hash"
import { SiloedTag } from "@aztec-labs/stdlib/logs"
import type { AztecNode } from "../generation"

/** How many handshake-registry logs transaction `txHash` carries under the tag computable from
 *  `account`'s address alone — the registry emits one when a sender opens a non-interactive
 *  handshake with `account`. */
export async function handshakeAnnouncementsIn(node: AztecNode, account: AztecAddress, txHash: string): Promise<number> {
	const tag = await computeLogTag(account.toField(), DomainSeparator.NON_INTERACTIVE_HANDSHAKE_LOG_TAG)
	const siloed = new SiloedTag(await computeSiloedPrivateLogFirstField(STANDARD_HANDSHAKE_REGISTRY_ADDRESS, tag))
	const [logs] = await node.getPrivateLogsByTags({ tags: [siloed], txHash: TxHash.fromString(txHash) })
	return logs?.length ?? 0
}
