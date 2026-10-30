/**
 * The send lane's claim side, wired to the app: the SDK's fee ladder bound to the journal, the app's
 * node and the wallet's balance reads, with every stop it raises put back into the words the app
 * has always shown. Plus the L1 legs a send performs before its claim. State stays OWNED by the
 * composable layer: `sealKeys` and the wallet singletons are passed in explicitly.
 */

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import {
	type BridgeJournalRecord,
	type DepositJournalRecord,
	type RecoveryBinding,
	type SiteKey,
	type SendDepositRecord,
	isSealTrusted,
	markSealTrusted,
	sealDepositRecord,
} from "@unleashed/bridge-core"
import {
	type FeeLadderEnv,
	type FeeLadderStore,
	FeeStopError,
	type FuelClaimRetry,
	type HubClaimContext,
	type HubClaimLatches as LadderLatches,
	type PollBudget,
	type RecoveryL1Client,
	type SendGeneration,
	type SendOpts,
	type StoredRecord,
	buildFeeJuiceClaim,
	fuelReceiptStatus as fuelReceiptStatusOn,
	patchFuel as patchFuelOn,
	readFeeJuiceOrNull as readFeeJuiceOrNullOn,
	recoverDepositLeg as recoverDepositLegOn,
	resolveHubClaimSendOpts as resolveHubClaimSendOptsOn,
	sendStandaloneFjClaim as sendStandaloneFjClaimOn,
} from "@unleashed/sdk/internal"
import { PRIVATE_FPC_ADDRESS } from "@unleashed/sdk/protocol"
import { NETWORK } from "@/lib/network"
import { FUEL, FUEL_MIN_FJ, LEGACY_ROUTERS } from "@/contracts/bridge-generation"
import { appNode } from "@/lib/aztec-node"
import { FEE_STOP_COPY } from "@/lib/fee-stop-copy"
import { cacheSecret, currentRecord, runOnLane, setRecordStep, updateRecord, updateRecordWhen } from "./useBridgeJournal"
import { readBalance } from "./useTokenBalance"

// Verbose tracing while the bridge flows are being hardened - ids, stages, tx hashes ONLY.
const log = (...args: unknown[]) => console.log("[bridge:deposit]", ...args)

type FuelBlock = NonNullable<DepositJournalRecord["fuel"]>

/** Best-effort signer fingerprint for the seal-trust cache (EIP-6963 rdns isn't plumbed for
 *  window.ethereum; injected flags are the practical discriminator). */
export function providerFingerprint(): string {
	if (typeof window === "undefined") return "unknown"
	const eth = (window as Window & { ethereum?: Record<string, unknown> }).ethereum
	if (!eth) return "unknown"
	if (eth.isRabby) return "rabby"
	if (eth.isMetaMask) return "metamask"
	return "injected"
}

/** A claim-side simulate/send pair — the journal engine's interaction contract. */
export interface ClaimInteraction {
	simulate: () => Promise<unknown>
	send: () => Promise<{ txHash: string }>
}

/** A fail-stop {simulate, send} pair that surfaces `why`. `sendWhy` preserves the historical
 *  wait-stop shape, whose send threw a shorter message. */
export function failStopInteraction(why: string, sendWhy: string = why): ClaimInteraction {
	return {
		simulate: async () => {
			throw new Error(why)
		},
		send: async () => {
			throw new Error(sendWhy)
		},
	}
}

// ── the SDK's fee ladder, bound to the app ───────────────────────────────────

/** A claim-side stop in the app's words; any other failure passes through unchanged. */
async function worded<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op()
	} catch (e) {
		throw e instanceof FeeStopError ? new Error(FEE_STOP_COPY[e.stop]) : e
	}
}

const wordedInteraction = (claim: ClaimInteraction): ClaimInteraction => ({
	simulate: () => worded(() => claim.simulate()),
	send: () => worded(() => claim.send()),
})

/** The journal as the ladder's store: every read is the PERSISTED record, every guarded write one synchronous load. */
const journalStore: FeeLadderStore = {
	current: (id) => currentRecord(id) as StoredRecord | undefined,
	mergeWhen: (id, when, patch) =>
		updateRecordWhen(
			id,
			(rec) => when(rec as StoredRecord),
			(rec) => patch(rec as StoredRecord) as Partial<BridgeJournalRecord>,
		) !== undefined,
	merge: (id, patch) => updateRecord(id, patch as Partial<BridgeJournalRecord>),
}

