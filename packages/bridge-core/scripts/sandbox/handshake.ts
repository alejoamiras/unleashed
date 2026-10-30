import { DomainSeparator } from "@aztec-labs/constants"
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { STANDARD_HANDSHAKE_REGISTRY_ADDRESS } from "@aztec-labs/standard-contracts/handshake-registry/constants"
import { computeLogTag } from "@aztec-labs/stdlib/hash"
import { SiloedTag, Tag } from "@aztec-labs/stdlib/logs"
import type { AztecNode } from "../generation"

/** How many announcements of a non-interactive handshake with `account` the handshake registry
 *  logged in transaction `txHash`. */
export async function handshakeAnnouncementsIn(node: AztecNode, account: AztecAddress, txHash: string): Promise<number> {
	const tag = new Tag(await computeLogTag(account.toField(), DomainSeparator.NON_INTERACTIVE_HANDSHAKE_LOG_TAG))
	const siloed = await SiloedTag.computeFromTagAndApp(tag, STANDARD_HANDSHAKE_REGISTRY_ADDRESS)
	const [logs] = await node.getPrivateLogsByTags({ tags: [siloed], txHash: TxHash.fromString(txHash) })
	return logs?.length ?? 0
}
