/**
 * The send: ONE Ethereum transaction that moves a token (with or without a gas slice), or gas
 * alone, into the generation — then the journal engine's claim through the hub.
 *
 * Two orderings are load-bearing. The wallet grant is raised FIRST, before the Permit2 signature,
 * so a declined prompt cancels with nothing signed and nothing on chain. And the words the factory
 * FROZE at creation are authoritative: the block written before the transaction is a prediction,
 * and the receipt's read-back replaces it (re-granting when it names a different L2 token) before
 * anything is claimed against it.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import {
	type EncryptionKey,
	type JournalTokenBlock,
	type L1Ctx,
	type Registration,
	type SendDepositRecord,
	type SendGasLeg,
	type SendOpts,
	type SendParams,
	type SendResult,
	type SendStage,
	PERMIT_DEADLINE_SECONDS,
	PRIVATE_FPC_ADDRESS,
	claimSendOpts,
	claimViaHub,
	deriveBridgeSecret,
	deriveTokenClaimSecret,
	feeJuiceAddress,
	hubAt,
	hubTokenFor,
	isProvisionalRecordId,
	l1ToL2MessageReadiness,
	makeProvisionalDepositId,
	readRegistration,
	runSend,
} from "@unleashed/bridge-core"
import type { Hex, PublicClient } from "viem"
import { type Ref, effectScope, ref, watch } from "vue"
import {
	FUEL_PORTAL,
	HUB,
	LEGACY_ROUTERS,
	MANIFEST_CHAIN,
	SEND_GENERATION,
	TOKEN_CLASS_ID,
	rebuildHubTokenInstance,
} from "@/contracts/bridge-generation"
import { classifyClaimReceipt } from "@/lib/claim-receipt"
import { NETWORK } from "@/lib/network"
import type { GasLegPlan, GrantOutcome, SendPlan } from "@/lib/send-model"
import { fuelRecipientFor } from "@/lib/fuel-target"
import { normalizeError } from "@/lib/errors"
import { humanizeWalletError } from "@/lib/wallet-errors"
import { webJournalLocks } from "@/lib/journal-locks"
import { PROMPT_WAIT_MS, PROMPTS_STALLED, promptsSettled } from "@/lib/prompt-queue"
import { findDepositTx } from "./deposit-reconcile"
import { sliceSwapData } from "./useFuelQuote"
import { reconcileFuelConsumed } from "./fuel-recovery"
import { hubMessageState } from "@/lib/message-nullifier"
import { resolveToolsTarget } from "@/lib/network-targets"
import {
	type ClaimRecord,
	addRecordVerified,
	attestSendTokenBlocks,
	connectJournalDeps,
	discard,
	flagRecordError,
	markSessionLive,
	rekeyJournalRecord,
	resumeSessionWork,
	runDepositClaim,
	setRecordStep,
	updateRecord,
	useBridgeJournal,
	markGrantOutcome,
} from "./useBridgeJournal"
import {
	type HubClaimFee,
	buildFeeJuiceClaimDep,
	ensurePermit2Approval,
	failStopInteraction,
	recoverDepositLeg,
	resolveHubClaimSendOpts,
	sealPrivateRecord,
} from "./deposit-flow"
import { fuelOverrideActive, launchStandaloneFuelClaim } from "./fuel-recovery"
import { type FuelClaimRetry, simulateFeePayload } from "./fuelClaim"
import { useBridgeWallet } from "./useBridgeWallet"
import { useL1Wallet } from "./useL1Wallet"
import { withOperation } from "./useOpsInFlight"
import {
	contractsReadinessRefusal,
	requestHubToken,
	retainPinnedHubTokens,
	retryOnUnregistered,
	useWalletConnection,
} from "./useWalletConnection"
import { useTokenGrant } from "./useTokenGrant"

// Ids, stages and tx hashes ONLY - secrets, salts, amounts and addresses never reach this log.
const log = (...args: unknown[]) => console.log("[bridge:send]", ...args)

const NODE_URL = NETWORK.nodeUrl

// The finalized-envelope re-seal key, held in memory only for records this session sealed.
const sealKeys = new Map<string, EncryptionKey>()

/** Same-session retained seal key - lets a backup export of a record sealed here skip the signature. */
export function getRetainedSealKey(id: string): EncryptionKey | undefined {
	return sealKeys.get(id)
}

function generation() {
	if (!SEND_GENERATION || !HUB || !TOKEN_CLASS_ID) throw new Error("This network has no bridge.")
	return SEND_GENERATION
}

/** The attached L1 client, asked for its OWN chain id at the last moment. `wrongChain` is a
 *  reactive display flag fed by `chainChanged`; a wallet switched between the panel's read and the
 *  act would otherwise sign a chain-bound Permit2 witness — or answer portal and pause reads — on a
 *  chain where none of the generation's addresses mean anything. Both lanes and the L1 finalization
 *  re-ask, because each is a separate window. */
export async function assertL1Chain(l1: { publicClient: { getChainId: () => Promise<number> } }): Promise<void> {
	const live = await l1.publicClient.getChainId()
	if (live !== MANIFEST_CHAIN.l1ChainId) {
		throw new Error(
			`Your Ethereum wallet is on chain ${live}, but this bridge lives on chain ${MANIFEST_CHAIN.l1ChainId}. Switch networks and try again — nothing was sent.`,
		)
	}
}

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
const tokenClaimAmount = (plan: SendPlan): bigint => (plan.intent === "gas" ? plan.amount : plan.amount - (plan.gas?.fuelAmount ?? 0n))

