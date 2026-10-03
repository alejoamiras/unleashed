/**
 * The L1 leg of a send through the router, for every intent: a token (with or without a gas slice)
 * into its factory clone, or gas only. The portal is never taken from a caller — it is the factory's
 * CREATE2 for the token, exactly what the router will re-derive and refuse to deviate from — and the
 * first send of a token creates the clone inside the same transaction.
 *
 * After the receipt the factory's frozen registration is read back: the words and decimals it
 * committed are what the hub derives the L2 token from, so they, not the app's pre-send preview,
 * become the journal's token block.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Abi, type Address, type Hex, parseEventLogs } from "viem"
import { deriveTokenClaimSecret } from "./claim-secret"
import { PORTAL_FACTORY_ABI } from "./factory-abi"
import { type Registration, readRegistration } from "./factory-registry"
import { deriveHubTokenInstance } from "./hub-token"
import type { L1Ctx } from "./flows"
import type { JournalTokenBlock } from "./journal"
import { type BridgeWitness, bridgeWitnessPermitTypedData, hashRoute, type PoolKey } from "./l1"
import { predictPortal } from "./portal-address"
import { fromWord } from "./register-hash"

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address

export type SendStage = "signing" | "sending" | "confirming" | "done"

export interface SendGeneration {
	router: Address
	routerAbi: Abi
	permit2: Address
	factory: Address
	implementation: Address
	feeJuicePortal: Address
	/** The FeeJuice ERC-20 — the token whose gas slice needs no swap. */
	feeAsset: Address
	/** The router's current swap target (witness-bound; a rotation voids the signature). */
	swapTarget: Address
	chainId: number
	/** The L2 hub + the Token class it instantiates — what the L2 token address derives from. */
	hub: string
	tokenClassId: string
}

export interface SendGasLeg {
	fuelAmount: bigint
	fuelRecipient: Hex
	/** The signed floor: `max(quote × (1 − s), minFuelFj)`. */
	minFuelOutput: bigint
	/** Empty for the fee asset (identity swap). */
	path: PoolKey[]
	zeroForOnes: boolean[]
	/** Private gas only — `deriveBridgeSecret(salt, claimer)`; the FPC claimer rebuilds it. */
	fuelSecret?: Fr
}

export interface SendParams {
	intent: "token" | "token+gas" | "gas"
	erc20: Address
	/** The total pulled by Permit2 (token + gas slice). */
	amount: bigint
	aztecRecipient: Hex
	isPrivate: boolean
	/** Private token leg only — the recipient-committed `claim_salt`. */
	claimSalt?: Fr
	gas?: SendGasLeg
	nonce: bigint
	deadline: bigint
}

export interface SendResult {
	/** PRIVATE: the claim_salt; PUBLIC: the raw secret. Absent for gas-only. */
	tokenClaimValueHex?: string
	tokenSecretHashHex?: string
	tokenLeafIndex?: bigint
	tokenMessageHashHex?: Hex
	fuelSecretHex?: string
	fuelSecretHashHex?: string
	fuelLeafIndex?: bigint
	fuelMessageHashHex?: Hex
	fuelReceived?: bigint
	txHash: Hex
	/** The factory's record after the receipt — the journal's token block. Absent for gas-only. */
	token?: JournalTokenBlock
}

export interface SendRecoveryHooks {
	/** The secret hashes travel with the values: they are what the L1 witness commits to, so a
	 *  caller keying its recovery record by them can write that record BEFORE the signature. */
	onSecrets?: (r: {
		tokenClaimValueHex?: string
		tokenSecretHashHex?: Hex
		fuelSecretHex?: string
		fuelSecretHashHex?: Hex
		isPrivate: boolean
	}) => void
	onSent?: (txHash: Hex) => void
	onConfirmed?: (r: SendResult) => void
}

