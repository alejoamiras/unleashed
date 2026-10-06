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
import { type Address, type Hex, pad, toHex } from "viem"
import { deriveTokenClaimSecret } from "./claim-secret"
import {
	type DepositedFacts,
	type DepositExpectation,
	type DepositLogContext,
	type InboxContext,
	readRouterDeposit,
} from "./crosschain-discovery"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi"
import { PORTAL_FACTORY_ABI } from "./factory-abi"
import { type Registration, readRegistration } from "./factory-registry"
import type { L1Ctx } from "./flows"
import { deriveHubTokenInstance } from "./hub-token"
import type { JournalTokenBlock } from "./journal"
import { depositWitness, depositWitnessPermitTypedData } from "./l1"
import type { RouterIntent } from "./lifi-decode"
import { predictPortal } from "./portal-address"
import { fromWord } from "./register-hash"

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex

export type SendStage = "signing" | "sending" | "confirming" | "done"

export interface SendGeneration {
	/** The deposit router: Permit2's spender and the emitter of `Deposited`. */
	router: Address
	permit2: Address
	factory: Address
	implementation: Address
	feeJuicePortal: Address
	/** The FeeJuice ERC-20 — the token whose gas slice needs no swap. */
	feeAsset: Address
	chainId: number
	/** The L2 hub + the Token class it instantiates — what the L2 token address derives from. */
	hub: string
	tokenClassId: string
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
 * The Inbox a send's leaves are recomputed against: the one the factory froze at construction, with
 * its rollup version, in the pinned Aztec line's `MessageSent` shape. The FeeJuicePortal's messages
 * are recorded under the protocol's Fee Juice address, which these lines seed at genesis.
 */
export async function readSendInbox(pub: ReadContract, g: SendGeneration): Promise<InboxContext> {
	const read = (functionName: "INBOX" | "ROLLUP_VERSION") =>
		pub.readContract({ address: g.factory, abi: PORTAL_FACTORY_ABI, functionName, args: [] } as never) as Promise<unknown>
	const [address, rollupVersion] = await Promise.all([read("INBOX"), read("ROLLUP_VERSION")])
	const feeJuice = toHex(FEE_JUICE_ADDRESS)
	return {
		address: address as Address,
		shape: "artifact",
		rollupVersion: rollupVersion as bigint,
		l2Hub: g.hub as Hex,
		feeJuice: { l2: pad(feeJuice, { size: 32 }), l1Sender: pad(feeJuice, { size: 20 }) as Address },
	}
}

/** The addresses that authenticate a send's `Deposited`: the router, the FeeJuicePortal and, with a
 *  token leg, the token's derived clone. */
export function sendLogContext(g: SendGeneration, inbox: InboxContext, x: DepositExpectation): DepositLogContext {
	return {
		router: g.router,
		feeJuicePortal: g.feeJuicePortal,
		...(x.token ? { tokenPortal: predictPortal(g.factory, g.implementation, x.token.erc20) as Address } : {}),
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
	g: SendGeneration,
	inbox: InboxContext,
	expected: DepositExpectation,
	txHash: Hex,
	logs: Parameters<typeof readRouterDeposit>[0],
): Promise<Partial<SendResult>> {
	return sendLeavesOf(await readRouterDeposit(logs, txHash, sendLogContext(g, inbox, expected), expected))
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
function sendExpectation(g: SendGeneration, p: SendParams, tokenSecretHash?: Hex, fuelSecretHash?: Hex): DepositExpectation {
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
async function assertIntent(g: SendGeneration, p: SendParams): Promise<void> {
	await assertRecipients(p)
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

/** Executes the L1 leg; the L2 claim runs separately against the returned facts. */
export async function runSend(
	l1: L1Ctx,
	g: SendGeneration,
	p: SendParams,
	onStage?: (s: SendStage) => void,
	recovery?: SendRecoveryHooks,
): Promise<SendResult> {
	await assertIntent(g, p)
	const tok = await tokenSecrets(p)
	const fuel = await fuelSecrets(p)
	recovery?.onSecrets?.({
		tokenClaimValueHex: tok?.claimValue.toString(),
		tokenSecretHashHex: tok?.secretHash,
		fuelSecretHex: fuel?.secret.toString(),
		fuelSecretHashHex: fuel?.secretHash,
		isPrivate: p.isPrivate,
	})

	const intent = sendIntentOf(p, tok?.secretHash, fuel?.secretHash)
	const swapData = p.gas?.swapData ?? "0x"
	const typedData = depositWitnessPermitTypedData(
		{ permitted: { token: p.erc20, amount: p.amount }, spender: g.router, nonce: p.nonce, deadline: p.deadline },
		depositWitness(intent, swapData),
		g.permit2,
		g.chainId,
	)
	onStage?.("signing")
	const signature = await l1.wallet.signTypedData({ account: l1.account, ...typedData } as never)

	onStage?.("sending")
	const txHash = await l1.wallet.writeContract({
		address: g.router,
		abi: DEPOSIT_ROUTER_ABI,
		functionName: "bridgeWithPermit",
		args: [intent, swapData, p.amount, { nonce: p.nonce, deadline: p.deadline, signature }],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	recovery?.onSent?.(txHash)

	onStage?.("confirming")
	const receipt = await l1.pub.waitForTransactionReceipt({ hash: txHash })
	if (receipt.status !== "success") throw new Error(`bridgeWithPermit() REVERTED (${txHash}) — no funds moved; inspect the tx and retry`)
	const expected = sendExpectation(g, p, tok?.secretHash, fuel?.secretHash)
	const leaves = await readSendReceiptLeaves(g, await readSendInbox(l1.pub, g), expected, txHash, receipt.logs)
	const result = await readSendResult(l1, g, p, { txHash, ...leaves }, tok, fuel)
	recovery?.onConfirmed?.(result)
	onStage?.("done")
	return result
}

async function readSendResult(
	l1: L1Ctx,
	g: SendGeneration,
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
		const reg = await readRegistration(l1.pub as never, g.factory, p.erc20)
		if (!reg)
			throw new Error(`the factory has no registration for ${p.erc20} after ${out.txHash} — the router should have created the clone`)
		out.token = await registrationToBlock(g, p.erc20, reg)
	}
	return out
}

export { PORTAL_FACTORY_ABI }
