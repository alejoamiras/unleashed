/**
 * The journal record a deposit files before anything is signed, from the plan the review showed: the
 * token block, the claim amount net of the gas slice, the fuel block and the key domain its private
 * envelope is sealed under. Shared by the Ethereum-origin send and the cross-chain one, whose record
 * extends this shape.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { type JournalTokenBlock, PRIVATE_FPC_ADDRESS, type SendDepositRecord, feeJuiceAddress } from "@unleashed/bridge-core"
import { FUEL_PORTAL, HUB } from "@/contracts/bridge-generation"
import { NETWORK } from "@/lib/network"
import type { GasLegPlan, SendPlan } from "@/lib/send-model"

/** The token block the wizard PREDICTS. The receipt's read-back replaces it. */
/** The token block a send files, from the plan: the wizard also renders it before the record exists. */
export function previewBlock(plan: SendPlan): JournalTokenBlock {
	return {
		erc20: plan.token.address.toLowerCase(),
		portal: plan.token.portal.toLowerCase(),
		l2Token: plan.token.l2Token,
		nameWord: plan.token.words.nameWord,
		symbolWord: plan.token.words.symbolWord,
		decimals: plan.token.decimals,
		displaySymbol: plan.token.symbol,
		registerKey: plan.token.registration?.registerKey,
		registerIndex: plan.token.registration?.registerIndex.toString(),
	}
}

/** The token leg's claim amount: the total minus whatever the gas slice took. */
export const tokenClaimAmount = (plan: SendPlan): bigint =>
	plan.intent === "gas" ? plan.amount : plan.amount - (plan.gas?.fuelAmount ?? 0n)

export function fuelBlockOf(gas: GasLegPlan, secretHex: string, secretHashHex: string, salt?: Fr) {
	return {
		amount: gas.fuelAmount.toString(),
		secret: secretHex,
		secretHashHex,
		minOutput: gas.minFuelOutput.toString(),
		...(salt ? { bridgeSecretSalt: salt.toString(), fpc: PRIVATE_FPC_ADDRESS } : {}),
	}
}

export interface RecordInputs {
	id: string
	plan: SendPlan
	recipient: string
	/** The L1 account signing this send. Required so neither build site (open, rekey) can drop it. */
	sender: string
	claimValueHex?: string
	fuelSecretHex?: string
	fuelSecretHashHex?: string
	fuelSalt?: Fr
}

export function buildSendRecord(i: RecordInputs): SendDepositRecord {
	const { id, plan, recipient } = i
	const now = Date.now()
	const gasOnly = plan.intent === "gas"
	const base = {
		schema: 3 as const,
		id,
		direction: "deposit" as const,
		isPrivate: plan.isPrivate,
		amount: tokenClaimAmount(plan).toString(),
		createdAt: now,
		updatedAt: now,
		chainId: NETWORK.l1ChainId,
		portal: gasOnly ? FUEL_PORTAL.toLowerCase() : plan.token.portal.toLowerCase(),
		bridge: gasOnly ? feeJuiceAddress.toString() : (HUB as AztecAddress).toString(),
		recipient,
		sender: i.sender,
		secretHashHex: id,
		// PRIVATE keeps its claim material sealed; the plaintext copy exists only for a public TOKEN
		// leg, whose message binds the recipient on L1 anyway. A gas-only send has no token leg: its
		// one secret lives in the fuel block, which is what the claim reads — never copied up here,
		// where the two could drift.
		secret: plan.isPrivate ? undefined : i.claimValueHex,
		...(plan.gas && i.fuelSecretHex && i.fuelSecretHashHex
			? { fuel: fuelBlockOf(plan.gas, i.fuelSecretHex, i.fuelSecretHashHex, i.fuelSalt) }
			: {}),
		// The rail shows REGISTER ahead of time only because the record says so; the hub decides at
		// claim time regardless.
		...(!gasOnly && plan.token.state.kind !== "registered" ? { registers: true as const } : {}),
	}
	return (gasOnly ? { ...base, intent: "gas" } : { ...base, intent: plan.intent, token: previewBlock(plan) }) as SendDepositRecord
}

/** The key domain a private record's envelope is sealed under: the SAME binding the record carries,
 *  because that is what the unseal re-derives the key from. A gas-only send is bound to the Fee
 *  Juice portal, everything else to ITS token's clone and the hub. */
export const sealBindingOf = (plan: SendPlan) => ({
	chainId: NETWORK.l1ChainId,
	portal: plan.intent === "gas" ? FUEL_PORTAL : plan.token.portal,
	bridge: plan.intent === "gas" ? feeJuiceAddress.toString() : (HUB as AztecAddress).toString(),
})
