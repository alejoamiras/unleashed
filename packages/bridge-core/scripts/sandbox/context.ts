/** The per-actor context a flow runs in, and the helpers every flow shares. Nothing here is module
 *  state: fee samples, the credit-note inventory and the exit-gas readings live on the context, so
 *  two actors (two test files) never see each other's numbers. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { TestERC20Abi } from "@aztec-foundation/l1-artifacts"
import { Gas, type GasUsed } from "@aztec-labs/stdlib/gas"
import { PrivateFPCContract } from "@alejoamiras/private-fee-juice/artifacts/private"
import type { Address, Hex } from "viem"
import { predictedWorstMinFees, publicFeeJuicePayment } from "../../src/fee-juice"
import type { L1Ctx } from "../../src/flows"
import { claimViaHub, type HubClaimOutcome } from "../../src/hub-l2"
import type { JournalTokenBlock } from "../../src/journal"
import type { BridgeBlock, ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import {
	deriveBridgeSecret,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_FPC_SALT,
	PRIVATE_HUB_EXIT_GAS,
	privateFeeJuicePayment,
	privateFpcFeeLimit,
	privateMintAndPayFee,
} from "../../src/private-fuel"
import { runSend, type SendGasLeg, type SendParams, type SendResult } from "../../src/send-flow"
import type { CalibrationSample } from "../calibration"
import { feeJuiceFor } from "../fee-juice-l2"
import { type L2Ctx, waitForL1ToL2Message } from "../generation"
import { ensureRouterPermit2 } from "../script-l1"
import { claimTokensUntilSynced, registerHub, registerHubToken } from "../script-l2"
import { planFuelLeg, sendGenerationOf } from "../script-send"
import { deadline, FEE_CEILING, PERMIT2, rndNonce } from "./constants"
import type { SandboxClients } from "./handle"
import { mintFeeAsset } from "./l1"
import { l2CtxFor } from "./l2"

// ─── Credit-note inventory ───────────────────────────────────────────────────

const byValueDesc = (a: bigint, b: bigint) => (b > a ? 1 : b < a ? -1 : 0)
export const sumOf = (notes: bigint[]) => notes.reduce((s, n) => s + n, 0n)

/** The actor's credit notes as the flows created them. `pay_fee` selects notes largest-first until
 *  the ceiling is covered and returns the remainder as one change note, so this inventory says how
 *  many notes an exit spends — what its gas sample is labelled with, and what the landed
 *  transaction's nullifier count is checked against. */
export class CreditInventory {
	readonly notes: bigint[] = []

	/** How many notes `pay_fee` selects for this ceiling from the inventory. */
	selectedFor(ceiling: bigint): number {
		let sum = 0n
		const sorted = [...this.notes].sort(byValueDesc)
		for (let i = 0; i < sorted.length; i++) {
			sum += sorted[i] as bigint
			if (sum >= ceiling) return i + 1
		}
		throw new Error(`the held notes (${this.notes.join(", ")}) do not cover the ceiling ${ceiling}`)
	}

	/** Replays the selection on the inventory once the exit has landed. */
	spend(count: number, ceiling: bigint): void {
		this.notes.sort(byValueDesc)
		const spent = sumOf(this.notes.splice(0, count))
		if (spent > ceiling) this.notes.push(spent - ceiling)
	}

	get total(): bigint {
		return sumOf(this.notes)
	}
}

// ─── Samples ─────────────────────────────────────────────────────────────────

export type HubGasLimits = { daGas: number; l2Gas: number }

export interface ExitGasSample {
	label: string
	/** Credit notes `pay_fee` spent, per the inventory. */
	notes: number
	/** Nullifiers the landed transaction emitted: each spent note is one, so two samples differ by their note difference. */
	nullifiers: number
	simulated: { l2Gas: number; daGas: number }
	fee: bigint
	feePerL2Gas: bigint
	feePerDaGas: bigint
	charged: bigint
	ceiling: bigint
	limits: HubGasLimits
}

