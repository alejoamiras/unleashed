import {
	type BridgeBackupFile,
	type BridgeJournalRecord,
	feeJuiceAddress,
	isSealTrusted,
	markSealTrusted,
	openBridgeBackup,
	parseBackupFile,
	recoveryKeyFromSignature,
	recoveryKeyMessage,
	sealBridgeBackup,
} from "@unleashed/bridge-core"
import { NETWORK } from "@/lib/network"
import { FUEL_PORTAL } from "@/contracts/bridge-generation"
import {
	addRecordVerified,
	deploymentMatches,
	runOnLane,
	sendHeaderMatches,
	useBridgeJournal,
	validateSendRecordBlock,
} from "./useBridgeJournal"
import { providerFingerprint } from "./deposit-flow"
import { getRetainedSealKey } from "./useSend"
import { useL1Wallet } from "./useL1Wallet"
import { useToast } from "./useToast"

// Ids, directions, and copy only - blobs, signatures, and keys never reach this log.
const log = (...args: unknown[]) => console.log("[bridge:backup]", ...args)

function backupFileName(rec: BridgeJournalRecord): string {
	return `unleashed-bridge-${rec.direction}-${rec.id.slice(0, 12)}.json`
}

function triggerDownload(file: BridgeBackupFile, name: string): void {
	const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, "\t")], { type: "application/json" }))
	const a = document.createElement("a")
	a.href = url
	a.download = name
	a.click()
	// Deferred: Safari has canceled downloads when the URL is revoked synchronously after click.
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Export/restore of per-bridge sealed recovery files. The key is the record-bound recovery key
 * (the signature IS the key material): same-session sealed deposits reuse the retained in-memory
 * key (zero signatures); otherwise export is trust-aware like the private seal - an untrusted
 * wallet proves signature determinism ONCE (two signatures, then cached), a trusted one signs
 * once. A non-deterministic signer must fail HERE, never produce an unrestorable file.
 */
const exportsInFlight = new Set<string>()

/** A schema-3 file is only tracked once its own binding AND its token block still agree with the
 *  chain: an imported record is attacker-supplied, and the block is what every later claim or exit
 *  is built from. */
async function assertSendRecordImportable(record: BridgeJournalRecord): Promise<void> {
	if (record.schema !== 3) return
	if (!deploymentMatches(record)) {
		throw new Error("This file belongs to a different bridge deployment — it cannot be restored here.")
	}
	const blocked = await validateSendRecordBlock(record)
	if (blocked) throw new Error(blocked)
}

export function useBridgeBackup() {
	const l1 = useL1Wallet()
	const journal = useBridgeJournal()
	const toast = useToast()

	function signer(): { sign: (m: string) => Promise<string>; from: string } {
		const wallet = l1.ensureWalletClient()
		const from = l1.address.value
		if (!wallet || !from) throw new Error("Connect your Ethereum wallet first.")
		return {
			sign: (m: string) => runOnLane("l1", () => wallet.signMessage({ account: from, message: m } as never) as Promise<string>),
			from,
		}
	}

	async function deriveKey(rec: Pick<BridgeJournalRecord, "id" | "chainId" | "portal" | "bridge">, mode: "export" | "restore") {
		const retained = getRetainedSealKey(rec.id)
		if (retained) return retained
		const { sign, from } = signer()
		const message = recoveryKeyMessage({
			chainId: rec.chainId,
			portal: rec.portal,
			bridge: rec.bridge,
			secretHashHex: rec.id,
		})
		const provider = providerFingerprint()
		const trusted = isSealTrusted(localStorage, rec.chainId, from, provider)
		const sig = await sign(message)
		if (mode === "export" && !trusted) {
			// Determinism self-test (one-time per wallet): an export sealed under a key the wallet
			// cannot re-derive would be unrestorable - fail now, before a file exists.
			const sig2 = await sign(message)
			if (sig.trim().toLowerCase() !== sig2.trim().toLowerCase()) {
				throw new Error("This wallet signs non-deterministically — a recovery file made with it could never be reopened. Aborting.")
			}
			markSealTrusted(localStorage, rec.chainId, from, provider)
		}
		return recoveryKeyFromSignature(sig)
	}

	/** Seal + download ONE bridge. Refusals (provisional, unsealed-private) come from the module. */
	async function exportBridge(rec: BridgeJournalRecord): Promise<void> {
		if (exportsInFlight.has(rec.id)) return // a double-click must not queue a second prompt.
		exportsInFlight.add(rec.id)
		try {
			const from = l1.address.value
			if (!from) throw new Error("Connect your Ethereum wallet first.")
			const key = await deriveKey(rec, "export")
			const file = await sealBridgeBackup(key, rec, from)
			triggerDownload(file, backupFileName(rec))
			log("exported", { id: rec.id, direction: rec.direction })
		} finally {
			exportsInFlight.delete(rec.id)
		}
	}

	/** The shared surface handler: both the card and the stepper export with the same toasts. */
	async function exportBridgeWithToast(rec: BridgeJournalRecord): Promise<void> {
		try {
			await exportBridge(rec)
			toast.push({ kind: "saved", text: "Recovery file downloaded. Keep it with your wallet." })
		} catch (e) {
			toast.push({ kind: "error", text: e instanceof Error ? e.message : "Export failed." })
		}
	}

	/** The restore ladder. Returns the restored record; throws user-facing copy per step. */
	async function restoreFile(raw: string): Promise<BridgeJournalRecord> {
		const file = parseBackupFile(raw)
		const portal = file.portal.toLowerCase()
		const bridge = file.bridge.toLowerCase()
		// A Fuel recovery file binds to the canonical FeeJuicePortal + the L2 Fee Juice address.
		const matchesFuel = portal === FUEL_PORTAL.toLowerCase() && bridge === feeJuiceAddress.toLowerCase()
		// A send file's portal is its TOKEN's clone, which the header alone cannot pin down; the hub
		// is what the header can prove, and the unsealed record proves the rest.
		const matchesSend = sendHeaderMatches(file.chainId, bridge)
		if (file.chainId !== NETWORK.l1ChainId || (!matchesFuel && !matchesSend)) {
			throw new Error("This file belongs to a different bridge deployment — it cannot be restored here.")
		}
		if (journal.records.value.some((r) => r.id === file.id)) {
			throw new Error("This bridge is already tracked here — nothing to restore.")
		}
		const record = await openBridgeBackup(await deriveKey(file, "restore"), file)
		if (journal.records.value.some((r) => r.id === record.id)) {
			throw new Error("This bridge is already tracked here — nothing to restore.")
		}
		await assertSendRecordImportable(record)
		addRecordVerified(record)
		log("restored", { id: record.id, direction: record.direction })
		return record
	}

	return { exportBridge, exportBridgeWithToast, restoreFile }
}
