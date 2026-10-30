/**
 * The max fee per gas the CONNECTED WALLET will submit a transaction under — the figure every fee
 * ceiling has to be priced from, because the Fee Juice a private claim, a private exit
 * or a private fuel claim sets aside is the transaction's `gasLimits · maxFeesPerGas`, kept in full
 * by the PrivateFPC, and the wallet decides the second factor. A dApp cannot bind it through the
 * wallet-sdk transport: the option schema (`GasSettingsOptionSchema`) names the cap `maxFeePerGas`
 * while the wallets read `maxFeesPerGas`, so a stock wallet prices the cap itself (predicted min
 * fees plus its own padding) and keeps a ceiling above anything predicted here. The wallet is asked:
 * a sender-less public read is simulated under the requested limits and the gas settings it applied
 * are read back. A wallet that cannot say, or that answers above the caller's bound, leaves the
 * ceiling unpriced — fail closed.
 */
import { NO_FROM } from "@aztec-labs/aztec.js/account"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { predictedWorstMinFees } from "../protocol/fee-juice.ts"

export type MaxFees = { feePerDaGas: bigint; feePerL2Gas: bigint }
export type GasLimits = { daGas: number; l2Gas: number }

/** A quote older than this is asked for again: the wallet re-prices at submission from fees that move every block. */
const QUOTE_FRESH_MS = 30_000

type SimulatingWallet = {
	simulateTx?: (payload: unknown, opts: unknown) => Promise<unknown>
}
type SimulatedGasSettings = {
	gasLimits?: { daGas: number | bigint | string; l2Gas: number | bigint | string }
	maxFeesPerGas?: { feePerDaGas: bigint | number | string; feePerL2Gas: bigint | number | string }
}

type Quote = { maxFees: MaxFees; at: number; epoch: number; pending?: Promise<MaxFees> }
/** Quotes live with the WALLET that gave them, per node: the same address reconnected through
 *  another wallet is another policy, and a replaced wallet object takes its quotes with it. */
const quotesByWallet = new WeakMap<object, WeakMap<AztecNode, Quote>>()
/** Bumped by every forget: a quote from before it, cached or still in flight, no longer counts. */
let epoch = 0
/** Keyed by node: two networks on one page never share limits. */
const networkMax = new WeakMap<AztecNode, GasLimits>()

/** The most a single transaction may declare on `node`'s network, read once; limits above it are refused
 *  at submission, so every fee named is clamped to it (a no-op where the given limits already fit).
 *  Unknown until the first read: `clampGas` passes limits through until then. */
export function clampGas(node: AztecNode, gas: GasLimits): GasLimits {
	const max = networkMax.get(node)
	if (!max) return gas
	return { daGas: Math.min(gas.daGas, max.daGas), l2Gas: Math.min(gas.l2Gas, max.l2Gas) }
}

/** Reads `node`'s per-transaction maximum once, so later `clampGas` calls on it clamp. */
export async function readNetworkMax(node: AztecNode): Promise<void> {
	if (networkMax.has(node)) return
	const gas = (await node.getNodeInfo()).txsLimits?.gas
	if (gas) networkMax.set(node, { daGas: Number(gas.daGas), l2Gas: Number(gas.l2Gas) })
}

/**
 * The max fees per gas the wallet applies to a transaction right now, checked on every call against a
 * fresh `bound()`: a fresh, cached, in-flight or fallback quote with a negative component or one above
 * the bound throws, as does a wallet that cannot simulate or a bound that cannot be read — the callers
 * turn that into their "could not price" stop. A wallet with no simulation at all (a scripted
 * stand-in) is priced from the node's prediction.
 */
