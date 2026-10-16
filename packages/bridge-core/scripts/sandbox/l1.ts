/** L1 side of the sandbox: canonical singletons installed from the vendored code, the fixtures the
 *  generation and the flows need, and the small write helpers every flow shares. */
import { TestERC20Abi } from "@aztec-foundation/l1-artifacts"
import { type Address, type Hex, keccak256 } from "viem"
import type { L1Ctx } from "../../src/flows"
import { evmArtifact } from "../script-artifacts"
import { lc, MOCK_RATE_NUM, type SpecKey, SPECS, type TokenSpec } from "./constants"
import { type CanonicalName, readVendored } from "./refresh-canonical-bytecode"

/** Permit2 and Multicall3 are canonical singletons nobody can redeploy at their real address, so the
 *  sandbox installs their vendored runtime code — never a live fetch, so CI needs no public RPC and
 *  a poisoned one could not reach the chain. The keccak is re-checked at install time. */
export async function copyCanonicalCode(l1: L1Ctx, name: CanonicalName): Promise<void> {
	const v = readVendored(name)
	if (keccak256(v.code) !== v.keccak) throw new Error(`${name}: vendored code does not match its pinned keccak`)
	await l1.pub.request({ method: "anvil_setCode" as never, params: [v.address, v.code] as never })
	console.log(`  ${name} code installed at ${v.address} (${v.chain}, ${v.keccak.slice(0, 10)}…)`)
}

export async function deployEvm(l1: L1Ctx, name: string, args: unknown[]): Promise<Address> {
	const { abi, bytecode } = evmArtifact(name)
	const hash = await l1.wallet.deployContract({ abi, bytecode, args, account: l1.account, chain: l1.wallet.chain } as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash })
	if (!receipt.contractAddress) throw new Error(`${name} deploy produced no address`)
	return lc(receipt.contractAddress)
}

export async function writeL1(l1: L1Ctx, address: Address, abi: unknown, functionName: string, args: unknown[]): Promise<Hex> {
	const hash = await l1.wallet.writeContract({
		address,
		abi: abi as never,
		functionName,
		args: args as never,
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	await l1.pub.waitForTransactionReceipt({ hash })
	return hash
}

export async function mint(l1: L1Ctx, erc20: Address, to: Address, amount: bigint): Promise<void> {
	await writeL1(l1, erc20, evmArtifact("MintableERC20").abi, "mint", [to, amount])
}

export async function mintFeeAsset(l1: L1Ctx, feeAsset: Address, to: Address, amount: bigint): Promise<void> {
	await writeL1(l1, feeAsset, TestERC20Abi, "mint", [to, amount])
}

export async function freshToken(l1: L1Ctx, spec: TokenSpec, mintTo: Address[], amount: bigint): Promise<Address> {
	const erc20 = await deployEvm(l1, "MintableERC20", [spec.name, spec.symbol, spec.decimals, 1_000_000n])
	for (const to of mintTo) await mint(l1, erc20, to, amount)
	return erc20
}

export async function erc20BalanceOf(l1: L1Ctx, erc20: Address, owner: Address): Promise<bigint> {
	return (await l1.pub.readContract({
		address: erc20,
		abi: evmArtifact("MintableERC20").abi,
		functionName: "balanceOf",
		args: [owner],
	})) as bigint
}

/** The fee asset is a minter-gated TestERC20 owned by the node's CoinIssuer; anvil lets us borrow
 *  that owner, so the grant never spends the publisher's nonce. */
export async function ensureFeeAssetMinter(l1: L1Ctx, feeJuice: Address): Promise<void> {
	const isMinter = await l1.pub.readContract({
		address: feeJuice,
		abi: TestERC20Abi,
		functionName: "minters",
		args: [l1.account.address],
	})
	if (isMinter) return
	const owner = lc(String(await l1.pub.readContract({ address: feeJuice, abi: TestERC20Abi, functionName: "owner", args: [] })))
	await l1.pub.request({ method: "anvil_impersonateAccount" as never, params: [owner] as never })
	await l1.pub.request({ method: "anvil_setBalance" as never, params: [owner, "0xde0b6b3a7640000"] as never })
	try {
		const hash = await l1.wallet.writeContract({
			address: feeJuice,
			abi: TestERC20Abi,
			functionName: "addMinter",
			args: [l1.account.address],
			account: owner,
			chain: l1.wallet.chain,
		} as never)
		const receipt = await l1.pub.waitForTransactionReceipt({ hash })
		if (receipt.status !== "success") throw new Error(`addMinter from the fee asset's owner ${owner} reverted`)
	} finally {
		await l1.pub.request({ method: "anvil_stopImpersonatingAccount" as never, params: [owner] as never })
	}
	const granted = await l1.pub.readContract({ address: feeJuice, abi: TestERC20Abi, functionName: "minters", args: [l1.account.address] })
	if (!granted) throw new Error(`the fee asset still refuses ${l1.account.address} as a minter`)
}

export interface L1Deployment {
	feeJuice: Address
	feeJuicePortal: Address
	registry: Address
	swapTarget: Address
	/** MockV4Quoter — answers discovery for the routable tokens with quotes the swap target settles exactly. */
	quoter: Address
	tokens: Record<SpecKey, Address>
	/** The `DepositRouter` beside the old router, and its `SWAP_TARGET`; set once the generation exists. */
	depositRouter?: Address
	fuelSwapper?: Address
}

/** Lets discovery find a route for `token` through the facade (NORT is deliberately never listed). */
export async function setRoutable(l1: L1Ctx, quoter: Address, token: Address, ok = true): Promise<void> {
	await writeL1(l1, quoter, evmArtifact("MockV4Quoter").abi, "setRoutable", [token, ok])
}

export async function deployL1Fixtures(
	l1: L1Ctx,
	addrs: { feeJuice: Address; feeJuicePortal: Address; registry: Address },
): Promise<L1Deployment> {
	const swapTarget = await deployEvm(l1, "MockSwapTarget", [addrs.feeJuice])
	await writeL1(l1, swapTarget, evmArtifact("MockSwapTarget").abi, "setRate", [MOCK_RATE_NUM, 1n])
	await ensureFeeAssetMinter(l1, addrs.feeJuice)
	await mintFeeAsset(l1, addrs.feeJuice, swapTarget, 10n ** 30n)
	await mintFeeAsset(l1, addrs.feeJuice, l1.account.address, 10n ** 24n)
	console.log(`  MockSwapTarget: ${swapTarget} (rate 1:${MOCK_RATE_NUM}, funded)`)

	// Sequential on purpose: these share one L1 account, and viem assigns each tx the nonce it reads
	// at build time — issuing them together makes every tx after the first "nonce too low".
	const entries: (readonly [string, Address])[] = []
	for (const [key, spec] of Object.entries(SPECS)) {
		const address = await deployEvm(l1, "MintableERC20", [spec.name, spec.symbol, spec.decimals, 1_000_000n])
		console.log(`  ${spec.symbol}: ${address}`)
		entries.push([key, address])
	}
	const tokens = Object.fromEntries(entries) as L1Deployment["tokens"]
	const quoter = await deployEvm(l1, "MockV4Quoter", [swapTarget, tokens.weth, addrs.feeJuice])
	for (const key of ["usdc", "usdt", "pxo"] as const) await setRoutable(l1, quoter, tokens[key])
	console.log(`  MockV4Quoter: ${quoter} (routable: USDC, USDT, PXO; WETH ${tokens.weth})`)
	return { ...addrs, swapTarget, quoter, tokens }
}
