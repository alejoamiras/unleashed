import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { decodeFunctionData, type Hex } from "viem"
import { describe, expect, it } from "vitest"
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
import { canaryBindings, formatCanaryRecord } from "./lifi-canary-plan"
import { type CanaryDeps, runCanary } from "./lifi-canary-run"
import { canaryEdge } from "./lifi-canary-testnet"

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
