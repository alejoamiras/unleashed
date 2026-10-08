/**
 * L1-side helpers shared by the operator scripts: the minimal ERC-20 ABI, the read-back assertion,
 * the operator-only factory/router constants the app's ABIs omit, and the portal/router preflights
 * every gate runs before it trusts a generation.
 */
import { type Abi, type Account, type Address, type Chain, defineChain, encodeFunctionData, type Hex, type WalletClient } from "viem"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import type { L1Ctx } from "../src/flows"
import { ensurePermit2Allowance } from "../src/l1"
import { predictPortal } from "../src/portal-address"
import { SWAP_BRIDGE_ROUTER_ABI } from "../src/router-abi"
import { sourceChain } from "../src/source-chains"
import { retried } from "./retried"

/** Minimal ERC20 surface the scripts touch. A superset per consumer is harmless — viem only
 *  encodes the functions actually called. */
export const ERC20_MIN_ABI = [
	{ type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
	{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
	{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
	{
		type: "function",
		name: "allowance",
		stateMutability: "view",
		inputs: [{ type: "address" }, { type: "address" }],
		outputs: [{ type: "uint256" }],
	},
	{
		type: "function",
		name: "approve",
		stateMutability: "nonpayable",
		inputs: [{ type: "address" }, { type: "uint256" }],
		outputs: [{ type: "bool" }],
	},
] as const

/** The router constants only the operator gates read; the app-facing ABI carries the call surface. */
export const ROUTER_CONSTANTS_ABI = [
	{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "permit2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "BRIDGE_WITNESS_TYPE_STRING", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const

/** The factory constants only the operator gates read. The guardian is the OWNER (the pause bits are
 *  all it can reach), and the registry the factory was built against is observable only through the
 *  inbox + rollup version its constructor froze. */
export const FACTORY_CONSTANTS_ABI = [
	{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "INBOX", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "ROLLUP_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const

/** The implementation's frozen pointers. A clone has no storage and no initializer, so these are the
 *  whole of what every token's portal delegates into — read them on the implementation itself. */
export const PORTAL_IMPL_CONSTANTS_ABI = [
	{ type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "INBOX", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "OUTBOX", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "ROLLUP_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
	{ type: "function", name: "L2_HUB", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const

/** `TestnetFuelSwapper`'s operator surface. */
export const FUEL_SWAPPER_ABI = [
	{ type: "function", name: "FEE_ASSET", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "FEE_ASSET_HANDLER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
	{ type: "function", name: "rate", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
	{
		type: "function",
		name: "setRate",
		stateMutability: "nonpayable",
		inputs: [{ type: "address" }, { type: "uint256" }],
		outputs: [],
	},
] as const

/** Aztec's testnet fee-asset faucet: permissionless, `mintAmount()` per call. */
export const FEE_ASSET_HANDLER_ABI = [
	{ type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
	{ type: "function", name: "mintAmount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const

/** How many floor-sized fueled sends the swapper's inventory should cover before `verify-l1` warns. Below it a swap
 *  still settles: the swapper mints from the faucet itself when short. */
export const SWAPPER_INVENTORY_SENDS = 10n

/** The stated inventory floor for a manifest's `fuel.minFuelFj`. */
export const swapperInventoryFloor = (minFuelFj: string | bigint): bigint => BigInt(minFuelFj) * SWAPPER_INVENTORY_SENDS

/** The env var that overrides each source chain's read RPC; without it the source catalogue's first keyless
 *  provider is used, and a chain with neither has no RPC. */
const SOURCE_RPC_ENV: Readonly<Record<number, string>> = {
	84532: "BASE_SEPOLIA_RPC_URL",
	8453: "BASE_RPC_URL",
	42161: "ARBITRUM_RPC_URL",
	10: "OPTIMISM_RPC_URL",
}

export function sourceRpcUrl(chainId: number, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
	const name = SOURCE_RPC_ENV[chainId]
	return (name ? env[name] : undefined) || sourceChain(chainId)?.rpcUrls[0]
}

/** One write, waited for: a reverted receipt throws, so no later step runs on a transaction that did nothing. */
export async function sendL1(
	l1: L1Ctx,
	call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<Hex> {
	const hash = await l1.wallet.writeContract({ ...call, account: l1.account, chain: l1.wallet.chain } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`${call.functionName} on ${call.address} REVERTED (${hash}) — STOP`)
	return hash
}

/** The explicit gas terms a bounded send carries. */
export interface GasTerms {
	gas: bigint
	maxFeePerGas: bigint
	maxPriorityFeePerGas: bigint
}

/** One send, as the node estimates it. */
export interface SendRequest {
	account: Address
	to?: Address
	data: Hex
	value?: bigint
	/** A gas limit the caller already chose; the terms keep it instead of estimating. */
	gas?: bigint
}

export type GasTermsFor = (request: SendRequest) => Promise<GasTerms>

/** The pricing reads a bounded send needs (a viem public client's shape). */
export interface GasPricing {
	estimateGas(args: SendRequest): Promise<bigint>
	estimateFeesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>
}

/**
 * Terms that bound a send's execution fee by `gas × maxFeePerGas`: the node's estimate plus a quarter, since state
 * moves before inclusion, at the chain's current EIP-1559 caps. `charge` sees that worst case before the send exists
 * and throws to refuse it. An OP-stack chain's L1 data fee is billed outside the product.
 */
export function boundedGasTerms(pub: GasPricing, charge: (worstWei: bigint, request: SendRequest) => void): GasTermsFor {
	return async (request) => {
		const gas = request.gas ?? ((await pub.estimateGas(request)) * 5n) / 4n
		const { maxFeePerGas, maxPriorityFeePerGas } = await pub.estimateFeesPerGas()
		charge(gas * maxFeePerGas, request)
		return { gas, maxFeePerGas, maxPriorityFeePerGas }
	}
}

interface BoundedWrite {
	address: Address
	abi: Abi
	functionName: string
	args?: readonly unknown[]
	value?: bigint
	gas?: bigint
	account?: Account | Address | null
}

interface BoundedSend {
	to?: Address | null
	data?: Hex
	value?: bigint
	gas?: bigint
	account?: Account | Address | null
}

/** `wallet` with explicit terms from `terms` on every `writeContract` and `sendTransaction`, so none of its sends goes out
 *  unbounded. Every other action is the wallet's own. */
export function withGasTerms<W extends WalletClient>(wallet: W, terms: GasTermsFor): W {
	const from = (account: Account | Address | null | undefined): Address => {
		const a = account ?? wallet.account
		if (!a) throw new Error("a bounded send needs an account")
		return typeof a === "string" ? a : a.address
	}
	const writeContract = async (w: BoundedWrite) => {
		const data = encodeFunctionData({ abi: w.abi, functionName: w.functionName, args: w.args } as never)
		const bound = await terms({ account: from(w.account), to: w.address, data, value: w.value, gas: w.gas })
		return wallet.writeContract({ ...w, ...bound } as never)
	}
	const sendTransaction = async (s: BoundedSend) => {
		const bound = await terms({ account: from(s.account), to: s.to ?? undefined, data: s.data ?? "0x", value: s.value, gas: s.gas })
		return wallet.sendTransaction({ ...s, ...bound } as never)
	}
	return { ...wallet, writeContract, sendTransaction } as W
}

/**
 * Leaves `spender`'s allowance over `owner`'s `token` at exactly `amount`, never above: a standing max approval is
 * what an exploited spender drains. A token that refuses to move a non-zero allowance (USDT) is reset to zero
 * first. Returns the transactions sent, none when the allowance already equals `amount`.
 */
export async function approveExact(l1: L1Ctx, token: Address, spender: Address, amount: bigint): Promise<Hex[]> {
	const current = await allowanceOf(l1, token, spender)
	if (current === amount) return []
	const sent = current > 0n && amount > 0n ? [await sendL1(l1, approveCall(token, spender, 0n))] : []
	sent.push(await setAllowance(l1, token, spender, amount))
	return sent
}

/**
 * Sends `approve(spender, amount)` whatever the allowance reads now, and reads it back at the approval's own block.
 * Use it to revoke: a `latest` read can come from a backend behind an approval just made and report it absent.
 *
 * @throws when the approval reverts, or the allowance reads back as anything but `amount`.
 */
export async function setAllowance(l1: L1Ctx, token: Address, spender: Address, amount: bigint): Promise<Hex> {
	const hash = await sendL1(l1, approveCall(token, spender, amount))
	// A backend without the approval's block errors, and the read retries.
	const { blockNumber } = await l1.pub.waitForTransactionReceipt({ hash })
	const after = await retried(() => allowanceOf(l1, token, spender, blockNumber))
	if (after !== amount) throw new Error(`allowance of ${spender} over ${token} is ${after} after approving exactly ${amount} — STOP`)
	return hash
}

const approveCall = (token: Address, spender: Address, amount: bigint) =>
	({ address: token, abi: ERC20_MIN_ABI, functionName: "approve", args: [spender, amount] }) as const

const allowanceOf = async (l1: L1Ctx, token: Address, spender: Address, blockNumber?: bigint) =>
	(await l1.pub.readContract({
		address: token,
		abi: ERC20_MIN_ABI,
		functionName: "allowance",
		args: [l1.account.address, spender],
		...(blockNumber === undefined ? {} : { blockNumber }),
	})) as bigint

export const lc = (v: unknown) => String(v).toLowerCase()

/** Case-insensitive read-back assert: abort the run on any mismatch, log the ✓ otherwise. */
export function assertSame(actual: unknown, expected: unknown, label: string): void {
	if (lc(actual) !== lc(expected)) throw new Error(`read-back FAILED: ${label} - on-chain ${lc(actual)} != expected ${lc(expected)}`)
	console.log(`  ✓ ${label}`)
}

/** A viem chain descriptor for whatever L1 the manifest declares — the gates never hardcode one.
 *  `multicall3` is only needed by the batched reads (viem refuses a multicall without it). */
export function manifestL1Chain(m: { network: string; l1ChainId: number }, rpcUrl: string, multicall3?: string): Chain {
	return defineChain({
		id: m.l1ChainId,
		name: m.network,
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
		...(multicall3 ? { contracts: { multicall3: { address: multicall3 as Address } } } : {}),
	})
}

/** The read surface the router preflight needs — a viem PublicClient satisfies it. The returns stay
 *  `unknown`: viem's per-ABI inference does not survive an overloaded structural signature. */
export interface RouterReader {
	readContract(args: {
		address: Address
		abi: typeof SWAP_BRIDGE_ROUTER_ABI
		functionName: "swapTarget"
		args: readonly []
	}): Promise<unknown>
	readContract(args: {
		address: Address
		abi: typeof ROUTER_CONSTANTS_ABI
		functionName: "BRIDGE_WITNESS_TYPE_STRING"
		args: readonly []
	}): Promise<unknown>
}

/** The router must bind its swap target INTO the Permit2 witness — one that does not would reject
 *  every signature the wallet produces — and the target it binds must be the expected one. */
export async function assertRouterWitnessShape(pub: RouterReader, router: Address, expectedSwapTarget: string): Promise<void> {
	assertSame(
		await pub.readContract({ address: router, abi: SWAP_BRIDGE_ROUTER_ABI, functionName: "swapTarget", args: [] }),
		expectedSwapTarget,
		"router.swapTarget",
	)
	const typeString = String(
		await pub.readContract({ address: router, abi: ROUTER_CONSTANTS_ABI, functionName: "BRIDGE_WITNESS_TYPE_STRING", args: [] }),
	)
	if (!typeString.includes("address swapTarget")) {
		throw new Error(`router ${router} does not bind swapTarget into its Permit2 witness — every wallet signature would be rejected`)
	}
	console.log("  ✓ router.BRIDGE_WITNESS_TYPE_STRING binds swapTarget")
}

/** The read surface the portal preflight needs — a viem PublicClient satisfies it. */
export interface FactoryReader {
	readContract(args: {
		address: Address
		abi: typeof PORTAL_FACTORY_ABI
		functionName: "predictPortal"
		args: readonly [Address]
	}): Promise<Address>
}

/** A token's portal is CREATE2 from the factory over the implementation: derived here AND re-derived
 *  by the factory itself, because a manifest portal that is neither strands every deposit of that
 *  token in a contract nothing on L2 is bound to. */
export async function assertFactoryPortal(
	pub: FactoryReader,
	factory: Address,
	implementation: Address,
	erc20: Address,
	expectedPortal: string,
): Promise<void> {
	assertSame(predictPortal(factory, implementation, erc20), expectedPortal, `predictPortal(${erc20})`)
	const onChain = await pub.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "predictPortal", args: [erc20] })
	assertSame(onChain, expectedPortal, `factory.predictPortal(${erc20})`)
}

/** Retry a send whose REVERT is the transient Inbox-subtree-full case (seen live: back-to-back
 *  deposits in one ~36s slot; identical calldata succeeded next block). Waits one Aztec slot between
 *  attempts; a persistent revert still fails the run. */
export async function retryOnRevert<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn()
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			if (i >= tries || !/REVERTED/.test(msg)) throw e
			console.log(`bridge() reverted (attempt ${i}/${tries}) — waiting one Aztec slot and retrying: ${msg.slice(0, 120)}`)
			await new Promise((r) => setTimeout(r, 45_000))
		}
	}
}

export interface RouterDepositEnv {
	pub: unknown
	wallet: unknown
	account: { address: `0x${string}` }
}

/** One-time Permit2 max-approve when the token needs it (a token that pre-approves Permit2
 *  short-circuits; real USDC starts at zero) — the app's exact allowance dance. */
export async function ensureRouterPermit2(
	env: RouterDepositEnv,
	p: { usdc: `0x${string}`; usdcAbi: unknown; permit2: `0x${string}`; needed: bigint; mins: () => string },
): Promise<void> {
	const { pub, wallet, account } = env as { pub: never; wallet: never; account: { address: `0x${string}` } }
	await ensurePermit2Allowance({
		allowance: async () =>
			(await (pub as { readContract: (a: unknown) => Promise<unknown> }).readContract({
				address: p.usdc,
				abi: p.usdcAbi as never,
				functionName: "allowance",
				args: [account.address, p.permit2],
			})) as bigint,
		approveMax: async () =>
			await (wallet as { writeContract: (a: unknown) => Promise<`0x${string}`> }).writeContract({
				address: p.usdc,
				abi: p.usdcAbi as never,
				functionName: "approve",
				args: [p.permit2, (1n << 256n) - 1n] as never,
			}),
		waitReceipt: async (hash) =>
			await (pub as { waitForTransactionReceipt: (a: unknown) => Promise<never> }).waitForTransactionReceipt({ hash }),
		needed: p.needed,
		onStatus: (st, tx) => console.log(`permit2 approval: ${st}${tx ? ` (${tx})` : ""} (${p.mins()})`),
	})
}
