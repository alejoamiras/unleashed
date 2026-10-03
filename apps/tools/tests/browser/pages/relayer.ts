/** Another submitter consuming a PUBLIC deposit the page journaled: the sandbox relayer, from the
 *  record's unsealed claim material (a private record seals its secret, so it cannot be relayed). */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { SendResult } from "@unleashed/bridge-core"
import { claim } from "@unleashed/bridge-core/sandbox"
import type { ActorHandle } from "../fixtures/test"
import type { JournalDeposit } from "./journal"

export async function claimAsRelayer(actor: ActorHandle, rec: JournalDeposit): Promise<string> {
	if (!rec.token || !rec.recipient || !rec.amount || !rec.secret || !rec.leafIndex || !rec.messageHash)
		throw new Error(`the record ${rec.id} lacks what a relayed public claim needs`)
	if (rec.isPrivate) throw new Error("a relayed claim needs the public secret; this record is private")
	const res = {
		token: rec.token,
		tokenClaimValueHex: rec.secret,
		tokenLeafIndex: BigInt(rec.leafIndex),
		tokenMessageHashHex: rec.messageHash,
	} as unknown as SendResult
	const outcome = await claim(actor.s, res, {
		amount: BigInt(rec.amount),
		isPrivate: false,
		recipient: AztecAddress.fromStringUnsafe(rec.recipient),
		submitter: "relayer",
	})
	return outcome.claimTxHash
}
