/**
 * The max fee per gas the CONNECTED WALLET will submit a transaction under — the figure every fee
 * ceiling in this app has to be priced from, because the Fee Juice a private claim, a private exit
 * or a private fuel claim sets aside is the transaction's `gasLimits · maxFeesPerGas`, kept in full
 * by the PrivateFPC, and the wallet decides the second factor. A dApp cannot bind it through the
 * wallet-sdk transport: the option schema (`GasSettingsOptionSchema`) names the cap `maxFeePerGas`
 * while the wallets read `maxFeesPerGas`, so a stock wallet prices the cap itself (predicted min
 * fees plus its own padding) and keeps a ceiling above anything predicted here. The only honest
 * source is the wallet: a no-op is simulated under the requested limits and the gas settings it
 * applied are read back. A wallet that cannot say leaves the ceiling unpriced — fail closed.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { predictedWorstMinFees } from "@unleashed/bridge-core"
import { NETWORK } from "@/lib/network"

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
/** Quotes live with the WALLET that gave them: the same address reconnected through another wallet
 *  is another policy, and a replaced wallet object takes its quotes with it. */
const quotesByWallet = new WeakMap<object, Map<string, Quote>>()
/** Bumped by every forget: a quote from before it, cached or still in flight, no longer counts. */
let epoch = 0
let networkMax: GasLimits | null = null

/** The most a single transaction may declare on this network, read once; limits above it are refused
 *  at submission, so every fee this app names is clamped to it (a no-op where the app's own limits
 *  already fit). Unknown until the first read: `clampGas` passes limits through until then. */
export function clampGas(gas: GasLimits): GasLimits {
	if (!networkMax) return gas
	return { daGas: Math.min(gas.daGas, networkMax.daGas), l2Gas: Math.min(gas.l2Gas, networkMax.l2Gas) }
}

async function readNetworkMax(): Promise<void> {
	if (networkMax) return
	const info = await createAztecNodeClient(NETWORK.nodeUrl).getNodeInfo()
	const gas = info.txsLimits?.gas
	if (gas) networkMax = { daGas: Number(gas.daGas), l2Gas: Number(gas.l2Gas) }
}

/** Quotes are per account: the wallet behind an account does not change under a session. */
const keyOf = (account: AztecAddress) => account.toString()

/**
 * The max fees per gas the wallet applies to this account's transactions right now. Probed with a
 * no-op the account can always send (a public authwit revocation of a random hash) under the app's
 * own limits, fee enforcement and validation skipped, so a cold account is priced like a funded one.
 * Throws when the wallet cannot simulate — the callers turn that into their "could not price" stop.
 * A wallet with no simulation at all (a scripted stand-in) is priced from the node's prediction.
 */
export async function walletMaxFees(aztec: unknown, account: AztecAddress, gas: GasLimits): Promise<MaxFees> {
	const wallet = aztec as SimulatingWallet | null | undefined
	if (!wallet || typeof wallet.simulateTx !== "function") return predictedWorstMinFees(createAztecNodeClient(NETWORK.nodeUrl))
	let quotes = quotesByWallet.get(wallet)
	if (!quotes) {
		quotes = new Map()
		quotesByWallet.set(wallet, quotes)
	}
	const key = keyOf(account)
	const cached = quotes.get(key)
	const current = cached?.epoch === epoch ? cached : undefined
	if (current?.pending) return current.pending
	if (current && Date.now() - current.at <= QUOTE_FRESH_MS) return current.maxFees
	const mine = epoch
	const pending = probe(wallet, account, gas)
		.then((maxFees) => {
			if (mine === epoch) quotes.set(key, { maxFees, at: Date.now(), epoch: mine })
			return maxFees
		})
		.catch((e) => {
			if (mine === epoch) quotes.delete(key)
			throw e
		})
	quotes.set(key, { maxFees: current?.maxFees ?? { feePerDaGas: 0n, feePerL2Gas: 0n }, at: current?.at ?? 0, epoch: mine, pending })
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
 * wallet answer with its own padded default, and the app would then bind it to that.
 */
async function probe(wallet: SimulatingWallet, account: AztecAddress, gas: GasLimits): Promise<MaxFees> {
	await readNetworkMax()
	const limits = clampGas(gas)
	const proposed = await predictedWorstMinFees(createAztecNodeClient(NETWORK.nodeUrl))
	const cap = { feePerDaGas: proposed.feePerDaGas, feePerL2Gas: proposed.feePerL2Gas }
	const noop = await SetPublicAuthwitContractInteraction.create(wallet as never, account, Fr.random(), false)
	const payload = await noop.request()
	const result = (await wallet.simulateTx?.(payload, {
		from: account,
		fee: { gasSettings: { gasLimits: limits, teardownGasLimits: { daGas: 0, l2Gas: 0 }, maxFeesPerGas: cap, maxFeePerGas: cap } },
		skipTxValidation: true,
		skipFeeEnforcement: true,
	})) as { publicInputs?: { constants?: { txContext?: { gasSettings?: SimulatedGasSettings } } } } | undefined
	const applied = result?.publicInputs?.constants?.txContext?.gasSettings?.maxFeesPerGas
	if (!applied) throw new Error("the wallet's simulation reported no gas settings")
	return { feePerDaGas: BigInt(applied.feePerDaGas), feePerL2Gas: BigInt(applied.feePerL2Gas) }
}
