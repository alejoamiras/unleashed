/**
 * The claim fee ladder: which Fee Juice pays a deposit's claim, decided from the record's own evidence. Every
 * mode pays from Fee Juice the user bridged or already holds — the bridged Fee Juice paying for its own claim,
 * the PrivateFPC paying from a fresh claim or from the credit it kept, or the account's own gas. Nothing is ever
 * sponsored, on any network. A rung that cannot pay stops with a `FeeStop` before any wallet call.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { publicFeeJuicePayment, selfPaidFeeJuicePayment } from "../protocol/fee-juice.ts"
import { ownGasTxs, PRIVATE_HUB_CLAIM_GAS, privateFpcFeeLimit } from "../protocol/private-fuel.ts"
import type { DepositFuelBlock } from "../records.ts"
import { isWellFormedTxHash } from "./claim-receipt.ts"
import { type FeeLadderEnv, type FeeLadderRecord, patchFuel, type RecordPatch, readFeeJuiceOrNull, walletFeesOrNull } from "./fee-env.ts"
import { type FeeStop, FeeStopError, feeStopInteraction } from "./fee-stop.ts"
import { buildFuelClaimInteraction, type FuelClaimInteraction, type FuelClaimRetry } from "./fuel-claim.ts"
import { decideFuelClaim, decideOwnGasSource, FUEL_FEE_MARGIN, isPrivateFuelInsufficiency } from "./fuel-claim-state.ts"
import { fuelReceiptStatus } from "./fuel-settlement.ts"
import type { SendOpts } from "./hub-l2.ts"
import { isMsgNotReady } from "./message-errors.ts"
import { type FpcFee, fpcCreditFee, resolvePrivateFuelFee } from "./private-fee.ts"
import { clampGas, type MaxFees } from "./wallet-fee-budget.ts"
import { DAPP_SELF_PAY_FEATURE, walletSupports } from "./wallet-features.ts"

export { type RecoveryL1Client, readDepositLeaves, recoverDepositLeg } from "./deposit-recovery.ts"
export {
	type FeeLadderEnv,
	type FeeLadderRecord,
	type FeeLadderStore,
	patchFuel,
	type RecordPatch,
	readFeeJuiceOrNull,
	type StoredRecord,
} from "./fee-env.ts"
export { type FeeStop, FeeStopError, feeStopInteraction } from "./fee-stop.ts"
export {
	fuelMessageCheckpointed,
	fuelReceiptStatus,
	type PollBudget,
	sendStandaloneFjClaim,
	waitForFuelInclusion,
} from "./fuel-settlement.ts"
export { type FpcFee, type PrivateFeeContext, type PrivateFuelFee, resolvePrivateFuelFee } from "./private-fee.ts"

/** Human Fee Juice (18 decimals) for the decision log; `null` = unread. */
const fmtFj = (x: bigint | null): string => (x === null ? "?" : `${(Number(x) / 1e18).toFixed(3)} FJ`)

// ── the gas-only claim ───────────────────────────────────────────────────────

/** A gas-only record with a prior claim on its PERSISTED fuel block is rebuilt ONLY once that claim
 *  conclusively dropped: an included one (success, or reverted past setup — the message was consumed
 *  either way) has nothing left to claim, and a pending or unreachable one may still land — simulate is
 *  an authority, not exclusion against a queued tx, and elapsed time is not evidence the tx vanished. */
async function priorFuelClaimStop(
	env: FeeLadderEnv,
	id: string,
	captured: DepositFuelBlock | undefined,
): Promise<FuelClaimInteraction | null> {
	const fuel = env.records.current(id)?.fuel ?? captured
	if (fuel?.consumed === true) return feeStopInteraction("fuel-already-claimed")
	if (fuel?.claimTxHash === undefined) return null
	if (!isWellFormedTxHash(fuel.claimTxHash)) return feeStopInteraction("malformed-claim-hash")
	const status = await fuelReceiptStatus(env, fuel.claimTxHash)
	if (status === "included") return feeStopInteraction("fuel-already-claimed")
	if (status === "dropped") return null
	return feeStopInteraction("fuel-claim-pending")
}

