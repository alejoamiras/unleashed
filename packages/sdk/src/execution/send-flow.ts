/**
 * The L1 leg of an Ethereum-origin send through the deposit router's `bridgeWithPermit`, for every
 * intent: a token (with or without a gas slice) into its factory clone, or gas only. The portal is
 * never taken from a caller: the router derives the token's clone itself, and the first send of a
 * token creates it inside the same transaction.
 *
 * After the receipt the factory's frozen registration is read back: the words and decimals it
 * committed are what the hub derives the L2 token from, so they, not the app's pre-send preview,
 * become the journal's token block.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { FEE_JUICE_ADDRESS } from "@aztec-labs/constants"
import { FeeJuicePortalAbi } from "@aztec-foundation/l1-artifacts"
import { type Abi, type Address, type Chain, type Hex, pad, toHex, zeroHash } from "viem"
import { assertSupportedLine } from "../protocol/aztec-line.ts"
import { deriveTokenClaimSecret } from "../protocol/claim-secret.ts"
import {
	type DepositedFacts,
	type DepositExpectation,
	type DepositLogContext,
	type InboxContext,
	readRouterDeposit,
} from "./router-receipt.ts"
import { DEPOSIT_ROUTER_ABI, type RouterIntent } from "../protocol/deposit-router-abi.ts"
import { PORTAL_FACTORY_ABI } from "../protocol/factory-abi.ts"
import { type Registration, readRegistration } from "./factory-registry.ts"
import type { L1Ctx } from "./flows.ts"
import { deriveHubTokenInstance } from "../protocol/hub-token.ts"
import type { JournalTokenBlock } from "../records.ts"
import { depositWitness, depositWitnessPermitTypedData } from "../protocol/l1.ts"
import { predictPortal } from "../protocol/portal-address.ts"
import { fromWord } from "../protocol/register-hash.ts"

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex
/** An Inbox message's gas depends on the bucket state it lands in (the first message of an L1 block
 *  opens a new bucket), which an earlier estimate cannot see; bare estimates have run out of gas. */
const L1_GAS_HEADROOM_PERCENT = 125n

/** An L1 gas limit for a transaction that sends an Inbox message. */
export function sendGasLimit(estimate: bigint): bigint {
	return (estimate * L1_GAS_HEADROOM_PERCENT + 99n) / 100n
}

export type SendStage = "signing" | "sending" | "confirming" | "done"

/** What a gas-only send binds to: a bridge's router, or a fuel-only route's router behind its gate. */
export interface FuelRoute {
	/** The deposit router: Permit2's spender and the emitter of `Deposited`. */
	router: Address
	permit2: Address
	feeJuicePortal: Address
	/** The FeeJuice ERC-20 — the token whose gas slice needs no swap. */
	feeAsset: Address
	chainId: number
}

/** A bridge's router, which can also send token legs into the factory's clones. */
export interface SendGeneration extends FuelRoute {
	factory: Address
	implementation: Address
	/** The L2 hub + the Token class it instantiates — what the L2 token address derives from. */
	hub: string
	tokenClassId: string
}

function tokenRouteOf(g: FuelRoute): SendGeneration {
	if (!("factory" in g)) throw new Error("runSend: this route has no token portals; it sends gas only")
	return g as SendGeneration
}