export interface Samples {
	fees: CalibrationSample[]
	exitGas: ExitGasSample[]
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface SmokeContext {
	clients: SandboxClients
	l1: L1Ctx
	/** A second L1 account, for the flows that need two depositors. */
	l1b: L1Ctx
	l2: L2Ctx
	relayer: AztecAddress
	relayerOpts: Record<string, unknown>
	/** Sends as the hub's guardian — the base actor that deployed the generation. */
	guardianOpts: Record<string, unknown>
	manifest: ManifestV2
	bridge: BridgeBlock
	hub: ContractBase
	feeJuiceL2: ContractBase
	/** Every fresh token the battery deploys, so a later flow can read its L2 balance. */
	l2TokenOf: (block: JournalTokenBlock) => Promise<ContractBase>
	credit: CreditInventory
	samples: Samples
	mins: () => string
}

/** A context whose actor is `from`. Each test file (each actor) builds its own. */
export async function buildContext(clients: SandboxClients, manifest: ManifestV2, from: AztecAddress): Promise<SmokeContext> {
	const bridge = manifest.bridge as BridgeBlock
	const hub = await registerHub(clients.l2.wallet, bridge.l2.hub)
	const hubAddress = AztecAddress.fromStringUnsafe(bridge.l2.hub.address)
	const known = new Map<string, ContractBase>()
	return {
		clients,
		l1: clients.l1,
		l1b: clients.l1b,
		l2: l2CtxFor(clients.l2, from),
		relayer: clients.l2.relayer,
		relayerOpts: clients.l2.relayerOpts,
		guardianOpts: clients.l2.guardianOpts,
		manifest,
		bridge,
		hub,
		feeJuiceL2: await feeJuiceFor(clients.l2.wallet as never, clients.l2.node as never),
		l2TokenOf: async (block) => {
			const cached = known.get(block.erc20.toLowerCase())
			if (cached) return cached
			const contract = await registerHubToken(
				clients.l2.wallet,
				hubAddress,
				tokenFromBlock(block, block.decimals),
				bridge.l2.tokenClassId,
			)
			known.set(block.erc20.toLowerCase(), contract)
			return contract
		},
		credit: new CreditInventory(),
		samples: { fees: [], exitGas: [] },
		mins: clients.mins,
	}
}

// ─── Token shapes ────────────────────────────────────────────────────────────

/** The ManifestToken shape for a token this run invented — the factory read-back is the authority. */
export function tokenFromBlock(block: JournalTokenBlock, decimals: number): ManifestToken {
	return {
		erc20: block.erc20,
		portal: block.portal,
		l2Token: block.l2Token,
		nameWord: block.nameWord,
		symbolWord: block.symbolWord,
		decimals,
		displayName: block.displaySymbol,
		displaySymbol: block.displaySymbol,
		source: "permissionless-mint",
		sourceContract: "MintableERC20",
	}
}

export const tokenBlockOf = (t: ManifestToken): JournalTokenBlock => ({
	erc20: t.erc20,
	portal: t.portal,
	l2Token: t.l2Token,
	nameWord: t.nameWord,
	symbolWord: t.symbolWord,
	decimals: t.decimals,
	displaySymbol: t.displaySymbol,
})

export const registerArgsOf = (block: JournalTokenBlock, nameWord: string) =>
	[
		EthAddress.fromString(block.erc20),
		EthAddress.fromString(block.portal),
		Fr.fromHexString(nameWord),
		Fr.fromHexString(block.symbolWord),
		block.decimals,
		new Fr(BigInt(block.registerIndex as string)),
	] as const

// ─── Reads ───────────────────────────────────────────────────────────────────

/** A send resolves when the node has the block; a read through the wallet's own PXE can trail
 *  that block by a sync tick. A value a transaction is expected to move is polled until it has —
 *  bounded, so a transaction that never landed still fails loudly with the last figure read. */
export async function settled<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
	const until = Date.now() + ms
	let value = await read()
	while (!done(value)) {
		if (Date.now() > until) throw new Error(`${what} never settled — last read ${String(value)}`)
		await new Promise((r) => setTimeout(r, 500))
		value = await read()
	}
	return value
}