/** The portal the router will accept for this intent. Gas-only has none; the fee asset's gas-only goes straight to the FeeJuicePortal. */
export function sendPortalFor(g: SendGeneration, p: Pick<SendParams, "intent" | "erc20" | "isPrivate">): Address {
	if (p.intent === "gas") {
		return p.erc20.toLowerCase() === g.feeAsset.toLowerCase() && !p.isPrivate ? g.feeJuicePortal : ZERO_ADDRESS
	}
	return predictPortal(g.factory, g.implementation, p.erc20) as Address
}

/** Which router entrypoint an intent takes. The fee asset's public gas-only is a plain `bridge()` into the FeeJuicePortal. */
export function sendEntrypoint(g: SendGeneration, p: Pick<SendParams, "intent" | "erc20" | "isPrivate">): "bridge" | "bridgeWithFuel" {
	if (p.intent === "token") return "bridge"
	if (p.intent === "gas" && p.erc20.toLowerCase() === g.feeAsset.toLowerCase() && !p.isPrivate) return "bridge"
	return "bridgeWithFuel"
}

async function registrationToBlock(g: SendGeneration, erc20: Address, r: Registration): Promise<JournalTokenBlock> {
	const words = { nameWord: r.nameWord, symbolWord: r.symbolWord, decimals: r.decimals }
	const inst = await deriveHubTokenInstance(AztecAddress.fromStringUnsafe(g.hub), erc20, words, g.tokenClassId)
	return {
		erc20: erc20.toLowerCase(),
		portal: r.portal.toLowerCase(),
		l2Token: inst.address.toString(),
		nameWord: r.nameWord,
		symbolWord: r.symbolWord,
		decimals: r.decimals,
		displaySymbol: fromWord(r.symbolWord),
		registerKey: r.registerKey,
		registerIndex: r.registerIndex.toString(),
	}
}

async function tokenSecrets(p: SendParams): Promise<{ claimValue: Fr; secretHash: Hex } | undefined> {
	if (p.intent === "gas") return undefined
	if (p.isPrivate && !p.claimSalt) {
		throw new Error("runSend: a private token leg requires claimSalt (recipient-committed) — a random secret strands the deposit")
	}
	if (!(await AztecAddress.fromStringUnsafe(p.aztecRecipient).isValid())) {
		throw new Error("runSend: aztecRecipient is not a valid Aztec address — refusing to deposit")
	}
	const claimValue = p.isPrivate ? (p.claimSalt as Fr) : Fr.random()
	const secret = p.isPrivate ? deriveTokenClaimSecret(p.claimSalt as Fr, AztecAddress.fromStringUnsafe(p.aztecRecipient)) : claimValue
	return { claimValue, secretHash: (await computeSecretHash(secret)).toString() as Hex }
}

async function fuelSecrets(p: SendParams): Promise<{ secret: Fr; secretHash: Hex } | undefined> {
	if (!p.gas) return undefined
	if (p.isPrivate && !p.gas.fuelSecret) {
		throw new Error("runSend: private gas requires an injected fuelSecret — a random secret strands the Fee Juice")
	}
	const secret = p.gas.fuelSecret ?? Fr.random()
	return { secret, secretHash: (await computeSecretHash(secret)).toString() as Hex }
}

/** A private recipient is committed through the secret hash and never published — the router's
 *  indexed event would leak it. Direct gas has no token leg, so the gas recipient is the only one. */
function witnessRecipient(p: SendParams, direct: boolean, tok?: { secretHash: Hex }): Hex {
	if (direct) return p.gas?.fuelRecipient ?? ZERO_BYTES32
	return p.isPrivate || !tok ? ZERO_BYTES32 : p.aztecRecipient
}

