/** Bounded sends: explicit gas terms priced and checked before a transaction exists, and signed only as checked. Viem only. */
import {
	type Abi,
	type Account,
	type Address,
	type Chain,
	encodeFunctionData,
	type Hex,
	type LocalAccount,
	parseTransaction,
	type WalletClient,
} from "viem"

/** The explicit terms a bounded send carries. */
export interface GasTerms {
	gas: bigint
	maxFeePerGas: bigint
	maxPriorityFeePerGas: bigint
	nonce: number
}

/** One send, as the node estimates it. */
export interface SendRequest {
	account: Address
	to?: Address
	data: Hex
	value?: bigint
	/** A gas limit the caller already chose; the terms keep it instead of estimating. */
	gas?: bigint
	/** A nonce the caller already chose; the terms keep it instead of reading the account's pending count. */
	nonce?: number
}

export type GasTermsFor = (request: SendRequest) => Promise<GasTerms>

/** The reads a bounded send needs (a viem public client's shape). */
export interface GasPricing {
	estimateGas(args: SendRequest): Promise<bigint>
	estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
	getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>
}

/**
 * Terms that bound a send's execution fee by `gas × maxFeePerGas`: the node's estimate plus a quarter, since state
 * moves before inclusion, at the chain's current EIP-1559 caps. `charge` sees that worst case before the send exists
 * and throws to refuse it; only then is the account's pending nonce read. An OP-stack chain's L1 data fee is billed
 * outside the product.
 */
export function boundedGasTerms(pub: GasPricing, charge: (worstWei: bigint, request: SendRequest) => void): GasTermsFor {
	return async (request) => {
		const gas = request.gas ?? ((await pub.estimateGas(request)) * 5n) / 4n
		const { maxFeePerGas, maxPriorityFeePerGas } = await pub.estimateFeesPerGas()
		charge(gas * maxFeePerGas, request)
		const nonce = request.nonce ?? (await pub.getTransactionCount({ address: request.account, blockTag: "pending" }))
		return { gas, maxFeePerGas, maxPriorityFeePerGas, nonce }
	}
}

interface BoundedCall {
	value?: bigint
	gas?: bigint
	nonce?: number
	account?: Account | Address | null
	chain?: Chain | null
}

interface BoundedWrite extends BoundedCall {
	address: Address
	abi: Abi
	functionName: string
	args?: readonly unknown[]
}

interface BoundedSend extends BoundedCall {
	to?: Address | null
	data?: Hex
}

type Pinned = GasTerms & { chainId: number; type: "eip1559" }

type SignedFields = Partial<Omit<Pinned, "type">> & { type?: string; to?: string | null; data?: string; value?: bigint }

/** Both sides of the signature check in one form: `parseTransaction` omits a zero gas, fee or value and empty data, and
 *  lower-cases `to`. */
const comparable = (t: SignedFields) => ({
	chainId: t.chainId ?? 0,
	nonce: t.nonce ?? 0,
	type: t.type,
	gas: t.gas ?? 0n,
	maxFeePerGas: t.maxFeePerGas ?? 0n,
	maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? 0n,
	to: (t.to ?? "").toLowerCase(),
	data: (t.data ?? "0x").toLowerCase(),
	value: t.value ?? 0n,
})

/** `account`, refusing any signature whose bytes differ from `request` under `pinned`: an edit made after pricing, by viem
 *  or a chain's hooks, stops before the transaction leaves the process. */
function checkedSigner(account: LocalAccount, request: SendRequest, pinned: Pinned): LocalAccount {
	const expected = comparable({ ...request, ...pinned })
	const signTransaction = async (transaction: never, options: never) => {
		const signed = await account.signTransaction(transaction, options)
		const carried = comparable(parseTransaction(signed) as SignedFields)
		for (const field of Object.keys(expected) as (keyof typeof expected)[])
			if (carried[field] !== expected[field])
				throw new Error(`a bounded send's signature carries ${field} ${carried[field]}, not the checked ${expected[field]}`)
		return signed
	}
	return { ...account, signTransaction: signTransaction as LocalAccount["signTransaction"] }
}

/**
 * `wallet` with every `writeContract` and `sendTransaction` signed as checked: explicit terms from `terms`, the wallet's
 * chain id and an EIP-1559 type, so viem asks the node to fill in nothing, and a signature whose bytes carry anything
 * else is refused before broadcast. A send forwards only the fields declared here. Every other action is the wallet's
 * own.
 *
 * @throws before any read when the wallet has no chain, the call names another chain, or the account is not local.
 */
export function withGasTerms<W extends WalletClient>(wallet: W, terms: GasTermsFor): W {
	const bounded = async (call: BoundedCall, priced: Pick<SendRequest, "to" | "data" | "value">) => {
		const chainId = wallet.chain?.id
		if (chainId === undefined) throw new Error("a bounded send needs its wallet's chain")
		if (call.chain && call.chain.id !== chainId) throw new Error(`a bounded send signs for chain ${chainId}, not ${call.chain.id}`)
		const account = call.account ?? wallet.account
		if (typeof account !== "object" || account?.type !== "local") throw new Error("a bounded send signs with a local account")
		const request: SendRequest = { ...priced, account: account.address, gas: call.gas, nonce: call.nonce }
		const pinned: Pinned = { ...(await terms(request)), chainId, type: "eip1559" }
		return { ...pinned, account: checkedSigner(account, request, pinned), chain: wallet.chain }
	}
	const writeContract = async ({ address, abi, functionName, args, value, ...call }: BoundedWrite) => {
		const data = encodeFunctionData({ abi, functionName, args } as never)
		const bound = await bounded(call, { to: address, data, value })
		return wallet.writeContract({ address, abi, functionName, args, value, ...bound } as never)
	}
	const sendTransaction = async ({ to, data, value, ...call }: BoundedSend) => {
		const bound = await bounded(call, { to: to ?? undefined, data: data ?? "0x", value })
		return wallet.sendTransaction({ to, data, value, ...bound } as never)
	}
	return { ...wallet, writeContract, sendTransaction } as W
}
