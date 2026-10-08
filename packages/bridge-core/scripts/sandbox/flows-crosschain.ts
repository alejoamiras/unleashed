/**
 * The cross-chain cells: a send that starts on the source anvil, crosses through the Across stand-ins and LI.FI's
 * compiled receiver and Executor into `DepositRouter.bridgeFromCaller`, is found the way the app finds it
 * (`discoverCrossChain`), and is claimed on L2 with the Fee Juice the same send bridged.
 */
import { randomUUID } from "node:crypto"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { BatchCall, type ContractBase } from "@aztec-labs/aztec.js/contracts"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import { Gas } from "@aztec-labs/stdlib/gas"
import { type Address, encodeFunctionData, erc20Abi, type Hex, keccak256, toHex, zeroHash } from "viem"
import z from "zod"
import { buildAcrossV4Deposit } from "../../src/across-v4"
import { deriveTokenClaimSecret } from "../../src/claim-secret"
import { type CrossChainDiscovery, type DepositedFacts, discoverCrossChain } from "../../src/crosschain-discovery"
import { DEPOSIT_ROUTER_ABI } from "../../src/deposit-router-abi"
import { predictedWorstMinFees, publicFeeJuicePayment } from "../../src/fee-juice"
import { type FuelQuote, testnetSwapperFuelProvider } from "../../src/fuel-quote"
import type { CrossChainDepositRecord, DepositFuelBlock, JournalTokenBlock } from "../../src/journal"
import type { LifiSwapData } from "../../src/lifi-abi"
import { LIFI_INTEGRATOR } from "../../src/lifi-api"
import type { RouterIntent } from "../../src/lifi-decode"
import type { ManifestToken } from "../../src/manifest-v2"
import {
	deriveBridgeSecret,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_FUEL_CLAIM_GAS,
	PUBLIC_FUEL_CLAIM_GAS,
	privateFpcFeeLimit,
	privateMintAndPayFee,
} from "../../src/private-fuel"
import type { SendResult } from "../../src/send-flow"
import type { FillDeps } from "../fill-testnet"
import { waitForL1ToL2Message } from "../generation"
import { evmArtifact } from "../script-artifacts"
import { CHAIN_ID, lc, SOURCE_CHAIN_ID } from "./constants"
import {
	balanceOf,
	claim,
	fpcClaimFee,
	fuelClaimFee,
	type HubGasLimits,
	privateCreditOf,
	privateFpc,
	type SmokeContext,
	settled,
	tokenBlockOf,
} from "./context"
import { type CrossChainClients, openCrossChain, sandboxDiscoveryContext, sandboxDiscoveryReads, startSandboxRelayer } from "./crosschain"
import { SET_PAUSED_ABI, TOKEN_PLUS_GAS_FUEL_UNITS } from "./flows"
import type { SandboxHandle } from "./handle"
import { erc20BalanceOf, mint, writeL1 } from "./l1"
import {
	depositsIn,
	type FillWallet,
	type RawLog,
	type Relayer,
	type RelayApi,
	type RelayMode,
	relayHashOf,
	serveRelayApi,
} from "./relayer"

// ─── The rig ─────────────────────────────────────────────────────────────────

/** The cross-chain clients, the relay loop that fills for them, and the loopback Across API that quotes them. */
export interface CrossChainRig {
	cc: CrossChainClients
	relayer: Relayer
	api: RelayApi
	/** Stops the loop (waiting out a fill in flight) and closes the API. */
	close(): Promise<void>
}

/** A rig on `handle`'s cross-chain half; the loop fills from the source's current head on. Throws for a handle
 *  without one. The caller closes it. */
export async function openCrossChainRig(handle: SandboxHandle, mode?: RelayMode): Promise<CrossChainRig> {
	const cc = openCrossChain(handle)
	const relayer = await startSandboxRelayer(cc, mode)
	try {
		const api = await serveRelayApi({
			source: cc.source.pub,
			destination: cc.relayer.pub,
			sourceSpokePool: cc.handle.source.spokePool as Address,
			destinationSpokePool: cc.handle.destination.spokePool as Address,
			relayer,
		})
		return { cc, relayer, api, close: () => Promise.all([relayer.stop(), api.close()]).then(() => undefined) }
	} catch (e) {
		await relayer.stop()
		throw e
	}
}

