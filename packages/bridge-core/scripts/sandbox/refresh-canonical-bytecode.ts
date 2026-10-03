/**
 * Re-fetches the canonical Permit2 + Multicall3 runtime code the sandbox installs with
 * `anvil_setCode`, from INDEPENDENT providers, and diffs it against the vendored copies.
 *
 * Independence is agreement between providers that share no operator, so one poisoned RPC
 * cannot pass. Multicall3 is byte-identical on every chain and is additionally checked across
 * chains; Permit2 is NOT — its runtime code bakes the deploying chain's id and EIP-712 domain
 * separator in as immutables (it recomputes the separator when `block.chainid` differs, which is
 * why Sepolia's copy works on anvil's 31337) — so it is pinned to the Sepolia deployment only.
 * Nothing is written unless every answering provider agrees; a changed hash is reported, never
 * silently accepted — the vendored file is the pin, the RPCs are only evidence.
 *
 *   bun scripts/sandbox/refresh-canonical-bytecode.ts [--write]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, createPublicClient, http, keccak256 } from "viem"

const here = dirname(fileURLToPath(import.meta.url))
const DIR = join(here, "bytecode")

export type CanonicalName = "permit2" | "multicall3"

export interface VendoredCode {
	name: CanonicalName
	address: Address
	/** The chain whose deployment this is; the sandbox installs exactly this code. */
	chain: string
	/** keccak256 of the runtime code — the pin `copyCanonicalCode` re-checks before installing. */
	keccak: `0x${string}`
	/** Providers that returned exactly this code when it was vendored. */
	verified: string[]
	code: `0x${string}`
}

export const CANONICAL: Record<CanonicalName, { address: Address; chainInvariant: boolean }> = {
	permit2: { address: "0x000000000022D473030F116dDEE9F6B43aC78BA3", chainInvariant: false },
	multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11", chainInvariant: true },
}

const VENDORED_CHAIN = "sepolia"
const PROVIDERS: Record<string, string[]> = {
	sepolia: ["https://ethereum-sepolia-rpc.publicnode.com", "https://1rpc.io/sepolia", "https://sepolia.drpc.org"],
	mainnet: ["https://ethereum-rpc.publicnode.com", "https://1rpc.io/eth", "https://eth.drpc.org"],
}
/** Public RPCs come and go; a chain counts only when this many of its providers answer and agree. */
const MIN_AGREEING = 2

export function vendoredPath(name: CanonicalName): string {
	return join(DIR, `${name}.json`)
}

export function readVendored(name: CanonicalName): VendoredCode {
	const v = JSON.parse(readFileSync(vendoredPath(name), "utf8")) as VendoredCode
	if (keccak256(v.code) !== v.keccak) throw new Error(`${name}: vendored code does not hash to its recorded keccak`)
	return v
}

type Observed = { chain: string; rpc: string; code: `0x${string}`; keccak: `0x${string}` }

async function observe(name: CanonicalName, chain: string): Promise<Observed[]> {
	const address = CANONICAL[name].address
	const settled = await Promise.allSettled(
		(PROVIDERS[chain] ?? []).map(async (rpc) => {
			const code = await createPublicClient({ transport: http(rpc, { timeout: 15_000 }) }).getCode({ address })
			if (!code || code === "0x") throw new Error(`no code at ${address}`)
			return { chain, rpc, code, keccak: keccak256(code) }
		}),
	)
	const ok: Observed[] = []
	for (const [i, r] of settled.entries()) {
		if (r.status === "fulfilled") ok.push(r.value)
		else console.log(`  ${name}: ${PROVIDERS[chain]?.[i]} unavailable (${String(r.reason).split("\n")[0]?.slice(0, 80)})`)
	}
	const hashes = new Set(ok.map((o) => o.keccak))
	if (hashes.size > 1) throw new Error(`${name}: ${chain} providers DISAGREE — ${ok.map((o) => `${o.rpc}=${o.keccak}`).join(", ")}`)
	if (ok.length < MIN_AGREEING) throw new Error(`${name}: only ${ok.length} ${chain} provider(s) answered — need ${MIN_AGREEING}`)
	return ok
}

async function fetchPinned(name: CanonicalName): Promise<VendoredCode> {
	const primary = await observe(name, VENDORED_CHAIN)
	const first = primary[0] as Observed
	if (CANONICAL[name].chainInvariant) {
		const other = await observe(name, "mainnet")
		if (other[0]?.keccak !== first.keccak)
			throw new Error(`${name}: mainnet code ${other[0]?.keccak} ≠ ${VENDORED_CHAIN} code ${first.keccak}`)
	}
	return {
		name,
		address: CANONICAL[name].address,
		chain: VENDORED_CHAIN,
		keccak: first.keccak,
		verified: primary.map((o) => o.rpc),
		code: first.code,
	}
}

async function main(): Promise<void> {
	const write = process.argv.includes("--write")
	for (const name of Object.keys(CANONICAL) as CanonicalName[]) {
		const fresh = await fetchPinned(name)
		let current: VendoredCode | undefined
		try {
			current = readVendored(name)
		} catch {}
		if (current && current.keccak === fresh.keccak) {
			console.log(
				`${name}: unchanged (${fresh.keccak}; ${fresh.verified.length} ${VENDORED_CHAIN} providers agree${CANONICAL[name].chainInvariant ? ", mainnet matches" : ""})`,
			)
			continue
		}
		console.log(
			`${name}: ${current ? `CHANGED ${current.keccak} → ${fresh.keccak}` : `new ${fresh.keccak}`} (${fresh.verified.length} providers agree)`,
		)
		if (!write) {
			console.log("  not written — rerun with --write after confirming the canonical deployment really changed")
			continue
		}
		writeFileSync(vendoredPath(name), `${JSON.stringify(fresh, null, "\t")}\n`)
		console.log(`  wrote ${vendoredPath(name)}`)
	}
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : String(e))
		process.exit(1)
	})
}