function fuelBlockOf(gas: GasLegPlan, secretHex: string, secretHashHex: string, salt?: Fr) {
	return {
		amount: gas.fuelAmount.toString(),
		secret: secretHex,
		secretHashHex,
		minOutput: gas.minFuelOutput.toString(),
		...(salt ? { bridgeSecretSalt: salt.toString(), fpc: PRIVATE_FPC_ADDRESS } : {}),
	}
}

interface RecordInputs {
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

function buildSendRecord(i: RecordInputs): SendDepositRecord {
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

/** The gas leg as bridge-core wants it. Private gas MUST use `deriveBridgeSecret`: the PrivateFPC
 *  re-derives that secret from msg_sender, so a random one would strand the Fee Juice forever. */
function gasLegOf(gas: GasLegPlan, swapData: Hex, recipient: string, isPrivate: boolean, salt?: Fr): SendGasLeg {
	return {
		fuelAmount: gas.fuelAmount,
		fuelRecipient: fuelRecipientFor(isPrivate, recipient),
		minFuelOutput: gas.minFuelOutput,
		swapData,
		...(salt ? { fuelSecret: deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(recipient)) } : {}),
	}
}

/** Every leg's L1-committed hash is known before the signature, so the record that recovers a
 *  crashed send can be written first. The token leg names the record; a gas-only send is named by
 *  its own Fee Juice message. */
const recordIdOf = (s: { tokenSecretHashHex?: string; fuelSecretHashHex?: string }): string | undefined =>
	s.tokenSecretHashHex ?? s.fuelSecretHashHex

let depsWired = false
let pinAttestationWired = false

/** Test-only: let a case re-wire the engine after resetting it. */
export function __resetSendDepsForTests(): void {
	depsWired = false
	pinAttestationWired = false
}

/** The journal's store is the browser's; outside a DOM the engine keeps whatever it was given. */
const browserKv = () => (typeof localStorage === "undefined" ? {} : { kv: localStorage })

/** The generation every schema-3 record must belong to; both send lanes wire the same one. */
export const sendBindingOf = () =>
	SEND_GENERATION && HUB
		? {
				factory: SEND_GENERATION.factory,
				implementation: SEND_GENERATION.implementation,
				hub: HUB.toString(),
				feeJuicePortal: FUEL_PORTAL,
			}
		: undefined

/** Wire the send lane's chain deps into the journal engine (idempotent; real clients only). */
export function ensureSendJournalDeps(): void {
	if (depsWired) return
	depsWired = true
	const l1 = useL1Wallet()
	const bridgeWallet = useBridgeWallet()
	connectJournalDeps({
		...browserKv(),
		connectedL1: () => l1.address.value,
		connectedAztec: () => bridgeWallet.selectedAccount.value,
		signL1: (message) => signL1With(l1, message),
		sendBinding: sendBindingOf,
		validateTokenBlock: (token) => validateTokenBlock(token, l1),
		ensureTokenGrant: (token) => grantForBlock(token),
		claimSend: (rec, claimValueHex, envelope) => buildHubClaim({ rec, claimValueHex, sealedSalt: envelope?.salt }, bridgeWallet),
		// The only deposit that does NOT go through the hub is a gas-only one: it claims Fee Juice.
		claim: async (rec, secretHex, envelope) => {
			const aztec = bridgeWallet.wallet.value
			if (!aztec) throw new Error("Connect your Aztec wallet first.")
			return buildFeeJuiceClaimDep(rec, secretHex, envelope, aztec, (op) => retryOnUnregistered(bridgeWallet, aztec, op))
		},
		recoverDepositLeg: (rec) => recoverDepositLeg(rec, l1.publicClient as never, SEND_GENERATION),
		findDepositTx: (rec) =>
			SEND_GENERATION
				? findDepositTx(rec, l1.publicClient as never, {
						chainId: MANIFEST_CHAIN.l1ChainId,
						router: SEND_GENERATION.router,
						legacyRouters: LEGACY_ROUTERS,
						chainEpoch: () => l1.chainChanges.value,
					})
				: Promise.resolve("incomplete" as const),
		retainPinnedTokens: (needed) => retainPinnedHubTokens(needed),
		l2BlockNumber: async () => Number(await createAztecNodeClient(NODE_URL).getBlockNumber()),
		messageReadiness: (messageHash) => messageReadiness(messageHash),
		messageNullified: (rec, material) =>
			hubMessageState(
				rec,
				material,
				resolveToolsTarget(),
				async (nullifier) =>
					(await createAztecNodeClient(NODE_URL).getNullifierMembershipWitness("checkpointed", nullifier)) !== undefined,
			),
		reconcileFuel: (id) => reconcileFuelConsumed(id),
		claimReceiptStatus: (txHash) => claimReceiptStatus(txHash),
		locks: webJournalLocks(),
	})
}

function signL1With(l1: ReturnType<typeof useL1Wallet>, message: string): Promise<string> {
	const wallet = l1.ensureWalletClient()
	const account = l1.address.value
	if (!wallet || !account) throw new Error("Connect your Ethereum wallet first.")
	return wallet.signMessage({ account, message } as never) as Promise<string>
}

const messageReadiness = (messageHash: string) => l1ToL2MessageReadiness(createAztecNodeClient(NODE_URL), messageHash)

async function claimReceiptStatus(txHash: string) {
	try {
		const receipt = await createAztecNodeClient(NODE_URL).getTxReceipt(TxHash.fromString(txHash))
		return classifyClaimReceipt(receipt as { status?: unknown; executionResult?: unknown })
	} catch (e) {
		// A dead RPC must read as connectivity, never as a slow claim.
		log("receipt lookup failed:", e instanceof Error ? e.message : String(e))
		return "unreachable" as const
	}
}

/** The register key/index are compared only when the block declares them: a record written before
 *  its receipt carries the wizard's prediction, which never had them. Omitting them buys nothing —
 *  the words, decimals and derived L2 token below still pin the block to exactly one token, and a
 *  first claim without a register index fails loudly at the hub instead. */
function registrationDiffers(reg: Registration, token: JournalTokenBlock): boolean {
	if (token.registerKey !== undefined && reg.registerKey !== token.registerKey) return true
	return token.registerIndex !== undefined && reg.registerIndex.toString() !== token.registerIndex
}

/**
 * The authoritative resume/import check: the factory's frozen registration must still name the
 * block's words, decimals and register key/index, and the hub's derivation from those words must
 * still land on the block's L2 token. Returns the refusal reason, or null when it all holds.
 */
export async function validateTokenBlock(token: JournalTokenBlock, l1 = useL1Wallet()): Promise<string | null> {
	const gen = SEND_GENERATION
	if (!gen || !HUB || !TOKEN_CLASS_ID) return "This network has no bridge — this record cannot run here."
	// A registration read on another chain answers "no portal" for every genuine block, and that
	// answer would be terminal. The chain is asserted on both sides of the read: a wallet that
	// switched mid-read throws (unavailable), it never contradicts.
	await assertL1Chain(l1)
	const reg = await readRegistration(l1.publicClient as never, gen.factory as `0x${string}`, token.erc20 as `0x${string}`)
	await assertL1Chain(l1)
	if (!reg) return "Ethereum has no portal for this token any more — this record cannot be claimed here."
	const sameWords = reg.nameWord === token.nameWord && reg.symbolWord === token.symbolWord && reg.decimals === token.decimals
	if (!sameWords || registrationDiffers(reg, token)) {
		return "This token's registration on Ethereum no longer matches this record. It has been stopped for your safety."
	}
	const derived = await deriveBlockToken(token)
	if (derived.toLowerCase() !== token.l2Token.toLowerCase()) {
		return "This record names an Aztec token the registration does not derive. It has been stopped for your safety."
	}
	return null
}

async function deriveBlockToken(token: JournalTokenBlock): Promise<string> {
	const inst = await rebuildHubTokenInstance(token.erc20, {
		nameWord: token.nameWord,
		symbolWord: token.symbolWord,
		decimals: token.decimals,
	})
	return inst.address.toString()
}

/** The journal's view of a token: only its identity fields (address, words, decimals, L2 token)
 *  reach the grant, which is exactly what the wallet is asked to authorize. */
function grantForBlock(token: JournalTokenBlock) {
	// Pinned: browsing a long list of exit tokens must never evict the grant a journal record needs.
	requestHubToken(hubTokenDesc(token), { pinned: true })
	return useTokenGrant().ensureGranted(
		{
			chainId: NETWORK.l1ChainId,
			address: token.erc20 as `0x${string}`,
			symbol: token.displaySymbol,
			name: token.displaySymbol,
			decimals: token.decimals,
			source: "manifest",
			logoKey: `${NETWORK.l1ChainId}:${token.erc20}`,
			state: { kind: "first-time" },
			portal: token.portal as `0x${string}`,
			words: { nameWord: token.nameWord as `0x${string}`, symbolWord: token.symbolWord as `0x${string}` },
			l2Token: token.l2Token as `0x${string}`,
		},
		() => 0,
	)
}

type HubHandles = { simulate: () => Promise<unknown>; send: () => Promise<{ txHash: string; registerTxHash?: string }> }

/** A stop from the fee ladder reaches the engine as a failing interaction, exactly as it does on
 *  the token-bridge claim: the engine surfaces the reason on the card and never sends. */
const stopHandles = (fee: Extract<HubClaimFee, { kind: "stop" }>): HubHandles => failStopInteraction(fee.why, fee.sendWhy) as HubHandles

/** `sealedSalt` is the gas salt the engine unsealed from this record's envelope — authenticated,
 *  unlike the journal's plaintext copy, and so the one the private fee ladder rebuilds from. */
async function buildHubClaim(
	claim: { rec: SendDepositRecord; claimValueHex: string; sealedSalt?: string },
	bridgeWallet: ReturnType<typeof useBridgeWallet>,
): Promise<HubHandles> {
	const { rec, claimValueHex, sealedSalt } = claim
	const aztec = bridgeWallet.wallet.value
	if (!aztec || !HUB) throw new Error("Connect your Aztec wallet first.")
	const recipientAddr = AztecAddress.fromStringUnsafe(rec.recipient)
	const hub = hubAt(aztec as never, HUB.toString())
	// Whether THIS claim registers the token is a live fact (someone may have registered it since
	// the send): it decides which transaction spends the fuel, and what a claim from held gas sets
	// aside; the hub re-checks at send time.
	const registers = (await hubTokenFor(hub, (rec.token as JournalTokenBlock).erc20, rec.recipient)) === undefined
	const fee = await resolveHubClaimSendOpts({
		rec,
		recipientAddr,
		aztec,
		sealedSalt,
		userOverride: fuelOverrideActive(rec.id),
		registers,
	})
	if (fee.kind === "stop") return stopHandles(fee)
	const params = {
		token: rec.token as JournalTokenBlock,
		recipient: rec.recipient,
		amount: BigInt(rec.amount),
		claimValue: Fr.fromString(claimValueHex),
		leafIndex: BigInt(rec.leafIndex ?? "0"),
		isPrivate: rec.isPrivate,
		from: rec.recipient,
	}
	return {
		simulate: () => probeHubClaim(hub, params, fee.opts, aztec, (op) => retryOnUnregistered(bridgeWallet, aztec, op)),
		send: async () => {
			const { seams, fuelOnRegistration } = hubClaimSeams(rec.id, fee)
			try {
				const outcome = await claimViaHub(hub, params, { ...fee.opts, ...seams })
				if (!fuelOnRegistration()) fee.onTxHash?.(outcome.claimTxHash)
				// The ladder left the bridged Fee Juice for a transaction of its own; fire it now the
				// claim is away, or the gas never arrives.
				if (fee.standalone) void launchStandaloneFuelClaim(rec.id, aztec, recipientAddr, fee.standalone)
				return { txHash: outcome.claimTxHash, registerTxHash: outcome.registerTxHash }
			} catch (e) {
				fee.onFailure?.(e)
				throw e
			}
		},
	}
}

/** The seams a hub claim hands to bridge-core: the fuel's attempt and hash latch against the
 *  transaction that actually spends it — the registration when the ladder put the fuel there and
 *  this call did register, else the claim — and the registration is journalled the moment its hash
 *  exists, with the wait for the claimer's own view narrated in between. */
function hubClaimSeams(id: string, fee: Extract<HubClaimFee, { kind: "opts" }>) {
	let registeredHere = false
	const fuelOnRegistration = () => registeredHere && fee.fuelOnRegister === true
	const seams: SendOpts = {
		// The wallet hands the registration's receipt back before it is mined; the node says how it ended.
		receiptOf: (txHash) => createAztecNodeClient(NODE_URL).getTxReceipt(TxHash.fromString(txHash)),
		onRegisterSend: () => {
			if (fee.fuelOnRegister) fee.onAttempt?.()
		},
		onRegistered: (registerTxHash: string) => {
			registeredHere = true
			if (fee.fuelOnRegister && fee.onRegistered) fee.onRegistered(registerTxHash)
			else updateRecord(id, { registerTxHash } as never)
			setRecordStep(id, "sending", "registered — preparing the claim")
		},
		onClaimSend: () => {
			if (!fuelOnRegistration()) fee.onAttempt?.()
			if (registeredHere) setRecordStep(id, "sending", "confirm the claim in your Aztec wallet")
		},
	}
	return { seams, fuelOnRegistration }
}

type HubContract = ReturnType<typeof hubAt>
type ProbeParams = Parameters<typeof claimViaHub>[1]

/**
 * The consumability probe. A FIRST claim cannot be simulated - registering enqueues the derived
 * Token's constructor, which no wallet can build against an instance it does not hold yet - so
 * for an unregistered token the fuel the registration spends is probed on its own (the fee's
 * setup as a whole transaction) and otherwise the checkpoint gate is the only readiness
 * authority. A registered token probes the real claim, which is what makes the engine wait out a
 * message that has not folded into the L2 yet.
 */
async function probeHubClaim(
	hub: HubContract,
	p: ProbeParams,
	opts: Record<string, unknown>,
	aztec: unknown,
	retry?: FuelClaimRetry,
): Promise<unknown> {
	if (!(await hubTokenFor(hub, p.token.erc20, p.from))) {
		const registerFee = opts.registerFee as { paymentMethod: unknown } | undefined
		return registerFee ? simulateFeePayload(aztec, AztecAddress.fromStringUnsafe(p.recipient), registerFee, retry) : {}
	}
	const to = AztecAddress.fromStringUnsafe(p.recipient)
	const l2Token = AztecAddress.fromStringUnsafe(p.token.l2Token)
	const call = p.isPrivate
		? hub.methods.claim_private(l2Token, to, p.amount, p.claimValue, new Fr(p.leafIndex))
		: hub.methods.claim_public(l2Token, to, p.amount, p.claimValue, new Fr(p.leafIndex))
	return call.simulate(claimSendOpts(opts) as never)
}

interface SendActors {
	l1: ReturnType<typeof useL1Wallet>
	recipient: string
	from: `0x${string}`
	wallet: unknown
}

/** The key domain a private record's envelope is sealed under: the SAME binding the record carries,
 *  because that is what the unseal re-derives the key from. A gas-only send is bound to the Fee
 *  Juice portal, everything else to ITS token's clone and the hub. */
const sealBindingOf = (plan: SendPlan) => ({
	chainId: NETWORK.l1ChainId,
	portal: plan.intent === "gas" ? FUEL_PORTAL : plan.token.portal,
	bridge: plan.intent === "gas" ? feeJuiceAddress.toString() : (HUB as AztecAddress).toString(),
})

/**
 * The pre-signature seal of a private send. `secret` is the credential the claim spends — the token
 * claim salt, or the gas salt when gas is all this send bought — and `salt` is the gas leg's own,
 * sealed alongside it: the PrivateFPC rebuilds the Fee Juice secret from that salt, so a fueled
 * record whose envelope omits it can be restored and still never claim its gas.
 */
async function sealSend(id: string, plan: SendPlan, prepared: Prepared, actors: SendActors, records: () => ClaimRecord[]): Promise<void> {
	const credential = prepared.claimSalt ?? prepared.fuelSalt
	if (!credential) return
	await sealPrivateRecord({
		id,
		secretStr: credential.toString(),
		fuelSaltStr: prepared.fuelSalt?.toString(),
		recipient: actors.recipient,
		tokenAmountStr: tokenClaimAmount(plan).toString(),
		from: actors.from,
		wallet: actors.wallet as never,
		sealKeys,
		readBack: () => records().find((r) => r.id === id) as never,
		binding: sealBindingOf(plan),
	})
}

export interface SendComposable {
	/** The record id, or "" when the send was cancelled before anything existed (see `error`). */
	send(plan: SendPlan): Promise<string>
	stage: Ref<SendStage | null>
	busy: Ref<boolean>
	error: Ref<string | null>
	dispose(): void
}

interface SendDeps {
	l1: ReturnType<typeof useL1Wallet>
	bridgeWallet: ReturnType<typeof useBridgeWallet>
	journal: ReturnType<typeof useBridgeJournal>
	grant: ReturnType<typeof useTokenGrant>
	stage: Ref<SendStage | null>
	busy: Ref<boolean>
	error: Ref<string | null>
	epoch: () => number
}

const failWith = (error: Ref<string | null>, message: string): string => {
	error.value = message
	return ""
}

/**
 * The wallet's token permission, BEFORE the Ethereum signature: a declined or superseded grant
 * cancels with nothing signed and nothing on chain, and a wallet that errors instead of answering
 * is a failure the caller reads from `error`, never an exception escaping the click. Resolves to
 * whether THIS run raised the prompt (the rail shows it as the run's first phase), or to the
 * refusal to report.
 */
async function ensureSendGrant(plan: SendPlan, d: SendDeps): Promise<{ granted: boolean } | { refused: string }> {
	if (plan.intent === "gas") return { granted: false }
	const granted = !d.grant.isGranted(plan.token.l2Token)
	let outcome: GrantOutcome
	try {
		outcome = await d.grant.ensureGranted(plan.token, d.epoch)
	} catch (e) {
		return { refused: humanizeWalletError(e instanceof Error ? e.message : String(e)) }
	}
	return outcome === "granted" ? { granted } : { refused: grantRefusal(outcome) }
}

/**
 * Read only once every prompt queued ahead of the send has settled: a quiet re-grant, this token's
 * or another's, holds the contracts unregistered until its re-registration lands, and another
 * token's re-grant replaces the whole grant, so this token's may be gone by then.
 */
async function settledRefusal(plan: SendPlan, d: SendDeps): Promise<string | undefined> {
	if (!(await promptsSettled(PROMPT_WAIT_MS))) return PROMPTS_STALLED
	const notReady = contractsReadinessRefusal(d.bridgeWallet)
	if (notReady) return notReady
	if (plan.intent !== "gas" && !d.grant.isGranted(plan.token.l2Token)) return grantRefusal("declined")
	return undefined
}

async function performSend(plan: SendPlan, d: SendDeps): Promise<string> {
	d.error.value = null
	d.stage.value = null
	const wallet = d.l1.ensureWalletClient()
	const from = d.l1.address.value
	const recipient = d.bridgeWallet.selectedAccount.value
	if (!wallet || !from) return failWith(d.error, "Connect your Ethereum wallet first.")
	if (!recipient) return failWith(d.error, "Connect your Aztec wallet first.")
	// The chain before the grant: a token resolved on another chain would otherwise leave a stale
	// exact-address grant in the Aztec wallet for an L2 token that never existed.
	try {
		await assertL1Chain(d.l1)
	} catch (e) {
		return failWith(d.error, e instanceof Error ? e.message : String(e))
	}
	const grant = await ensureSendGrant(plan, d)
	if ("refused" in grant) return failWith(d.error, grant.refused)
	const refusal = await settledRefusal(plan, d)
	if (refusal) return failWith(d.error, refusal)
	const { granted } = grant
	d.busy.value = true
	try {
		return await executeSend({
			plan,
			actors: { l1: d.l1, recipient, from, wallet },
			journal: d.journal,
			stage: d.stage,
			error: d.error,
			granted,
		})
	} catch (e) {
		return failWith(d.error, sendFailureCopy(e))
	} finally {
		d.busy.value = false
	}
}

export function useSend(opts: { epoch?: () => number } = {}): SendComposable {
	ensureSendJournalDeps()
	const stage = ref<SendStage | null>(null)
	const busy = ref(false)
	const error = ref<string | null>(null)
	const grant = useTokenGrant()
	let localEpoch = 0
	const deps: SendDeps = {
		l1: useL1Wallet(),
		bridgeWallet: useBridgeWallet(),
		journal: useBridgeJournal(),
		grant,
		stage,
		busy,
		error,
		// Without an owning selection, every send is its own epoch: a completion for a superseded
		// one is discarded rather than applied to the plan on screen now.
		epoch: opts.epoch ?? (() => localEpoch),
	}
	bootJournalGrants()

	function send(plan: SendPlan): Promise<string> {
		localEpoch++
		return withOperation(() => performSend(plan, deps))
	}

	return {
		send,
		stage,
		busy,
		error,
		dispose: () => {
			localEpoch++
			grant.dispose()
		},
	}
}

/** The grant set the FIRST capability request carries covers every token the journal already
 *  holds, so a resumed lane never raises a prompt the user did not expect - but only once the
 *  factory has vouched for each block. */
function bootJournalGrants(): void {
	wirePinAttestation()
	if (useWalletConnection().status.value === "connected") resumeSessionWork()
}

/**
 * A persisted token block is attacker-writable, and pinning one asks the wallet to grant — and
 * registers a contract instance for — the words it names. So the factory's frozen registration
 * attests every block BEFORE it is pinned. The attestation is an L1 read: with no wallet to read
 * through, nothing is pinned at all, and the watch re-runs it the moment one connects.
 */
function wirePinAttestation(): void {
	if (pinAttestationWired) return
	pinAttestationWired = true
	// Detached: the watch belongs to the module's one journal, not to whichever component called
	// useSend() first - a component scope would stop it at unmount and never arm one again.
	const l1 = useL1Wallet()
	effectScope(true).run(() => watch([l1.address, l1.chainId], () => void pinAttestedJournalTokens(), { immediate: true }))
}

async function pinAttestedJournalTokens(): Promise<void> {
	const l1 = useL1Wallet()
	// On the wrong chain nothing can be attested — and nothing may be judged: the reads would
	// answer for a chain where the generation does not exist.
	if (!l1.address.value || l1.wrongChain.value) return
	try {
		for (const token of await attestSendTokenBlocks()) requestHubToken(hubTokenDesc(token), { pinned: true })
	} catch (e) {
		// Boot-time work nobody is waiting on: a failure leaves the tokens unpinned - the claim lane
		// proves each block again before it grants anyway - and never breaks the shell.
		log("journal token attestation failed - nothing pinned", e instanceof Error ? e.message : String(e))
	}
}

const hubTokenDesc = (t: JournalTokenBlock) => ({
	l2Token: t.l2Token,
	erc20: t.erc20 as `0x${string}`,
	words: { nameWord: t.nameWord as `0x${string}`, symbolWord: t.symbolWord as `0x${string}` },
	decimals: t.decimals,
})

interface RunCtx {
	plan: SendPlan
	actors: SendActors
	journal: ReturnType<typeof useBridgeJournal>
	stage: Ref<SendStage | null>
	error: Ref<string | null>
	/** The wallet's token permission was raised (and granted) by this run, before any signature. */
	granted?: boolean
}

/** The row every L1 leg narrates into, opened before the Permit2 approval so its prompt and its
 *  transaction have somewhere to land. A private leg is already named by its claim hash; a public
 *  one takes a provisional name until the send derives that hash. */
async function openSendRecord(id: string, ctx: RunCtx, prepared: Prepared): Promise<void> {
	const { plan, actors } = ctx
	addRecordVerified(
		buildSendRecord({ ...prepared.inputs, fuelSalt: prepared.fuelSalt, id, plan, recipient: actors.recipient, sender: actors.from }),
	)
	markSessionLive(id)
	// The permission the wallet granted happened before the record existed; it is the run's first,
	// done phase from the record's first render — the seal's own prompt comes after it.
	if (ctx.granted) markGrantOutcome(id)
	// EVERY private send seals, gas-only included: without an envelope its claim material exists
	// only in this tab's memory, so a reload strands it and a recovery file cannot be exported.
	if (plan.isPrivate) await sealSend(id, plan, prepared, actors, () => ctx.journal.records.value as ClaimRecord[])
}

async function executeSend(ctx: RunCtx): Promise<string> {
	const { plan, actors } = ctx
	const gen = generation()
	// Before the FIRST wallet interaction of the send (the private seal's signature), so a wallet on
	// the wrong chain costs no prompt and leaves no record behind.
	await assertL1Chain(actors.l1)
	// Before anything is sealed or signed: a venue that no longer meets the reviewed floor stops here.
	const swapData = plan.gas ? await sliceSwapData(actors.l1.publicClient as unknown as PublicClient, plan.token.address, plan.gas) : "0x"
	const prepared = await prepareSecrets(plan, actors.recipient)
	let id = prepared.id ?? makeProvisionalDepositId()
	try {
		// Inside the failure boundary: a private seal asks the wallet for a signature, and its refusal
		// must settle the row it was opened for like any later refusal.
		await openSendRecord(id, ctx, prepared)
		await ensurePermit2Approval(gen.permit2, plan.amount, id, l1ApprovalCtx(actors), plan.token.address)
		const res = await runSend(
			l1Ctx(actors),
			gen,
			await sendParams(plan, actors, prepared, swapData),
			(s) => {
				ctx.stage.value = s
			},
			{
				onSecrets: (s) => {
					id = persistPreTx(s, ctx, prepared, id)
				},
				onSent: (txHash) => updateRecord(id, { depositTxHash: txHash }),
				onConfirmed: (r) => journalConfirmed(id, r, ctx),
			},
		)
		await afterReceipt(id, ctx, res)
		return id
	} catch (e) {
		settleFailedSend(id, ctx, e)
		throw e
	}
}

/**
 * What a send that threw leaves behind. A row the send never named holds no claim material at all —
 * nothing in it for a resume or a recovery file to act on — so it dies with the attempt; so does a
 * named row when the wallet refused the signature that would have deposited: nothing reached the
 * chain for it to claim, and the row's vanishing is what returns the wizard to the review. Any other
 * failure keeps the row — a transaction may have been broadcast — and, unless a lane already said
 * why, names the failure on its active phase so the rail is never left mute. The bookkeeping must
 * not mask the failure it records.
 */
function settleFailedSend(id: string, ctx: RunCtx, e: unknown): void {
	try {
		const row = ctx.journal.records.value.find((r) => r.id === id) as SendDepositRecord | undefined
		const refused = normalizeError(e).category === "user-rejected"
		if (isProvisionalRecordId(id) || (refused && !row?.depositTxHash)) {
			discard(id)
			return
		}
		if (row && !ctx.journal.runtime.value[id]?.attention) flagRecordError(id, sendFailureCopy(e))
	} catch (cleanup) {
		log("failed-send bookkeeping threw", cleanup instanceof Error ? cleanup.message : String(cleanup))
	}
}

/** The wallet's own refusal reads as its one line, and the two structured envelope categories get
 *  their own copy; anything else keeps its message, humanized. */
function sendFailureCopy(e: unknown): string {
	const normalized = normalizeError(e)
	if (
		normalized.category === "user-rejected" ||
		normalized.category === "contract-not-registered" ||
		normalized.category === "chain-desync"
	) {
		return normalized.message
	}
	return humanizeWalletError(e instanceof Error ? e.message : String(e))
}

const l1ApprovalCtx = (actors: SendActors) => ({ publicClient: actors.l1.publicClient, wallet: actors.wallet, from: actors.from }) as never

type SecretsReport = { tokenClaimValueHex?: string; tokenSecretHashHex?: string; fuelSecretHex?: string; fuelSecretHashHex?: string }

/** The record must carry the hash the witness commits to BEFORE the signature: that hash is the
 *  only handle a crashed send has on its own deposit. A private leg's row already holds it; a public
 *  leg's provisional row is re-keyed onto it here, with the claim material the send just derived. */
function persistPreTx(s: SecretsReport, ctx: RunCtx, prepared: Prepared, known: string): string {
	const id = recordIdOf(s)
	if (!id) throw new Error("the send produced no claim material — refusing to sign")
	if (prepared.id && prepared.id !== id) {
		throw new Error("the send derived a different claim hash than the sealed record — refusing to sign")
	}
	if (id === known) {
		backfillFuelBlock(s, ctx, prepared, id)
	} else {
		const named = buildSendRecord({
			id,
			plan: ctx.plan,
			recipient: ctx.actors.recipient,
			sender: ctx.actors.from,
			claimValueHex: s.tokenClaimValueHex,
			fuelSecretHex: s.fuelSecretHex,
			fuelSecretHashHex: s.fuelSecretHashHex,
			fuelSalt: prepared.fuelSalt,
		})
		// Only the identity and the claim material are new: what the L1 approval already wrote into
		// the provisional row belongs to this same send and must survive the rename.
		const opened = ctx.journal.records.value.find((r) => r.id === known) as SendDepositRecord | undefined
		const renamed: SendDepositRecord = { ...named, createdAt: opened?.createdAt ?? named.createdAt }
		if (opened?.approveTxHash) renamed.approveTxHash = opened.approveTxHash
		rekeyJournalRecord(known, renamed)
		// The same write-and-verify bar `addRecordVerified` sets: an unstored record before the
		// irreversible L1 transaction is a stranded deposit.
		if (!ctx.journal.records.value.some((r) => r.id === id)) {
			throw new Error("Could not persist the bridge record — aborting before the deposit (storage full?).")
		}
	}
	setRecordStep(id, "signing", "sign the bridge intent in your Ethereum wallet")
	return id
}

/**
 * A record the send did NOT have to rename keeps whatever was written when it was opened — so a
 * fuel block missing from it would stay missing for good, and with it the salt the private fee
 * ladder is the only consumer of. The send's own pre-signature material is authoritative here:
 * this runs before the witness is signed, so the block the claim reads is the one the L1 leg
 * committed to.
 */
function backfillFuelBlock(s: SecretsReport, ctx: RunCtx, prepared: Prepared, id: string): void {
	const gas = ctx.plan.gas
	if (!gas || !s.fuelSecretHex || !s.fuelSecretHashHex) return
	const rec = ctx.journal.records.value.find((r) => r.id === id) as SendDepositRecord | undefined
	if (rec?.fuel?.secret && rec.fuel.secretHashHex) return
	updateRecord(id, { fuel: { ...rec?.fuel, ...fuelBlockOf(gas, s.fuelSecretHex, s.fuelSecretHashHex, prepared.fuelSalt) } } as never)
}

/** The confirmed L1 facts, journaled synchronously so a crash right after the receipt still knows
 *  which leaves to claim. */
function journalConfirmed(id: string, r: SendResult, ctx: RunCtx): void {
	updateRecord(id, {
		leafIndex: r.tokenLeafIndex?.toString(),
		messageHash: r.tokenMessageHashHex,
		...(r.token ? { token: r.token } : {}),
		...(r.fuelLeafIndex !== undefined ? { fuel: fuelFacts(id, r, ctx) } : {}),
	} as never)
}

function fuelFacts(id: string, r: SendResult, ctx: RunCtx) {
	const rec = ctx.journal.records.value.find((x) => x.id === id) as SendDepositRecord | undefined
	const block = rec?.fuel ?? { amount: "0", secret: r.fuelSecretHex ?? "", secretHashHex: r.fuelSecretHashHex ?? "", minOutput: "0" }
	return { ...block, leafIndex: r.fuelLeafIndex?.toString(), messageHash: r.fuelMessageHashHex, received: r.fuelReceived?.toString() }
}

/** The words the factory froze win. A read-back naming a different L2 token rewrites the block and
 *  re-raises the grant, so the claim is never built against an address the wallet was not asked
 *  about. */
async function afterReceipt(id: string, ctx: RunCtx, res: SendResult): Promise<void> {
	if (res.token && res.token.l2Token.toLowerCase() !== previewBlock(ctx.plan).l2Token.toLowerCase()) {
		log("registration read-back names another token - re-granting", { id })
		updateRecord(id, { token: res.token } as never)
		requestHubToken(hubTokenDesc(res.token), { pinned: true })
		const outcome = await grantForBlock(res.token)
		if (outcome !== "granted") {
			ctx.error.value = grantRefusal(outcome)
			return
		}
	}
	setRecordStep(id, undefined, undefined) // the engine narrates from here
	await runDepositClaim(id)
}

/** What a non-granted outcome says. `busy` is NOT a refusal - the wallet was mid-flow and never saw
 *  this request, so the copy asks for a retry instead of reporting a decision the wallet never made. */
export function grantRefusal(outcome: Exclude<GrantOutcome, "granted">): string {
	if (outcome === "busy") return "Your wallet is still finishing another request — try again in a moment."
	if (outcome === "stale") return "The selection changed while your wallet was deciding — nothing was sent."
	return "Your wallet didn't grant access to this token — nothing was sent."
}

interface Prepared {
	/** Known before the signature only when THIS app owns the claim material (every private leg). */
	id?: string
	claimSalt?: Fr
	fuelSalt?: Fr
	inputs: Omit<RecordInputs, "id" | "plan" | "recipient" | "sender">
}

/** The gas leg's claim material, which a private send derives ITSELF — the PrivateFPC rebuilds the
 *  same secret from `msg_sender`, so it is knowable before anything is signed and the record can
 *  carry the whole fuel block from the moment it is opened. */
async function privateFuelInputs(
	fuelSalt: Fr | undefined,
	recipientAddr: AztecAddress,
): Promise<{ fuelSecretHex?: string; fuelSecretHashHex?: string }> {
	if (!fuelSalt) return {}
	const secret = deriveBridgeSecret(fuelSalt, recipientAddr)
	return { fuelSecretHex: secret.toString(), fuelSecretHashHex: (await computeSecretHash(secret)).toString() }
}

/** Private legs derive their own secrets, so their record id exists before anything is signed;
 *  a public leg learns it from the send's own pre-signature hook. */
async function prepareSecrets(plan: SendPlan, recipient: string): Promise<Prepared> {
	const recipientAddr = AztecAddress.fromStringUnsafe(recipient)
	if (!plan.isPrivate) return { inputs: {} }
	const fuelSalt = plan.gas ? Fr.random() : undefined
	const inputs = await privateFuelInputs(fuelSalt, recipientAddr)
	// Gas-only is named by its own Fee Juice message; a token leg by its claim hash.
	if (plan.intent === "gas") return { id: inputs.fuelSecretHashHex, fuelSalt, inputs }
	const claimSalt = Fr.random()
	const committed = deriveTokenClaimSecret(claimSalt, recipientAddr)
	return { id: (await computeSecretHash(committed)).toString(), claimSalt, fuelSalt, inputs }
}

/** A wall-clock deadline fails on a drifted chain: the window is measured from the chain's own
 *  latest block, which is the clock the Permit2 check reads. */
async function sendParams(plan: SendPlan, actors: SendActors, prepared: Prepared, swapData: Hex): Promise<SendParams> {
	const block = (await actors.l1.publicClient.getBlock()) as { timestamp: bigint }
	const deadline = block.timestamp + PERMIT_DEADLINE_SECONDS
	return {
		intent: plan.intent,
		erc20: plan.token.address,
		amount: plan.amount,
		aztecRecipient: actors.recipient as `0x${string}`,
		isPrivate: plan.isPrivate,
		claimSalt: prepared.claimSalt,
		gas: plan.gas ? gasLegOf(plan.gas, swapData, actors.recipient, plan.isPrivate, prepared.fuelSalt) : undefined,
		nonce: BigInt(`0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`),
		deadline,
	}
}

/** Canonical viem meets the fork-typed bridge-core only here: the clients are structurally what
 *  it calls, and the two viem copies' nominal types are deliberately never shared. */
const l1Ctx = (actors: SendActors): L1Ctx =>
	({ pub: actors.l1.publicClient, wallet: actors.wallet, account: actors.from }) as unknown as L1Ctx