const ladderEnv = (): FeeLadderEnv => ({
	records: journalStore,
	node: appNode(),
	privateFpc: PRIVATE_FPC_ADDRESS,
	fuel: FUEL,
	minFloorFj: FUEL_MIN_FJ,
	readPublicFeeJuice: readPublicFeeJuiceBalance,
	readPrivateFeeJuice: readPrivateFeeJuiceBalance,
	log,
})

/** Merge explicit fields into the record's PERSISTED fuel block; `false` when the record is gone or
 *  now holds another deposit's fuel block (the write is refused). */
export function patchFuel(
	id: string,
	captured: FuelBlock | undefined,
	patch: Partial<FuelBlock>,
	topLevel: Partial<DepositJournalRecord & Pick<SendDepositRecord, "registerTxHash">> = {},
): boolean {
	return patchFuelOn({ records: journalStore, log }, id, captured, patch, topLevel)
}

export const fuelReceiptStatus = (txHash: string) => fuelReceiptStatusOn({ node: appNode() }, txHash)

/** The standalone self-paid Fee Juice claim, inclusion-gated (`sendStandaloneFjClaim` in the SDK). */
export function sendStandaloneFjClaim(
	aztec: unknown,
	recipientAddr: AztecAddress,
	fuel: FuelBlock,
	id: string,
	budget: PollBudget = {},
): Promise<void> {
	return worded(() => sendStandaloneFjClaimOn(ladderEnv(), aztec, recipientAddr, fuel, id, budget))
}

/** Read the account's PUBLIC Fee Juice balance - what a wallet that routes a dApp-named payer can pay
 *  a claim from. Uses the FeeJuice contract's `balance_of_public` via the connected wallet (scoped
 *  in the bridge manifest's simulation); mirrors the wallet's own gas-balance reader. */
export async function readPublicFeeJuiceBalance(aztec: unknown, recipient: AztecAddress): Promise<bigint> {
	const { FeeJuiceContract } = await import("@aztec-labs/aztec.js/protocol")
	return readBalance(aztec as never, FeeJuiceContract.withWallet(aztec as never), "balance_of_public", recipient)
}

/** Read the account's PRIVATE Fee Juice balance held at the Wonderland PrivateFPC — the remainder a
 *  prior private fuel claim credited (via `mint_and_pay_fee`). The 2.2 MB artifact is lazily imported
 *  from the SDK's dedicated code-split entry (never the eager `./artifacts` barrel). `balance_of`
 *  is `abi_utility` — scoped in the combined manifest's `simulation.utilities`. */
export async function readPrivateFeeJuiceBalance(aztec: unknown, recipient: AztecAddress): Promise<bigint> {
	const { PrivateFPCContractArtifact } = await import("@unleashed/sdk/private-fpc-artifact")
	const fpc = await Contract.at(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS), PrivateFPCContractArtifact, aztec as never)
	return readBalance(aztec as never, fpc, "balance_of", recipient)
}

/** A Fee Juice balance with a read FAILURE as `null` (≠ a real zero), so a fee-source decision can FAIL CLOSED. */
export const readFeeJuiceOrNull = (label: string, read: () => Promise<bigint>): Promise<bigint | null> =>
	readFeeJuiceOrNullOn({ log }, label, read)

/** Deposit-leg recovery from the recorded `depositTxHash` alone (`recoverDepositLeg` in the SDK). */
export function recoverDepositLeg(
	rec: DepositJournalRecord | SendDepositRecord,
	publicClient: RecoveryL1Client,
	generation?: SendGeneration,
	legacyRouters: readonly `0x${string}`[] = LEGACY_ROUTERS,
): Promise<"pending" | "recovered"> {
	return worded(() => recoverDepositLegOn({ records: journalStore, log }, rec, publicClient, generation, legacyRouters))
}

/** A gas-only bridge claims Fee Juice directly: no token leg, its own fee ladder (`buildFeeJuiceClaim` in the SDK). */
export async function buildFeeJuiceClaimDep(
	rec: DepositJournalRecord,
	secretHex: string,
	envelope: { salt?: string } | undefined,
	aztec: unknown,
	retry?: FuelClaimRetry,
): Promise<ClaimInteraction> {
	return wordedInteraction(await worded(() => buildFeeJuiceClaim(ladderEnv(), rec, secretHex, envelope, aztec, retry)))
}

