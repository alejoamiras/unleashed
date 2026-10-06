/** The bridge round trips as pure functions of a context. Each returns the one-line evidence the
 *  smoke prints; each throws on the first assertion it cannot make. None keeps state between calls. */
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TestERC20Abi } from "@aztec-foundation/l1-artifacts"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { type Address, type Hex, parseAbi, toFunctionSelector } from "viem"
import { PORTAL_FACTORY_ABI, TOKEN_PORTAL_ABI } from "../../src/factory-abi"
import { consumeWithdrawal } from "../../src/flows"
import { exitViaHub, type HubExitParams, hubExitsPaused, hubTokenFor, preflightHubExit, simulateHubExit } from "../../src/hub-l2"
import type { JournalTokenBlock } from "../../src/journal"
import type { ManifestToken } from "../../src/manifest-v2"
import { deriveBridgeSecret, PRIVATE_FPC_ADDRESS, PRIVATE_HUB_CLAIM_GAS } from "../../src/private-fuel"
import type { SendResult } from "../../src/send-flow"
import { waitForL1ToL2Message } from "../generation"
import { ensureRouterPermit2 } from "../script-l1"
import { MIN_FJ, PERMIT2, ZERO_L1 } from "./constants"
import {
	balanceOf,
	claim,
	type ClaimPlan,
	claimOnce,
	depositFresh,
	ensurePrivateFpc,
	exitCeiling,
	type FeeMode,
	fpcClaimFee,
	fuelClaimFee,
	fuelLeg,
	fuelSwapperOf,
	mintPrivateGasNote,
	privateCreditFee,
	privateCreditOf,
	privateExitFee,
	privateFpc,
	registerArgsOf,
	sampleExitGas,
	send,
	settled,
	type SmokeContext,
	tokenBlockOf,
} from "./context"
import { erc20BalanceOf, freshToken, mint, mintFeeAsset, setFuelRate, writeL1 } from "./l1"
import { withBlockHeartbeat } from "./l2"

// ─── Deposits ────────────────────────────────────────────────────────────────

/** Who pays a token-only claim. The sponsor is scaffolding — a deposit another flow only needs to
 *  have happened; `credit` is the payer the cells assert: the PrivateFPC keeps the claim's whole
 *  ceiling from the held private gas, exactly, and the note inventory is told. */
export type ClaimPayer = "sponsor" | "credit"

async function claimPayment(s: SmokeContext, payer: ClaimPayer): Promise<{ plan: Partial<ClaimPlan>; settle: () => Promise<string> }> {
	if (payer === "sponsor") return { plan: {}, settle: async () => "sponsored" }
	const fpc = await privateFpc(s)
	const { fee, ceiling } = await privateCreditFee(s, PRIVATE_HUB_CLAIM_GAS)
	const before = await privateCreditOf(s, fpc)
	const selecting = s.credit.selectedFor(ceiling)
	return {
		plan: { fee, feeMode: "private-fpc" },
		settle: async () => {
			const after = await privateCreditOf(s, fpc)
			if (before - after !== ceiling) throw new Error(`the credit moved by ${before - after}, not the claim's ceiling ${ceiling}`)
			s.credit.spend(selecting, ceiling)
			if (after !== s.credit.total) throw new Error(`the credit ${after} is not the inventory's ${s.credit.total}`)
			return `${ceiling} FJ-wei of private credit charged`
		},
	}
}

export async function flowPublicDeposit(
	s: SmokeContext,
	token: ManifestToken,
	l2Token: ContractBase,
	payer: ClaimPayer = "sponsor",
): Promise<string> {
	const amount = 100n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const res = await send(s, s.l1, {
		intent: "token",
		erc20: token.erc20 as Address,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
	})
	const pay = await claimPayment(s, payer)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from, ...pay.plan })
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	if (gained < amount) throw new Error(`public balance rose by ${gained}, expected ${amount}`)
	if (outcome.path !== "claim") throw new Error(`expected the plain claim path for a registered token, got ${outcome.path}`)
	return `${outcome.path}, +${gained} ${token.displaySymbol} (${await pay.settle()})`
}

