/** The sandbox's cross-chain half: the DepositRouter and its TestnetFuelSwapper beside the old router, LI.FI's
 *  compiled destination contracts and the Across stand-ins at CREATE2 addresses, and the clients and discovery
 *  context a cross-chain flow signs and reads with. */
import { readFileSync } from "node:fs"
import { FEE_JUICE_ADDRESS } from "@aztec-labs/constants"
import { type Abi, type Address, concat, encodeDeployData, getContractAddress, type Hex, keccak256, pad, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { CrossChainDiscoveryContext, DiscoveryChainReads, DiscoveryReads } from "../../src/crosschain-discovery"
import type { L1Ctx } from "../../src/flows"
import { evmArtifact } from "../script-artifacts"
import { createL1Clients } from "../script-bootstrap"
import { CHAIN_ID, lc, PERMIT2, SOURCE_CHAIN_ID, sandboxChain, sandboxSourceChain, ZERO_L1 } from "./constants"
import { lifiArtifactPath } from "./forge"
import type { SandboxHandle } from "./handle"
import { deployEvm, mint, mintFeeAsset, writeL1 } from "./l1"
import { type FillWallet, type Relayer, type RelayMode, startRelayer } from "./relayer"

/** Arachnid's deterministic deployer, which anvil installs at genesis. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C"

/** The swapper's rate for every fixture token: one whole Fee Juice per whole token, the old mock venue's rate. */
export const SWAPPER_FJ_PER_WHOLE_TOKEN = 10n ** 18n
const SWAPPER_INVENTORY = 10n ** 30n

export interface CrossChainDeployment {
	depositRouter: Address
	fuelSwapper: Address
	source: {
		chainId: number
		spokePool: Address
		/** `SourceAcrossStub`, the Diamond's stand-in: the address a route calls and approves. */
		diamond: Address
		/** The token a cross-chain send starts with. */
		token: Address
	}
	destination: {
		spokePool: Address
		executor: Address
		erc20Proxy: Address
		receiverAcrossV4: Address
		/** The L1 token the rail delivers: a manifest token with a pre-created portal. */
		token: Address
	}
}

function lifiArtifact(name: string): { abi: Abi; bytecode: Hex } {
	const j = JSON.parse(readFileSync(lifiArtifactPath(name), "utf8"))
	return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex }
}

const initcode = (a: { abi: Abi; bytecode: Hex }, args: readonly unknown[]): Hex =>
	encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args: args as never })

/**
 * Deploys `code` through the CREATE2 deployer under a salt named by `label`, or adopts the contract already there:
 * the address commits to the exact init code, so one at the predicted address is this one. The same code and
 * label land at the same address on both anvils.
 */
export async function create2(ctx: L1Ctx, code: Hex, label: string): Promise<Address> {
	const salt = keccak256(toHex(`unleashed:sandbox:${label}`))
	const address = getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt, bytecode: code })
	if (await ctx.pub.getCode({ address })) return lc(address)
	if (!(await ctx.pub.getCode({ address: CREATE2_DEPLOYER }))) throw new Error(`no CREATE2 deployer at ${CREATE2_DEPLOYER}`)
	const hash = await ctx.wallet.sendTransaction({
		to: CREATE2_DEPLOYER,
		data: concat([salt, code]),
		account: ctx.account,
		chain: ctx.wallet.chain,
	})
	const receipt = await ctx.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success" || !(await ctx.pub.getCode({ address })))
		throw new Error(`CREATE2 of ${label} left no code at ${address}`)
	return lc(address)
}

/** LI.FI's destination half on L1, unmodified from the `lifi` profile, wired the way LI.FI deploys it: the
 *  ERC20Proxy authorizes the Executor, the receiver names the Executor and the SpokePool. */