export async function balanceOf(contract: ContractBase, from: AztecAddress, kind: "public" | "private"): Promise<bigint> {
	const call = kind === "public" ? contract.methods.balance_of_public(from) : contract.methods.balance_of_private(from)
	const r = (await call.simulate({ from } as never)) as { result?: bigint } | bigint
	return typeof r === "bigint" ? r : (r.result ?? 0n)
}

// ─── Sends and claims ────────────────────────────────────────────────────────

const generationOf = (s: SmokeContext) => sendGenerationOf(s.manifest, s.bridge)

/** The deposit router's fuel swapper; a sandbox booted before the router existed has none. */
export function fuelSwapperOf(s: SmokeContext): Address {
	const swapper = s.clients.deployment.fuelSwapper
	if (!swapper) throw new Error("this sandbox has no fuel swapper — boot a fresh one")
	return swapper
}

/** The fuel swapper's floored quote for `slice` of `erc20`: the call the router hands it and the floor
 *  that call carries. Throws for a token the swapper has no rate for. */
export async function fuelLeg(s: SmokeContext, erc20: Address, slice: bigint): Promise<Pick<SendGasLeg, "swapData" | "minFuelOutput">> {
	const plan = await planFuelLeg(s.l1.pub, s.manifest, erc20, slice)
	return { swapData: plan.swapData, minFuelOutput: plan.minFuelOutput }
}

export async function send(s: SmokeContext, l1: L1Ctx, p: Omit<SendParams, "nonce" | "deadline">): Promise<SendResult> {
	return runSend(l1, generationOf(s), { ...p, nonce: rndNonce(), deadline: await deadline(l1) })
}

export async function depositFresh(s: SmokeContext, erc20: Address, amount: bigint, l1: L1Ctx = s.l1): Promise<SendResult> {
	return send(s, l1, {
		intent: "token",
		erc20,
		amount,
		aztecRecipient: (l1 === s.l1 ? s.l2.from : s.relayer).toString() as Hex,
		isPrivate: false,
	})
}

export interface ClaimPlan {
	amount: bigint
	isPrivate: boolean
	recipient: AztecAddress
	submitter?: "relayer"
	fee?: unknown
	/** A private first claim registers in a transaction of its own: `registerFee` pays that
	 *  registration (else `fee` does), `registeredClaimFee` the claim that follows (else `fee` again
	 *  — which re-spends a fuel message, so a fueled first claim must name it). */
	registerFee?: unknown
	registeredClaimFee?: unknown
	/** Which fee mode paid; a paid claim's landed fee becomes a calibration sample. */
	feeMode?: CalibrationSample["feeMode"]
}

/** The landed claim's `transactionFee`, kept per shape so the budget the manifest ships is measured. */
async function sampleClaimFee(s: SmokeContext, outcome: HubClaimOutcome, p: ClaimPlan): Promise<void> {
	const feeMode = p.feeMode ?? "sponsored"
	const hashes: Array<[CalibrationSample["shape"], string]> = []
	if (outcome.registerTxHash) hashes.push(["register_token", outcome.registerTxHash])
	const claimShape: CalibrationSample["shape"] =
		outcome.path === "register+claim" ? "register_and_claim_public" : p.isPrivate ? "claim_private" : "claim_public"
	hashes.push([claimShape, outcome.claimTxHash])
	for (const [shape, hash] of hashes) {
		const receipt = await s.l2.node.getTxReceipt(TxHash.fromString(hash))
		s.samples.fees.push({ shape, feeMode, transactionFee: receipt.transactionFee ?? 0n })
	}
}

/** The claim's token block always comes from the factory read-back the send returned — the manifest
 *  copy would be missing for a token this run just invented. */