type HubClaimLatches = Omit<LadderLatches, "standalone"> & { standalone?: FuelBlock }

export type HubClaimFee = ({ kind: "stop"; why: string; sendWhy?: string } | { kind: "opts"; opts: SendOpts }) & Partial<HubClaimLatches>

/** The send options a hub claim carries (`resolveHubClaimSendOpts` in the SDK), its stop in the app's words. */
export async function resolveHubClaimSendOpts(ctx: HubClaimContext): Promise<HubClaimFee> {
	const fee = await resolveHubClaimSendOptsOn(ladderEnv(), ctx)
	// The ladder hands back the record's own fuel block, which the journal types more narrowly.
	if (fee.kind !== "stop") return fee as HubClaimFee
	return { kind: "stop", why: FEE_STOP_COPY[fee.stop], ...(fee.sendStop ? { sendWhy: FEE_STOP_COPY[fee.sendStop] } : {}) }
}

// ── the L1 legs a send performs before its claim ─────────────────────────────

/** The L1 wallet surface those legs need (viem clients passed as-is). */
export interface DepositL1Ctx {
	publicClient: RecoveryL1Client & {
		readContract: (args: unknown) => Promise<unknown>
		waitForTransactionReceipt: (args: { hash: `0x${string}`; timeout?: number }) => Promise<unknown>
	}
	wallet: {
		signMessage: (args: unknown) => Promise<unknown>
		signTypedData: (args: unknown) => Promise<unknown>
		writeContract: (args: unknown) => Promise<unknown>
	}
	from: string
}

/** Trust-aware seal of the bearer secret + metadata BEFORE the first L1 tx (1 signature
 *  steady-state, 2 on a wallet's first private bridge), with a write-and-verify of the
 *  envelope patch: the record was created pre-seal, so a silent storage failure here would
 *  leave a private record without its only recovery blob. */
export async function sealPrivateRecord(ctx: {
	id: string
	secretStr: string
	/** The gas leg's own salt, when the send bought gas. The PrivateFPC re-derives the Fee Juice
	 *  secret from it, and the plaintext journal copy is the only other place it exists — a record
	 *  restored from a file without it can never claim its gas privately. */
	fuelSaltStr?: string
	recipient: string
	tokenAmountStr: string
	from: string
	wallet: DepositL1Ctx["wallet"]
	sealKeys: Map<string, SiteKey>
	readBack: () => DepositJournalRecord | undefined
	/** The recovery-key domain: a send binds to ITS token's clone and the hub, so the key is per-token. */
	binding: Omit<RecoveryBinding, "secretHashHex">
}): Promise<void> {
	const { id, secretStr, recipient, tokenAmountStr, from, wallet, sealKeys, readBack, binding } = ctx
	const provider = providerFingerprint()
	const trusted = isSealTrusted(localStorage, NETWORK.l1ChainId, from, provider)
	log(trusted ? "seal: trusted wallet - one signature" : "seal: first private bridge for this wallet - two signatures")
	setRecordStep(
		id,
		"sealing",
		trusted ? "one Ethereum signature — encrypts the recovery secret" : "two Ethereum signatures — encrypt + verify determinism",
	)
	const sign = (m: string) => runOnLane("l1", () => wallet.signMessage({ account: from, message: m } as never) as Promise<string>)
	const envelope = {
		secret: secretStr,
		recipient,
		amount: tokenAmountStr,
		sealerL1: from,
		...(ctx.fuelSaltStr ? { salt: ctx.fuelSaltStr } : {}),
	}
	const { blob, key } = await sealDepositRecord({ sign, binding: { ...binding, secretHashHex: id }, envelope, trusted })
	if (!trusted) markSealTrusted(localStorage, NETWORK.l1ChainId, from, provider)
	sealKeys.set(id, key)
	cacheSecret(id, secretStr, { v: 2, ...envelope })
	updateRecord(id, { sealedEnvelope: blob, sealerL1: from })
	const sealed = readBack()
	if (!sealed?.sealedEnvelope) {
		throw new Error("Could not persist the sealed recovery secret — aborting before the deposit (storage full?).")
	}
}
