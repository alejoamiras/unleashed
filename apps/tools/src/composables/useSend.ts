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
import { Fr } from "@aztec-labs/aztec.js/fields"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { type EncryptionKey, type SendDepositRecord, isProvisionalRecordId, makeProvisionalDepositId } from "@unleashed/bridge-core"
import {
	type DepositRecord,
	type DepositSecrets,
	isBridgeError,
	type JournalTokenBlock,
	type Reads,
	type TransferEvent,
} from "@unleashed/sdk"
import {
	type DepositPlan,
	type Registration,
	type SendOpts,
	type SendStage,
	assertDepositsOpen,
	depositL1,
	probeHubClaim,
	claimViaHub,
	hubAt,
	hubTokenFor,
	l1ToL2MessageReadiness,
	readRegistration,
	classifyClaimReceipt,
	findDepositTx,
	hubMessageState,
} from "@unleashed/sdk/internal"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret } from "@unleashed/sdk/protocol"
import { type PublicClient, WaitForTransactionReceiptTimeoutError, type WalletClient } from "viem"
import { type Ref, effectScope, ref, watch } from "vue"
import {
	FUEL_PORTAL,
	HUB,
	LEGACY_ROUTERS,
	MANIFEST_CHAIN,
	SEND_GENERATION,
	TOKEN_CLASS_ID,
	bridgeNetwork,
	rebuildHubTokenInstance,
} from "@/contracts/bridge-generation"
import { appNode } from "@/lib/aztec-node"
import { buildSendRecord, previewBlock, sealBindingOf, tokenClaimAmount } from "@/lib/send-record"

export { previewBlock }
import { NETWORK } from "@/lib/network"
import { type GrantOutcome, NO_GAS_ROUTE, type SendPlan } from "@/lib/send-model"
import { normalizeError } from "@/lib/errors"
import { humanizeWalletError, sendFailureCopy } from "@/lib/wallet-errors"
import { webJournalLocks } from "@/lib/journal-locks"
import { PROMPT_WAIT_MS, PROMPTS_STALLED, promptsSettled } from "@/lib/prompt-queue"
import { appWatchDeps } from "./crosschain-deposit-flow"
import { resumeCrossChainWatches } from "./crosschain-watch"
import { readClientFor } from "./useEthereumReader"
import { GAS_QUOTE_MOVED } from "./useFuelQuote"
import { reconcileFuelConsumed, fuelOverrideActive, launchStandaloneFuelClaim } from "./fuel-recovery"
import { resolveToolsTarget } from "@/lib/network-targets"
import {
	type ClaimRecord,
	addRecordVerified,
	attestSendTokenBlocks,
	connectJournalDeps,
	discard,
	flagRecordError,
	markApproveOutcome,
	markSessionLive,
	rekeyJournalRecord,
	resumeSessionWork,
	runDepositClaim,
	runOnLane,
	setRecordStep,
	updateRecord,
	useBridgeJournal,
	markGrantOutcome,
} from "./useBridgeJournal"
import {
	type HubClaimFee,
	buildFeeJuiceClaimDep,
	failStopInteraction,
	recoverDepositLeg,
	resolveHubClaimSendOpts,
	sealPrivateRecord,
} from "./deposit-flow"
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
	if (live !== MANIFEST_CHAIN.l1ChainId) throw new Error(wrongChainCopy(live))
}

const wrongChainCopy = (live: number | string) =>
	`Your Ethereum wallet is on chain ${live}, but this bridge lives on chain ${MANIFEST_CHAIN.l1ChainId}. Switch networks and try again — nothing was sent.`

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
						privateFpc: PRIVATE_FPC_ADDRESS,
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
	// Reads only: a transfer still crossing from another chain is watched without any wallet.
	resumeCrossChainWatches(appWatchDeps())
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
 *
 * Reads through the build's pinned Ethereum RPCs where it pins any: a cross-chain send leaves the
 * wallet on its source chain, and its claim must not wait on the wallet coming back. The wallet's
 * transport answers only where no reader is pinned.
 */