function claimInputs(s: SmokeContext, res: SendResult, p: ClaimPlan) {
	const sendOpts = p.submitter === "relayer" ? s.relayerOpts : s.l2.sendOpts
	return {
		hub: s.hub,
		claim: {
			token: res.token as JournalTokenBlock,
			recipient: p.recipient.toString(),
			amount: p.amount,
			claimValue: Fr.fromHexString(res.tokenClaimValueHex as string),
			leafIndex: res.tokenLeafIndex as bigint,
			isPrivate: p.isPrivate,
			from: (sendOpts.from as AztecAddress).toString(),
		},
		sendOpts: {
			...sendOpts,
			...(p.fee ? { fee: p.fee } : {}),
			...(p.registerFee ? { registerFee: p.registerFee } : {}),
			...(p.registeredClaimFee ? { registeredClaimFee: p.registeredClaimFee } : {}),
		},
	}
}

export async function claim(s: SmokeContext, res: SendResult, p: ClaimPlan) {
	// A first claim registers the token, which enqueues the derived Token's constructor — the wallet
	// has to hold that instance to build the transaction at all.
	await s.l2TokenOf(res.token as JournalTokenBlock)
	// Waiting for the deposit's own message first turns the retry loop into a fallback rather than
	// the normal path, which keeps a genuinely-rejected claim from spending minutes in it.
	await waitForL1ToL2Message(s.l2.node, res.tokenMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const outcome = await claimTokensUntilSynced({ ...claimInputs(s, res, p), attempts: 60, intervalMs: 3000 })
	await sampleClaimFee(s, outcome, p)
	return outcome
}

/** One attempt, no sync retry — for the claims that are SUPPOSED to fail. */
export async function claimOnce(s: SmokeContext, res: SendResult, p: ClaimPlan) {
	const { hub, claim: params, sendOpts } = claimInputs(s, res, p)
	return claimViaHub(hub, params, sendOpts)
}

// ─── Fee modes ───────────────────────────────────────────────────────────────

/** The fee modes a claim can be driven under here. */
export type FeeMode = "sponsored" | "fee-juice-claim" | "private-fpc"

/** Pays the claim's own gas with the Fee Juice the same send bridged. */
export function fuelClaimFee(s: SmokeContext, res: SendResult) {
	return {
		paymentMethod: publicFeeJuicePayment(s.l2.from, {
			claimAmount: res.fuelReceived ?? 0n,
			claimSecret: Fr.fromHexString(res.fuelSecretHex as string),
			messageLeafIndex: res.fuelLeafIndex as bigint,
		}),
		gasSettings: FEE_CEILING,
	}
}

/** Same bridged Fee Juice, but minted straight into the PrivateFPC, which pays as a third party. */
export async function fpcClaimFee(s: SmokeContext, res: SendResult, bridgeSalt: Fr) {
	// The FPC asserts `amount >= gasLimits · maxFeesPerGas` up front, so the committed ceiling has to
	// be a live prediction. The blunt setup ceiling would price a budget no bridged slice can cover.
	const maxFeesPerGas = (await predictedWorstMinFees(s.l2.node)).mul(2)
	return {
		paymentMethod: privateMintAndPayFee(
			AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS),
			res.fuelReceived ?? 0n,
			deriveBridgeSecret(bridgeSalt, s.l2.from),
			bridgeSalt,
			new Fr(res.fuelLeafIndex as bigint),
		),
		gasSettings: { teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }), maxFeesPerGas },
	}
}

// ─── Private gas held at the PrivateFPC ──────────────────────────────────────

/** The canonical PrivateFPC has no initializer and no owner, so a fresh chain just needs the
 *  universal deploy at its pinned salt before anything can pay through it. */
export async function ensurePrivateFpc(l2: L2Ctx): Promise<void> {
	const pinned = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
	const existing = await l2.node.getContract(pinned)
	if (existing) {
		// Deployed through another wallet (an earlier file, a kept network): this one still has to
		// hold the instance and artifact before it can simulate against it.
		await l2.wallet.registerContract(existing, PrivateFPCContract.artifact as never)
		return
	}
	await PrivateFPCContract.deploy(l2.wallet as never, { salt: Fr.fromHexString(PRIVATE_FPC_SALT), universalDeploy: true } as never).send(
		l2.deployOpts as never,
	)
	if (!(await l2.node.getContract(pinned))) throw new Error(`a deploy at the canonical salt did not land at ${PRIVATE_FPC_ADDRESS}`)
}

