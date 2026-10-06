import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeFunctionData, type Hex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "../src/flows"
import { SWAP_TOKENS_SINGLE_V3_ABI } from "../src/lifi-abi"
import { lifiBook } from "../src/lifi-addresses"
import {
	bridgeFromCallerCall,
	crossChainExpectation,
	crossChainTx,
	fuelLegFor,
	routerIntent,
	rowLegs,
	selfBuiltTerms,
	verifiedRoute,
} from "./lifi-canary-build"
import { ethereumChain, FJ_PER_UNIT, fakeAcross, NOW_S, routedManifest, sourceChain } from "./lifi-canary-fixture"
import { type CanaryCaps, canaryBindings, formatCanaryRecord, GasBudget, planCanaryRows } from "./lifi-canary-plan"
import { boundedSigner, type CanaryDeps, runCanary, runLiveRows } from "./lifi-canary-run"
import { canaryEdge } from "./lifi-canary-testnet"
import { ERC20_MIN_ABI } from "./script-l1"

const CANARY = `0x${"ca".repeat(20)}` as const
const cfg = () => canaryEdge(routedManifest(), { dryRun: true, canary: CANARY }, {}, null).cfg

async function dryRun(
	o: {
		across?: ReturnType<typeof fakeAcross>
		ethereum?: ReturnType<typeof ethereumChain>
		source?: ReturnType<typeof sourceChain>
	} = {},
) {
	const minted: Fr[] = []
	const logs: string[] = []
	const reads = { source: o.source ?? sourceChain(), ethereum: o.ethereum ?? ethereumChain() }
	const across = o.across ?? fakeAcross()
	const deps: CanaryDeps = {
		reads,
		across,
		random: () => {
			const f = new Fr(BigInt(minted.length + 1) * 1_000_003n + 7n)
			minted.push(f)
			return f
		},
		recipient: await AztecAddress.random(),
		now: () => NOW_S * 1000,
		sleep: async () => {},
		log: (l) => logs.push(l),
		mode: { kind: "dry-run" },
	}
	return { run: () => runCanary(cfg(), deps), minted, logs, reads, across }
}

