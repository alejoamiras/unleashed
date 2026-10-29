/**
 * A token plus the gas to use it: any ERC-20 through the network's hub, part of it swapped into Fee Juice on the way,
 * claimed as public balances. Typechecked with the package, never run.
 */
import { type Capability, type Network, parseNetwork, type Reads, type RunOptions } from "@unleashed/sdk"
import {
	type AztecSigner,
	type BridgeToken,
	capabilitiesFor,
	claimToken,
	depositToken,
	quoteBridge,
	resolveToken,
} from "@unleashed/sdk/bridge"
import { TESTNET_MANIFEST } from "@unleashed/sdk/networks"
import type { Address, WalletClient } from "viem"
import { show } from "./fuel.ts"

/** What the Aztec wallet must grant before the claim: merge it into the capability request the app sends its wallet. */
export function claimGrant(net: Network, token: BridgeToken): Capability[] {
	return capabilitiesFor(net, { fuel: true, tokens: [token] })
}

export async function bridgeWithGas(p: {
	reads: Reads
	l1: WalletClient
	aztec: AztecSigner
	erc20: Address
	amount: bigint
	persist: RunOptions["persist"]
}): Promise<void> {
	const net = await parseNetwork(TESTNET_MANIFEST, p.reads)
	// Listed or not, any ERC-20 resolves; a first-time token's portal is created by the deposit, its L2 token by the claim.
	const token = await resolveToken(net, p.reads, p.erc20)
	const quote = await quoteBridge(net, p.reads, {
		token,
		amount: p.amount,
		recipient: p.aztec.account.toString(),
		privacy: "public",
		gas: { txTarget: 5 },
	})
	const run = { persist: p.persist, onEvent: show }
	const record = await depositToken(net, p.reads, p.l1, quote, run)
	const outcome = await claimToken(net, p.reads, p.aztec, record, run)
	// The tokens landed; the bridged gas did not, and no retry can claim it.
	if (outcome.gasLeft) console.warn(`gas left unclaimed: ${outcome.gasLeft.message}`)
}