/** The pinned PrivateFPC as this wallet sees it, deployed at the canonical salt when the chain has none. */
export async function privateFpc(s: SmokeContext): Promise<ContractBase> {
	await ensurePrivateFpc(s.l2)
	const at = await PrivateFPCContract.at(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS), s.l2.wallet as never)
	return at as unknown as ContractBase
}

/** The account's credit at the FPC — `balance_of` is a utility, read through the wallet's own PXE. */
export async function privateCreditOf(s: SmokeContext, fpc: ContractBase, of: AztecAddress = s.l2.from): Promise<bigint> {
	const r = (await fpc.methods.balance_of(of).simulate({ from: s.l2.from } as never)) as { result?: bigint } | bigint
	return typeof r === "bigint" ? r : (r.result ?? 0n)
}

/** One credit note, funded the way a user's is: Fee Juice bridged straight to the PrivateFPC under
 *  a claimer-bound secret, claimed into the FPC's public balance, then minted into the actor's
 *  credit — `mint` proves the claim by reading its nullifier rather than consuming the message
 *  itself (`mint_and_pay_fee` is the one-transaction form). Returns the credit gained. */
export async function mintPrivateGasNote(s: SmokeContext, fpc: ContractBase, amount: bigint): Promise<bigint> {
	const feeAsset = s.clients.deployment.feeJuice
	await mintFeeAsset(s.l1, feeAsset, s.l1.account.address, amount)
	await ensureRouterPermit2(s.l1, { usdc: feeAsset, usdcAbi: TestERC20Abi, permit2: PERMIT2, needed: amount, mins: s.mins })
	return mintPrivateGasVia(s, fpc, { erc20: feeAsset, amount, minFuelOutput: amount, swapData: "0x" })
}

/** The gas leg of a private gas-only deposit: whatever the venue turns `amount` of `erc20` into. */
export type PrivateGasLeg = { erc20: Address; amount: bigint } & Pick<SendGasLeg, "minFuelOutput" | "swapData">

/** The private half of any gas-only shape: the Fee Juice the leg buys lands at the PrivateFPC under
 *  a claimer-bound secret, is claimed into the FPC's public balance, then minted into the actor's
 *  credit. Returns the credit gained, which the swapper's fixed rate makes exact. */