/** A gas-only deposit's claim: the Fee Juice itself, no token leg, its own fee ladder. Throws
 *  `FeeStopError("unpriced-by-wallet")` when the wallet cannot price the claim; every other stop is an
 *  interaction that refuses. `secretHex` (public) and `envelope.salt` (private) are the authoritative claim
 *  material the caller resolved, never the record's plaintext copy. */
export async function buildFeeJuiceClaim(
	env: FeeLadderEnv,
	rec: { id: string; isPrivate: boolean; recipient: string; fuel?: DepositFuelBlock },
	secretHex: string,
	envelope: { salt?: string } | undefined,
	aztec: unknown,
	retry?: FuelClaimRetry,
): Promise<FuelClaimInteraction> {
	const prior = await priorFuelClaimStop(env, rec.id, rec.fuel)
	if (prior) return prior
	const latchFuel = (patch: Partial<DepositFuelBlock>) => patchFuel(env, rec.id, rec.fuel, patch)
	const recipient = AztecAddress.fromStringUnsafe(rec.recipient)
	// Both paths SELF-PAY (public via FeeJuicePaymentMethodWithClaim, private via the embedded FPC): the
	// bridged amount is the whole budget and the setup asserts amount >= gasLimits*maxFeesPerGas with no
	// refund, so any fee headroom inflates max_gas_cost past the bridged amount and reverts "Amount too
	// low to cover gas cost". Predicted-worst already looks past the proving window; a rare spike beyond
	// it fails recoverably (a retry reprices). The figure is the WALLET's: it submits under its own max fee.
	const claimMaxFees = await walletFeesOrNull(env, aztec, recipient, PRIVATE_HUB_CLAIM_GAS)
	if (claimMaxFees === null) throw new FeeStopError("unpriced-by-wallet")
	return buildFuelClaimInteraction(rec, {
		aztec,
		node: env.node,
		privateFpc: env.privateFpc,
		recipient,
		minFloorFj: env.minFloorFj,
		maxFeesPerGas: { feePerDaGas: claimMaxFees.feePerDaGas, feePerL2Gas: claimMaxFees.feePerL2Gas },
		resolvedSalt: rec.isPrivate ? envelope?.salt : undefined,
		resolvedSecret: rec.isPrivate ? undefined : secretHex,
		onAttempt: () => latchFuel({ claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: false }),
		onTxHash: (txHash: string) => latchFuel({ claimAttempt: true, claimAttemptAt: Date.now(), claimTxHash: txHash }),
		onSetupInsufficiency: () => latchFuel({ setupInsufficiency: true }),
		retry,
	})
}

// ── the public ladder ────────────────────────────────────────────────────────

/** The public claim's fee resolution, as a strict discriminated result — impossible
 *  combinations (a stop with a fee, standalone with fjwc) cannot be constructed. */
export type PublicClaimFee =
	| { kind: "stop"; stop: FeeStop; sendStop?: FeeStop }
	| { kind: "fjwc"; fee: { paymentMethod: unknown } }
	/** The private gas the account already holds at the FPC pays the claim. A private first-time
	 *  token sends a registration first, on the register seams; `standalone` is bridged Fee Juice a
	 *  fee spike left for a claim of its own. */
	| { kind: "own-gas"; fee: FpcFee; registerFee?: FpcFee; registeredClaimFee?: FpcFee; standalone?: DepositFuelBlock }

const OWN_GAS_STOPS = { none: "own-gas-none", unverifiable: "own-gas-unverifiable", short: "own-gas-short" } as const
/** A private bridge's claim is never paid from public Fee Juice (see `decideOwnGasSource`). */
const PRIVATE_OWN_GAS_STOPS = {
	none: "private-own-gas-none",
	unverifiable: "private-own-gas-unverifiable",
	short: "private-own-gas-short",
} as const

/** The account's own public Fee Juice as the transaction's payer, on a wallet that routes it: the
 *  wallet sizes the limits from its own estimate and charges the exact fee; the cap is the
 *  predicted worst fee, so a rise before inclusion cannot reject it. */
const selfPayFee = (payer: AztecAddress, maxFees: MaxFees): FpcFee => ({
	paymentMethod: selfPaidFeeJuicePayment(payer),
	gasSettings: { maxFeesPerGas: { feePerDaGas: maxFees.feePerDaGas, feePerL2Gas: maxFees.feePerL2Gas } },
})

