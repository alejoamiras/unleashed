/** The app's bridge journal, read from the page's storage: the exact figures a send recorded. */
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { JOURNAL_KEY_PREFIX, SWAP_BRIDGE_ROUTER_ABI } from "@unleashed/bridge-core"
import type { Page } from "@playwright/test"
import { decodeFunctionData } from "viem"

export interface JournalDeposit {
	id: string
	direction: string
	intent?: string
	/** The token leg's base units — what a token+gas send delivers as the token, the whole amount otherwise. */
	amount?: string
	depositTxHash?: string
	claimTxHash?: string
	registerTxHash?: string
	/** The token was claimed by another submitter; the record completes without a claim hash of its own. */
	claimedByOther?: boolean
	completedAt?: number
	fuel?: { received?: string; claimTxHash?: string }
	/** The Aztec account the deposit claims to. */
	recipient?: string
	isPrivate?: boolean
	/** PUBLIC deposits only: the raw claim secret the record carries (a private one is sealed). */
	secret?: string
	leafIndex?: string
	/** The token message's inbox key, once the deposit receipt was read. */
	messageHash?: string
	/** The token block the send read back from the factory — what the harness derives the L2 token from. */
	token?: {
		erc20: string
		portal: string
		l2Token: string
		nameWord: string
		symbolWord: string
		decimals: number
		displaySymbol: string
	}
}

export interface JournalExit {
	id: string
	direction: string
	exitTxHash?: string
	consumeTxHash?: string
	/** The token's portal clone the finish transaction goes to. */
	portal?: string
}

/** Every exit record the journal holds, newest last. */
export async function exitRecords(page: Page): Promise<JournalExit[]> {
	return collect(await readJournal(page), "withdraw") as unknown as JournalExit[]
}

/** Every deposit record the journal holds, newest last. */
export async function depositRecords(page: Page): Promise<JournalDeposit[]> {
	return collect(await readJournal(page), "deposit") as unknown as JournalDeposit[]
}

async function readJournal(page: Page): Promise<unknown[]> {
	return page.evaluate((prefix) => {
		const out: unknown[] = []
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i)
			if (!key?.startsWith(prefix)) continue
			try {
				out.push(JSON.parse(localStorage.getItem(key) ?? "null"))
			} catch {}
		}
		return out
	}, JOURNAL_KEY_PREFIX)
}

/** Records of one direction wherever the stored shape nests them (arrays, keyed maps, wrapper objects). */
function collect(v: unknown, direction: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
	if (Array.isArray(v)) {
		for (const x of v) collect(x, direction, out)
		return out
	}
	if (!v || typeof v !== "object") return out
	const o = v as Record<string, unknown>
	if (typeof o.id === "string" && o.direction === direction) out.push(o)
	else for (const x of Object.values(o)) collect(x, direction, out)
	return out
}

/** The Permit2 fields the deposit transaction carried on-chain — what the signed permit must equal. */
export interface DepositPermitCalldata {
	functionName: "bridge" | "bridgeWithFuel"
	to: string
	nonce: bigint
	deadline: bigint
	bridgeToken: string
	amount: bigint
}

type PublicClientLike = { getTransaction: (a: { hash: `0x${string}` }) => Promise<{ to?: string | null; input: `0x${string}` }> }

/** Decode the router call the journal's deposit hash points at: the entry, its token and total, and the permit. */
export async function depositCalldata(pub: unknown, depositTxHash: string): Promise<DepositPermitCalldata> {
	const tx = await (pub as PublicClientLike).getTransaction({ hash: depositTxHash as `0x${string}` })
	const decoded = decodeFunctionData({ abi: SWAP_BRIDGE_ROUTER_ABI, data: tx.input })
	const [p, permit] = decoded.args as unknown as [Record<string, unknown>, { nonce: bigint; deadline: bigint }]
	const functionName = decoded.functionName as DepositPermitCalldata["functionName"]
	return {
		functionName,
		to: (tx.to ?? "").toLowerCase(),
		nonce: permit.nonce,
		deadline: permit.deadline,
		bridgeToken: String(p.bridgeToken).toLowerCase(),
		amount: (functionName === "bridge" ? p.amount : p.totalAmount) as bigint,
	}
}

type NodeLike = { getTxReceipt: (hash: TxHash) => Promise<{ transactionFee?: bigint }> }

/** What a landed L2 transaction billed, from the node's receipt. */
export async function transactionFeeOf(node: unknown, txHash: string): Promise<bigint> {
	const receipt = await (node as NodeLike).getTxReceipt(TxHash.fromString(txHash))
	if (receipt.transactionFee === undefined) throw new Error(`no transactionFee on the receipt of ${txHash}`)
	return receipt.transactionFee
}

/** The fuel a deposit's event recorded and the fee its claim billed — the two sides of conservation. */
export async function fuelConservation(page: Page, node: unknown): Promise<{ received: bigint; fee: bigint }> {
	const records = await depositRecords(page)
	const rec = records.at(-1)
	if (!rec) throw new Error("the journal holds no deposit")
	const received = rec.fuel?.received
	const claim = rec.fuel?.claimTxHash ?? rec.claimTxHash
	if (received === undefined || !claim)
		throw new Error(`the deposit ${rec.id} has no fuel figures (received ${received}, claim ${claim})`)
	return { received: BigInt(received), fee: await transactionFeeOf(node, claim) }
}