export async function flowPrivateDeposit(
	s: SmokeContext,
	token: ManifestToken,
	l2Token: ContractBase,
	payer: ClaimPayer = "sponsor",
): Promise<string> {
	const amount = 50n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const before = await balanceOf(l2Token, s.l2.from, "private")
	const res = await send(s, s.l1, {
		intent: "token",
		erc20: token.erc20 as Address,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: true,
		claimSalt: Fr.random(),
	})
	const pay = await claimPayment(s, payer)
	const outcome = await claim(s, res, { amount, isPrivate: true, recipient: s.l2.from, ...pay.plan })
	const gained = (await balanceOf(l2Token, s.l2.from, "private")) - before
	if (gained < amount) throw new Error(`private balance rose by ${gained}, expected ${amount}`)
	return `${outcome.path}, +${gained} ${token.displaySymbol} privately (${await pay.settle()})`
}

export async function flowRelayedPrivateDeposit(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = 25n * 10n ** BigInt(token.decimals)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const res = await send(s, s.l1, {
		intent: "token",
		erc20: token.erc20 as Address,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: true,
		claimSalt: Fr.random(),
	})
	await waitForL1ToL2Message(s.l2.node, res.tokenMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	// The consumption secret is derived from (salt, recipient) in-circuit, so naming the relayer as
	// the recipient derives a secret that consumes nothing.
	let redirected = false
	try {
		await claimOnce(s, res, { amount, isPrivate: true, recipient: s.relayer, submitter: "relayer" })
		redirected = true
	} catch {}
	if (redirected) throw new Error("SECURITY: a relayer redirected a private claim to itself")

	const before = await balanceOf(l2Token, s.l2.from, "private")
	const outcome = await claim(s, res, { amount, isPrivate: true, recipient: s.l2.from, submitter: "relayer" })
	const gained = (await balanceOf(l2Token, s.l2.from, "private")) - before
	if (gained < amount) throw new Error(`relayed claim credited ${gained}, expected ${amount}`)
	return `wrong recipient rejected, then ${outcome.path} submitted by the relayer credited the actor`
}

/** The slice has to buy enough Fee Juice to pay the claim it funds, which the swapper's fixed rate
 *  makes exact: 40 whole 6-decimal units → 4×10^19 FJ-wei. */
export const TOKEN_PLUS_GAS_FUEL_UNITS = 40n
export const GAS_ONLY_AMOUNT = 20n * MIN_FJ

export async function flowTokenPlusGas(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const unit = 10n ** BigInt(token.decimals)
	const total = 100n * unit
	const fuelAmount = TOKEN_PLUS_GAS_FUEL_UNITS * unit
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, total)
	const res = await send(s, s.l1, {
		intent: "token+gas",
		erc20: token.erc20 as Address,
		amount: total,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount, fuelRecipient: s.l2.from.toString() as Hex, ...(await fuelLeg(s, token.erc20 as Address, fuelAmount)) },
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const outcome = await claim(s, res, {
		amount: total - fuelAmount,
		isPrivate: false,
		recipient: s.l2.from,
		fee: fuelClaimFee(s, res),
		feeMode: "fee-juice",
	})
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	if (gained < total - fuelAmount) throw new Error(`token leg credited ${gained}, expected ${total - fuelAmount}`)
	return `${outcome.path} paid for itself with the ${res.fuelReceived} FJ-wei the same send bridged`
}

export async function flowGasOnly(s: SmokeContext): Promise<string> {
	const amount = GAS_ONLY_AMOUNT
	const feeAsset = s.clients.deployment.feeJuice
	await mintFeeAsset(s.l1, feeAsset, s.l1.account.address, amount)
	await ensureRouterPermit2(s.l1, { usdc: feeAsset, usdcAbi: TestERC20Abi, permit2: PERMIT2, needed: amount, mins: s.mins })
	const res = await send(s, s.l1, {
		intent: "gas",
		erc20: feeAsset,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount: amount, fuelRecipient: s.l2.from.toString() as Hex, minFuelOutput: amount, swapData: "0x" },
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	await s.feeJuiceL2.methods
		.claim(s.l2.from, amount, Fr.fromHexString(res.fuelSecretHex as string), new Fr(res.fuelLeafIndex as bigint))
		.send(s.l2.sendOpts as never)
	const after = await settled(
		() => balanceOf(s.feeJuiceL2, s.l2.from, "public"),
		(v) => v - before >= amount,
		"the public Fee Juice after the claim",
	)
	const gained = after - before
	return `fuel-only bridgeWithPermit into the FeeJuicePortal, +${gained} FJ-wei claimed as fee juice`
}

// ─── Private gas held at the PrivateFPC ──────────────────────────────────────

/** One note worth 1.4× the ceiling: the exit that spends it selects exactly one even if fees rise
 *  before it lands, and its change becomes one of the three the fragmented exit needs. Starts from
 *  nothing: credit a re-attached run already holds would make the note shape unknowable. */
export async function flowPrivateGasOneNote(s: SmokeContext): Promise<string> {
	const fpc = await privateFpc(s)
	const held = await privateCreditOf(s, fpc)
	if (held !== 0n) throw new Error(`the actor already holds ${held} FJ-wei of private gas; the note inventory cannot be established`)
	const gained = await mintPrivateGasNote(s, fpc, ((await exitCeiling(s)) * 14n) / 10n)
	s.credit.notes.push(gained)
	return `bridge() to the PrivateFPC, FeeJuice.claim then PrivateFPC.mint credited ${gained} FJ-wei as one note`
}

/** Two equal notes x beside the first exit's change r, sized so `pay_fee` must select all three and
 *  recurse past the two notes it reads first: x ≥ (C − r)/2, x < C − r and 2x < C, taking the middle
 *  of that window because fees drift before the exit re-checks it. */
export async function flowPrivateGasFragmented(s: SmokeContext): Promise<string> {
	const fpc = await privateFpc(s)
	const ceiling = await exitCeiling(s)
	if (s.credit.notes.length !== 1) throw new Error(`expected the first exit's change alone, not notes ${s.credit.notes.join(", ")}`)
	const change = s.credit.total
	const low = (ceiling - change + 1n) / 2n
	const high = ceiling - change < ceiling / 2n ? ceiling - change : ceiling / 2n
	if (low >= high) throw new Error(`a change of ${change} at the ceiling ${ceiling} leaves no two-note window`)
	const each = (low + high) / 2n
	s.credit.notes.push(await mintPrivateGasNote(s, fpc, each), await mintPrivateGasNote(s, fpc, each))
	const held = await privateCreditOf(s, fpc)
	if (held !== s.credit.total) throw new Error(`the credit ${held} is not the inventory's ${s.credit.total}`)
	const selecting = s.credit.selectedFor(ceiling)
	if (selecting !== 3) throw new Error(`at the ceiling ${ceiling} the notes ${s.credit.notes.join(", ")} select ${selecting}, not 3`)
	return `notes of ${s.credit.notes.join(", ")} FJ-wei held (${held} in all) at the ceiling ${ceiling}; none covers a ceiling, nor does any pair`
}

// ─── Exits ───────────────────────────────────────────────────────────────────

export interface ExitPlan {
	token: ManifestToken
	l2Token: ContractBase
	amount: bigint
	isPrivate: boolean
	/** Names a private exit's gas sample in the report. */
	label?: string
	/** The credit notes the private exit's `pay_fee` is expected to spend (default 1); the send refuses when the inventory at its ceiling says otherwise. */
	notes?: number
	/** A public exit's payer: the sponsor (scaffolding) or, as the app leaves it, the wallet's default —
	 *  the actor's own public Fee Juice, for the authwit and the exit both. A private exit always pays
	 *  from credit. */
	payer?: "sponsor" | "own"
}

/** Sends as the actor with no fee named: the wallet's default payer, the account's own Fee Juice. */
const ownFeeOpts = (s: SmokeContext) => ({ from: s.l2.from, wait: { waitForStatus: TxStatus.PROPOSED } })

async function exitAuthwit(s: SmokeContext, p: ExitPlan, nonce: Fr): Promise<{ authWitnesses?: unknown[]; fee: bigint }> {
	const burn = p.isPrivate
		? p.l2Token.methods.burn_private(s.l2.from, p.amount, nonce)
		: p.l2Token.methods.burn_public(s.l2.from, p.amount, nonce)
	const intent = { caller: s.hub.address, action: burn }
	if (!p.isPrivate) {
		const authwit = await SetPublicAuthwitContractInteraction.create(s.l2.wallet as never, s.l2.from, intent as never, true)
		const opts = p.payer === "own" ? ownFeeOpts(s) : s.l2.sendOpts
		const { receipt } = (await authwit.send(opts as never)) as unknown as { receipt?: ExitReceipt }
		return { fee: receipt?.transactionFee ?? 0n }
	}
	return { authWitnesses: [await s.l2.wallet.createAuthWit(s.l2.from, intent as never)], fee: 0n }
}

type ExitReceipt = { txHash: unknown; transactionFee?: bigint }

/** Sends the exit the way the app does. A public one runs the preflight (pause assert, portal
 *  read, burn) before any authwit is spent and rides the sponsor; a private one carries its witness
 *  and is paid by the PrivateFPC from held credit — its simulation is read for gas, and the credit
 *  around the send for what the FPC kept. */
async function sendExit(
	s: SmokeContext,
	exit: HubExitParams,
	extra: { authWitnesses?: unknown[] },
	sample: { label: string; notes: number; payer?: ExitPlan["payer"] },
): Promise<ExitReceipt> {
	const from = s.l2.from.toString()
	if (!exit.isPrivate) {
		await preflightHubExit(s.hub, exit, from)
		const opts = sample.payer === "own" ? ownFeeOpts(s) : s.l2.sendOpts
		const { receipt } = (await exitViaHub(s.hub, exit, { ...opts, ...extra })) as unknown as { receipt: ExitReceipt }
		return receipt
	}
	const fpc = await privateFpc(s)
	const { fee, ceiling, limits } = await privateExitFee(s)
	// The ceiling is priced now, not when the notes were minted: the shape is checked at this price.
	const selecting = s.credit.selectedFor(ceiling)
	if (selecting !== sample.notes) {
		throw new Error(
			`${sample.label}: at the ceiling ${ceiling} pay_fee selects ${selecting} note(s), not ${sample.notes}; the fixture lost its shape`,
		)
	}
	const sim = await simulateHubExit(s.hub, exit, from, { ...extra, fee })
	const before = await privateCreditOf(s, fpc)
	const { receipt } = (await exitViaHub(s.hub, exit, { ...s.l2.sendOpts, ...extra, fee })) as unknown as { receipt: ExitReceipt }
	const after = await privateCreditOf(s, fpc)
	await sampleExitGas(s, sample, String(receipt.txHash), sim, { charged: before - after, ceiling, limits })
	s.credit.spend(selecting, ceiling)
	if (after !== s.credit.total) throw new Error(`${sample.label}: the credit ${after} is not the inventory's ${s.credit.total}`)
	return receipt
}

export async function runExit(s: SmokeContext, p: ExitPlan): Promise<string> {
	if (p.isPrivate && p.payer === "own") throw new Error("a private exit pays only from credit")
	const authwitNonce = Fr.random()
	const publicFjBefore = p.payer === "own" ? await balanceOf(s.feeJuiceL2, s.l2.from, "public") : 0n
	const { fee: authwitFee, ...extra } = await exitAuthwit(s, p, authwitNonce)
	const exit: HubExitParams = {
		l2Token: p.token.l2Token,
		recipientL1: s.l1.account.address,
		amount: p.amount,
		callerOnL1: ZERO_L1,
		authwitNonce,
		isPrivate: p.isPrivate,
	}
	const receipt = await sendExit(s, exit, extra, { label: p.label ?? "private", notes: p.notes ?? 1, payer: p.payer })
	let paid = ""
	if (p.payer === "own") {
		const fees = authwitFee + (receipt.transactionFee ?? 0n)
		const dropped = publicFjBefore - (await balanceOf(s.feeJuiceL2, s.l2.from, "public"))
		if (fees === 0n || dropped !== fees)
			throw new Error(`the actor's public Fee Juice dropped by ${dropped}, the two transactions billed ${fees}`)
		paid = `; authwit + exit fees ${fees} FJ-wei paid from the actor's public Fee Juice`
	}
	const before = await erc20BalanceOf(s.l1, p.token.erc20 as Address, s.l1.account.address)
	// The burn's epoch cannot prove while the chain is idle, and the Outbox refuses the consume until
	// it has — so the heartbeat runs for the whole finalization, not just the message wait.
	await withBlockHeartbeat(s.l2, () =>
		consumeWithdrawal(
			s.l1,
			s.l2.node as never,
			receipt,
			{
				recipientL1: s.l1.account.address,
				amount: p.amount,
				portal: p.token.portal as Address,
				portalAbi: TOKEN_PORTAL_ABI as never,
				provenTimeoutSec: 900,
			},
			(stage) => console.log(`    withdraw: ${stage} (${s.mins()})`),
		),
	)
	const released = (await erc20BalanceOf(s.l1, p.token.erc20 as Address, s.l1.account.address)) - before
	if (released < p.amount) throw new Error(`L1 released ${released}, expected ${p.amount}`)
	return `${p.isPrivate ? "private" : "public"} burn → Outbox consume released ${released} ${p.token.displaySymbol}-units on L1${paid}`
}

// ─── First-time token shapes ─────────────────────────────────────────────────

export async function flowRelayerFirstRegister(s: SmokeContext): Promise<string> {
	const amount = 10n ** 18n
	const erc20 = await freshToken(s.l1, { name: "Relayer First", symbol: "RLY", decimals: 18 }, [s.l1.account.address], amount)
	const res = await depositFresh(s, erc20, amount)
	const block = res.token as JournalTokenBlock
	const l2Token = await s.l2TokenOf(block)
	await waitForL1ToL2Message(s.l2.node, block.registerKey as string, { forceBlock: s.l2.forceBlock })
	// The relayer consumes the factory's register leaf; the depositor's claim then has nothing left to
	// register and must succeed as a plain claim.
	await s.hub.methods.register_token(...registerArgsOf(block, block.nameWord)).send(s.relayerOpts as never)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	if (outcome.path !== "claim") throw new Error(`expected a plain claim after a relayer registration, got ${outcome.path}`)
	const balance = await balanceOf(l2Token, s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `the relayer registered RLY first, the depositor's ${outcome.path} landed ${balance}`
}

export async function flowConcurrentFirstClaims(s: SmokeContext): Promise<string> {
	const amount = 10n ** 18n
	const erc20 = await freshToken(
		s.l1,
		{ name: "Race Token", symbol: "RACE", decimals: 18 },
		[s.l1.account.address, s.l1b.account.address],
		amount,
	)
	const first = await depositFresh(s, erc20, amount)
	const second = await depositFresh(s, erc20, amount, s.l1b)
	await waitForL1ToL2Message(s.l2.node, second.tokenMessageHashHex as string, { forceBlock: s.l2.forceBlock })

	const settled = await Promise.allSettled([
		claim(s, first, { amount, isPrivate: false, recipient: s.l2.from }),
		claim(s, second, { amount, isPrivate: false, recipient: s.relayer, submitter: "relayer" }),
	])
	const paths: string[] = []
	for (const [i, outcome] of settled.entries()) {
		if (outcome.status === "fulfilled") {
			paths.push(outcome.value.path)
			continue
		}
		// The loser of the register race retries as a plain claim once the winner's registration lands.
		const retry = await claim(s, i === 0 ? first : second, {
			amount,
			isPrivate: false,
			recipient: i === 0 ? s.l2.from : s.relayer,
			submitter: i === 0 ? undefined : "relayer",
		})
		paths.push(retry.path)
	}
	if (paths.filter((p) => p === "register+claim").length !== 1 || paths.filter((p) => p === "claim").length !== 1) {
		throw new Error(`expected one register+claim and one plain claim, got ${paths.join(" + ")}`)
	}
	return `two first-time deposits from two L1 accounts settled as ${paths.join(" + ")}`
}

export async function flowPortalOnlyToken(s: SmokeContext, pxo: ManifestToken): Promise<string> {
	const amount = 10n ** 18n
	if (await hubTokenFor(s.hub, pxo.erc20, s.l2.from.toString()))
		throw new Error("PXO was already registered — the fixture is not portal-only")
	await mint(s.l1, pxo.erc20 as Address, s.l1.account.address, amount)
	const res = await depositFresh(s, pxo.erc20 as Address, amount)
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from })
	if (outcome.path !== "register+claim") throw new Error(`expected register+claim for a portal-only token, got ${outcome.path}`)
	const l2Token = await s.l2TokenOf(res.token as JournalTokenBlock)
	const balance = await balanceOf(l2Token, s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `portal existed, hub did not know it; the claim took ${outcome.path}`
}

const failure = async (run: () => Promise<unknown>): Promise<string> => {
	try {
		await run()
	} catch (e) {
		return e instanceof Error ? e.message : String(e)
	}
	return ""
}

/** NORT never gets a rate at the fuel swapper, so its gas leg has no quote — exactly the shape a token
 *  no venue prices produces — and a send without one is refused before anything is signed. */
export async function flowNoRoute(s: SmokeContext, nort: Address): Promise<string> {
	const unquoted = await failure(() => fuelLeg(s, nort, 10n ** 18n))
	if (!/no fuel quote/.test(unquoted)) throw new Error(`expected the swapper to refuse NORT, got "${unquoted.slice(0, 120)}"`)
	// The refusal is the whole point: nothing was signed, so no Permit2 nonce and no L1 tx exist. The
	// floor is a real one, so the missing quote — not a zero floor — is what the send refuses.
	const refused = await failure(() =>
		send(s, s.l1, {
			intent: "token+gas",
			erc20: nort,
			amount: 2n * 10n ** 18n,
			aztecRecipient: s.l2.from.toString() as Hex,
			isPrivate: false,
			gas: { fuelAmount: 10n ** 18n, fuelRecipient: s.l2.from.toString() as Hex, minFuelOutput: MIN_FJ, swapData: "0x" },
		}),
	)
	if (!refused) throw new Error("a quoteless token+gas send was signed and broadcast")
	if (!/swapData/.test(refused)) throw new Error(`the quoteless send was refused for "${refused.slice(0, 120)}", not its missing quote`)
	return `no-route: the swapper has no rate for NORT; the send refused its missing quote before signing (${refused.slice(0, 60)}…)`
}

// ─── Rejected registration under each fee mode ───────────────────────────────

const FEE_MODE_SYMBOL: Record<FeeMode, string> = { sponsored: "BADS", "fee-juice-claim": "BADF", "private-fpc": "BADP" }

/** The deposit each fee mode's claim is paid from. Only the sponsored lane needs no gas leg. */
async function fundedSendFor(
	s: SmokeContext,
	mode: FeeMode,
	erc20: Address,
	total: bigint,
	fuelAmount: bigint,
	bridgeSalt: Fr,
): Promise<SendResult> {
	if (mode === "sponsored") {
		return send(s, s.l1, { intent: "token", erc20, amount: total, aztecRecipient: s.l2.from.toString() as Hex, isPrivate: false })
	}
	const toFpc = mode === "private-fpc"
	await setFuelRate(s.l1, fuelSwapperOf(s), erc20)
	return send(s, s.l1, {
		intent: "token+gas",
		erc20,
		amount: total,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: {
			fuelAmount,
			fuelRecipient: (toFpc ? PRIVATE_FPC_ADDRESS : s.l2.from.toString()) as Hex,
			...(await fuelLeg(s, erc20, fuelAmount)),
			// The FPC rebuilds this secret from the claimer inside `mint_and_pay_fee`; a random one
			// would strand the Fee Juice at the FPC forever.
			fuelSecret: toFpc ? deriveBridgeSecret(bridgeSalt, s.l2.from) : undefined,
		},
	})
}

/** A tampered word hashes to a message the Inbox never carried, so the consume finds no witness —
 *  and because the consume runs FIRST, the register leaf survives for the corrected attempt. The
 *  attempt rides the mode's own payer: a rejection is a simulation failure, so a fee that claims in
 *  setup spends nothing and the same fuel pays the corrected claim. */
async function rejectTamperedRegistration(s: SmokeContext, block: JournalTokenBlock, fee: unknown): Promise<string> {
	const tampered = `0x00${"ff".repeat(31)}`
	const opts = fee === undefined ? s.l2.sendOpts : { ...s.l2.sendOpts, fee }
	try {
		await s.hub.methods.register_token(...registerArgsOf(block, tampered)).send(opts as never)
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e)
		// Only the missing witness counts as the rejection; a wallet, fee or RPC failure is not it.
		if (!/no l1 to l2 message found/i.test(message)) throw new Error(`the tampered registration failed for another reason: ${message}`)
		return message
	}
	throw new Error("a registration with tampered metadata was accepted")
}

export async function flowRejectedRegistration(s: SmokeContext, mode: FeeMode): Promise<string> {
	if (mode === "private-fpc") await ensurePrivateFpc(s.l2)
	const unit = 10n ** 6n
	const total = 100n * unit
	const fuelAmount = mode === "sponsored" ? 0n : 40n * unit
	const bridgeSalt = Fr.random()
	const erc20 = await freshToken(
		s.l1,
		{ name: `Bad Register ${mode}`, symbol: FEE_MODE_SYMBOL[mode], decimals: 6 },
		[s.l1.account.address],
		total,
	)
	const res = await fundedSendFor(s, mode, erc20, total, fuelAmount, bridgeSalt)

	const block = res.token as JournalTokenBlock
	await waitForL1ToL2Message(s.l2.node, block.registerKey as string, { forceBlock: s.l2.forceBlock })
	if (fuelAmount > 0n) await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const feeFor = () =>
		mode === "private-fpc" ? fpcClaimFee(s, res, bridgeSalt) : mode === "fee-juice-claim" ? fuelClaimFee(s, res) : undefined
	const rejection = await rejectTamperedRegistration(s, block, await feeFor())

	const amount = total - fuelAmount
	const feeMode = mode === "sponsored" ? "sponsored" : mode === "private-fpc" ? "private-fpc" : "fee-juice"
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from, fee: await feeFor(), feeMode })
	if (outcome.path !== "register+claim") throw new Error(`expected register+claim after the rejected attempt, got ${outcome.path}`)
	const balance = await balanceOf(await s.l2TokenOf(block), s.l2.from, "public")
	if (balance < amount) throw new Error(`balance ${balance} < ${amount}`)
	return `tampered register rejected ("${rejection.slice(0, 70)}"), corrected ${outcome.path} landed ${balance} under ${mode}`
}