/** Runs `fn` on a fresh rig and always closes it. */
export async function withCrossChainRig<T>(handle: SandboxHandle, fn: (rig: CrossChainRig) => Promise<T>): Promise<T> {
	const rig = await openCrossChainRig(handle)
	try {
		return await fn(rig)
	} finally {
		await rig.close()
	}
}

// ─── Quote, plan, send ───────────────────────────────────────────────────────

const uintString = z.string().regex(/^\d+$/)
const relayQuoteSchema = z.object({ outputAmount: uintString, timestamp: uintString, fillDeadline: uintString })

export interface RelayQuote {
	outputAmount: bigint
	quoteTimestamp: number
	fillDeadline: number
}

/** `GET /suggested-fees` for `amount` of `inputToken` → `outputToken`, read the way a client reads Across's API. */
export async function quoteRelay(apiUrl: string, q: { inputToken: Address; outputToken: Address; amount: bigint }): Promise<RelayQuote> {
	const params = new URLSearchParams({
		inputToken: q.inputToken,
		outputToken: q.outputToken,
		originChainId: String(SOURCE_CHAIN_ID),
		destinationChainId: String(CHAIN_ID),
		amount: q.amount.toString(),
	})
	const res = await fetch(`${apiUrl}/suggested-fees?${params}`)
	if (!res.ok) throw new Error(`/suggested-fees answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
	const body = relayQuoteSchema.parse(await res.json())
	return { outputAmount: BigInt(body.outputAmount), quoteTimestamp: Number(body.timestamp), fillDeadline: Number(body.fillDeadline) }
}

export type CrossChainShape = { intent: "token+gas" | "gas"; isPrivate: boolean }

/** The L2 secrets a send commits to: what each claim needs, and the hashes the intent carries. */
export interface CrossChainSecrets {
	/** Public: the raw token secret; private: the claim salt the recipient-bound secret derives from. Absent for gas only. */
	tokenClaimValue?: Fr
	tokenSecretHash?: Hex
	fuelSecret: Fr
	fuelSecretHash: Hex
	/** Private fuel only: the salt `deriveBridgeSecret` binds to the claimer. */
	bridgeSalt?: Fr
}

const hashOf = async (secret: Fr): Promise<Hex> => (await computeSecretHash(secret)).toString() as Hex

async function planSecrets(shape: CrossChainShape, claimer: AztecAddress): Promise<CrossChainSecrets> {
	const bridgeSalt = shape.isPrivate ? Fr.random() : undefined
	const fuelSecret = bridgeSalt ? deriveBridgeSecret(bridgeSalt, claimer) : Fr.random()
	const fuel = { fuelSecret, fuelSecretHash: await hashOf(fuelSecret), bridgeSalt }
	if (shape.intent === "gas") return fuel
	const tokenClaimValue = Fr.random()
	const tokenSecret = shape.isPrivate ? deriveTokenClaimSecret(tokenClaimValue, claimer) : tokenClaimValue
	return { ...fuel, tokenClaimValue, tokenSecretHash: await hashOf(tokenSecret) }
}

function intentOf(shape: CrossChainShape, secrets: CrossChainSecrets, recipient: Hex, token: Address, fuel: FuelQuote): RouterIntent {
	return {
		token,
		aztecRecipient: shape.isPrivate || shape.intent === "gas" ? zeroHash : recipient,
		tokenSecretHash: secrets.tokenSecretHash ?? zeroHash,
		isPrivate: shape.isPrivate,
		fuelSlice: fuel.amountIn,
		fuelRecipient: shape.isPrivate ? (PRIVATE_FPC_ADDRESS as Hex) : recipient,
		fuelSecretHash: secrets.fuelSecretHash,
		minFuelOutput: fuel.minOut,
	}
}

function swapperOf(s: SmokeContext): { router: Address; swapper: Address } {
	const { depositRouter, fuelSwapper } = s.clients.deployment
	if (!depositRouter || !fuelSwapper) throw new Error("this sandbox has no DepositRouter — boot a fresh one")
	return { router: depositRouter, swapper: fuelSwapper }
}

/** The swapper's quote for `slice`, floored by the manifest's fuel budgets and bound to this transfer's id. */
async function fuelQuote(s: SmokeContext, token: Address, slice: bigint, transactionId: Hex): Promise<FuelQuote> {
	const budgets = s.bridge.l1.fuel
	if (!budgets) throw new Error("the sandbox manifest carries no bridge.l1.fuel budgets")
	const { router, swapper } = swapperOf(s)
	const abi = evmArtifact("TestnetFuelSwapper").abi
	const provider = testnetSwapperFuelProvider({
		reader: {
			quote: (t, amountIn) =>
				s.l1.pub.readContract({ address: swapper, abi, functionName: "quote", args: [t, amountIn] }) as Promise<bigint>,
		},
		swapper,
		router,
		feeAsset: s.clients.deployment.feeJuice,
		slippageBps: budgets.slippageBps,
		minFuelFj: BigInt(budgets.minFuelFj),
		transactionId,
	})
	const r = await provider.quote(token, slice)
	if (!r.ok) throw new Error(`the swapper gave no fuel quote for ${slice} of ${token}: ${r.reason}`)
	return r.quote
}

/** A send ready to sign, and everything its record and its claims need. */
interface PlannedSend {
	shape: CrossChainShape
	secrets: CrossChainSecrets
	quote: RelayQuote
	user: Address
	srcToken: Address
	inputAmount: bigint
	transactionId: Hex
	intent: RouterIntent
	call: { to: Address; data: Hex }
	token?: JournalTokenBlock
}

function routerStep(router: Address, token: Address, intent: RouterIntent, swapData: Hex, outputAmount: bigint): LifiSwapData {
	return {
		callTo: router,
		approveTo: router,
		sendingAssetId: token,
		receivingAssetId: token,
		fromAmount: outputAmount,
		// Across delivers exactly `outputAmount`, so it is both bounds.
		callData: encodeFunctionData({
			abi: DEPOSIT_ROUTER_ABI,
			functionName: "bridgeFromCaller",
			args: [intent, swapData, outputAmount, outputAmount],
		}),
		requiresDeposit: false,
	}
}

async function planSend(
	s: SmokeContext,
	rig: CrossChainRig,
	shape: CrossChainShape,
	token: ManifestToken,
	amount: bigint,
): Promise<PlannedSend> {
	const { source, destination } = rig.cc.handle
	const outputToken = destination.token as Address
	if (lc(token.erc20) !== lc(outputToken)) throw new Error(`the rail delivers ${outputToken}, not ${token.erc20}`)
	const srcToken = source.token as Address
	const user = rig.cc.source.account.address
	const quote = await quoteRelay(rig.api.url, { inputToken: srcToken, outputToken, amount })
	const transactionId = keccak256(toHex(`unleashed:sandbox:transfer:${randomUUID()}`))
	const secrets = await planSecrets(shape, s.l2.from)
	const slice = shape.intent === "gas" ? quote.outputAmount : TOKEN_PLUS_GAS_FUEL_UNITS * 10n ** BigInt(token.decimals)
	const fuel = await fuelQuote(s, outputToken, slice, transactionId)
	const intent = intentOf(shape, secrets, s.l2.from.toString() as Hex, outputToken, fuel)
	const call = buildAcrossV4Deposit({
		diamond: source.diamond as Address,
		transactionId,
		integrator: LIFI_INTEGRATOR,
		user,
		inputToken: srcToken,
		inputAmount: amount,
		destinationChainId: BigInt(CHAIN_ID),
		destinationReceiver: destination.receiverAcrossV4 as Address,
		outputToken,
		outputAmount: quote.outputAmount,
		quoteTimestamp: quote.quoteTimestamp,
		fillDeadline: quote.fillDeadline,
		steps: [routerStep(swapperOf(s).router, outputToken, intent, fuel.swapData, quote.outputAmount)],
	})
	const tokenBlock = shape.intent === "gas" ? undefined : tokenBlockOf(token)
	return { shape, secrets, quote, user, srcToken, inputAmount: amount, transactionId, intent, call, token: tokenBlock }
}

/** The schema-4 record the app journals for this send, once the source receipt names its hash. */
function recordOf(s: SmokeContext, p: PlannedSend, at: { srcTxHash: Hex; srcFrom: bigint; ethFrom: bigint }): CrossChainDepositRecord {
	const { shape, secrets, intent, quote } = p
	const now = Date.now()
	const id = secrets.tokenSecretHash ?? secrets.fuelSecretHash
	const fuel: DepositFuelBlock = {
		amount: intent.fuelSlice.toString(),
		secret: secrets.fuelSecret.toString(),
		secretHashHex: secrets.fuelSecretHash,
		minOutput: intent.minFuelOutput.toString(),
		...(secrets.bridgeSalt ? { bridgeSecretSalt: secrets.bridgeSalt.toString(), fpc: PRIVATE_FPC_ADDRESS } : {}),
	}
	const leg = p.token
		? {
				intent: "token+gas" as const,
				token: p.token,
				portal: p.token.portal,
				amount: (quote.outputAmount - intent.fuelSlice).toString(),
			}
		: { intent: "gas" as const, portal: s.clients.deployment.feeJuicePortal as string, amount: intent.fuelSlice.toString() }
	return {
		schema: 4,
		id,
		direction: "deposit",
		isPrivate: shape.isPrivate,
		...leg,
		createdAt: now,
		updatedAt: now,
		chainId: CHAIN_ID,
		bridge: s.bridge.l2.hub.address,
		recipient: s.l2.from.toString(),
		secretHashHex: id,
		...(!shape.isPrivate && secrets.tokenClaimValue ? { secret: secrets.tokenClaimValue.toString() } : {}),
		sender: p.user,
		fuel,
		route: {
			provider: "lifi",
			rail: "acrossV4",
			srcChainId: SOURCE_CHAIN_ID,
			srcToken: p.srcToken,
			srcAmount: p.inputAmount.toString(),
			srcSender: p.user,
			srcScanFromBlock: at.srcFrom.toString(),
			srcTxHash: at.srcTxHash,
			lifiTxId: p.transactionId,
			router: swapperOf(s).router,
			minReceived: quote.outputAmount.toString(),
			maxPull: quote.outputAmount.toString(),
			scanFromBlock: at.ethFrom.toString(),
			etaSeconds: 2,
			fillDeadline: quote.fillDeadline,
		},
	}
}

/** A send signed on the source chain: its secrets, its record, and the relay a filler must reproduce. */
export interface CrossChainSend {
	shape: CrossChainShape
	secrets: CrossChainSecrets
	rec: CrossChainDepositRecord
	srcTxHash: Hex
	relayHash: Hex
	/** What Across delivers on L1. */
	outputAmount: bigint
	token?: JournalTokenBlock
}

/** Mints the source token to the user, approves the Diamond for exactly the input, and sends the deposit. */
export async function sendCrossChain(
	s: SmokeContext,
	rig: CrossChainRig,
	shape: CrossChainShape,
	p: { token: ManifestToken; amount: bigint },
): Promise<CrossChainSend> {
	const planned = await planSend(s, rig, shape, p.token, p.amount)
	const src = rig.cc.source
	const [srcFrom, ethFrom] = await Promise.all([src.pub.getBlockNumber(), rig.cc.l1.pub.getBlockNumber()])
	await mint(src, planned.srcToken, planned.user, planned.inputAmount)
	await writeL1(src, planned.srcToken, erc20Abi, "approve", [planned.call.to, planned.inputAmount])
	const hash = await src.wallet.sendTransaction({ ...planned.call, account: src.account, chain: src.wallet.chain } as never)
	const receipt = await src.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`the source deposit ${hash} reverted`)
	const pool = rig.cc.handle.source.spokePool as Address
	const deposit = depositsIn(receipt.logs as RawLog[], pool, BigInt(SOURCE_CHAIN_ID)).find(
		(d) => d.destinationChainId === BigInt(CHAIN_ID),
	)
	if (!deposit) throw new Error(`the source transaction ${hash} logged no FundsDeposited for chain ${CHAIN_ID}`)
	return {
		shape,
		secrets: planned.secrets,
		rec: recordOf(s, planned, { srcTxHash: hash, srcFrom, ethFrom }),
		srcTxHash: hash,
		relayHash: relayHashOf(deposit),
		outputAmount: planned.quote.outputAmount,
		token: planned.token,
	}
}

// ─── Fill and discovery ──────────────────────────────────────────────────────

/** Fills a sent deposit on L1; resolves with the fill's hash. */
export type Filler = (sent: CrossChainSend) => Promise<Hex>

/** The rig's relay loop fills it, as the mode in force when the loop saw it says. */
export const loopFill =
	(rig: CrossChainRig): Filler =>
	async (sent) => {
		const o = await rig.relayer.waitFor(sent.relayHash)
		if (o.state !== "filled") throw new Error(`the relayer left ${sent.relayHash} ${o.state}`)
		return o.fillTxHash
	}

/** `fill-testnet.ts`'s dependencies on the sandbox: the rig's source reads, its L1 filler, and the sandbox pools. */
export const sandboxFillDeps = (rig: CrossChainRig): FillDeps => ({
	source: rig.cc.source.pub,
	destination: { public: rig.cc.relayer.pub, wallet: rig.cc.relayer.wallet as FillWallet },
	sourceSpokePool: rig.cc.handle.source.spokePool as Address,
	destinationSpokePool: rig.cc.handle.destination.spokePool as Address,
})

type SettledDiscovery = Exclude<CrossChainDiscovery, { verdict: "incomplete" } | { verdict: "pending" }>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Discovery re-run until it decides: `incomplete` and `pending` are never answers. */
export async function discoverSettled(
	s: SmokeContext,
	rig: CrossChainRig,
	rec: CrossChainDepositRecord,
	ms = 120_000,
): Promise<SettledDiscovery> {
	const info = await s.l2.node.getNodeInfo()
	const ctx = sandboxDiscoveryContext(
		rig.cc,
		{
			router: swapperOf(s).router,
			feeJuicePortal: s.clients.deployment.feeJuicePortal,
			tokenPortal: rec.intent === "gas" ? undefined : (rec.token.portal as Address),
		},
		{
			address: lc(info.l1ContractAddresses.inboxAddress.toString()),
			rollupVersion: BigInt(info.rollupVersion),
			hub: s.bridge.l2.hub.address as Hex,
		},
	)
	const reads = sandboxDiscoveryReads(rig.cc)
	const until = Date.now() + ms
	for (;;) {
		const d = await discoverCrossChain(rec, ctx, reads)
		if (d.verdict !== "incomplete" && d.verdict !== "pending") return d
		if (Date.now() > until) throw new Error(`discovery stayed ${d.verdict}${d.verdict === "incomplete" ? ` (${d.reason})` : ""}`)
		await sleep(1_000)
	}
}

async function depositedFacts(s: SmokeContext, rig: CrossChainRig, sent: CrossChainSend): Promise<DepositedFacts> {
	const d = await discoverSettled(s, rig, sent.rec)
	if (d.verdict !== "deposited") throw new Error(`discovery says ${d.verdict}, not deposited`)
	return d.deposit
}

/** The claim helpers' view of a discovered deposit: every leaf and amount comes from discovery, none from the plan. */
function sendResultOf(sent: CrossChainSend, d: DepositedFacts): SendResult {
	return {
		txHash: d.depositTxHash,
		token: sent.token,
		tokenClaimValueHex: sent.secrets.tokenClaimValue?.toString(),
		tokenSecretHashHex: sent.secrets.tokenSecretHash,
		tokenLeafIndex: d.token ? BigInt(d.token.leafIndex) : undefined,
		tokenMessageHashHex: d.token?.messageHash,
		fuelSecretHex: sent.secrets.fuelSecret.toString(),
		fuelSecretHashHex: sent.secrets.fuelSecretHash,
		fuelLeafIndex: d.fuel ? BigInt(d.fuel.leafIndex) : undefined,
		fuelMessageHashHex: d.fuel?.messageHash,
		fuelReceived: d.fuel ? BigInt(d.fuel.received) : undefined,
	}
}

// ─── L2 ──────────────────────────────────────────────────────────────────────

/** The limits clamped to what this network admits per transaction; a local network caps DA gas below testnet's. */
async function clampedLimits(s: SmokeContext, gas: HubGasLimits): Promise<HubGasLimits> {
	const max = (await s.l2.node.getNodeInfo()).txsLimits.gas
	return { daGas: Math.min(gas.daGas, max.daGas), l2Gas: Math.min(gas.l2Gas, max.l2Gas) }
}

/** A transaction with no app call, which exists to run its fee payment's setup. Its limits must be explicit: the
 *  estimator has nothing to measure and would commit the network's per-transaction maximum. */
async function sendCarrierless(s: SmokeContext, fee: unknown): Promise<TxHash> {
	const sent = (await new BatchCall(s.l2.wallet as never, []).send({
		from: s.l2.from,
		fee,
		wait: { waitForStatus: TxStatus.PROPOSED },
	} as never)) as unknown as { receipt: { txHash: unknown } }
	return TxHash.fromString(String(sent.receipt.txHash))
}

/** The wallet's anchor can trail the node's message tree by a sync tick after the readiness gate passes. */
async function untilSynced<T>(fn: () => Promise<T>, what: string, attempts = 20): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn()
		} catch (e) {
			if (i >= attempts) throw new Error(`${what} failed ${attempts} times; last: ${errorText(e).slice(0, 300)}`)
			await sleep(3_000)
		}
	}
}

const NO_TEARDOWN = () => Gas.from({ daGas: 0, l2Gas: 0 })

async function selfPayPublic(s: SmokeContext, secrets: CrossChainSecrets, fuel: { received: bigint; leafIndex: bigint }): Promise<string> {
	// The predicted worst fee, unpadded: the claim's whole budget is the bridged amount, as the app commits it.
	const [maxFeesPerGas, limits] = await Promise.all([predictedWorstMinFees(s.l2.node), clampedLimits(s, PUBLIC_FUEL_CLAIM_GAS)])
	const fee = {
		paymentMethod: publicFeeJuicePayment(s.l2.from, {
			claimAmount: fuel.received,
			claimSecret: secrets.fuelSecret,
			messageLeafIndex: fuel.leafIndex,
		}),
		gasSettings: { gasLimits: Gas.from(limits), teardownGasLimits: NO_TEARDOWN(), maxFeesPerGas },
	}
	const before = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	const txHash = await untilSynced(() => sendCarrierless(s, fee), "the self-paying Fee Juice claim")
	const charged = (await s.l2.node.getTxReceipt(txHash)).transactionFee ?? 0n
	if (charged <= 0n) throw new Error("the self-paying claim landed without a fee: something else paid it")
	const net = fuel.received - charged
	const after = await settled(
		() => balanceOf(s.feeJuiceL2, s.l2.from, "public"),
		(v) => v - before >= net,
		"the public Fee Juice after the self-paid claim",
	)
	if (after - before !== net) throw new Error(`the claim left ${after - before} FJ-wei, expected ${fuel.received} − ${charged}`)
	return `claim_and_end_setup with no app call: +${net} FJ-wei (${fuel.received} bridged − the ${charged} it paid for itself)`
}

async function selfPayPrivate(s: SmokeContext, secrets: CrossChainSecrets, fuel: { received: bigint; leafIndex: bigint }): Promise<string> {
	const fpc = await privateFpc(s)
	const salt = secrets.bridgeSalt
	if (!salt) throw new Error("a private fuel send needs its bridge-secret salt")
	const [maxFeesPerGas, limits] = await Promise.all([predictedWorstMinFees(s.l2.node), clampedLimits(s, PRIVATE_FUEL_CLAIM_GAS)])
	// `mint_and_pay_fee` credits the claim minus the whole ceiling: there is no refund.
	const net = fuel.received - privateFpcFeeLimit(limits, maxFeesPerGas)
	const fee = {
		paymentMethod: privateMintAndPayFee(
			AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS),
			fuel.received,
			deriveBridgeSecret(salt, s.l2.from),
			salt,
			new Fr(fuel.leafIndex),
		),
		gasSettings: { gasLimits: Gas.from(limits), teardownGasLimits: NO_TEARDOWN(), maxFeesPerGas },
	}
	const before = await privateCreditOf(s, fpc)
	await untilSynced(() => sendCarrierless(s, fee), "the PrivateFPC's mint_and_pay_fee")
	const after = await settled(
		() => privateCreditOf(s, fpc),
		(v) => v - before >= net,
		"the private credit after mint_and_pay_fee",
	)
	if (after - before !== net) throw new Error(`mint_and_pay_fee credited ${after - before} FJ-wei, expected ${net}`)
	s.credit.notes.push(net)
	return `mint_and_pay_fee with no app call: +${net} FJ-wei of private credit (${fuel.received} bridged − the fee ceiling)`
}

// ─── Cells ───────────────────────────────────────────────────────────────────

const wholeUnits = (token: ManifestToken, n: bigint) => n * 10n ** BigInt(token.decimals)

/**
 * Token + gas from the source chain: both legs land through one router call, and the L2 claim is paid by the fuel the
 * same send bridged — publicly by `claim_and_end_setup`, privately by the PrivateFPC's `mint_and_pay_fee`.
 */
export async function flowCrossChainTokenPlusGas(
	s: SmokeContext,
	rig: CrossChainRig,
	token: ManifestToken,
	l2Token: ContractBase,
	isPrivate: boolean,
	fill: Filler = loopFill(rig),
): Promise<string> {
	const sent = await sendCrossChain(s, rig, { intent: "token+gas", isPrivate }, { token, amount: wholeUnits(token, 100n) })
	await fill(sent)
	const d = await depositedFacts(s, rig, sent)
	if (!d.token || !d.fuel) throw new Error("a token+gas deposit was discovered without both legs")
	const res = sendResultOf(sent, d)
	const amount = BigInt(d.token.amount)
	await waitForL1ToL2Message(s.l2.node, d.fuel.messageHash, { forceBlock: s.l2.forceBlock })
	const kind = isPrivate ? "private" : "public"
	// The wallet must hold the PrivateFPC's instance before it can build a fee paid through it.
	if (isPrivate) await privateFpc(s)
	const before = await balanceOf(l2Token, s.l2.from, kind)
	const fee = isPrivate ? await fpcClaimFee(s, res, sent.secrets.bridgeSalt as Fr) : fuelClaimFee(s, res)
	const outcome = await claim(s, res, { amount, isPrivate, recipient: s.l2.from, fee, feeMode: isPrivate ? "private-fpc" : "fee-juice" })
	const after = await settled(
		() => balanceOf(l2Token, s.l2.from, kind),
		(v) => v - before >= amount,
		`the ${kind} balance after the claim`,
	)
	if (after - before !== amount) throw new Error(`the ${kind} claim credited ${after - before}, the router deposited ${amount}`)
	return `${outcome.path} ${kind}: ${amount} through ReceiverAcrossV4 → Executor → router, paid by the ${d.fuel.received} FJ-wei it bridged`
}

/** Gas only from the source chain: the whole delivery becomes Fee Juice, claimed by a transaction with no app call
 *  that pays for itself — into the account's public balance, or into PrivateFPC credit. */
export async function flowCrossChainFuelOnly(
	s: SmokeContext,
	rig: CrossChainRig,
	token: ManifestToken,
	isPrivate: boolean,
	fill: Filler = loopFill(rig),
): Promise<string> {
	const sent = await sendCrossChain(s, rig, { intent: "gas", isPrivate }, { token, amount: wholeUnits(token, 50n) })
	await fill(sent)
	const d = await depositedFacts(s, rig, sent)
	if (d.token || !d.fuel) throw new Error("a gas-only deposit was discovered with a token leg or without fuel")
	if (BigInt(d.fuel.consumed) !== sent.outputAmount)
		throw new Error(`the swap consumed ${d.fuel.consumed} of a ${sent.outputAmount} delivery`)
	await waitForL1ToL2Message(s.l2.node, d.fuel.messageHash, { forceBlock: s.l2.forceBlock })
	const fuel = { received: BigInt(d.fuel.received), leafIndex: BigInt(d.fuel.leafIndex) }
	return isPrivate ? selfPayPrivate(s, sent.secrets, fuel) : selfPayPublic(s, sent.secrets, fuel)
}

/** The destination token at the user and every contract the delivery crosses, and Fee Juice wherever a swap could
 *  have left it. */
async function railBalances(s: SmokeContext, rig: CrossChainRig, token: ManifestToken): Promise<Map<string, bigint>> {
	const dest = rig.cc.handle.destination
	const { router, swapper } = swapperOf(s)
	const { feeJuice, feeJuicePortal } = s.clients.deployment
	const erc20 = token.erc20 as Address
	const watched: [string, Address, Address][] = [
		["the user", erc20, rig.cc.l1.account.address],
		["the router", erc20, router],
		["the Executor", erc20, dest.executor as Address],
		["the receiver", erc20, dest.receiverAcrossV4 as Address],
		["the swapper", erc20, swapper],
		["the token portal", erc20, token.portal as Address],
		["the router's Fee Juice", feeJuice, router],
		["the swapper's Fee Juice", feeJuice, swapper],
		["the FeeJuicePortal", feeJuice, feeJuicePortal],
	]
	const values = await Promise.all(watched.map(([, asset, at]) => erc20BalanceOf(s.l1, asset, at)))
	return new Map(watched.map(([label], i) => [label, values[i] as bigint]))
}

function assertOnlyTheUserGained(before: Map<string, bigint>, after: Map<string, bigint>, amount: bigint): void {
	for (const [label, was] of before) {
		const moved = (after.get(label) ?? 0n) - was
		const want = label === "the user" ? amount : 0n
		if (moved !== want) throw new Error(`${label} moved by ${moved}, expected ${want}`)
	}
}

/**
 * Deposits paused on the factory: the router refuses the Executor's call, ReceiverAcrossV4 recovers the whole delivery
 * to the user's L1 address, and nothing stays on the way. The switch is always flipped back.
 */
export async function flowCrossChainPausedRecovers(s: SmokeContext, rig: CrossChainRig, token: ManifestToken): Promise<string> {
	const factory = s.bridge.l1.factory as Address
	await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [true, false])
	try {
		const before = await railBalances(s, rig, token)
		const sent = await sendCrossChain(s, rig, { intent: "token+gas", isPrivate: false }, { token, amount: wholeUnits(token, 100n) })
		await loopFill(rig)(sent)
		const d = await discoverSettled(s, rig, sent.rec)
		if (d.verdict !== "delivered-to-wallet") throw new Error(`a paused router's delivery was discovered as ${d.verdict}`)
		if (d.observation.amount !== sent.outputAmount.toString()) {
			throw new Error(`the recovery observed ${d.observation.amount}, Across delivered ${sent.outputAmount}`)
		}
		assertOnlyTheUserGained(before, await railBalances(s, rig, token), sent.outputAmount)
		return `deposits paused: the Executor's call reverted, ${sent.outputAmount} recovered to the user's L1 address, nothing left on the way`
	} finally {
		await writeL1(s.l1, factory, SET_PAUSED_ABI, "setPaused", [false, false])
	}
}
