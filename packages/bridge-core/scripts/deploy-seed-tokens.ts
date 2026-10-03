/**
 * Deploys the mintable test tokens a testnet generation ships with (`MintableERC20`: permissionless
 * capped mint, Permit2 pre-allowed) and prints the `SEED_TOKENS` line for `deploy-generation deploy`.
 * Sepolia only; signs with the pinned testnet key. A token is usable as a seed only when its address
 * sorts below WETH (`SeedTokenPool` needs it as `currency0`), so an address that lands above is
 * discarded and the spec is deployed again at the next nonce.
 *
 *   bun scripts/deploy-seed-tokens.ts --spec "Test USDC:USDC:6" --spec "Test USDT:USDT:6" [--dry-run]
 */
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { PLAN_PINNED_L1_SIGNERS } from "./live-intent"
import { evmArtifact } from "./script-artifacts"
import { createL1Clients, sepoliaChain } from "./script-bootstrap"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const WETH = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14"
const MAX_WHOLE_PER_TX = 1_000_000n
const MAX_ATTEMPTS_PER_SPEC = 3

interface TokenSpec {
	name: string
	symbol: string
	decimals: number
}

type L1 = ReturnType<typeof createL1Clients<ReturnType<typeof sepoliaChain>, ReturnType<typeof privateKeyToAccount>>>

function parseSpecs(): TokenSpec[] {
	const specs: TokenSpec[] = []
	for (let i = 0; i < process.argv.length; i++) {
		if (process.argv[i] !== "--spec") continue
		const [name, symbol, decimals] = (process.argv[i + 1] ?? "").split(":")
		if (!name || !symbol || !/^\d+$/.test(decimals ?? ""))
			throw new Error(`--spec wants "<name>:<symbol>:<decimals>", got ${process.argv[i + 1]}`)
		specs.push({ name, symbol, decimals: Number(decimals) })
	}
	if (specs.length === 0) throw new Error("at least one --spec is required")
	return specs
}

function requireSigner(): ReturnType<typeof privateKeyToAccount> {
	const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined
	if (!pk) throw new Error("PRIVATE_KEY is required (packages/bridge-core/.env) — STOP")
	const account = privateKeyToAccount(pk)
	const pinned = PLAN_PINNED_L1_SIGNERS.testnet
	if (!pinned || account.address.toLowerCase() !== pinned.toLowerCase()) {
		throw new Error(`L1 deployer ${account.address} != pinned testnet signer ${pinned} — wrong key; STOP`)
	}
	return account
}

const sortsBelowWeth = (address: Address): boolean => BigInt(address) < BigInt(WETH)

/** Deploys one spec until an address below WETH lands; an address above is left as an unused token. */
async function deployBelowWeth(l1: L1, spec: TokenSpec): Promise<Address> {
	const { abi, bytecode } = evmArtifact("MintableERC20")
	for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_SPEC; attempt++) {
		const hash = await l1.wallet.deployContract({ abi, bytecode, args: [spec.name, spec.symbol, spec.decimals, MAX_WHOLE_PER_TX] })
		const receipt = await l1.pub.waitForTransactionReceipt({ hash })
		if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${spec.symbol} deploy REVERTED (${hash}) — STOP`)
		const address = receipt.contractAddress.toLowerCase() as Address
		const usable = sortsBelowWeth(address)
		console.log(`  ${spec.symbol}: ${address} (${hash})${usable ? "" : " — sorts above WETH, redeploying"}`)
		if (usable) return address
	}
	throw new Error(`${spec.symbol}: no address below WETH in ${MAX_ATTEMPTS_PER_SPEC} attempts — STOP`)
}

async function main(): Promise<void> {
	const specs = parseSpecs()
	const account = requireSigner()
	const l1 = createL1Clients({ chain: sepoliaChain(SEPOLIA_RPC), rpcUrl: SEPOLIA_RPC, account })
	console.log(`deployer ${account.address} · ${specs.map((s) => s.symbol).join(", ")} · cap ${MAX_WHOLE_PER_TX} whole/tx`)
	if (process.argv.includes("--dry-run")) return
	const seeds: Address[] = []
	for (const spec of specs) seeds.push(await deployBelowWeth(l1, spec))
	console.log(`\nSEED_TOKENS=${seeds.join(",")}`)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