/** What a claim from held gas sets aside, priced from the CLAMPED limits it is submitted under —
 *  what the FPC actually keeps — never from the declared constants a smaller network cuts down. */
function clampedOwnGasCeiling(env: FeeLadderEnv, shape: { isPrivate: boolean; registers: boolean }, maxFees: MaxFees): bigint {
	const txs = ownGasTxs(shape)
	const claim = privateFpcFeeLimit(clampGas(env.node, txs.claim), maxFees)
	return txs.register ? claim + privateFpcFeeLimit(clampGas(env.node, txs.register), maxFees) : claim
}

/** A claim with no fresh Fee Juice message of its own pays from gas the account ALREADY holds, and
 *  names its payer: the private balance at the FPC, or — on a wallet that routes a dApp-named payer
 *  — its public Fee Juice. A claim sent without a payer would be left to the wallet's picker, whose
 *  default is the sponsored FPC no bridge path may lean on; a public payer on a wallet that cannot
 *  route it builds an invalid transaction, so the wallet is asked first. Reads are fail-closed
 *  (null = unread). */
export async function ownGasFee(
	env: FeeLadderEnv,
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	registers: boolean,
): Promise<PublicClaimFee> {
	const publicAllowed = await walletSupports(aztec, DAPP_SELF_PAY_FEATURE)
	const [pub, credit, maxFees] = await Promise.all([
		publicAllowed ? readFeeJuiceOrNull(env, "public FJ", () => env.readPublicFeeJuice(aztec, recipientAddr)) : Promise.resolve(0n),
		readFeeJuiceOrNull(env, "private FJ", () => env.readPrivateFeeJuice(aztec, recipientAddr)),
		walletFeesOrNull(env, aztec, recipientAddr, PRIVATE_HUB_CLAIM_GAS),
	])
	if (maxFees === null) return { kind: "stop", stop: "unpriced-by-wallet" }
	const shape = { isPrivate: rec.isPrivate, registers }
	const ceiling = clampedOwnGasCeiling(env, shape, maxFees)
	const source = decideOwnGasSource({
		publicFeeJuice: pub,
		privateFeeJuice: credit,
		ceiling,
		privateBridge: rec.isPrivate,
		publicAllowed,
	})
	env.log("own-gas source", {
		id: rec.id,
		source,
		registers,
		publicAllowed,
		pub: fmtFj(pub),
		credit: fmtFj(credit),
		ceiling: fmtFj(ceiling),
	})
	if (source === "public") return { kind: "own-gas", fee: selfPayFee(recipientAddr, maxFees) }
	if (source !== "private") return { kind: "stop", stop: (rec.isPrivate ? PRIVATE_OWN_GAS_STOPS : OWN_GAS_STOPS)[source] }
	const fpc = AztecAddress.fromStringUnsafe(env.privateFpc)
	const txs = ownGasTxs(shape)
	const fee = fpcCreditFee(env, fpc, maxFees, txs.claim)
	return {
		kind: "own-gas",
		fee,
		...(txs.register ? { registerFee: fpcCreditFee(env, fpc, maxFees, txs.register), registeredClaimFee: fee } : {}),
	}
}

/** A fee spike: the claim pays from held gas and the bridged Fee Juice lands by a transaction of its own. */
async function ownGasWithStandalone(
	env: FeeLadderEnv,
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	registers: boolean,
	fuel: DepositFuelBlock,
): Promise<PublicClaimFee> {
	const own = await ownGasFee(env, rec, recipientAddr, aztec, registers)
	return own.kind === "own-gas" ? { ...own, standalone: fuel } : own
}

/** The bridged Fee Juice pays for the claim that lands it. A public block without its secret is corrupted. */
function fjwcFee(recipientAddr: AztecAddress, fuel: DepositFuelBlock & { received: string; leafIndex: string }): PublicClaimFee {
	if (fuel.secret === undefined) return { kind: "stop", stop: "missing-secret" }
	const claim = { claimAmount: BigInt(fuel.received), claimSecret: Fr.fromString(fuel.secret), messageLeafIndex: BigInt(fuel.leafIndex) }
	return { kind: "fjwc", fee: { paymentMethod: publicFeeJuicePayment(recipientAddr, claim) } }
}

