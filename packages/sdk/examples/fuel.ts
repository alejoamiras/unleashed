/**
 * Gas for an Aztec account: a token swapped into Fee Juice on Ethereum, then claimed as private credit at the network's
 * PrivateFPC. Typechecked with the package, never run.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { type DepositSecrets, parseNetwork, type Reads, type RunOptions, type TransferEvent } from "@unleashed/sdk"
import { type AztecSigner, type ClaimOutcome, claimFuel, depositFuel, quoteFuel } from "@unleashed/sdk/fuel"
import { TESTNET_MANIFEST } from "@unleashed/sdk/networks"
import { type Address, createPublicClient, http, type WalletClient } from "viem"

/** The step-by-step progress a page shows. Events are display only: the run never waits on this. */
export function show(e: TransferEvent): void {
	switch (e.type) {
		case "signature-requested":
		case "registration-requested":
		case "claim-requested":
			console.log("confirm in your wallet")
			return
		case "arrival":
			console.log(`reaching Aztec (${e.stage})${e.stage === "counting" && e.blocksLeft ? `: ${e.blocksLeft} blocks left` : ""}`)
			return
		case "deposit-recovery":
			if (e.stage === "waiting") console.log("waiting for Ethereum to confirm the deposit")
			return
		case "settled":
			console.log(e.via === "claim" ? `claimed in ${e.txHash ?? "an earlier call"}` : "claimed by someone else")
			return
		default:
			console.log(e.type)
	}
}

export async function buyGas(p: {
	l1Rpc: string
	aztecNodeUrl: string
	/** The user's Ethereum wallet, on the network's chain. */
	l1: WalletClient
	/** The user's Aztec wallet and the account that receives the gas. */
	aztec: AztecSigner
	token: Address
	amount: bigint
	/** Stores the record, and the salts sealed apart from it, before the call goes on. */
	persist: RunOptions["persist"]
}): Promise<ClaimOutcome> {
	const reads: Reads = {
		l1: createPublicClient({ transport: http(p.l1Rpc), ccipRead: false }),
		aztecNode: createAztecNodeClient(p.aztecNodeUrl),
	}
	const net = await parseNetwork(TESTNET_MANIFEST, reads)
	const quote = await quoteFuel(net, reads, {
		token: p.token,
		amount: p.amount,
		recipient: p.aztec.account.toString(),
		privacy: "private",
	})
	// `quote.minFj` is the least Fee Juice the deposit bridges (it reverts below it), before the claim's own fee.
	let secrets: DepositSecrets | undefined
	const persist: RunOptions["persist"] = async (record, s) => {
		await p.persist(record, s)
		secrets = s ?? secrets
	}
	const record = await depositFuel(net, reads, p.l1, quote, { persist, onEvent: show })
	return claimFuel(net, reads, p.aztec, record, { persist, onEvent: show, ...(secrets ? { secrets } : {}) })
}