function buildWitness(
	g: SendGeneration,
	p: SendParams,
	portal: Address,
	entry: "bridge" | "bridgeWithFuel",
	tok?: { secretHash: Hex },
	fuel?: { secretHash: Hex },
): BridgeWitness {
	// The fee asset's public gas-only rides the plain `bridge()` entrypoint, which knows no fuel leg
	// at all: the router hashes every fuel field as zero and takes the gas recipient and secret as the
	// TOKEN ones. A witness built the other way is rejected by Permit2, and a deposit that somehow
	// landed would mint Fee Juice to L2 address zero behind an unopenable secret.
	const direct = entry === "bridge" && p.intent === "gas"
	const gasLeg = direct ? undefined : p.gas
	return {
		tokenPortal: portal,
		bridgeToken: p.erc20,
		totalAmount: p.amount,
		fuelAmount: gasLeg?.fuelAmount ?? 0n,
		aztecRecipient: witnessRecipient(p, direct, tok),
		fuelRecipient: gasLeg?.fuelRecipient ?? ZERO_BYTES32,
		tokenSecretHash: (direct ? fuel : tok)?.secretHash ?? ZERO_BYTES32,
		fuelSecretHash: direct ? ZERO_BYTES32 : (fuel?.secretHash ?? ZERO_BYTES32),
		minFuelOutput: gasLeg?.minFuelOutput ?? 0n,
		routeHash: gasLeg ? hashRoute(gasLeg.path, gasLeg.zeroForOnes) : ZERO_BYTES32,
		isPrivate: p.isPrivate,
		swapTarget: g.swapTarget,
	}
}

/** An Aztec address is a Grumpkin x-coordinate; a word that is not one can never be decrypted to. */
async function assertAztecRecipient(label: string, hex: string): Promise<void> {
	if (hex.toLowerCase() === ZERO_BYTES32) throw new Error(`runSend: the ${label} recipient is the zero address`)
	let valid = false
	try {
		valid = await AztecAddress.fromStringUnsafe(hex).isValid()
	} catch {
		valid = false
	}
	if (!valid) throw new Error(`runSend: the ${label} recipient is not a valid Aztec address`)
}

/** Every recipient an intent mints to must exist: an unusable recipient is an irreversible deposit to nobody. */
async function assertRecipients(p: SendParams): Promise<void> {
	if (p.amount <= 0n) throw new Error("runSend: amount must be positive")
	if (p.intent !== "gas") await assertAztecRecipient("token", p.aztecRecipient)
	if (p.gas) await assertAztecRecipient("gas", p.gas.fuelRecipient)
	if (p.gas && p.gas.minFuelOutput <= 0n) throw new Error("runSend: a gas leg needs a positive minFuelOutput")
	if (p.gas && p.gas.path.length !== p.gas.zeroForOnes.length) throw new Error("runSend: route path and zeroForOnes differ in length")
}

async function assertIntent(g: SendGeneration, p: SendParams): Promise<void> {
	await assertRecipients(p)
	if (p.intent === "token" && p.gas) throw new Error("runSend: a token-only send carries no gas leg")
	if (p.intent !== "token" && !p.gas) throw new Error(`runSend: intent ${p.intent} requires a gas leg`)
	if (p.intent === "gas" && p.gas && p.gas.fuelAmount !== p.amount) throw new Error("runSend: gas-only means fuelAmount == amount")
	if (p.intent === "token+gas" && p.gas && (p.gas.fuelAmount <= 0n || p.gas.fuelAmount >= p.amount)) {
		throw new Error("runSend: token+gas needs 0 < fuelAmount < amount")
	}
	const identity = p.gas !== undefined && p.gas.path.length === 0
	if (identity && p.erc20.toLowerCase() !== g.feeAsset.toLowerCase())
		throw new Error("runSend: an empty route is only the fee asset's identity swap")
}