/** Fueled records pick their payment from record-specific evidence only. */
export async function resolvePublicClaimFee(
	env: FeeLadderEnv,
	rec: FeeLadderRecord,
	recipientAddr: AztecAddress,
	aztec: unknown,
	userOverride: boolean,
	registers: boolean,
): Promise<PublicClaimFee> {
	const fuel = rec.fuel
	if (!(fuel?.received && fuel.leafIndex)) return ownGasFee(env, rec, recipientAddr, aztec, registers)
	if (fuel.claimTxHash !== undefined && !isWellFormedTxHash(fuel.claimTxHash)) return { kind: "stop", stop: "malformed-claim-hash" }
	const receiptStatus = fuel.claimTxHash ? await fuelReceiptStatus(env, fuel.claimTxHash) : undefined
	// Promote a prior attempt to INCLUSION-GRADE durable evidence: only an `included` receipt sets
	// `consumed`, so a later unreachable node can trust it — a PROPOSED-time latch would wrongly
	// survive a dropped tx.
	if (receiptStatus === "included" && fuel.consumed !== true) {
		patchFuel(env, rec.id, fuel, { consumed: true })
	}
	const decision = decideFuelClaim({
		attempt: fuel.claimAttempt === true,
		txHashKnown: typeof fuel.claimTxHash === "string",
		receiptStatus,
		consumed: fuel.consumed === true || receiptStatus === "included",
		fuelReceived: BigInt(fuel.received),
		// The calibrated floor is the fee reference; a live min-fee query is a refinement, not a
		// correctness need — the floor is twice a real observed fee.
		currentMinFee: env.fuel ? BigInt(env.fuel.minFuelFj) / FUEL_FEE_MARGIN : undefined,
		persistentFailureCount: 0,
		userOverride,
	})
	env.log("fuel claim decision", { id: rec.id, action: decision.action })
	if (decision.action === "fjwc") return fjwcFee(recipientAddr, { ...fuel, received: fuel.received, leafIndex: fuel.leafIndex })
	if (decision.action === "own-gas-plus-standalone-fj") return ownGasWithStandalone(env, rec, recipientAddr, aztec, registers, fuel)
	// The wait stop refuses a send in shorter terms than a simulate.
	if (decision.action === "wait") return { kind: "stop", stop: "fuel-attempt-pending", sendStop: "fuel-attempt-pending-send" }
	// "own-gas" (user override, or a consumed prior attempt): gas the account already holds.
	return ownGasFee(env, rec, recipientAddr, aztec, registers)
}

// ── the hub claim ────────────────────────────────────────────────────────────

/** The record writes a chosen fee owes, run around the wallet call the caller makes. The latches are
 *  store-FIRST by contract: an attempt is recorded before the wallet is asked. */
export interface HubClaimLatches {
	onAttempt?: () => void
	onTxHash?: (txHash: string) => void
	/** A setup-insufficiency throw means the tx was INVALID and the Fee Juice is unconsumed — the
	 *  one signal that authorises a retry of a private claim. */
	onFailure?: (e: unknown) => void
	/** The fuel rides on the token's registration rather than on the claim: the attempt and its hash
	 *  latch against THAT transaction, and `onRegistered` records the registration's hash as the
	 *  fuel's in one write. A registration someone else won leaves the fuel on the claim after all. */
	fuelOnRegister?: boolean
	onRegistered?: (registerTxHash: string) => void
	/** Present when the ladder left the bridged Fee Juice for a claim of its own: the caller fires
	 *  that best-effort self-paid claim after the hub claim is away. */
	standalone?: DepositFuelBlock
}

export type HubClaimFee = ({ kind: "stop"; stop: FeeStop; sendStop?: FeeStop } | { kind: "opts"; opts: SendOpts }) &
	Partial<HubClaimLatches>

const fjwcLatches = (env: FeeLadderEnv, id: string, fuel?: DepositFuelBlock): HubClaimLatches =>
	fuel
		? {
				onAttempt: () => patchFuel(env, id, fuel, { claimAttempt: true, claimAttemptAt: Date.now() }),
				// PROPOSED is NOT inclusion: latch the attempt and hash only; `consumed` is set later,
				// inclusion-grade, from the receipt probe.
				onTxHash: (txHash: string) => patchFuel(env, id, fuel, { claimAttempt: true, claimTxHash: txHash }),
			}
		: {}