// ─── Pause switches ──────────────────────────────────────────────────────────

/** Pauses, proves the refusal, proves a claim still lands, and ALWAYS unpauses — a paused hub left
 *  behind would fail every later exit for reasons unrelated to them. */
export async function flowGuardianPause(s: SmokeContext, token: ManifestToken): Promise<string> {
	const exit = {
		l2Token: token.l2Token,
		recipientL1: s.l1.account.address,
		amount: 1n,
		callerOnL1: ZERO_L1,
		authwitNonce: Fr.random(),
		isPrivate: false,
	}
	await s.hub.methods.set_exits_paused(true).send(s.guardianOpts as never)
	let claimed: string
	try {
		if (!(await hubExitsPaused(s.hub, s.l2.from.toString()))) throw new Error("exits_paused() stayed false after the pause")
		let refusal = ""
		try {
			await preflightHubExit(s.hub, exit, s.l2.from.toString())
		} catch (e) {
			refusal = e instanceof Error ? e.message : String(e)
		}
		if (!/exits paused/i.test(refusal))
			throw new Error(`a paused exit preflight failed with "${refusal.slice(0, 120)}" instead of "exits paused"`)
		// Claims are deliberately NOT pausable: a deposit already made must always be claimable.
		claimed = await flowPublicDeposit(s, token, await s.l2TokenOf(tokenBlockOf(token)))
	} finally {
		await s.hub.methods.set_exits_paused(false).send(s.guardianOpts as never)
	}
	if (await hubExitsPaused(s.hub, s.l2.from.toString())) throw new Error("exits_paused() stayed true after the unpause")
	return `exit preflight refused with "exits paused" while a claim still landed (${claimed}); unpaused`
}

