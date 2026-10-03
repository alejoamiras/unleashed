/**
 * What the FPC will KEEP for a transaction the connected wallet submits: the app's limits times the
 * max fees per gas the wallet chooses. The test wallet is a stock `EmbeddedWallet`, and so is the
 * harness's scripting wallet — same class, same node, same policy — so the figure is read the way
 * the app reads it: a no-op simulated under the limits, the applied settings read back.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Page } from "@playwright/test"
import { ownGasTxs, PRIVATE_FUEL_CLAIM_GAS, PRIVATE_HUB_EXIT_GAS, privateFpcFeeLimit } from "@unleashed/bridge-core"
import type { RunEnv } from "../env"
import type { ActorHandle } from "../fixtures/test"
import type { TestWalletProfile } from "../test-wallet/profile"
import { walletFrame } from "./connect"

type MaxFees = { feePerDaGas: bigint; feePerL2Gas: bigint }
type Limits = { daGas: number; l2Gas: number }

async function networkMax(actor: ActorHandle): Promise<Limits> {
	const info = await actor.s.l2.node.getNodeInfo()
	return { daGas: Number(info.txsLimits.gas.daGas), l2Gas: Number(info.txsLimits.gas.l2Gas) }
}

const clamp = (gas: Limits, max: Limits): Limits => ({ daGas: Math.min(gas.daGas, max.daGas), l2Gas: Math.min(gas.l2Gas, max.l2Gas) })

/**
 * The max fees per gas a stock wallet applies to this actor's transactions right now. No cap is
 * proposed here, on purpose: the app proposes one, but the wallet-sdk transport strips it before a
 * stock wallet reads its options, so the question the wallet ends up answering is this one.
 */
export async function walletMaxFees(actor: ActorHandle, gas: Limits): Promise<MaxFees> {
	const wallet = actor.s.l2.wallet as unknown as { simulateTx: (payload: unknown, opts: unknown) => Promise<unknown> }
	const from = AztecAddress.fromStringUnsafe(actor.address)
	const noop = await SetPublicAuthwitContractInteraction.create(wallet as never, from, Fr.random(), false)
	const payload = await noop.request()
	const result = (await wallet.simulateTx(payload, {
		from,
		fee: { gasSettings: { gasLimits: clamp(gas, await networkMax(actor)), teardownGasLimits: { daGas: 0, l2Gas: 0 } } },
		skipTxValidation: true,
		skipFeeEnforcement: true,
	})) as { publicInputs: { constants: { txContext: { gasSettings: { maxFeesPerGas: MaxFees } } } } }
	const applied = result.publicInputs.constants.txContext.gasSettings.maxFeesPerGas
	return { feePerDaGas: BigInt(applied.feePerDaGas), feePerL2Gas: BigInt(applied.feePerL2Gas) }
}

/** What the FPC keeps of a private gas-only bridge's own claim: the credit it leaves is the fuel minus this. */
export async function walletFuelClaimCeiling(actor: ActorHandle): Promise<bigint> {
	const max = await networkMax(actor)
	return privateFpcFeeLimit(clamp(PRIVATE_FUEL_CLAIM_GAS, max), await walletMaxFees(actor, PRIVATE_FUEL_CLAIM_GAS))
}

/** The Fee Juice a private exit sets aside from credit, as the wallet will price it. */
export async function walletExitCeiling(actor: ActorHandle): Promise<bigint> {
	const max = await networkMax(actor)
	return privateFpcFeeLimit(clamp(PRIVATE_HUB_EXIT_GAS, max), await walletMaxFees(actor, PRIVATE_HUB_EXIT_GAS))
}

/** The Fee Juice a claim of this shape sets aside from held gas, as the wallet will price it. */
export async function walletCeiling(actor: ActorHandle, shape: { isPrivate: boolean; registers: boolean }): Promise<bigint> {
	const txs = ownGasTxs(shape)
	const max = await networkMax(actor)
	const fees = await walletMaxFees(actor, txs.claim)
	const claim = privateFpcFeeLimit(clamp(txs.claim, max), fees)
	return txs.register ? claim + privateFpcFeeLimit(clamp(txs.register, max), fees) : claim
}

/** A transaction the journal says landed, with the gas limits the app was to submit it under
 *  (omitted for the shape that folds a registration into its claim). */
export interface LandedTx {
	hash?: string
	gas?: Limits
}

/**
 * What the FPC kept for these transactions: the fee limit of each as the wallet handed it to the
 * node — `gasLimits × maxFeesPerGas`, no refund — never a prediction. The chain's fees move between a
 * fixture's pricing and the wallet's send (anvil's base fee follows every L1 write), so equality is
 * only exact against the submission itself; the limits are checked against the app's so an
 * over-budget submission cannot balance the books.
 */
export async function keptFor(
	page: Page,
	run: Pick<RunEnv, "testWalletOrigins">,
	profile: TestWalletProfile,
	actor: ActorHandle,
	txs: LandedTx[],
): Promise<bigint> {
	const submitted = await walletFrame(page, run, profile).evaluate(() => window.__unleashedTestWallet!.submitted())
	const max = await networkMax(actor)
	let kept = 0n
	for (const tx of txs) {
		if (!tx.hash) throw new Error("a transaction the journal should have landed has no hash")
		const hit = submitted.find((s) => s.hash === tx.hash)
		if (!hit) throw new Error(`the wallet never handed ${tx.hash} to the node`)
		if (tx.gas) {
			const want = clamp(tx.gas, max)
			if (hit.daGas !== want.daGas || hit.l2Gas !== want.l2Gas) {
				throw new Error(`${tx.hash} went out under ${hit.daGas}/${hit.l2Gas} gas, not the app's ${want.daGas}/${want.l2Gas}`)
			}
		}
		kept += BigInt(hit.feeLimit)
	}
	return kept
}
