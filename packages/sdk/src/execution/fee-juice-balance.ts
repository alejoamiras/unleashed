/**
 * The account's Fee Juice as the claim fee ladder reads it: public at the Fee Juice contract, private as credit at the
 * PrivateFPC. A value of a shape this module does not know throws, which the ladder reads as unread, never as zero.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"

function asBigInt(v: unknown, read: string): bigint {
	if (typeof v === "bigint") return v
	const o = v as { toBigInt?: () => bigint } | null | undefined
	if (o && typeof o.toBigInt === "function") return o.toBigInt()
	throw new Error(`${read} returned no readable amount`)
}

/** `balance_of_public` is a public view: simulated, with the amount in the simulation's `result`. */
export async function readPublicFeeJuice(wallet: unknown, account: AztecAddress): Promise<bigint> {
	const { FeeJuiceContract } = await import("@aztec-labs/aztec.js/protocol")
	const view = FeeJuiceContract.withWallet(wallet as Wallet).methods.balance_of_public(account)
	const raw = (await view.simulate({ from: account } as never)) as { result?: unknown }
	return asBigInt(raw?.result, "balance_of_public")
}

/** The PrivateFPC's `balance_of` is a utility function, executed by the wallet over the account's own notes. The
 *  artifact is megabytes, so it loads only when a claim reads credit. */
export async function readPrivateFeeJuice(privateFpc: string, wallet: unknown, account: AztecAddress): Promise<bigint> {
	const { PrivateFPCContractArtifact } = await import("../protocol/private-fpc-artifact.ts")
	const fpc = await Contract.at(AztecAddress.fromStringUnsafe(privateFpc), PrivateFPCContractArtifact, wallet as Wallet)
	const call = ((await fpc.methods.balance_of(account).request()) as { calls?: unknown[] }).calls?.[0]
	if (!call) throw new Error("balance_of produced no call")
	const options = { scopes: [account], authWitnesses: [], capsules: [], extraHashedArgs: [] }
	const raw = (await (wallet as Wallet).executeUtility(call as never, options as never)) as { result?: unknown[] }
	return asBigInt(raw?.result?.[0], "balance_of")
}