const PAUSED_ERRORS = {
	deposits: { name: "DepositsPaused", selector: toFunctionSelector("DepositsPaused()") },
	withdraws: { name: "WithdrawsPaused", selector: toFunctionSelector("WithdrawsPaused()") },
}
/** The owner's switch is not part of the app-facing factory ABI (the app only reads the flags). */
export const SET_PAUSED_ABI = parseAbi(["function setPaused(bool deposits, bool withdraws)"])

/** Whether a portal call reverts with the named pause error — by name where the ABI decodes it,
 *  by selector otherwise. */
async function portalRefuses(
	s: SmokeContext,
	portal: Address,
	fn: "depositToAztecPublic" | "withdraw",
	args: unknown[],
): Promise<string | null> {
	try {
		await s.l1.pub.simulateContract({
			address: portal,
			abi: TOKEN_PORTAL_ABI as never,
			functionName: fn,
			args: args as never,
			account: s.l1.account,
		})
		return null
	} catch (e) {
		return e instanceof Error ? e.message : String(e)
	}
}

const refusesWith = (refusal: string | null, which: keyof typeof PAUSED_ERRORS) =>
	refusal !== null && (refusal.includes(PAUSED_ERRORS[which].name) || refusal.includes(PAUSED_ERRORS[which].selector))