export async function walletMaxFees(node: AztecNode, aztec: unknown, gas: GasLimits, bound: () => Promise<MaxFees>): Promise<MaxFees> {
	const [quoted, limit] = await Promise.all([quoteOf(node, aztec, gas), bound()])
	const fees = (f: MaxFees) => `DA ${f.feePerDaGas}, L2 ${f.feePerL2Gas}`
	if (quoted.feePerDaGas < 0n || quoted.feePerL2Gas < 0n)
		throw new Error(`the wallet quoted a negative max fee per gas (${fees(quoted)})`)
	if (quoted.feePerDaGas > limit.feePerDaGas || quoted.feePerL2Gas > limit.feePerL2Gas)
		throw new Error(`the wallet's max fees per gas (${fees(quoted)}) are above the rollup's bound (${fees(limit)})`)
	return { feePerDaGas: quoted.feePerDaGas, feePerL2Gas: quoted.feePerL2Gas }
}

async function quoteOf(node: AztecNode, aztec: unknown, gas: GasLimits): Promise<MaxFees> {
	const wallet = aztec as SimulatingWallet | null | undefined
	if (!wallet || typeof wallet.simulateTx !== "function") return predictedWorstMinFees(node)
	let quotes = quotesByWallet.get(wallet)
	if (!quotes) {
		quotes = new WeakMap()
		quotesByWallet.set(wallet, quotes)
	}
	const cached = quotes.get(node)
	const current = cached?.epoch === epoch ? cached : undefined
	if (current?.pending) return current.pending
	if (current && Date.now() - current.at <= QUOTE_FRESH_MS) return current.maxFees
	const mine = epoch
	const pending = probe(node, wallet, gas)
		.then((maxFees) => {
			if (mine === epoch) quotes.set(node, { maxFees, at: Date.now(), epoch: mine })
			return maxFees
		})
		.catch((e) => {
			if (mine === epoch) quotes.delete(node)
			throw e
		})
	quotes.set(node, { maxFees: current?.maxFees ?? { feePerDaGas: 0n, feePerL2Gas: 0n }, at: current?.at ?? 0, epoch: mine, pending })
	return pending
}

/** Forget every quote: a new account or wallet prices from scratch, and a probe still running for
 *  the old one lands nowhere. */
export function forgetWalletFees(): void {
	epoch++
}

/**
 * The probe PROPOSES the app's own cap — the node's worst predicted min fees, no padding — in
 * both spellings of the option. A wallet that honors a dApp's cap (the Nulo wallet) answers with
 * exactly that, so its users keep a ceiling of `limits × 1×`; a wallet that ignores it answers with
 * whatever it will really submit under. Probing without a proposal would make a cap-honoring
 * wallet answer with its own padded default, and the app would then bind it to that. The call is
 * Fee Juice's `balance_of_public` of the zero address from `NO_FROM`: a static public read that
 * BaseWallet prices through the same fee completion as a send, with no sender, fee payer or
 * argument naming the account.
 */
async function probe(node: AztecNode, wallet: SimulatingWallet, gas: GasLimits): Promise<MaxFees> {
	await readNetworkMax(node)
	const limits = clampGas(node, gas)
	const proposed = await predictedWorstMinFees(node)
	const cap = { feePerDaGas: proposed.feePerDaGas, feePerL2Gas: proposed.feePerL2Gas }
	const { FeeJuiceContract } = await import("@aztec-labs/aztec.js/protocol")
	const payload = await FeeJuiceContract.withWallet(wallet as never)
		.methods.balance_of_public(AztecAddress.ZERO)
		.request()
	const result = (await wallet.simulateTx?.(payload, {
		from: NO_FROM,
		fee: { gasSettings: { gasLimits: limits, teardownGasLimits: { daGas: 0, l2Gas: 0 }, maxFeesPerGas: cap, maxFeePerGas: cap } },
		skipTxValidation: true,
		skipFeeEnforcement: true,
	})) as { publicInputs?: { constants?: { txContext?: { gasSettings?: SimulatedGasSettings } } } } | undefined
	const applied = result?.publicInputs?.constants?.txContext?.gasSettings?.maxFeesPerGas
	if (!applied) throw new Error("the wallet's simulation reported no gas settings")
	return { feePerDaGas: BigInt(applied.feePerDaGas), feePerL2Gas: BigInt(applied.feePerL2Gas) }
}
