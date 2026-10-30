/**
 * A chain and an Aztec node that answer exactly what a manifest says, for the public API's unit tests: every read
 * `parseNetwork` and a deposit make, a wallet that records the order of its prompts, and synthetic code pins that the
 * fakes' runtimes satisfy.
 */
import { concat, type Hex, hexToBytes, toHex } from "viem"
import { type CodePin, type PinnedContract, pinOfBuild } from "../src/protocol/code-hash.ts"
import type * as GenerationRecordModule from "../src/protocol/generation-record.ts"
import { DEPOSIT_WITNESS_TYPE_STRING } from "../src/protocol/l1.ts"
import { lifiBook } from "../src/protocol/lifi-addresses.ts"
import { CANONICAL_PERMIT2, MAINNET_L1 } from "../src/protocol/l1-pins.ts"
import { type ManifestV2, parseManifestV2 } from "../src/protocol/manifest-v2.ts"
import { MAINNET_MANIFEST, TESTNET_MANIFEST } from "../src/networks.ts"
import type { Reads } from "../src/network.ts"

export const PINNED: readonly PinnedContract[] = ["DepositRouter", "PortalFactory", "TokenPortalImpl", "FuelOnlyGate", "TestnetFuelSwapper"]

/** A runtime as solc lays it out: code, an INVALID guard, a CBOR metadata map and its 2-byte length. */
export function runtime(seed: number, ipfsByte = 0x22): Uint8Array {
	const code = toHex(new Uint8Array(40).fill(seed))
	const cbor = concat(["0xa264697066735822", toHex(new Uint8Array(34).fill(ipfsByte)), "0x64736f6c634300081c"])
	return hexToBytes(concat([code, "0xfe", cbor, toHex((cbor.length - 2) / 2, { size: 2 })]))
}

/** Pins of the synthetic runtimes; a deployment differing only in its metadata still matches. */
export function syntheticPins(): Record<PinnedContract, CodePin> {
	return Object.fromEntries(PINNED.map((c, i) => [c, pinOfBuild(runtime(i + 1))])) as Record<PinnedContract, CodePin>
}

/**
 * The generation selector with the fakes' pins and no record, for `vi.mock`: the fakes' runtimes are no generation's,
 * and a case's own manifest is bound by none. The hub artifact stays the testnet generation's.
 */
export function withSyntheticCode(real: typeof GenerationRecordModule): typeof GenerationRecordModule {
	const pins = syntheticPins()
	const { hubArtifact } = real.codeOf(parseManifestV2(TESTNET_MANIFEST))
	return { ...real, codeOf: () => ({ pins, hubArtifact }) }
}

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
export const ROLLUP = addr(0xa11)
/** The rollup's L1 minimum fee per mana, at every timestamp. */
export const MANA_MIN_FEE = 1_250_000_000_000n
export const INBOX = addr(0xa12)
export const OUTBOX = addr(0xa13)
export const ATTACKER = addr(0xbad)
export const ACCOUNT = addr(0xacc)
export const RECIPIENT = "0x0000000000000000000000000000000000000000000000000000000000000002"

export const testnet = (): ManifestV2 => structuredClone(parseManifestV2(TESTNET_MANIFEST))

/** The mainnet placeholder with a gas-only route whose router is the one LI.FI's recorded mainnet quotes pay. */
export function mainnetFuelRoute(router: string, slippageBps = 100): ManifestV2 {
	return parseManifestV2({
		...structuredClone(MAINNET_MANIFEST as object),
		fuelRoute: {
			depositRouter: router.toLowerCase(),
			gate: addr(0x6a7e),
			guardian: addr(0x6a8d),
			registry: MAINNET_L1.registry,
			permit2: CANONICAL_PERMIT2,
			fuel: { slippageBps, minFuelFj: "20000000000000000000", fjPerTx: "2000000000000000000" },
		},
	})
}

type Answer = unknown | ((args: readonly unknown[]) => unknown)

/** The world a manifest describes; tests overwrite an entry to play an attacker. */
export interface World {
	m: ManifestV2
	reads: Map<string, Answer>
	code: Map<string, Uint8Array>
	chainId: number
	node: { l1ChainId: number; rollupVersion: number; registry: string; portal: string; asset: string }
	blockTimestamp: bigint
}

const key = (address: string, fn: string) => `${address.toLowerCase()}:${fn}`