describe("runCanary --dry-run", () => {
	it("builds and verifies every row from reads alone, and prints no secret", async () => {
		const t = await dryRun()
		const rec = await t.run()
		expect(rec.mode).toBe("dry-run")
		expect(rec.rows.map((r) => [r.kind, r.status])).toEqual([
			["crosschain-public", "built"],
			["crosschain-private", "built"],
			["ethereum-plain", "built"],
			["ethereum-fueled", "built"],
			["crosschain-recovery", "built"],
		])
		const diamond = lifiBook(84532).diamond
		const built = rec.rows.flatMap((r) => (r.status === "built" ? [r] : []))
		expect(
			built
				.filter((r) => r.kind.startsWith("crosschain"))
				.every((r) => r.to === diamond && r.detail.startsWith("5000000 in, 3800000 out (across)")),
		).toBe(true)
		expect(rec.spend).toMatchObject({ source: 15_000_000n, ethereum: 20_000_000n })

		const touched = new Set([...t.reads.source.touched, ...t.reads.ethereum.touched])
		expect([...touched].sort()).toEqual(["getBalance", "getChainId", "readContract"])
		expect(t.across.requests.every((r) => r.method === "GET" && r.url.pathname === "/api/suggested-fees")).toBe(true)

		const printed = [formatCanaryRecord(rec), ...t.logs].join("\n").toLowerCase()
		expect(t.minted.length).toBeGreaterThan(10)
		for (const secret of t.minted) expect(printed).not.toContain(secret.toString().slice(2).toLowerCase())
	})

	it("self-builds the terms when Across quotes nothing, uncapped by any maxDeposit", async () => {
		const t = await dryRun({ across: fakeAcross({ refuse: "SIMULATION_ERROR" }) })
		const rec = await t.run()
		const cross = rec.rows.filter((r) => r.kind.startsWith("crosschain"))
		expect(cross.every((r) => r.status === "built" && r.detail.startsWith("6000000 in, 4500000 out (self-built)"))).toBe(true)
		expect(t.logs.some((l) => l.includes("SIMULATION_ERROR"))).toBe(true)
	})

	it("refuses another chain or a router wired to another swapper before building anything", async () => {
		const wrongChain = await dryRun({ source: sourceChain(8453) })
		await expect(wrongChain.run()).rejects.toThrow(/source RPC answers chain 8453/)
		expect(wrongChain.across.requests).toHaveLength(0)
		const wrongTarget = await dryRun({ ethereum: ethereumChain(`0x${"ee".repeat(20)}`) })
		await expect(wrongTarget.run()).rejects.toThrow(/not the manifest's swapper/)
		expect(wrongTarget.across.requests).toHaveLength(0)
	})
})

describe("the canary's transactions", () => {
	const b = canaryBindings(routedManifest(), 84532)

	it("refuse to sign a cross-chain transaction verifyRoute does not accept", async () => {
		const terms = selfBuiltTerms(5_000_000n, NOW_S)
		const legs = await rowLegs(
			{ kind: "crosschain-public", origin: "crosschain", isPrivate: false, fuel: "none", expect: "deposited" },
			await AztecAddress.random(),
			Fr.random,
		)
		const routerCall = bridgeFromCallerCall(routerIntent(b.destToken.erc20 as Hex, false, legs), "0x", terms.outputAmount)
		const expectation = (call: Hex) =>
			crossChainExpectation(b, {
				user: CANARY,
				srcAmount: 5_000_000n,
				lifiTxId: `0x${"11".repeat(32)}`,
				routerCall: call,
				hasFuel: false,
				terms,
			})
		const x = expectation(routerCall)
		const tx = crossChainTx(x)
		expect(() => verifiedRoute(tx, x)).not.toThrow()
		const notTheRouter = expectation("0x1234")
		expect(() => verifiedRoute(crossChainTx(notTheRouter), notTheRouter)).toThrow(/verifyRoute refused router.selector/)
		expect(() => verifiedRoute({ ...tx, approval: { ...tx.approval, amount: tx.approval.amount + 1n } }, x)).toThrow(
			/verifyRoute refused/,
		)
		expect(() => verifiedRoute({ ...tx, data: tx.data.replace(CANARY.slice(2), "cb".repeat(20)) as Hex }, x)).toThrow(
			/verifyRoute refused/,
		)
	})

	it("sign the recovery row's floor above the swapper's quote, in the intent and the swap call alike", async () => {
		const quote = async (_: string, amountIn: bigint) => amountIn * FJ_PER_UNIT
		const { testnetSwapperFuelProvider } = await import("../src/fuel-quote")
		const provider = testnetSwapperFuelProvider({
			reader: { quote },
			swapper: b.fuelSwapper,
			router: b.depositRouter,
			feeAsset: b.feeAsset,
			...b.fuel,
		})
		const token = { erc20: b.destToken.erc20 as `0x${string}`, decimals: 6 }
		const plain = await fuelLegFor(provider, b, token, 3_800_000n, false)
		const recovery = await fuelLegFor(provider, b, token, 3_800_000n, true)
		expect(plain.minOut).toBeLessThanOrEqual(plain.expectedOut)
		expect(recovery.minOut).toBeGreaterThan(recovery.expectedOut)
		const signed = decodeFunctionData({ abi: SWAP_TOKENS_SINGLE_V3_ABI, data: recovery.swapData }).args[4]
		expect(signed).toBe(recovery.minOut)
	})
})

describe("the canary's gas ceilings", () => {
	const GWEI = 10n ** 9n

	it("send with explicit gas and fee caps, and refuse a send whose worst case passes what the chain's cap has left", async () => {
		const fees = { maxFeePerGas: 4n * GWEI, maxPriorityFeePerGas: GWEI }
		const wallet = {
			account: { address: CANARY },
			chain: undefined,
			writeContract: vi.fn(async (_: object) => `0x${"01".repeat(32)}`),
			sendTransaction: vi.fn(async (_: object) => `0x${"02".repeat(32)}`),
		}
		const l1 = {
			account: { address: CANARY },
			pub: { estimateGas: vi.fn(async () => 80_000n), estimateFeesPerGas: vi.fn(async () => fees) },
			wallet,
		} as unknown as L1Ctx
		const budget = new GasBudget("source", 10n ** 15n)
		const bounded = boundedSigner(l1, budget, "crosschain-public").l1.wallet

		// 80,000 estimated + a quarter = 100,000 gas at 4 gwei: a worst case of 4 × 10^14 wei per send.
		await bounded.sendTransaction({ to: CANARY, data: "0x1234", account: CANARY } as never)
		await bounded.writeContract({ address: CANARY, abi: ERC20_MIN_ABI, functionName: "approve", args: [CANARY, 1n] } as never)
		const terms = { gas: 100_000n, ...fees }
		expect(wallet.sendTransaction.mock.calls[0]?.[0]).toMatchObject(terms)
		expect(wallet.writeContract.mock.calls[0]?.[0]).toMatchObject(terms)
		expect(budget.left).toBe(2n * 10n ** 14n)

		// A fee spike prices the next send past what is left: refused before the wallet sees it.
		fees.maxFeePerGas = 10n * GWEI
		await expect(bounded.sendTransaction({ to: CANARY, data: "0x1234" } as never)).rejects.toThrow(
			/crosschain-public: a send to .* may burn 1000000000000000 wei on the source chain, over the 200000000000000 wei/,
		)
		expect(wallet.sendTransaction).toHaveBeenCalledTimes(1)
	})

	it("reconcile the gas burned against the caps after every row, the last included", async () => {
		const caps: CanaryCaps = {
			sourceChainId: 84532,
			sourcePerRow: 1n,
			sourceTotal: 1n,
			ethereumTotal: 1n,
			gasWei: { source: 100n, ethereum: 100n },
		}
		const rows = planCanaryRows({ crossChain: 1n, ethereumPlain: 1n, ethereumFueled: 1n }).slice(0, 2)
		const burns = [
			{ source: 0n, ethereum: 0n },
			{ source: 20n, ethereum: 30n },
			{ source: 101n, ethereum: 40n },
		]
		const left: bigint[][] = []
		const run = runLiveRows(
			rows,
			{ caps, perRow: { source: 10n, ethereum: 10n }, burned: async () => burns.shift() as (typeof burns)[number] },
			async (row, b) => {
				left.push([b.source.left, b.ethereum.left])
				return { kind: row.kind, status: "built", to: CANARY, selector: "0x00000000", detail: "" }
			},
		)
		await expect(run).rejects.toThrow(/after crosschain-private the run has burned 101 wei on the source chain, over its cap 100/)
		// Each row's budgets are what the caps had left after the rows before it.
		expect(left).toEqual([
			[100n, 100n],
			[80n, 70n],
		])
	})
})
