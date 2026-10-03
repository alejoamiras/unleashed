import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { FeeJuiceContract } from "@aztec-labs/aztec.js/protocol"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"

/**
 * The canonical Fee Juice contract through `wallet`. When `node` is given, the address the wrapper
 * binds must equal the one the node reports: a mismatch means a wrong endpoint or a second Aztec
 * line in the process, and every balance or claim read through it would be against the wrong contract.
 */
export async function feeJuiceFor(wallet: Wallet, node?: Pick<AztecNode, "getNodeInfo">): Promise<FeeJuiceContract> {
	const fj = FeeJuiceContract.withWallet(wallet)
	if (node) {
		const reported = (await node.getNodeInfo()).protocolContractAddresses.feeJuice
		if (!reported.equals(fj.address)) throw new Error(`node reports FeeJuice at ${reported}, the wrapper binds ${fj.address}; STOP`)
	}
	return fj
}