const privateLatches = (env: FeeLadderEnv, id: string, fuel: DepositFuelBlock, fuelOnRegister: boolean): HubClaimLatches => {
	const latchHash = (txHash: string, topLevel: RecordPatch = {}) =>
		patchFuel(
			env,
			id,
			fuel,
			{ claimAttempt: true, claimAttemptAt: Date.now(), claimTxHash: txHash, setupInsufficiency: false },
			topLevel,
		)
	return {
		fuelOnRegister,
		onAttempt: () => patchFuel(env, id, fuel, { claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: false }),
		onTxHash: (txHash: string) => latchHash(txHash),
		...(fuelOnRegister ? { onRegistered: (txHash: string) => latchHash(txHash, { registerTxHash: txHash }) } : {}),
		onFailure: (e: unknown) => {
			// The FPC's insufficiency assert and a message the wallet cannot consume yet both refuse
			// the transaction before it exists, and a dropped transaction was never included: the
			// fuel is provably unspent and a retry is safe. Any OTHER throw leaves setupInsufficiency
			// unset ⇒ the next decision WAITS (fail-closed).
			const msg = e instanceof Error ? e.message : String(e)
			if (isPrivateFuelInsufficiency(msg) || isMsgNotReady(msg) || /\bdropped\b/i.test(msg)) {
				patchFuel(env, id, fuel, { claimAttempt: true, claimAttemptAt: Date.now(), setupInsufficiency: true })
			}
		},
	}
}

function publicHubFee(env: FeeLadderEnv, rec: FeeLadderRecord, base: SendOpts, resolved: PublicClaimFee): HubClaimFee {
	if (resolved.kind === "stop") return { kind: "stop", stop: resolved.stop, sendStop: resolved.sendStop }
	if (resolved.kind === "fjwc") return { kind: "opts", opts: { ...base, fee: resolved.fee }, ...fjwcLatches(env, rec.id, rec.fuel) }
	const { fee, registerFee, registeredClaimFee, standalone } = resolved
	const seams = registerFee ? { registerFee, registeredClaimFee } : {}
	return { kind: "opts", opts: { ...base, fee, ...seams }, ...(standalone ? { standalone } : {}) }
}

export interface HubClaimContext {
	rec: FeeLadderRecord
	recipientAddr: AztecAddress
	aztec: unknown
	/** The user chose to claim without the bridged Fee Juice. */
	userOverride: boolean
	/** The gas salt from this record's sealed envelope, when the claim opened one. */
	sealedSalt?: string
	/** This claim registers the token first (the hub does not know it yet). */
	registers?: boolean
}

/** The send options a hub claim carries, resolved without building the claim's interaction. */
export async function resolveHubClaimSendOpts(env: FeeLadderEnv, ctx: HubClaimContext): Promise<HubClaimFee> {
	const { rec, recipientAddr, aztec, userOverride } = ctx
	const base: SendOpts = { from: recipientAddr, wait: { waitForStatus: TxStatus.PROPOSED } }
	const priv = await resolvePrivateFuelFee(env, rec, recipientAddr, ctx.sealedSalt, { registers: ctx.registers === true, aztec })
	if (priv.kind === "stop") return { kind: "stop", stop: priv.stop }
	if (priv.kind === "credit") {
		// Spent fuel pays from the credit it left; a still-unregistered token registers from it too.
		const seams = priv.registers ? { registerFee: priv.registerFee, registeredClaimFee: priv.registeredClaimFee } : {}
		return { kind: "opts", opts: { ...base, fee: priv.fee, ...seams } }
	}
	if (priv.kind === "fee") {
		// The fuel fee consumes the bridged Fee Juice message, which only one transaction can do: on
		// a first-time token the registration goes first and spends it, and the claim that follows
		// draws on the credit the FPC kept; on a registered token the claim spends it directly.
		const seams = priv.registers ? { registerFee: priv.fee, registeredClaimFee: priv.registeredClaimFee } : {}
		return { kind: "opts", opts: { ...base, fee: priv.fee, ...seams }, ...privateLatches(env, rec.id, priv.fuel, priv.registers) }
	}
	return publicHubFee(env, rec, base, await resolvePublicClaimFee(env, rec, recipientAddr, aztec, userOverride, ctx.registers === true))
}