/** Executes the L1 leg; the L2 claim runs separately against the returned facts. */
export async function runSend(
	l1: L1Ctx,
	g: SendGeneration,
	p: SendParams,
	onStage?: (s: SendStage) => void,
	recovery?: SendRecoveryHooks,
): Promise<SendResult> {
	await assertIntent(g, p)
	const portal = sendPortalFor(g, p)
	const entry = sendEntrypoint(g, p)
	const tok = await tokenSecrets(p)
	const fuel = await fuelSecrets(p)
	recovery?.onSecrets?.({
		tokenClaimValueHex: tok?.claimValue.toString(),
		tokenSecretHashHex: tok?.secretHash,
		fuelSecretHex: fuel?.secret.toString(),
		fuelSecretHashHex: fuel?.secretHash,
		isPrivate: p.isPrivate,
	})

	const witness = buildWitness(g, p, portal, entry, tok, fuel)
	const typedData = bridgeWitnessPermitTypedData(
		{ permitted: { token: p.erc20, amount: p.amount }, spender: g.router, nonce: p.nonce, deadline: p.deadline },
		witness,
		g.permit2,
		g.chainId,
	)
	onStage?.("signing")
	const signature = await l1.wallet.signTypedData({ account: l1.account, ...typedData } as never)
	const permit = { nonce: p.nonce, deadline: p.deadline, signature }

	onStage?.("sending")
	const args =
		entry === "bridge"
			? [
					{
						tokenPortal: portal,
						bridgeToken: p.erc20,
						amount: p.amount,
						aztecRecipient: witness.aztecRecipient,
						secretHash: witness.tokenSecretHash,
						isPrivate: p.isPrivate,
					},
					permit,
				]
			: [
					{
						tokenPortal: portal,
						bridgeToken: p.erc20,
						totalAmount: p.amount,
						fuelAmount: witness.fuelAmount,
						aztecRecipient: witness.aztecRecipient,
						fuelRecipient: witness.fuelRecipient,
						tokenSecretHash: witness.tokenSecretHash,
						fuelSecretHash: witness.fuelSecretHash,
						minFuelOutput: witness.minFuelOutput,
						path: p.gas?.path ?? [],
						zeroForOnes: p.gas?.zeroForOnes ?? [],
						isPrivate: p.isPrivate,
					},
					permit,
				]
	const txHash = await l1.wallet.writeContract({
		address: g.router,
		abi: g.routerAbi,
		functionName: entry,
		args,
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	recovery?.onSent?.(txHash)

	onStage?.("confirming")
	const receipt = await l1.pub.waitForTransactionReceipt({ hash: txHash })
	if (receipt.status !== "success") throw new Error(`${entry}() REVERTED (${txHash}) — no funds moved; inspect the tx and retry`)
	const result = await readSendResult(l1, g, p, entry, txHash, receipt.logs, tok, fuel)
	recovery?.onConfirmed?.(result)
	onStage?.("done")
	return result
}

type Logs = Parameters<typeof parseEventLogs>[0]["logs"]

/**
 * The router's one event of the given name. Only logs the ROUTER emitted count: the token being
 * bridged runs arbitrary code inside the Permit2 pull, before the router emits, and a hostile one
 * can emit a same-signature event carrying a leaf index nothing will ever prove.
 */
function routerEvent<T>(g: SendGeneration, eventName: "Bridge" | "BridgeWithFuel", txHash: Hex, logs: Logs): T {
	const own = logs.filter((l) => l.address.toLowerCase() === g.router.toLowerCase())
	const events = parseEventLogs({ abi: g.routerAbi, eventName, logs: own })
	if (events.length !== 1) throw new Error(`the router emitted ${events.length} ${eventName} events in ${txHash}, expected exactly one`)
	return events[0] as T
}

/** The event carried no amount and no signed amount stood behind it, so nothing says what landed. */
export class MissingBridgeAmountError extends Error {
	constructor(txHash: Hex) {
		super(`Bridge event in ${txHash} decoded without an amount — refusing to record a gas leg of unknown size`)
		this.name = "MissingBridgeAmountError"
	}
}

/** What `readLeaves` needs of a send. A receipt-only recovery has the intent but no signed amount. */
type LeafParams = Pick<SendParams, "intent"> & { amount?: bigint }

/** The leaf indices + message keys the L2 claims consume, read from the router's event — never guessed from order. */
function readLeaves(g: SendGeneration, p: LeafParams, entry: "bridge" | "bridgeWithFuel", txHash: Hex, logs: Logs): Partial<SendResult> {
	if (entry === "bridge") {
		const ev = routerEvent<{ args?: { index?: bigint; key?: Hex; amount?: bigint } }>(g, "Bridge", txHash, logs)
		if (ev.args?.index === undefined || ev.args.key === undefined)
			throw new Error(`Bridge event in ${txHash} decoded without index/key`)
		if (p.intent !== "gas") return { tokenLeafIndex: ev.args.index, tokenMessageHashHex: ev.args.key }
		// The fee asset sent straight into the FeeJuicePortal IS the gas leg; the event's amount is
		// what landed, which a recovery reading the receipt alone still has.
		const received = ev.args.amount ?? p.amount
		if (received === undefined) throw new MissingBridgeAmountError(txHash)
		return { fuelLeafIndex: ev.args.index, fuelMessageHashHex: ev.args.key, fuelReceived: received }
	}
	const ev = routerEvent<{ args?: { tokenKey?: Hex; tokenIndex?: bigint; fuelKey?: Hex; fuelIndex?: bigint; fuelAmount?: bigint } }>(
		g,
		"BridgeWithFuel",
		txHash,
		logs,
	)
	if (ev.args?.fuelIndex === undefined || ev.args.fuelKey === undefined)
		throw new Error(`BridgeWithFuel event in ${txHash} decoded without fuelIndex/fuelKey`)
	const fuelLeg = { fuelLeafIndex: ev.args.fuelIndex, fuelMessageHashHex: ev.args.fuelKey, fuelReceived: ev.args.fuelAmount ?? 0n }
	return p.intent === "gas" ? fuelLeg : { ...fuelLeg, tokenLeafIndex: ev.args.tokenIndex, tokenMessageHashHex: ev.args.tokenKey }
}

/**
 * The leaves a landed send produced, from its receipt alone — what a journal recovers after a
 * crash between the signature and the confirmation. A first-time deposit's receipt also carries the
 * factory's register leaf, so the Inbox events are never read directly: only the router's own
 * event names the deposit's leaf.
 */
export function readSendReceiptLeaves(g: SendGeneration, intent: SendParams["intent"], txHash: Hex, logs: Logs): Partial<SendResult> {
	const own = logs.filter((l) => l.address.toLowerCase() === g.router.toLowerCase())
	const fueled = parseEventLogs({ abi: g.routerAbi, eventName: "BridgeWithFuel", logs: own }).length > 0
	// The receipt is the whole input here: there is no signed amount to fall back on, so an event
	// that decodes without one fails rather than recording a gas-only recovery as having received 0.
	return readLeaves(g, { intent }, fueled ? "bridgeWithFuel" : "bridge", txHash, logs)
}

async function readSendResult(
	l1: L1Ctx,
	g: SendGeneration,
	p: SendParams,
	entry: "bridge" | "bridgeWithFuel",
	txHash: Hex,
	logs: Logs,
	tok?: { claimValue: Fr; secretHash: Hex },
	fuel?: { secret: Fr; secretHash: Hex },
): Promise<SendResult> {
	const out: SendResult = { txHash, ...readLeaves(g, p, entry, txHash, logs) }
	if (tok) {
		out.tokenClaimValueHex = tok.claimValue.toString()
		out.tokenSecretHashHex = tok.secretHash
	}
	if (fuel) {
		out.fuelSecretHex = fuel.secret.toString()
		out.fuelSecretHashHex = fuel.secretHash
	}
	if (p.intent !== "gas") {
		const reg = await readRegistration(l1.pub as never, g.factory, p.erc20)
		if (!reg)
			throw new Error(`the factory has no registration for ${p.erc20} after ${txHash} — the router should have created the clone`)
		out.token = await registrationToBlock(g, p.erc20, reg)
	}
	return out
}

export { PORTAL_FACTORY_ABI }