export async function mintPrivateGasVia(s: SmokeContext, fpc: ContractBase, leg: PrivateGasLeg): Promise<bigint> {
	const salt = Fr.random()
	const res = await send(s, s.l1, {
		intent: "gas",
		erc20: leg.erc20,
		amount: leg.amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: {
			fuelAmount: leg.amount,
			fuelRecipient: PRIVATE_FPC_ADDRESS as Hex,
			minFuelOutput: leg.minFuelOutput,
			swapData: leg.swapData,
			// The FPC rebuilds this secret from the claimer inside `mint`; a random one would strand the Fee Juice.
			fuelSecret: deriveBridgeSecret(salt, s.l2.from),
		},
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const received = res.fuelReceived ?? leg.amount
	const leafIndex = new Fr(res.fuelLeafIndex as bigint)
	const before = await privateCreditOf(s, fpc)
	await s.feeJuiceL2.methods.claim(fpc.address, received, deriveBridgeSecret(salt, s.l2.from), leafIndex).send(s.l2.sendOpts as never)
	await fpc.methods.mint(received, salt, leafIndex).send(s.l2.sendOpts as never)
	const after = await settled(
		() => privateCreditOf(s, fpc),
		(v) => v - before >= received,
		"the private credit after the mint",
	)
	return after - before
}

/** The exit's ceiling at today's predicted worst fees under the app's limits. */
export async function exitCeiling(s: SmokeContext): Promise<bigint> {
	return privateFpcFeeLimit(PRIVATE_HUB_EXIT_GAS, await predictedWorstMinFees(s.l2.node))
}

/** What the app names for a transaction paid from held credit: the FPC's `pay_fee` under the
 *  transaction's limits at the predicted worst fee — the ceiling the FPC keeps in full. The limits
 *  are clamped to what this network admits per transaction (a local network caps DA gas far below
 *  testnet's 117,668): a no-op at the app's limits, and where it ever binds the report shows the
 *  declared limits beside the constant, since a lower ceiling is a different deduction and note
 *  selection. */
export async function privateCreditFee(
	s: SmokeContext,
	gas: HubGasLimits,
): Promise<{ fee: Record<string, unknown>; ceiling: bigint; limits: HubGasLimits }> {
	const [maxFeesPerGas, info] = await Promise.all([predictedWorstMinFees(s.l2.node), s.l2.node.getNodeInfo()])
	const max = info.txsLimits.gas
	const limits = { daGas: Math.min(gas.daGas, max.daGas), l2Gas: Math.min(gas.l2Gas, max.l2Gas) }
	const fee = {
		paymentMethod: privateFeeJuicePayment(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)),
		gasSettings: { gasLimits: Gas.from(limits), teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }), maxFeesPerGas },
	}
	return { fee, ceiling: privateFpcFeeLimit(limits, maxFeesPerGas), limits }
}

export const privateExitFee = (s: SmokeContext) => privateCreditFee(s, PRIVATE_HUB_EXIT_GAS)

/** The landed exit's bill beside its simulation, and what the FPC took from the credit. Fails the
 *  flow rather than record a hole: missing evidence, a landed fee that is not the simulated gas at
 *  the block's prices, a deduction that is not the ceiling, or a nullifier count that does not move
 *  with the notes spent since the previous sample would each make the reading worthless. */
export async function sampleExitGas(
	s: SmokeContext,
	sample: { label: string; notes: number },
	txHash: string,
	sim: { gasUsed?: GasUsed },
	paid: { charged: bigint; ceiling: bigint; limits: HubGasLimits },
): Promise<void> {
	const { label, notes } = sample
	const receipt = await s.l2.node.getTxReceipt(TxHash.fromString(txHash), { includeTxEffect: true })
	const billed = sim.gasUsed?.billedGas
	if (!billed || receipt.transactionFee === undefined || receipt.blockNumber === undefined || !receipt.txEffect) {
		throw new Error(`${label}: the exit's gas evidence is incomplete (simulated gas, landed fee, block or effects missing)`)
	}
	const fees = (await s.l2.node.getBlockData(receipt.blockNumber))?.header.globalVariables.gasFees
	if (!fees) throw new Error(`${label}: block ${receipt.blockNumber} has no gas prices to bill the exit at`)
	const priced = billed.computeFee(fees).toBigInt()
	if (priced !== receipt.transactionFee) {
		throw new Error(`${label}: landed fee ${receipt.transactionFee} ≠ simulated billed gas at the block's prices ${priced}`)
	}
	if (paid.charged !== paid.ceiling)
		throw new Error(`${label}: the FPC charged ${paid.charged}, not the ceiling ${paid.ceiling} it commits to`)
	const nullifiers = receipt.txEffect.nullifiers.length
	const prev = s.samples.exitGas.at(-1)
	if (prev && nullifiers - prev.nullifiers !== notes - prev.notes) {
		throw new Error(
			`${label}: ${nullifiers} nullifiers after ${prev.nullifiers} (${prev.label}) is not ${notes - prev.notes} more spent note(s)`,
		)
	}
	s.samples.exitGas.push({
		label,
		notes,
		nullifiers,
		simulated: { l2Gas: billed.l2Gas, daGas: billed.daGas },
		fee: receipt.transactionFee,
		feePerL2Gas: fees.feePerL2Gas,
		feePerDaGas: fees.feePerDaGas,
		...paid,
	})
}
