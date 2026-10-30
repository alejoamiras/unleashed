/**
 * The app's side of a send around the SDK: the seal before its first transaction, the Fee Juice balance reads its
 * fee choices make, and the journal-bound fuel helpers the card's gas actions use. State stays OWNED by the
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
	type FeeLadderStore,
	type RecoveryL1Client,
	type StoredRecord,
	fuelReceiptStatus as fuelReceiptStatusOn,
	patchFuel as patchFuelOn,
	readFeeJuiceOrNull as readFeeJuiceOrNullOn,
} from "@unleashed/sdk/internal"
import { PRIVATE_FPC_ADDRESS } from "@unleashed/sdk/protocol"
import { NETWORK } from "@/lib/network"
import { appNode } from "@/lib/aztec-node"
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

/** The journal as the fuel helpers' store: every read is the PERSISTED record, every guarded write one synchronous load. */
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
