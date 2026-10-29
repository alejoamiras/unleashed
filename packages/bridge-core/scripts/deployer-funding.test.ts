import { Fr } from "@aztec-labs/aztec.js/fields"
import { computeSecretHash } from "@aztec-labs/stdlib/hash"
import { encodeFunctionData, type Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "@unleashed/sdk/internal"
import { FeeJuicePortalAbi } from "@unleashed/sdk/protocol"
import { mainnetPlaceholderManifest } from "../test/fixtures/frozen-manifests"
import {
	assertFundingDestination,
	authenticFunding,
	type Claimable,
	decideFunding,
	type FundingState,
	fundingSecret,
	matchFundings,
	scanFundings,
	scanStartFor,
} from "./deployer-funding"
import { MAINNET_REGISTRY, type NodeIdentity } from "./live-intent"

const PORTAL = "0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3" as const
const FUNDER = `0x${"f1".repeat(20)}` as const
const STRANGER = `0x${"5a".repeat(20)}` as const
const RECIPIENT = `0x${"0d".repeat(32)}` as Hex
const SECRET_HASH = `0x${"11".repeat(32)}` as Hex
const KEY = `0x${"22".repeat(32)}` as Hex
const TX = `0x${"33".repeat(32)}` as Hex

const depositInput = (to: Hex, amount: bigint, secretHash: Hex) =>
	encodeFunctionData({ abi: FeeJuicePortalAbi, functionName: "depositToAztecPublic", args: [to, amount, secretHash] })

const log = (over: Partial<{ address: string; to: Hex; amount: bigint; secretHash: Hex }> = {}) => ({
	address: (over.address ?? PORTAL) as `0x${string}`,
	transactionHash: TX,
	args: { to: over.to ?? RECIPIENT, amount: over.amount ?? 100n, secretHash: over.secretHash ?? SECRET_HASH, key: KEY, index: 7n },
})
const tx = (over: Partial<{ from: string; to: string; input: Hex }> = {}) => ({
	from: (over.from ?? FUNDER) as `0x${string}`,
	to: (over.to ?? PORTAL) as `0x${string}`,
	input: over.input ?? depositInput(RECIPIENT, 100n, SECRET_HASH),
})
const scope = { portal: PORTAL, recipient: RECIPIENT, funder: FUNDER } as const

describe("authenticFunding", () => {
	it("accepts the funder's own deposit straight to the portal", () => {
		expect(authenticFunding(log(), tx(), scope)).toEqual({ txHash: TX, amount: 100n, secretHash: SECRET_HASH, key: KEY, leafIndex: 7n })
	})

	it.each([
		["another emitter", log({ address: STRANGER }), tx()],
		["another sender", log(), tx({ from: STRANGER })],
		["a call through another contract", log(), tx({ to: STRANGER })],
		["calldata naming another secret hash", log(), tx({ input: depositInput(RECIPIENT, 100n, `0x${"44".repeat(32)}`) })],
		["calldata naming another amount", log(), tx({ input: depositInput(RECIPIENT, 99n, SECRET_HASH) })],
	])("refuses %s", (_, l, t) => {
		expect(authenticFunding(l, t, scope)).toBeUndefined()
	})
})

describe("scanFundings", () => {
	it("covers every block once in windows a free RPC plan accepts", async () => {
		const windows: Array<[bigint, bigint]> = []
		const pub = {
			getContractEvents: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
				windows.push([fromBlock, toBlock])
				return fromBlock === 20_005n ? [log()] : []
			}),
			getTransaction: vi.fn(async () => tx()),
		}
		const found = await scanFundings(pub as never, { ...scope, fromBlock: 5n, toBlock: 25_004n })
		expect(windows).toEqual([
			[5n, 10_004n],
			[10_005n, 20_004n],
			[20_005n, 25_004n],
		])
		expect(found.map((f) => f.leafIndex)).toEqual([7n])
	})
})

describe("matchFundings", () => {
	it("matches only secret hashes the seed derives and numbers the next funding after the highest", async () => {
		const seed = Fr.random()
		const hashOf = async (n: number) => (await computeSecretHash(fundingSecret(seed, n))).toString() as Hex
		const base = { txHash: TX, amount: 1n, key: KEY, leafIndex: 0n }
		const fundings = [
			{ ...base, secretHash: await hashOf(1) },
			{ ...base, secretHash: SECRET_HASH },
			{ ...base, secretHash: await hashOf(2) },
		]
		const { matched, next } = await matchFundings(fundings, seed)
		expect(matched.map((m) => m.n)).toEqual([1, 2])
		expect(next).toBe(3)
		expect((await matchFundings([], seed)).next).toBe(1)
	})
})