export interface SendGasLeg {
	/** The slice of `amount` that buys Fee Juice; all of it for gas only. */
	fuelAmount: bigint
	fuelRecipient: Hex
	/** The signed floor, which `swapData` carries as its `_minAmountOut`. */
	minFuelOutput: bigint
	/** A fuel quote's call bytes for the slice; `0x` for the fee asset, which needs no swap. */
	swapData: Hex
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

type ReadContract = Pick<L1Ctx["pub"], "readContract">

/**
 * The Inbox a send's leaves are recomputed against, in the installed Aztec line's `MessageSent` shape: the one a
 * bridge's factory froze at construction, or, on a fuel-only route, the one the FeeJuicePortal sends through. The
 * FeeJuicePortal's messages are recorded under the protocol's Fee Juice address, which these lines seed at genesis.
 */
export async function readSendInbox(pub: ReadContract, g: FuelRoute): Promise<InboxContext> {
	assertSupportedLine(g.chainId)
	const read = (address: Address, abi: Abi, functionName: string) =>
		pub.readContract({ address, abi, functionName, args: [] } as never) as Promise<unknown>
	const [address, rollupVersion] = await Promise.all(
		"factory" in g
			? [
					read(tokenRouteOf(g).factory, PORTAL_FACTORY_ABI, "INBOX"),
					read(tokenRouteOf(g).factory, PORTAL_FACTORY_ABI, "ROLLUP_VERSION"),
				]
			: [read(g.feeJuicePortal, FeeJuicePortalAbi, "INBOX"), read(g.feeJuicePortal, FeeJuicePortalAbi, "VERSION")],
	)
	const feeJuice = toHex(FEE_JUICE_ADDRESS)
	return {
		address: address as Address,
		shape: "artifact",
		rollupVersion: rollupVersion as bigint,
		// A fuel-only route carries no token leg, so no message names a hub.
		l2Hub: ("hub" in g ? g.hub : zeroHash) as Hex,
		feeJuice: { l2: pad(feeJuice, { size: 32 }), l1Sender: pad(feeJuice, { size: 20 }) as Address },
	}
}

/** The addresses that authenticate a send's `Deposited`: the router, the FeeJuicePortal and, with a
 *  token leg, the token's derived clone. */
export function sendLogContext(g: FuelRoute, inbox: InboxContext, x: DepositExpectation): DepositLogContext {
	const tokenPortal = x.token && predictPortal(tokenRouteOf(g).factory, tokenRouteOf(g).implementation, x.token.erc20)
	return {
		router: g.router,
		feeJuicePortal: g.feeJuicePortal,
		...(tokenPortal ? { tokenPortal: tokenPortal as Address } : {}),
		inbox,
	}
}

/** The leaves the L2 claims consume, in the result's shape. */
export function sendLeavesOf(facts: DepositedFacts): Partial<SendResult> {
	return {
		...(facts.token ? { tokenLeafIndex: BigInt(facts.token.leafIndex), tokenMessageHashHex: facts.token.messageHash } : {}),
		...(facts.fuel
			? {
					fuelLeafIndex: BigInt(facts.fuel.leafIndex),
					fuelMessageHashHex: facts.fuel.messageHash,
					fuelReceived: BigInt(facts.fuel.received),
				}
			: {}),
	}
}

/**
 * The leaves a landed send produced, from its receipt alone — what a journal recovers after a crash
 * between the signature and the confirmation. Only the router's `Deposited` for `expected` counts,
 * each leg authenticated by its portal's event and a recomputed Inbox leaf; a first-time deposit's
 * register leaf is never mistaken for it. Throws `ScanIncomplete` when the receipt does not carry
 * exactly that deposit.
 */
export async function readSendReceiptLeaves(
	g: FuelRoute,
	inbox: InboxContext,
	expected: DepositExpectation,
	txHash: Hex,
	logs: Parameters<typeof readRouterDeposit>[0],
): Promise<Partial<SendResult>> {
	return sendLeavesOf(await readRouterDeposit(logs, txHash, sendLogContext(g, inbox, expected), expected))
}

/** The token block the factory froze: its words, decimals and register leaf, and the Aztec token the hub derives. */
export async function registrationToBlock(g: SendGeneration, erc20: Address, r: Registration): Promise<JournalTokenBlock> {
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

/**
 * The router's intent for a send. A private recipient is committed through the secret hash and never
 * published (the router's event would leak it), and gas only has no token recipient: its zero token
 * secret is what makes the router take the fuel-only shape.
 */
export function sendIntentOf(p: SendParams, tokenSecretHash?: Hex, fuelSecretHash?: Hex): RouterIntent {
	return {
		token: p.erc20,
		aztecRecipient: p.intent === "gas" || p.isPrivate ? ZERO_BYTES32 : p.aztecRecipient,
		tokenSecretHash: tokenSecretHash ?? ZERO_BYTES32,
		isPrivate: p.isPrivate,
		fuelSlice: p.gas?.fuelAmount ?? 0n,
		fuelRecipient: p.gas?.fuelRecipient ?? ZERO_BYTES32,
		fuelSecretHash: fuelSecretHash ?? ZERO_BYTES32,
		minFuelOutput: p.gas?.minFuelOutput ?? 0n,
	}
}

/** What the send's `Deposited` must carry: each leg paid to the recipient this send named for it. */
function sendExpectation(g: FuelRoute, p: SendParams, tokenSecretHash?: Hex, fuelSecretHash?: Hex): DepositExpectation {
	const gas = p.gas
	return {
		l1ChainId: g.chainId,
		isPrivate: p.isPrivate,
		recipient: p.intent === "gas" && gas ? gas.fuelRecipient : p.aztecRecipient,
		...(tokenSecretHash ? { token: { erc20: p.erc20, secretHash: tokenSecretHash } } : {}),
		...(gas && fuelSecretHash ? { fuel: { secretHash: fuelSecretHash, recipient: gas.fuelRecipient } } : {}),
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
}

/** The shapes the router refuses, refused before anything is signed. */
async function assertIntent(g: FuelRoute, p: SendParams): Promise<void> {
	assertSupportedLine(g.chainId)
	await assertRecipients(p)
	if (p.intent !== "gas") tokenRouteOf(g)
	if (p.intent === "token" && p.gas) throw new Error("runSend: a token-only send carries no gas leg")
	if (p.intent !== "token" && !p.gas) throw new Error(`runSend: intent ${p.intent} requires a gas leg`)
	if (p.intent === "gas" && p.gas && p.gas.fuelAmount !== p.amount) throw new Error("runSend: gas-only means fuelAmount == amount")
	if (p.intent === "token+gas" && p.gas && (p.gas.fuelAmount <= 0n || p.gas.fuelAmount >= p.amount)) {
		throw new Error("runSend: token+gas needs 0 < fuelAmount < amount")
	}
	if (!p.gas) return
	const identity = p.erc20.toLowerCase() === g.feeAsset.toLowerCase()
	if (identity && p.gas.swapData !== "0x") throw new Error("runSend: the fee asset's gas leg needs no swap, so it carries no swapData")
	if (!identity && p.gas.swapData === "0x")
		throw new Error("runSend: a gas leg for any token but the fee asset needs a fuel quote's swapData")
}

/** A send with its secrets drawn and its intent built: everything the witness commits to, before any prompt. */
export interface PreparedSend {
	params: SendParams
	tok?: { claimValue: Fr; secretHash: Hex }
	fuel?: { secret: Fr; secretHash: Hex }
	intent: RouterIntent
	swapData: Hex
	expected: DepositExpectation
}

/** Refuses the shapes the router refuses, then draws the secrets and builds the intent. Nothing is signed. */
export async function prepareSend(g: FuelRoute, p: SendParams): Promise<PreparedSend> {
	await assertIntent(g, p)
	const tok = await tokenSecrets(p)
	const fuel = await fuelSecrets(p)
	return {
		params: p,
		...(tok ? { tok } : {}),
		...(fuel ? { fuel } : {}),
		intent: sendIntentOf(p, tok?.secretHash, fuel?.secretHash),
		swapData: p.gas?.swapData ?? "0x",
		expected: sendExpectation(g, p, tok?.secretHash, fuel?.secretHash),
	}
}

/** The Permit2 witness signature over a prepared send, bound to the route's chain. */
export function signSend(l1: L1Ctx, g: FuelRoute, s: PreparedSend): Promise<Hex> {
	const p = s.params
	const typedData = depositWitnessPermitTypedData(
		{ permitted: { token: p.erc20, amount: p.amount }, spender: g.router, nonce: p.nonce, deadline: p.deadline },
		depositWitness(s.intent, s.swapData),
		g.permit2,
		g.chainId,
	)
	return l1.wallet.signTypedData({ account: l1.account, ...typedData } as never) as Promise<Hex>
}

/** Sends `bridgeWithPermit`. `chain` is the chain viem asserts the wallet is on; the wallet's own when omitted. */
function sendCall(l1: L1Ctx, g: FuelRoute, s: PreparedSend, signature: Hex) {
	const p = s.params
	return {
		address: g.router,
		abi: DEPOSIT_ROUTER_ABI,
		functionName: "bridgeWithPermit",
		args: [s.intent, s.swapData, p.amount, { nonce: p.nonce, deadline: p.deadline, signature }],
		account: l1.account,
	}
}

/** The send's gas, simulated: a throw here means nothing was sent. */
export function estimateSend(l1: L1Ctx, g: FuelRoute, s: PreparedSend, signature: Hex): Promise<bigint> {
	return l1.pub.estimateContractGas(sendCall(l1, g, s, signature) as never)
}

/** Hands the signed send to the wallet under the gas `estimateSend` returned. */
export async function writeSend(l1: L1Ctx, g: FuelRoute, s: PreparedSend, signature: Hex, estimate: bigint, chain?: Chain): Promise<Hex> {
	const call = sendCall(l1, g, s, signature)
	return (await l1.wallet.writeContract({ ...call, chain: chain ?? l1.wallet.chain, gas: sendGasLimit(estimate) } as never)) as Hex
}

export async function submitSend(l1: L1Ctx, g: FuelRoute, s: PreparedSend, signature: Hex, chain?: Chain): Promise<Hex> {
	return writeSend(l1, g, s, signature, await estimateSend(l1, g, s, signature), chain)
}

/** The facts a mined send produced: its leaves from the router's own `Deposited`, and the token's frozen registration. */
export async function confirmSend(
	l1: L1Ctx,
	g: FuelRoute,
	s: PreparedSend,
	txHash: Hex,
	receipt: { status: string; logs: Parameters<typeof readRouterDeposit>[0] },
	inbox?: InboxContext,
): Promise<SendResult> {
	if (receipt.status !== "success") throw new Error(`bridgeWithPermit() REVERTED (${txHash}) — no funds moved; inspect the tx and retry`)
	const leaves = await readSendReceiptLeaves(g, inbox ?? (await readSendInbox(l1.pub, g)), s.expected, txHash, receipt.logs)
	return readSendResult(l1, g, s.params, { txHash, ...leaves }, s.tok, s.fuel)
}

/** Executes the L1 leg; the L2 claim runs separately against the returned facts. */
export async function runSend(
	l1: L1Ctx,
	g: FuelRoute,
	p: SendParams,
	onStage?: (s: SendStage) => void,
	recovery?: SendRecoveryHooks,
): Promise<SendResult> {
	const s = await prepareSend(g, p)
	recovery?.onSecrets?.({
		tokenClaimValueHex: s.tok?.claimValue.toString(),
		tokenSecretHashHex: s.tok?.secretHash,
		fuelSecretHex: s.fuel?.secret.toString(),
		fuelSecretHashHex: s.fuel?.secretHash,
		isPrivate: p.isPrivate,
	})
	onStage?.("signing")
	const signature = await signSend(l1, g, s)
	onStage?.("sending")
	const txHash = await submitSend(l1, g, s, signature)
	recovery?.onSent?.(txHash)
	onStage?.("confirming")
	const result = await confirmSend(l1, g, s, txHash, await l1.pub.waitForTransactionReceipt({ hash: txHash }))
	recovery?.onConfirmed?.(result)
	onStage?.("done")
	return result
}

async function readSendResult(
	l1: L1Ctx,
	g: FuelRoute,
	p: SendParams,
	out: SendResult,
	tok?: { claimValue: Fr; secretHash: Hex },
	fuel?: { secret: Fr; secretHash: Hex },
): Promise<SendResult> {
	if (tok) {
		out.tokenClaimValueHex = tok.claimValue.toString()
		out.tokenSecretHashHex = tok.secretHash
	}
	if (fuel) {
		out.fuelSecretHex = fuel.secret.toString()
		out.fuelSecretHashHex = fuel.secretHash
	}
	if (p.intent !== "gas") {
		const bridge = tokenRouteOf(g)
		const reg = await readRegistration(l1.pub as never, bridge.factory, p.erc20)
		if (!reg)
			throw new Error(`the factory has no registration for ${p.erc20} after ${out.txHash} — the router should have created the clone`)
		out.token = await registrationToBlock(bridge, p.erc20, reg)
	}
	return out
}

export { PORTAL_FACTORY_ABI }
