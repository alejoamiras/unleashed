/**
 * L1-side helpers shared by the operator scripts: the minimal ERC-20 ABI, the read-back assertion,
 * the operator-only factory/router constants the app's ABIs omit, and the portal/router preflights
 * every gate runs before it trusts a generation.
 */
import { type Address, type Chain, defineChain } from "viem"
import { PORTAL_FACTORY_ABI } from "../src/factory-abi"
import { ensurePermit2Allowance } from "../src/l1"
import { predictPortal } from "../src/portal-address"
import { SWAP_BRIDGE_ROUTER_ABI } from "../src/router-abi"

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