const pending: Claimable = { amount: 50n, key: KEY, leafIndex: 3n, n: 1, secret: Fr.ONE }
const state = (over: Partial<FundingState> = {}): FundingState => ({
	accountInitialized: false,
	balance: 0n,
	nextFee: 10n,
	claimFee: 10n,
	unclaimed: [],
	funded: 0n,
	fund: 100n,
	cap: 1_000n,
	signer: FUNDER,
	funder: FUNDER,
	nonceAtScan: 4,
	nonceNow: 4,
	...over,
})

describe("decideFunding", () => {
	it("deposits for a fresh account, and only for a shortfall once it is up", () => {
		expect(decideFunding(state())).toEqual({ kind: "deposit", amount: 100n })
		expect(decideFunding(state({ accountInitialized: true, balance: 10n }))).toEqual({ kind: "none" })
		expect(decideFunding(state({ accountInitialized: true, balance: 9n }))).toEqual({ kind: "deposit", amount: 100n })
	})

	it("resumes an unclaimed funding instead of making another, whatever the other inputs say", () => {
		expect(decideFunding(state({ unclaimed: [pending], signer: STRANGER, nonceNow: 9 }))).toEqual({
			kind: "claim",
			fundings: [pending],
		})
	})

	it.each([
		["no --fund", { fund: undefined }, /re-run with --fund/],
		["another signer", { signer: STRANGER }, /not the pinned funding key/],
		["a nonce that moved since the scanned block", { nonceNow: 5 }, /newer than the scanned block/],
		["an amount below twice its own claim's fee", { fund: 19n }, /below twice its own claim/],
		["an amount above the cap", { fund: 1_001n }, /exceeds --cap/],
		["an amount that, with what is funded, passes the cap", { funded: 950n }, /exceeds --cap/],
	])("refuses %s", (_, over, message) => {
		expect(() => decideFunding(state(over as Partial<FundingState>))).toThrow(message)
	})

	it("refuses a top-up that leaves less than the next send after its own claim", () => {
		expect(() => decideFunding(state({ accountInitialized: true, nextFee: 95n, claimFee: 10n }))).toThrow(/after its claim/)
		expect(decideFunding(state({ accountInitialized: true, nextFee: 90n, claimFee: 10n })).kind).toBe("deposit")
	})
})

describe("scanStartFor", () => {
	it("pins the canonical portal's first block and refuses any other portal", () => {
		expect(scanStartFor(PORTAL)).toBe(26_160_102n)
		expect(() => scanStartFor(STRANGER)).toThrow(/no pinned first block/)
	})
})

describe("assertFundingDestination", () => {
	const manifest = mainnetPlaceholderManifest()
	const CANONICAL = "0xe37a2663cc9c119ba41572c40fab0bbb23a5402f"
	const identity = (over: Record<string, string> = {}): NodeIdentity => ({
		nodeVersion: "6.0.0",
		l1ChainId: 1,
		rollupVersion: 2070860440,
		l1ContractAddresses: {
			registryAddress: MAINNET_REGISTRY,
			feeJuicePortalAddress: manifest.feeJuice.portal,
			feeJuiceAddress: manifest.feeJuice.asset,
			rollupAddress: CANONICAL,
			...over,
		},
	})
	const l1 = (rollup: string) => {
		const reads: Record<string, unknown> = {
			UNDERLYING: manifest.feeJuice.asset,
			ROLLUP: rollup,
			VERSION: 2070860440n,
			getCanonicalRollup: CANONICAL,
			getFeeAssetPortal: manifest.feeJuice.portal,
		}
		return {
			pub: { readContract: vi.fn(async ({ functionName }: { functionName: string }) => reads[functionName]) },
		} as unknown as L1Ctx
	}

	it("accepts mainnet's node and the canonical rollup's portal", async () => {
		await expect(assertFundingDestination(l1(CANONICAL), identity(), manifest, 2070860440)).resolves.toBeUndefined()
	})

	it("refuses a node serving another portal before reading L1", async () => {
		const chain = l1(CANONICAL)
		await expect(assertFundingDestination(chain, identity({ feeJuicePortalAddress: STRANGER }), manifest, 2070860440)).rejects.toThrow(
			/feeJuicePortal/,
		)
		expect(chain.pub.readContract).not.toHaveBeenCalled()
	})

	it("refuses another rollup version and a portal bound to a retired rollup", async () => {
		await expect(assertFundingDestination(l1(CANONICAL), identity(), manifest, 4248422647)).rejects.toThrow(/rollup version/)
		await expect(assertFundingDestination(l1(STRANGER), identity(), manifest, 2070860440)).rejects.toThrow(/rollup/)
	})
})
