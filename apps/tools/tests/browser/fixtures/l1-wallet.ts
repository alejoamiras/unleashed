/**
 * An injected EIP-1193 wallet for the tools page, answered from Node: the page's `window.ethereum`
 * forwards every request through an exposed function to a viem wallet client over the anvil of the
 * chain it is on, which signs with the run's actor key. Wrong-chain, account-change, rejection and
 * batch cells drive it through the control it returns.
 */
import type { BrowserContext, Page } from "@playwright/test"
import { type Address, createPublicClient, createWalletClient, defineChain, type Hex, http, numberToHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

export interface L1WalletOptions {
	/** The anvil behind each chain the wallet can switch to; it starts on `chainId`, which must be one of them. */
	rpcUrls: Readonly<Record<number, string>>
	privateKey: Hex
	chainId: number
}

/** One EIP-5792 `wallet_sendCalls` the page made, as it asked, and the transactions the wallet sent for it. */
export interface CallBatch {
	id: string
	chainId: number
	atomicRequired: boolean
	calls: { to: Address; data?: Hex; value?: Hex }[]
	hashes: Hex[]
}

export type RejectKind = "signature" | "transaction"

/** Narrows a hold to one transaction target — the deposit's router, not the ERC-20 approval before it. */
export interface HoldMatch {
	to?: Address
}

/** One Permit2 `PermitWitnessTransferFrom` the page asked the wallet to sign, as signed, with the wallet's clock. */
export interface SignedPermit {
	signedAt: number
	domain: { name?: string; chainId?: number; verifyingContract?: string }
	primaryType: string
	permitted: { token: string; amount: bigint }
	spender: string
	nonce: bigint
	deadline: bigint
	witness: Record<string, unknown>
}

export interface L1WalletControl {
	address: Address
	/** Everything the page has had signed so far — typed data, transactions, messages. */
	readonly signatures: number
	/** Every Permit2 permit signed so far, in order (other typed data is not a permit and is not listed). */
	permits(): SignedPermit[]
	/** How often the page asked for one wallet-side method (`eth_sendTransaction`,
	 *  `eth_signTypedData_v4`, `personal_sign`), held and refused calls included. */
	calls(method: string): number
	/** The chain `eth_chainId` answers; a change emits `chainChanged` in every page of the context. A chain
	 *  without an anvil of its own reads and signs through the starting chain's, as a misconfigured wallet would. */
	setChainId(chainId: number): Promise<void>
	readonly chainId: number
	/** Report EIP-5792 atomic batching on `chainId` from now on; null (the default) reports it nowhere. */
	atomicOn(chainId: number | null): void
	/** The next batch is sent at once but its receipts are withheld (`wallet_getCallsStatus` answers pending) until
	 *  `releaseBatchReceipts`: a wallet whose batch landed before it told the page. */
	holdBatchReceipts(): void
	releaseBatchReceipts(): void
	batches(): CallBatch[]
	/** Sends from this account on `chainId` outside the page, as another app would have before this one opened. */
	sendOutside(chainId: number, call: { to: Address; data: Hex }): Promise<Hex>
	/** Swap the signing key; emits `accountsChanged`. */
	setAccount(privateKey: Hex): Promise<void>
	/** The next request of that kind is refused with EIP-1193 code 4001. */
	rejectNext(kind: RejectKind): void
	/** The next request of that kind (matching `match` when given) never answers — the shape of a
	 *  wallet whose prompt the user left open; the page that made it must be reloaded to get past it. */
	holdNext(kind: RejectKind, match?: HoldMatch): void
	/** The next transaction (matching `match` when given) is BROADCAST through the wallet and then
	 *  never answered — the shape of a wallet that sent but whose reply the page never received. */
	swallowNext(match?: HoldMatch): void
	/** How many holds and swallows are still armed — zero once the request has arrived and parked. */
	holdsArmed(): number
	/** Answer every parked request: the wallet performs it now, as if its prompt had been confirmed. */
	release(): Promise<void>
}

type Rpc = { method: string; params?: unknown[] }

const USER_REJECTED = { code: 4001, message: "User rejected the request." }
/** EIP-3326: a chain this wallet has no network for. */
const UNKNOWN_CHAIN = { code: 4902, message: "Unrecognized chain ID." }

type BatchRequest = { chainId: Hex; atomicRequired: boolean; calls: { to: Address; data?: Hex; value?: Hex }[] }
type RawReceipt = { status: Hex; logs: unknown[]; blockHash: Hex; blockNumber: Hex; gasUsed: Hex; transactionHash: Hex } | null

/** EIP-5792 batches: sent one call after another on the chain the wallet is on, answered with the receipts the
 *  chain holds for them unless a hold withholds them. */
class BatchBook {
	private atomicChain: number | null = null
	private readonly list: CallBatch[] = []
	private readonly withheld = new Set<string>()
	private holdArmed = false

	setAtomic(chainId: number | null): void {
		this.atomicChain = chainId
	}
	atomicOn = (chainId: number): boolean => this.atomicChain === chainId
	holdNext(): void {
		this.holdArmed = true
	}
	release(): void {
		this.withheld.clear()
	}
	all = (): CallBatch[] => this.list.map((b) => ({ ...b, hashes: [...b.hashes] }))

	/** Files a batch; refuses one for another chain (5710) or one that must be atomic where this wallet is not (5760). */
	open(req: BatchRequest, walletChain: number): string {
		const chainId = Number(req.chainId)
		if (chainId !== walletChain) throw { code: 5710, message: `the batch names chain ${chainId}; the wallet is on ${walletChain}` }
		if (req.atomicRequired && !this.atomicOn(chainId)) throw { code: 5760, message: "Atomicity not supported." }
		const id = numberToHex(BigInt(this.list.length + 1), { size: 32 })
		this.list.push({ id, chainId, atomicRequired: req.atomicRequired, calls: req.calls, hashes: [] })
		if (this.holdArmed) this.withheld.add(id)
		this.holdArmed = false
		return id
	}

	async send(id: string, sendOne: (call: { to: Address; data?: Hex; value?: bigint }) => Promise<Hex>): Promise<void> {
		const batch = this.byId(id)
		for (const c of batch.calls)
			batch.hashes.push(await sendOne({ to: c.to, data: c.data, value: c.value ? BigInt(c.value) : undefined }))
	}

	async status(id: string, receiptOf: (chainId: number, hash: Hex) => Promise<unknown>) {
		const b = this.byId(id)
		const head = { version: "2.0.0", id, chainId: numberToHex(b.chainId), atomic: this.atomicOn(b.chainId) }
		if (this.withheld.has(id)) return { ...head, status: 100 }
		const receipts = (await Promise.all(b.hashes.map((h) => receiptOf(b.chainId, h)))) as RawReceipt[]
		if (receipts.some((r) => r === null)) return { ...head, status: 100 }
		const ok = receipts.every((r) => r?.status === "0x1")
		const fields = (r: NonNullable<RawReceipt>) => ({
			logs: r.logs,
			status: r.status,
			blockHash: r.blockHash,
			blockNumber: r.blockNumber,
			gasUsed: r.gasUsed,
			transactionHash: r.transactionHash,
		})
		return { ...head, status: ok ? 200 : 500, receipts: receipts.map((r) => fields(r as NonNullable<RawReceipt>)) }
	}

	private byId(id: string): CallBatch {
		const b = this.list.find((x) => x.id === id)
		if (!b) throw { code: 5730, message: `unknown batch ${id}` }
		return b
	}
}

/** JSON turned every bigint into a string on the way over; the ABI types say which ones to restore. */
function coerceTyped(types: Record<string, { name: string; type: string }[]>, type: string, value: unknown): unknown {
	const fields = types[type]
	if (!fields || typeof value !== "object" || value === null) return value
	const out: Record<string, unknown> = {}
	for (const f of fields) {
		const v = (value as Record<string, unknown>)[f.name]
		if (/^u?int\d*$/.test(f.type)) out[f.name] = typeof v === "string" ? BigInt(v) : v
		else if (f.type.endsWith("[]")) out[f.name] = Array.isArray(v) ? v.map((x) => coerceTyped(types, f.type.slice(0, -2), x)) : v
		else out[f.name] = coerceTyped(types, f.type, v)
	}
	return out
}

/** The `eth_signTypedData_v4` payload as viem signs it: the domain's chain id numeric, `EIP712Domain` out of `types`. */
function typedDataOf(json: string) {
	const typed = JSON.parse(json) as {
		domain: Record<string, unknown>
		types: Record<string, { name: string; type: string }[]>
		primaryType: string
		message: Record<string, unknown>
	}
	const domain = { ...typed.domain, chainId: typed.domain.chainId === undefined ? undefined : Number(typed.domain.chainId) }
	const { EIP712Domain: _domain, ...types } = typed.types
	return {
		domain,
		types,
		primaryType: typed.primaryType,
		message: coerceTyped(types, typed.primaryType, typed.message) as Record<string, unknown>,
	}
}

export async function installL1Wallet(context: BrowserContext, o: L1WalletOptions): Promise<L1WalletControl> {
	const home = o.rpcUrls[o.chainId]
	if (!home) throw new Error(`the L1 wallet starts on chain ${o.chainId}, which has no anvil`)
	const rpcOf = (id: number) => o.rpcUrls[id] ?? home
	const chain = (id: number) =>
		defineChain({
			id,
			name: `anvil-${id}`,
			nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
			rpcUrls: { default: { http: [rpcOf(id)] } },
		})
	let account = privateKeyToAccount(o.privateKey)
	let chainId = o.chainId
	const clientOn = (id: number) => createWalletClient({ account, chain: chain(id), transport: http(rpcOf(id)) })
	const readerOn = (id: number) => createPublicClient({ chain: chain(id), transport: http(rpcOf(id)) })
	let client = clientOn(chainId)
	const batches = new BatchBook()
	const rejections = new Set<RejectKind>()
	const holds: Array<{ kind: RejectKind; match?: HoldMatch }> = []
	const swallows: Array<{ match?: HoldMatch }> = []
	const parked: Array<{ perform: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = []
	const counts: Record<string, number> = {}
	const permits: SignedPermit[] = []
	let signed = 0
	const recordPermit = (typed: ReturnType<typeof typedDataOf>) => {
		if (typed.primaryType !== "PermitWitnessTransferFrom") return
		const m = typed.message as {
			permitted: { token: string; amount: bigint }
			spender: string
			nonce: bigint
			deadline: bigint
			witness: Record<string, unknown>
		}
		permits.push({
			signedAt: Math.floor(Date.now() / 1000),
			domain: typed.domain as SignedPermit["domain"],
			primaryType: typed.primaryType,
			permitted: m.permitted,
			spender: m.spender,
			nonce: m.nonce,
			deadline: m.deadline,
			witness: m.witness,
		})
	}
	const takeRejection = (kind: RejectKind) => rejections.delete(kind)
	/** A matching hold is consumed and the call parks until `release()` (or forever); a hold for
	 *  another target stays armed. */
	const takeHold = (kind: RejectKind, to: string | undefined, perform: () => Promise<unknown>): Promise<unknown> | undefined => {
		const i = holds.findIndex((h) => h.kind === kind && (h.match?.to === undefined || h.match.to.toLowerCase() === to?.toLowerCase()))
		if (i < 0) return undefined
		holds.splice(i, 1)
		return new Promise<unknown>((resolve, reject) => parked.push({ perform, resolve, reject }))
	}
	const takeSwallow = (to?: string): boolean => {
		const i = swallows.findIndex((h) => h.match?.to === undefined || h.match.to.toLowerCase() === to?.toLowerCase())
		if (i < 0) return false
		swallows.splice(i, 1)
		return true
	}
	const count = (method: string) => {
		counts[method] = (counts[method] ?? 0) + 1
	}

	const emit = (event: string, payload: unknown) =>
		Promise.all(
			context.pages().map((p) => p.evaluate(([e, v]) => window.__unleashedL1Emit?.(e, v), [event, payload] as const).catch(() => {})),
		)

	const switchChain = async (id: number) => {
		chainId = id
		client = clientOn(chainId)
		await emit("chainChanged", `0x${id.toString(16)}`)
	}
	const refuse = (kind: RejectKind) => {
		if (takeRejection(kind)) throw USER_REJECTED
	}

	/** The wallet-side methods; anything else is a node read, proxied to the current chain's anvil as-is. */
	const wallet: Record<string, (params: unknown[]) => Promise<unknown>> = {
		eth_requestAccounts: async () => [account.address],
		eth_accounts: async () => [account.address],
		eth_chainId: async () => `0x${chainId.toString(16)}`,
		wallet_switchEthereumChain: async (params) => {
			count("wallet_switchEthereumChain")
			const id = Number.parseInt((params[0] as { chainId: string }).chainId, 16)
			if (!(id in o.rpcUrls)) throw UNKNOWN_CHAIN
			await switchChain(id)
			return null
		},
		wallet_getCapabilities: async (params) => {
			count("wallet_getCapabilities")
			const asked = (params[1] as Hex[] | undefined) ?? Object.keys(o.rpcUrls).map((id) => numberToHex(Number(id)))
			return Object.fromEntries(
				asked.map((id) => [id, { atomic: { status: batches.atomicOn(Number(id)) ? "supported" : "unsupported" } }]),
			)
		},
		wallet_sendCalls: async (params) => {
			count("wallet_sendCalls")
			refuse("transaction")
			const id = batches.open(params[0] as BatchRequest, chainId)
			signed++
			await batches.send(id, (call) => client.sendTransaction(call))
			return { id }
		},
		wallet_getCallsStatus: async (params) =>
			batches.status(params[0] as string, (id, hash) =>
				readerOn(id).request({ method: "eth_getTransactionReceipt", params: [hash] }),
			),
		eth_sendTransaction: (params) => {
			count("eth_sendTransaction")
			refuse("transaction")
			const tx = params[0] as { to?: Address; data?: Hex; value?: Hex; gas?: Hex }
			const send = () => {
				signed++
				return client.sendTransaction({
					to: tx.to,
					data: tx.data,
					value: tx.value ? BigInt(tx.value) : undefined,
					gas: tx.gas ? BigInt(tx.gas) : undefined,
				})
			}
			const held = takeHold("transaction", tx.to, send)
			if (held) return held
			const sent = send()
			if (takeSwallow(tx.to)) return sent.then(() => new Promise<never>(() => {}))
			return sent
		},
		eth_signTypedData_v4: (params) => {
			count("eth_signTypedData_v4")
			refuse("signature")
			const sign = () => {
				signed++
				const typed = typedDataOf(params[1] as string)
				recordPermit(typed)
				return account.signTypedData(typed)
			}
			const held = takeHold("signature", undefined, sign)
			if (held) return held
			return sign()
		},
		personal_sign: (params) => {
			count("personal_sign")
			refuse("signature")
			const sign = () => {
				signed++
				return account.signMessage({ message: { raw: params[0] as Hex } })
			}
			const held = takeHold("signature", undefined, sign)
			if (held) return held
			return sign()
		},
	}
	const handle = (rpc: Rpc) => {
		const params = rpc.params ?? []
		const method = wallet[rpc.method]
		return method ? method(params) : client.request({ method: rpc.method, params } as never)
	}

	// UNLEASHED_E2E_TRACE_L1=1 prints every request and its outcome to the runner's stdout.
	const trace = process.env.UNLEASHED_E2E_TRACE_L1 === "1" ? (line: string) => console.log(`[l1] ${line}`) : () => {}
	await context.exposeFunction("__unleashedL1Request", async (json: string) => {
		const rpc = JSON.parse(json) as Rpc
		try {
			const result = await handle(rpc)
			trace(`${rpc.method} → ${JSON.stringify(result)?.slice(0, 80)}`)
			return JSON.stringify({ result })
		} catch (e) {
			const err = e as { code?: number; message?: string; shortMessage?: string }
			trace(`${rpc.method} ✗ ${err.shortMessage ?? err.message ?? String(e)}`)
			return JSON.stringify({ error: { code: err.code ?? -32000, message: err.shortMessage ?? err.message ?? String(e) } })
		}
	})
	await context.addInitScript(() => {
		const listeners = new Map<string, Set<(v: unknown) => void>>()
		const provider = {
			async request(args: { method: string; params?: unknown[] }) {
				const reply = JSON.parse(await window.__unleashedL1Request(JSON.stringify(args))) as {
					result?: unknown
					error?: { code: number; message: string }
				}
				if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code })
				return reply.result
			},
			on(event: string, fn: (v: unknown) => void) {
				listeners.set(event, (listeners.get(event) ?? new Set()).add(fn))
				return provider
			},
			removeListener(event: string, fn: (v: unknown) => void) {
				listeners.get(event)?.delete(fn)
				return provider
			},
		}
		window.__unleashedL1Emit = (event, value) => {
			for (const fn of listeners.get(event) ?? []) fn(value)
		}
		Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false })
	})

	return {
		get address() {
			return account.address
		},
		get signatures() {
			return signed
		},
		calls: (method) => counts[method] ?? 0,
		permits: () => [...permits],
		setChainId: switchChain,
		get chainId() {
			return chainId
		},
		atomicOn: (id) => batches.setAtomic(id),
		holdBatchReceipts: () => batches.holdNext(),
		releaseBatchReceipts: () => batches.release(),
		batches: () => batches.all(),
		sendOutside: async (id, call) => {
			const hash = await clientOn(id).sendTransaction(call)
			const receipt = await readerOn(id).request({ method: "eth_getTransactionReceipt", params: [hash] })
			if (receipt?.status !== "0x1") throw new Error(`the outside transaction ${hash} on chain ${id} did not succeed`)
			return hash
		},
		async setAccount(privateKey) {
			account = privateKeyToAccount(privateKey)
			client = clientOn(chainId)
			await emit("accountsChanged", [account.address])
		},
		rejectNext(kind) {
			rejections.add(kind)
		},
		holdNext(kind, match) {
			holds.push({ kind, match })
		},
		swallowNext(match) {
			swallows.push({ match })
		},
		holdsArmed: () => holds.length + swallows.length,
		async release() {
			const waiting = parked.splice(0)
			for (const p of waiting) await p.perform().then(p.resolve, p.reject)
		},
	}
}

/** The frame a page hosts for the test wallet, once the SDK has created it. */
export function walletFrameOf(page: Page, walletOrigins: readonly string[]) {
	return page.frames().find((f) => walletOrigins.includes(originOf(f.url())) && f.url().includes("profile="))
}

function originOf(url: string): string {
	try {
		return new URL(url).origin
	} catch {
		return ""
	}
}

declare global {
	interface Window {
		__unleashedL1Request: (json: string) => Promise<string>
		__unleashedL1Emit?: (event: string, value: unknown) => void
	}
}