/** What the Outbox answers a witness it never carried with (`Epoch` is a uint256 in the ABI). */
const OUTBOX_ERRORS = [
	"Outbox__NothingToConsumeAtEpoch(uint256)",
	"Outbox__NothingToConsume(bytes32)",
	"Outbox__InvalidRecipient(address,address)",
	"Outbox__LeafIndexOutOfBounds(uint256,uint256)",
	"Outbox__PathTooLong()",
	"Outbox__AlreadyNullified(uint256,uint256)",
	"Outbox__InvalidChainId()",
	"Outbox__VersionMismatch(uint256,uint256)",
	"Outbox__InvalidNumCheckpointsInEpoch(uint256)",
].map((signature) => ({ name: signature.slice(0, signature.indexOf("(")), selector: toFunctionSelector(signature) }))
const outboxErrorIn = (refusal: string | null): string | null =>
	refusal === null ? null : (OUTBOX_ERRORS.find((e) => refusal.includes(e.name) || refusal.includes(e.selector))?.name ?? null)

async function readPaused(s: SmokeContext): Promise<{ deposits: boolean; withdraws: boolean }> {
	const factory = s.bridge.l1.factory as Address
	const read = (functionName: "depositsPaused" | "withdrawsPaused") =>
		s.l1.pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI as never, functionName }) as Promise<boolean>
	return { deposits: await read("depositsPaused"), withdraws: await read("withdrawsPaused") }
}