export function worldOf(m: ManifestV2): World {
	const route = (m.bridge?.l1 ?? m.fuelRoute) as NonNullable<ManifestV2["fuelRoute"]> & { factory?: string; implementation?: string }
	const factory = m.bridge?.l1.factory ?? m.fuelRoute?.gate ?? ""
	const version = BigInt((m.walletChainId ^ m.l1ChainId) >>> 0)
	const reads = new Map<string, Answer>()
	const set = (a: string, fn: string, v: Answer) => reads.set(key(a, fn), v)
	set(route.registry, "getCanonicalRollup", ROLLUP)
	set(ROLLUP, "getInbox", INBOX)
	set(ROLLUP, "getOutbox", OUTBOX)
	set(ROLLUP, "getVersion", version)
	set(ROLLUP, "getFeeAssetPortal", m.feeJuice.portal)
	set(ROLLUP, "getSlotDuration", 36n)
	set(ROLLUP, "getManaMinFeeAt", MANA_MIN_FEE)
	set(m.feeJuice.portal, "UNDERLYING", m.feeJuice.asset)
	set(m.feeJuice.portal, "ROLLUP", ROLLUP)
	set(m.feeJuice.portal, "INBOX", INBOX)
	set(m.feeJuice.portal, "VERSION", version)
	const swapTarget = m.l1ChainId === 1 ? lifiBook(1).diamond : (route.fuelSwapper ?? "0x0000000000000000000000000000000000000000")
	for (const [fn, v] of [
		["PERMIT2", route.permit2],
		["FEE_JUICE_PORTAL", m.feeJuice.portal],
		["FACTORY", factory],
		["FEE_ASSET", m.feeJuice.asset],
		["SWAP_TARGET", swapTarget],
		["DEPOSIT_WITNESS_TYPE_STRING", DEPOSIT_WITNESS_TYPE_STRING],
	] as const)
		set(route.depositRouter as string, fn, v)
	set(factory, "depositsPaused", false)
	const code = new Map<string, Uint8Array>([
		[(route.depositRouter as string).toLowerCase(), runtime(1, 0x33)],
		[factory.toLowerCase(), runtime(m.bridge ? 2 : 4, 0x33)],
	])
	if (route.fuelSwapper) {
		code.set(route.fuelSwapper.toLowerCase(), runtime(5, 0x33))
		set(route.fuelSwapper, "FEE_ASSET", m.feeJuice.asset)
	}
	if (m.bridge) {
		const b = m.bridge
		for (const [fn, v] of [
			["IMPLEMENTATION", b.l1.implementation],
			["L2_HUB", b.l2.hub.address],
			["INBOX", INBOX],
			["ROLLUP_VERSION", version],
		] as const)
			set(factory, fn, v)
		for (const [fn, v] of [
			["FACTORY", factory],
			["L2_HUB", b.l2.hub.address],
			["INBOX", INBOX],
			["OUTBOX", OUTBOX],
			["ROLLUP_VERSION", version],
		] as const)
			set(b.l1.implementation, fn, v)
		code.set(b.l1.implementation.toLowerCase(), runtime(3, 0x33))
	}
	return {
		m,
		reads,
		code,
		chainId: m.l1ChainId,
		node: {
			l1ChainId: m.l1ChainId,
			rollupVersion: Number(version),
			registry: route.registry,
			portal: m.feeJuice.portal,
			asset: m.feeJuice.asset,
		},
		blockTimestamp: 1_700_000_000n,
	}
}

const eth = (a: string) => ({ toString: () => a })

/** The reads a world answers. An unanswered read throws, so a test sees every call it did not expect. */
export function readsOf(w: World, extra: Partial<Reads> = {}): Reads {
	const l1 = {
		getChainId: async () => w.chainId,
		readContract: async ({ address, functionName, args }: { address: string; functionName: string; args?: readonly unknown[] }) => {
			const k = key(address, functionName)
			if (!w.reads.has(k)) throw new Error(`unanswered read ${functionName} at ${address}`)
			const v = w.reads.get(k)
			return typeof v === "function" ? (v as (a: readonly unknown[]) => unknown)(args ?? []) : v
		},
		getCode: async ({ address }: { address: string }) => toHex(w.code.get(address.toLowerCase()) ?? new Uint8Array()),
		getBlock: async () => ({ timestamp: w.blockTimestamp }),
		estimateContractGas: async () => 200_000n,
		waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
		getTransactionReceipt: async () => ({ status: "success", logs: [] }),
	}
	const aztecNode = {
		getNodeInfo: async () => ({
			l1ChainId: w.node.l1ChainId,
			rollupVersion: w.node.rollupVersion,
			l1ContractAddresses: {
				registryAddress: eth(w.node.registry),
				feeJuicePortalAddress: eth(w.node.portal),
				feeJuiceAddress: eth(w.node.asset),
			},
			txsLimits: { gas: { daGas: 1_000_000, l2Gas: 6_540_000 } },
		}),
		getBlockNumber: async () => 100,
		getCurrentMinFees: async () => ({ feePerDaGas: 0n, feePerL2Gas: MANA_MIN_FEE }),
	}
	return { l1: l1 as never, aztecNode: aztecNode as never, ...extra }
}

/** One prompt or storage write, in the order it happened. */
export type Step = { kind: "persist" | "sign" | "write" | "event"; detail: unknown }

/** A wallet on `chainId` that records each prompt into `log`. */
export function walletOf(log: Step[], chainId: number, opts: { reject?: "sign" | "write" } = {}) {
	let n = 0
	return {
		account: { address: ACCOUNT, type: "json-rpc" },
		chain: undefined,
		getChainId: async () => chainId,
		getAddresses: async () => [ACCOUNT],
		signTypedData: async (td: unknown) => {
			log.push({ kind: "sign", detail: td })
			if (opts.reject === "sign") throw Object.assign(new Error("User rejected the request."), { code: 4001 })
			return `0x${"11".repeat(65)}` as Hex
		},
		writeContract: async (call: { functionName: string }) => {
			log.push({ kind: "write", detail: call.functionName })
			if (opts.reject === "write") throw Object.assign(new Error("User rejected the request."), { code: 4001 })
			return `0x${(++n).toString(16).padStart(64, "0")}` as Hex
		},
	} as never
}

/** An allowance that is short until the wallet sends an `approve`, then unlimited. */
export function allowanceAfterApprove(log: Step[], initial = 0n) {
	return () => (log.some((s) => s.kind === "write" && s.detail === "approve") ? (1n << 256n) - 1n : initial)
}
