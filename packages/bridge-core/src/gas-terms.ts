/** Bounded sends: explicit gas terms priced and checked before a transaction exists. Viem only. */
import { type Abi, type Account, type Address, encodeFunctionData, type Hex, type WalletClient } from "viem"

/** The explicit gas terms a bounded send carries. */
export interface GasTerms {
	gas: bigint
	maxFeePerGas: bigint
	maxPriorityFeePerGas: bigint
}

/** One send, as the node estimates it. */
export interface SendRequest {
	account: Address
	to?: Address
	data: Hex
	value?: bigint
	/** A gas limit the caller already chose; the terms keep it instead of estimating. */
	gas?: bigint
}

export type GasTermsFor = (request: SendRequest) => Promise<GasTerms>

/** The pricing reads a bounded send needs (a viem public client's shape). */
export interface GasPricing {
	estimateGas(args: SendRequest): Promise<bigint>
	estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
}

/**
 * Terms that bound a send's execution fee by `gas × maxFeePerGas`: the node's estimate plus a quarter, since state
 * moves before inclusion, at the chain's current EIP-1559 caps. `charge` sees that worst case before the send exists
 * and throws to refuse it. An OP-stack chain's L1 data fee is billed outside the product.
 */
export function boundedGasTerms(pub: GasPricing, charge: (worstWei: bigint, request: SendRequest) => void): GasTermsFor {
	return async (request) => {
		const gas = request.gas ?? ((await pub.estimateGas(request)) * 5n) / 4n
		const { maxFeePerGas, maxPriorityFeePerGas } = await pub.estimateFeesPerGas()
		charge(gas * maxFeePerGas, request)
		return { gas, maxFeePerGas, maxPriorityFeePerGas }
	}
}

interface BoundedWrite {
	address: Address
	abi: Abi
	functionName: string
	args?: readonly unknown[]
	value?: bigint
	gas?: bigint
	account?: Account | Address | null
}

interface BoundedSend {
	to?: Address | null
	data?: Hex
	value?: bigint
	gas?: bigint
	account?: Account | Address | null
}

/** `wallet` with explicit terms from `terms` on every `writeContract` and `sendTransaction`, so none of its sends goes out
 *  unbounded. Every other action is the wallet's own. */
export function withGasTerms<W extends WalletClient>(wallet: W, terms: GasTermsFor): W {
	const from = (account: Account | Address | null | undefined): Address => {
		const a = account ?? wallet.account
		if (!a) throw new Error("a bounded send needs an account")
		return typeof a === "string" ? a : a.address
	}
	const writeContract = async (w: BoundedWrite) => {
		const data = encodeFunctionData({ abi: w.abi, functionName: w.functionName, args: w.args } as never)
		const bound = await terms({ account: from(w.account), to: w.address, data, value: w.value, gas: w.gas })
		return wallet.writeContract({ ...w, ...bound } as never)
	}
	const sendTransaction = async (s: BoundedSend) => {
		const bound = await terms({ account: from(s.account), to: s.to ?? undefined, data: s.data ?? "0x", value: s.value, gas: s.gas })
		return wallet.sendTransaction({ ...s, ...bound } as never)
	}
	return { ...wallet, writeContract, sendTransaction } as W
}