export async function validateTokenBlock(
	token: JournalTokenBlock,
	l1 = useL1Wallet(),
	reader: Pick<PublicClient, "getChainId"> | undefined = readClientFor(NETWORK.l1ChainId),
): Promise<string | null> {
	const gen = SEND_GENERATION
	if (!gen || !HUB || !TOKEN_CLASS_ID) return "This network has no bridge — this record cannot run here."
	const source = { publicClient: reader ?? l1.publicClient }
	// A registration read on another chain answers "no portal" for every genuine block, and that
	// answer would be terminal. The chain is asserted on both sides of the read: a transport that
	// switched mid-read throws (unavailable), it never contradicts.
	await assertL1Chain(source)
	const reg = await readRegistration(source.publicClient as never, gen.factory as `0x${string}`, token.erc20 as `0x${string}`)
	await assertL1Chain(source)
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

interface SendActors {
	l1: ReturnType<typeof useL1Wallet>
	recipient: string
	from: `0x${string}`
	wallet: unknown
}

/**
 * The pre-signature seal of a private send. The credential is what the claim spends — the token
 * claim salt, or the gas salt when gas is all this send bought — and the gas leg's own salt is
 * sealed alongside it: the PrivateFPC rebuilds the Fee Juice secret from that salt, so a fueled
 * record whose envelope omits it can be restored and still never claim its gas.
 */
async function sealSend(
	id: string,
	plan: SendPlan,
	secrets: DepositSecrets,
	actors: SendActors,
	records: () => ClaimRecord[],
): Promise<void> {
	const credential = secrets.claimSalt ?? secrets.fuelSalt
	if (!credential) throw new Error("a private send carries no salt to seal — refusing to sign")
	await sealPrivateRecord({
		id,
		secretStr: credential.toString(),
		fuelSaltStr: secrets.fuelSalt?.toString(),
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
	/** Reads the bridge's trust roots and the route's pause, with no prompt: null when `plan` may be sent, else the
	 *  sentence to show. */
	check(plan: SendPlan): Promise<string | null>
	/** A cross-chain send's pause check, with no prompt: the sentence when the route reads as paused, else null. */
	checkCrossChain(plan: SendPlan): Promise<string | null>
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
		check: (plan) => bridgeRefusal(plan, deps.l1),
		checkCrossChain: crossChainPauseRefusal,
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

/**
 * One send's row. A private send's row is named by its claim hash from the SDK's first persist and sealed there,
 * before any other prompt; a public one takes a provisional name, with no claim material, until the signature names
 * it — so a public send that fails before its signature leaves nothing behind.
 */
interface SendRow {
	ctx: RunCtx
	/** Undefined until the first persist opens the row. */
	id?: string
	/** The SDK's latest record: what the signature names a public row with. */
	latest?: DepositRecord
}

const rowOf = (ctx: RunCtx, id: string) => ctx.journal.records.value.find((r) => r.id === id) as SendDepositRecord | undefined

/** viem's default receipt wait, the one this app's sends have always given up after: the row keeps its hash, and a
 *  resume recovers the deposit from it. */
const DEPOSIT_RECEIPT_WAIT_MS = 180_000

async function executeSend(ctx: RunCtx): Promise<string> {
	const { plan, actors } = ctx
	generation()
	// Before the network check and the FIRST wallet interaction (a private send's seal), so a wallet on the wrong
	// chain costs no prompt and leaves no record behind.
	await assertL1Chain(actors.l1)
	const reads = sendReads(actors.l1)
	const row: SendRow = { ctx }
	const receiptWait = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const net = await bridgeNetwork(reads)
		const record = await depositL1(net, reads, sdkWallet(row), depositPlanOf(plan, actors.recipient), {
			persist: (record, secrets) => persistSend(row, record, secrets),
			onEvent: (e) => {
				narrate(row, e)
				if (e.type !== "deposit-sent") return
				const timeout = new WaitForTransactionReceiptTimeoutError({ hash: e.txHash })
				timer = setTimeout(() => receiptWait.abort(timeout), DEPOSIT_RECEIPT_WAIT_MS)
			},
			signal: receiptWait.signal,
		})
		ctx.stage.value = "done"
		const id = row.id as string
		await afterReceipt(id, ctx, record.intent === "gas" ? undefined : record.token)
		return id
	} catch (e) {
		settleFailedSend(row, e)
		throw appFailureOf(e, row.id === undefined ? undefined : rowOf(ctx, row.id)?.depositTxHash)
	} finally {
		clearTimeout(timer)
	}
}

/** The reviewed plan, exactly: the SDK re-quotes the slice and refuses `quote-moved` under the reviewed floor, which
 *  is the floor it signs. It reads the pause again before its first persist, so a route paused while the grant prompt
 *  was open still costs no seal and no Ethereum prompt. */
function depositPlanOf(plan: SendPlan, recipient: string): DepositPlan {
	return {
		intent: plan.intent,
		token: plan.token.address,
		amount: plan.amount,
		recipient,
		isPrivate: plan.isPrivate,
		...(plan.gas ? { gas: { fuelAmount: plan.gas.fuelAmount, minFuelOutput: plan.gas.minFuelOutput } } : {}),
		...(plan.intent === "gas" ? {} : { tokenBlock: previewBlock(plan), registers: plan.token.state.kind !== "registered" }),
	}
}

/** The SDK's persist: the first call opens the row; later ones write only the facts a send adds, so the app's own
 *  fields (a private fuel block's secret and salt, the seal) survive every write. */
async function persistSend(row: SendRow, record: DepositRecord, secrets?: DepositSecrets): Promise<void> {
	row.latest = record
	if (row.id === undefined) return openRow(row, record, secrets)
	updateRecord(row.id, factsOf(rowOf(row.ctx, row.id), record) as never)
}

/** The facts under today's names. The SDK's `depositL2Block` is not one: this lane's rows never carried it, and it
 *  would start a block countdown on the rail. */
function factsOf(row: SendDepositRecord | undefined, r: DepositRecord): Partial<SendDepositRecord> {
	const leaf = r.fuel?.leafIndex
	return {
		...(r.approveTxHash ? { approveTxHash: r.approveTxHash } : {}),
		...(r.depositTxHash ? { depositTxHash: r.depositTxHash } : {}),
		...(r.leafIndex !== undefined ? { leafIndex: r.leafIndex, messageHash: r.messageHash } : {}),
		...(r.leafIndex !== undefined && r.intent !== "gas" ? { token: r.token } : {}),
		...(leaf !== undefined
			? { fuel: { ...row?.fuel, leafIndex: leaf, messageHash: r.fuel?.messageHash, received: r.fuel?.received } }
			: {}),
	} as Partial<SendDepositRecord>
}

async function openRow(row: SendRow, record: DepositRecord, secrets: DepositSecrets | undefined): Promise<void> {
	const { plan, actors } = row.ctx
	row.id = plan.isPrivate ? record.id : makeProvisionalDepositId()
	const fuel = plan.isPrivate ? privateFuelOf(record, secrets, actors.recipient) : {}
	addRecordVerified(buildSendRecord({ id: row.id, plan, recipient: actors.recipient, sender: actors.from, ...fuel }))
	markSessionLive(row.id)
	// The permission the wallet granted happened before the record existed; it is the run's first, done phase from
	// the record's first render — the seal's own prompt comes after it.
	if (row.ctx.granted) markGrantOutcome(row.id)
	// EVERY private send seals, gas-only included: without an envelope its claim material exists only in this tab's
	// memory, so a reload strands it and a recovery file cannot be exported.
	if (plan.isPrivate) await sealSend(row.id, plan, secrets ?? {}, actors, () => row.ctx.journal.records.value as ClaimRecord[])
}

/** A private gas leg's claim material, derived as the PrivateFPC derives it from `msg_sender`, so the row carries the
 *  whole fuel block from the moment it opens. */
function privateFuelOf(record: DepositRecord, secrets: DepositSecrets | undefined, recipient: string) {
	const salt = secrets?.fuelSalt
	if (!salt || !record.fuel) return {}
	const secret = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(recipient))
	return { fuelSecretHex: secret.toString(), fuelSecretHashHex: record.fuel.secretHashHex, fuelSalt: salt }
}

/**
 * The last moment before the deposit is signed, and the last that can still stop it: a public row is renamed to the
 * hash the witness commits to, with its claim material, and read back — that hash is a crashed send's only handle on
 * its own deposit. A failed write throws, and the SDK reports it with nothing signed.
 */
function nameAtSignature(row: SendRow): void {
	const { ctx } = row
	const rec = row.latest
	const known = row.id
	if (!rec || !known) throw new Error("the send produced no claim material — refusing to sign")
	if (known !== rec.id) {
		const named = buildSendRecord({
			id: rec.id,
			plan: ctx.plan,
			recipient: ctx.actors.recipient,
			sender: ctx.actors.from,
			claimValueHex: rec.secret,
			fuelSecretHex: rec.fuel?.secret,
			fuelSecretHashHex: rec.fuel?.secretHashHex,
		})
		// Only the identity and the claim material are new: what the approval already wrote into the provisional row
		// belongs to this same send and must survive the rename.
		const opened = rowOf(ctx, known)
		const renamed: SendDepositRecord = { ...named, createdAt: opened?.createdAt ?? named.createdAt }
		if (opened?.approveTxHash) renamed.approveTxHash = opened.approveTxHash
		rekeyJournalRecord(known, renamed)
		if (!rowOf(ctx, rec.id)) throw new Error("Could not persist the bridge record — aborting before the deposit (storage full?).")
		row.id = rec.id
	}
	setRecordStep(rec.id, "signing", "sign the bridge intent in your Ethereum wallet")
}

/**
 * The wallet the SDK signs through. The approval takes the L1 prompt lane, as every other L1 prompt does (a private
 * send's seal takes it inside `persist`, so it is never held across them); the signature first names the row.
 */
function sdkWallet(row: SendRow): WalletClient {
	const { l1, from, wallet } = row.ctx.actors
	const w = wallet as WalletClient
	const writeContract = (args: Parameters<WalletClient["writeContract"]>[0]) =>
		args.functionName === "approve" ? runOnLane("l1", () => w.writeContract(args)) : w.writeContract(args)
	const signTypedData = async (args: Parameters<WalletClient["signTypedData"]>[0]) => {
		nameAtSignature(row)
		row.ctx.stage.value = "signing"
		const signature = await w.signTypedData(args)
		row.ctx.stage.value = "sending"
		return signature
	}
	return {
		...w,
		account: { address: from, type: "json-rpc" },
		getChainId: () => l1.publicClient.getChainId(),
		writeContract,
		signTypedData,
	} as unknown as WalletClient
}

/** The rail, from the SDK's events, into the row as it is named now: a public send's approval narrates into its
 *  provisional row, which the events' own id does not name. */
function narrate(row: SendRow, e: TransferEvent): void {
	const id = row.id
	if (id === undefined) return
	if (e.type === "deposit-sent") row.ctx.stage.value = "confirming"
	if (e.type !== "approval") return
	if (e.status === "requested") setRecordStep(id, "approving", "first time only: approve Permit2 in your Ethereum wallet")
	else if (e.status === "waiting") setRecordStep(id, "approving", `still waiting for the approval (round ${e.round})`)
	else if (e.status === "confirmed") markApproveOutcome(id, "done")
}

export const DEPOSITS_PAUSED = "Deposits on this route are paused right now. Nothing was sent."
export const BRIDGE_UNCHECKED = "This app could not check the bridge on this network. Nothing was sent."

/** Every read of a send goes through the wallet's own client, as its signature does, and the app's Aztec node. */
const sendReads = (l1: SendDeps["l1"]): Reads => ({ l1: l1.publicClient as unknown as PublicClient, aztecNode: appNode() })

/**
 * The confirm's check, before any prompt: the bridge's trust roots (read once per session, then cached) and the
 * route's pause. It fails closed: a read that throws is a bridge this app could not check. A wallet on another chain
 * at the session's first check keeps its own sentence; later ones read through the cache, and the send's own chain
 * check still refuses it before a signature.
 */
async function bridgeRefusal(plan: SendPlan, l1: SendDeps["l1"]): Promise<string | null> {
	const reads = sendReads(l1)
	try {
		await assertDepositsOpen(await bridgeNetwork(reads), reads, plan.intent)
		return null
	} catch (e) {
		log("bridge check refused the send", { code: isBridgeError(e) ? e.code : "read-failed" })
		if (isBridgeError(e) && (e.code === "paused" || e.code === "wrong-chain")) return sendFailureCopy(appFailureOf(e))
		return BRIDGE_UNCHECKED
	}
}

/**
 * A cross-chain confirm's pause check, through the build's pinned Ethereum reader: the wallet sits on the source
 * chain. Only a pause it reads refuses; any other failure lets the send go unchecked.
 */
async function crossChainPauseRefusal(plan: SendPlan): Promise<string | null> {
	const l1 = readClientFor(NETWORK.l1ChainId)
	if (!l1) {
		log("cross-chain pause check", { code: "no-reader" })
		return null
	}
	const reads: Reads = { l1, aztecNode: appNode() }
	try {
		await assertDepositsOpen(await bridgeNetwork(reads), reads, plan.intent)
		return null
	} catch (e) {
		const code = isBridgeError(e) ? e.code : "read-failed"
		log("cross-chain pause check", { code })
		return code === "paused" ? DEPOSITS_PAUSED : null
	}
}

/**
 * The error this app's copy reads. The SDK's own sentences name its API, so a refusal it makes itself becomes this
 * app's sentence for it; anything it wraps — a wallet's answer, a venue's, this app's storage — is shown as the
 * wrapped error, as before.
 */
export function appFailureOf(e: unknown, depositTxHash?: string): unknown {
	if (!isBridgeError(e)) return e
	if (e.code === "paused") return new Error(DEPOSITS_PAUSED)
	if (e.code === "quote-moved") return new Error(GAS_QUOTE_MOVED)
	if (e.code === "no-fuel-route" || e.code === "fetch-unavailable") return new Error(NO_GAS_ROUTE)
	const live = e.code === "wrong-chain" ? /on chain (\d+)/.exec(e.message)?.[1] : undefined
	if (live) return new Error(wrongChainCopy(live))
	if (e.code === "deposit-reverted" && e.submission === "submitted" && depositTxHash) {
		return new Error(`bridgeWithPermit() REVERTED (${depositTxHash}) — no funds moved; inspect the tx and retry`)
	}
	return e.cause === undefined ? e : appFailureOf(e.cause, depositTxHash)
}

/** The user said no: the SDK's own code, or today's reading of the first error it wraps (a refused seal arrives
 *  wrapped in the SDK's `persist-failed`). */
function refusedByUser(e: unknown): boolean {
	if (isBridgeError(e)) return e.code === "user-rejected" || (e.cause !== undefined && refusedByUser(e.cause))
	return normalizeError(e).category === "user-rejected"
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
function settleFailedSend(row: SendRow, e: unknown): void {
	try {
		const id = row.id
		if (id === undefined) return
		const rec = rowOf(row.ctx, id)
		if (isProvisionalRecordId(id) || (refusedByUser(e) && !rec?.depositTxHash)) {
			discard(id)
			return
		}
		if (rec && !row.ctx.journal.runtime.value[id]?.attention) flagRecordError(id, sendFailureCopy(appFailureOf(e, rec.depositTxHash)))
	} catch (cleanup) {
		log("failed-send bookkeeping threw", cleanup instanceof Error ? cleanup.message : String(cleanup))
	}
}

/** The words the factory froze win. A read-back naming a different L2 token rewrites the block and
 *  re-raises the grant, so the claim is never built against an address the wallet was not asked
 *  about. */
async function afterReceipt(id: string, ctx: RunCtx, frozen: JournalTokenBlock | undefined): Promise<void> {
	if (frozen && frozen.l2Token.toLowerCase() !== previewBlock(ctx.plan).l2Token.toLowerCase()) {
		log("registration read-back names another token - re-granting", { id })
		updateRecord(id, { token: frozen } as never)
		requestHubToken(hubTokenDesc(frozen), { pinned: true })
		const outcome = await grantForBlock(frozen)
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