/** The L1 switches: the factory's owner (the deployer) pauses deposits and withdraws, every portal
 *  refuses each before touching anything, and the switches are ALWAYS flipped back. The refusal is
 *  the portal's FIRST check, so a withdraw with no witness at all proves the pause rather than the
 *  Outbox; unpaused, the same call fails on its witness instead. */
export async function flowL1Pause(s: SmokeContext, token: ManifestToken): Promise<string> {
	const factory = s.bridge.l1.factory as Address
	const portal = token.portal as Address
	const deposit = [s.l2.from.toString(), 1n, `0x${"00".repeat(32)}`]
	const withdraw = [s.l1.account.address, 1n, false, 0n, 0n, 0n, []]
	await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [true, true])
	try {
		const paused = await readPaused(s)
		if (!paused.deposits || !paused.withdraws) throw new Error(`setPaused(true, true) read back as ${JSON.stringify(paused)}`)
		const depositRefusal = await portalRefuses(s, portal, "depositToAztecPublic", deposit)
		if (!refusesWith(depositRefusal, "deposits"))
			throw new Error(`a paused deposit was refused with "${depositRefusal?.slice(0, 120)}", not DepositsPaused`)
		const withdrawRefusal = await portalRefuses(s, portal, "withdraw", withdraw)
		if (!refusesWith(withdrawRefusal, "withdraws"))
			throw new Error(`a paused withdraw was refused with "${withdrawRefusal?.slice(0, 120)}", not WithdrawsPaused`)
	} finally {
		await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [false, false])
	}
	const after = await readPaused(s)
	if (after.deposits || after.withdraws) throw new Error(`setPaused(false, false) read back as ${JSON.stringify(after)}`)
	// Unpaused, the same bogus witness must reach the Outbox and be refused THERE — a null (accepted)
	// or an unrelated failure would let this pass on nothing.
	const witnessRefusal = await portalRefuses(s, portal, "withdraw", withdraw)
	const outboxError = outboxErrorIn(witnessRefusal)
	if (outboxError === null) {
		const what = witnessRefusal === null ? "accepted" : `refused with "${witnessRefusal.slice(0, 120)}"`
		throw new Error(`unpaused, the bogus witness was ${what} — not an Outbox refusal`)
	}
	return `factory paused both ways: the portal refused a deposit (DepositsPaused) and a withdraw (WithdrawsPaused) first; unpaused, the Outbox refused the witness (${outboxError})`
}