async function deployLifiDestination(l1: L1Ctx): Promise<Omit<CrossChainDeployment["destination"], "token">> {
	const owner = l1.account.address
	const spokePool = await create2(l1, initcode(evmArtifact("TestSpokePool"), []), "spoke-pool")
	// The proxy and the Executor name each other; LI.FI breaks the cycle with CREATE3, the sandbox with the owner's call.
	const proxy = lifiArtifact("ERC20Proxy")
	const erc20Proxy = await create2(l1, initcode(proxy, [owner, ZERO_L1]), "lifi-erc20-proxy")
	const executor = await create2(l1, initcode(lifiArtifact("Executor"), [erc20Proxy, owner]), "lifi-executor")
	await writeL1(l1, erc20Proxy, proxy.abi, "setAuthorizedCaller", [executor, true])
	const receiverAcrossV4 = await create2(
		l1,
		initcode(lifiArtifact("ReceiverAcrossV4"), [owner, executor, spokePool]),
		"lifi-receiver-across-v4",
	)
	console.log(`  LI.FI: Executor ${executor}, ERC20Proxy ${erc20Proxy}, ReceiverAcrossV4 ${receiverAcrossV4}; TestSpokePool ${spokePool}`)
	return { spokePool, executor, erc20Proxy, receiverAcrossV4 }
}

async function deploySourceSide(source: L1Ctx): Promise<CrossChainDeployment["source"]> {
	const spokePool = await create2(source, initcode(evmArtifact("TestSpokePool"), []), "spoke-pool")
	const diamond = await create2(source, initcode(evmArtifact("SourceAcrossStub"), [spokePool]), "source-across-stub")
	const token = await create2(source, initcode(evmArtifact("MintableERC20"), ["Source USDC", "USDC", 6, 1_000_000n]), "source-usdc")
	console.log(`  source chain ${SOURCE_CHAIN_ID}: SourceAcrossStub ${diamond}, TestSpokePool ${spokePool}, USDC ${token}`)
	return { chainId: SOURCE_CHAIN_ID, spokePool, diamond, token }
}

export interface CrossChainDeployParams {
	factory: Address
	feeJuicePortal: Address
	feeJuice: Address
	/** Tokens the swapper rates; the router fuels from these. */
	fuelTokens: readonly Address[]
	/** The L1 token the rail delivers. */
	railToken: Address
}

/**
 * The swapper (fixture rates, minted inventory, no faucet) and a `DepositRouter` swapping through it, beside the old
 * router; then LI.FI's destination half and the Across stand-ins. The harness must already mint the fee asset.
 */
export async function deployCrossChain(l1: L1Ctx, source: L1Ctx, p: CrossChainDeployParams): Promise<CrossChainDeployment> {
	const owner = l1.account.address
	const swapperAbi = evmArtifact("TestnetFuelSwapper").abi
	const fuelSwapper = await deployEvm(l1, "TestnetFuelSwapper", [p.feeJuice, ZERO_L1, owner])
	for (const token of p.fuelTokens) await writeL1(l1, fuelSwapper, swapperAbi, "setRate", [token, SWAPPER_FJ_PER_WHOLE_TOKEN])
	await mintFeeAsset(l1, p.feeJuice, fuelSwapper, SWAPPER_INVENTORY)
	const depositRouter = await deployEvm(l1, "DepositRouter", [PERMIT2, p.feeJuicePortal, p.factory, fuelSwapper, owner])
	console.log(`  DepositRouter ${depositRouter} → TestnetFuelSwapper ${fuelSwapper} (${p.fuelTokens.length} rates, funded)`)
	const destination = await deployLifiDestination(l1)
	return { depositRouter, fuelSwapper, source: await deploySourceSide(source), destination: { ...destination, token: p.railToken } }
}

// ─── Clients ─────────────────────────────────────────────────────────────────

export type CrossChainHandle = NonNullable<SandboxHandle["crossChain"]>

