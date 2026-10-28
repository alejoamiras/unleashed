/**
 * The hub claim that pays for itself out of the Fee Juice its own send bridged, shared by the fueled
 * live canaries: public fuel is claimed in the claim's setup and pays the actual fee; private fuel is
 * minted into the PrivateFPC, which pays against the ceiling the claim commits to.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { Gas, type GasFees } from "@aztec-labs/stdlib/gas"
import {
	type MinFeeNode,
	predictedWorstMinFees,
	publicFeeJuicePayment,
	deriveBridgeSecret,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	privateFeeJuicePayment,
	privateMintAndPayFee,
} from "@unleashed/sdk/protocol"
import { claimViaHub, type HubClaimOutcome, hubTokenFor } from "@unleashed/sdk/internal"
import type { JournalTokenBlock } from "@unleashed/sdk"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Where the send's bridged Fee Juice went, and what its claim needs. */
export type BridgedFuel =
	/** Deposited to the claimer with a random secret. */
	| { via: "public"; received: bigint; leafIndex: bigint; secret: Fr }
	/** Deposited to the PrivateFPC under `deriveBridgeSecret(bridgeSalt, claimer)`. */
	| { via: "private-fpc"; received: bigint; leafIndex: bigint; bridgeSalt: Fr }

export interface FueledClaim {
	label: string
	hub: ContractBase
	node: MinFeeNode
	/** The claimer, and the recipient the token leg names. */
	from: AztecAddress
	/** The factory's read-back block, already checked against the manifest. */
	token: JournalTokenBlock
	amount: bigint
	/** PUBLIC: the raw secret. PRIVATE: the `claim_salt`. */
	claimValue: Fr
	leafIndex: bigint
	isPrivate: boolean
	fuel: BridgedFuel
	/** Multiplies the predicted-worst max fees a PrivateFPC claim commits to; 1 commits them unpadded. */
	reliabilityPad?: number
	mins: () => string
}

export interface FueledClaimResult {
	outcome: HubClaimOutcome
	/** The max fees a PrivateFPC claim committed to: with the declared limits, its exact ceiling. */
	committedMaxFees?: GasFees
	/** Whether this claim's first transaction registered the token. */
	registered: boolean
}

/** PUBLIC fuel pays the ACTUAL fee, so its payment is static. PRIVATE-FPC fuel asserts
 *  `amount >= getFeeLimit` against the COMMITTED maxFeesPerGas, and the protocol rejects a tx whose
 *  committed cap fell below the live base fee by inclusion time — a claim proves for minutes, so the
 *  cap is re-priced on every attempt rather than reused. */
async function fueledClaimFee(
	c: FueledClaim,
	registers: boolean,
): Promise<{ fee: unknown; registerFee?: unknown; registeredClaimFee?: unknown; maxFees?: GasFees }> {
	if (c.fuel.via === "public") {
		const claim = { claimAmount: c.fuel.received, claimSecret: c.fuel.secret, messageLeafIndex: c.fuel.leafIndex }
		return { fee: { paymentMethod: publicFeeJuicePayment(c.from, claim) } }
	}
	const maxFees = (await predictedWorstMinFees(c.node)).mul(c.reliabilityPad ?? 1)
	const fpc = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
	const { bridgeSalt, received, leafIndex } = c.fuel
	const fuelPayment = privateMintAndPayFee(fpc, received, deriveBridgeSecret(bridgeSalt, c.from), bridgeSalt, new Fr(leafIndex))
	const gasSettings = (gas: { daGas: number; l2Gas: number }) => ({
		gasLimits: Gas.from(gas),
		teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
		maxFeesPerGas: maxFees,
	})
	// The fuel message is spent by whichever transaction goes first — a first-time token's own
	// registration, sized for one, else the claim — and a claim after such a registration draws on
	// the credit the FPC kept, exactly as the app's ladder does it.
	return {
		fee: { paymentMethod: fuelPayment, gasSettings: gasSettings(PRIVATE_HUB_CLAIM_GAS) },
		...(registers
			? {
					registerFee: { paymentMethod: fuelPayment, gasSettings: gasSettings(PRIVATE_HUB_REGISTER_GAS) },
					registeredClaimFee: { paymentMethod: privateFeeJuicePayment(fpc), gasSettings: gasSettings(PRIVATE_HUB_CLAIM_GAS) },
				}
			: {}),
		maxFees,
	}
}

/** An FPC budget assert means the bridged FJ is below the committed getFeeLimit — a real failure,
 *  never a sync/fee-drift wait to retry through. */
function throwIfFpcBudgetAssert(label: string, fuelReceived: bigint, msg: string): void {
	if (/Amount too low to cover gas cost|max_gas_cost/.test(msg)) {
		throw new Error(`${label}: FPC budget assert — bridged FJ ${fuelReceived} < committed getFeeLimit. ${msg}`)
	}
}

/** The self-paying claim, retried on the message-sync cadence. It cannot use the shared fixed-options
 *  claim loop: the FPC fee has to be rebuilt per attempt (see fueledClaimFee). */
export async function settleFueledClaim(c: FueledClaim): Promise<FueledClaimResult> {
	const claim = {
		token: c.token,
		recipient: c.from.toString(),
		amount: c.amount,
		claimValue: c.claimValue,
		leafIndex: c.leafIndex,
		isPrivate: c.isPrivate,
		from: c.from.toString(),
	}
	for (let i = 0; i < 300; i++) {
		try {
			// Whether this claim registers the token is a live fact, re-read per attempt like the app does.
			const registers = c.fuel.via === "private-fpc" && (await hubTokenFor(c.hub, c.token.erc20, c.from.toString())) === undefined
			const built = await fueledClaimFee(c, registers)
			const sendOpts = {
				from: c.from,
				fee: built.fee,
				...(built.registerFee ? { registerFee: built.registerFee, registeredClaimFee: built.registeredClaimFee } : {}),
				onRegistered: (hash: string) =>
					console.log(
						`${c.label}: register_token ${hash} landed — waiting for the claim to pass in this wallet's view (${c.mins()})`,
					),
				wait: { waitForStatus: TxStatus.PROPOSED },
			}
			return { outcome: await claimViaHub(c.hub, claim, sendOpts), committedMaxFees: built.maxFees, registered: registers }
		} catch (e) {
			throwIfFpcBudgetAssert(c.label, c.fuel.received, e instanceof Error ? e.message : String(e))
			if (i % 10 === 0) console.log(`${c.label}: claim not ready / re-pricing… (${c.mins()})`)
			await sleep(6000)
		}
	}
	throw new Error(`${c.label}: self-paying claim never SETTLED within budget`)
}