/** The handle's cross-chain block; a handle written before the source chain existed has none. */
export function crossChainOf(handle: SandboxHandle): CrossChainHandle {
	if (!handle.crossChain) throw new Error("this sandbox handle predates the cross-chain half — boot a fresh sandbox")
	return handle.crossChain
}

export interface CrossChainClients {
	handle: CrossChainHandle
	/** The cross-chain depositor on the source chain. */
	source: L1Ctx
	/** The relay loop's filler on L1. */
	relayer: L1Ctx
	/** Read-only L1 client of the same handle. */
	l1: L1Ctx
}

/** Connected clients for the cross-chain half of a handle. One writer per key per process, as `openSandbox`. */
export function openCrossChain(handle: SandboxHandle): CrossChainClients {
	const cc = crossChainOf(handle)
	const user = privateKeyToAccount(cc.userKey as Hex)
	const filler = privateKeyToAccount(cc.relayerKey as Hex)
	const source: L1Ctx = {
		...createL1Clients({ chain: sandboxSourceChain(cc.sourceUrl), rpcUrl: cc.sourceUrl, account: user }),
		account: user,
	}
	const relayer: L1Ctx = {
		...createL1Clients({ chain: sandboxChain(handle.anvilUrl), rpcUrl: handle.anvilUrl, account: filler }),
		account: filler,
	}
	const l1: L1Ctx = {
		...createL1Clients({ chain: sandboxChain(handle.anvilUrl), rpcUrl: handle.anvilUrl, account: user }),
		account: user,
	}
	return { handle: cc, source, relayer, l1 }
}

/** The relay loop on the sandbox's two anvils; the filler mints the output it pays before each fill. */
export function startSandboxRelayer(cc: CrossChainClients, mode?: RelayMode): Promise<Relayer> {
	return startRelayer({
		source: cc.source.pub,
		destination: { public: cc.relayer.pub, wallet: cc.relayer.wallet as FillWallet },
		sourceSpokePool: cc.handle.source.spokePool as Address,
		destinationSpokePool: cc.handle.destination.spokePool as Address,
		mode,
		fund: (token, amount) => mint(cc.relayer, token, cc.relayer.account.address, amount),
	})
}

/** Every address discovery authenticates, from the sandbox's own deployment; never the LI.FI book. */
export function sandboxDiscoveryContext(
	cc: CrossChainClients,
	l1: { router: Address; feeJuicePortal: Address; tokenPortal?: Address },
	inbox: { address: Address; rollupVersion: bigint; hub: Hex },
): CrossChainDiscoveryContext {
	// The Inbox records the FeeJuicePortal's messages under the Fee Juice address, which the rollup seeds at genesis.
	const feeJuice = toHex(FEE_JUICE_ADDRESS)
	return {
		source: { chainId: SOURCE_CHAIN_ID, diamond: cc.handle.source.diamond as Address },
		ethereum: {
			chainId: CHAIN_ID,
			router: l1.router,
			executor: cc.handle.destination.executor as Address,
			feeJuicePortal: l1.feeJuicePortal,
			tokenPortal: l1.tokenPortal,
			inbox: {
				address: inbox.address,
				shape: "artifact",
				rollupVersion: inbox.rollupVersion,
				l2Hub: inbox.hub,
				feeJuice: { l2: pad(feeJuice, { size: 32 }), l1Sender: pad(feeJuice, { size: 20 }) as Address },
			},
		},
		rail: {
			kind: "acrossV4",
			sourceSpokePool: cc.handle.source.spokePool as Address,
			destinationSpokePool: cc.handle.destination.spokePool as Address,
			receiver: cc.handle.destination.receiverAcrossV4 as Address,
		},
	}
}

/** Viem public clients answer every read discovery makes. */
export const sandboxDiscoveryReads = (cc: CrossChainClients): DiscoveryReads => ({
	source: cc.source.pub as unknown as DiscoveryChainReads,
	ethereum: cc.l1.pub as unknown as DiscoveryChainReads,
})
