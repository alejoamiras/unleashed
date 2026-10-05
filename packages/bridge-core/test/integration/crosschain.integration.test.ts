/**
 * The LI.FI rail end to end on the sandbox: a send on the source anvil, an Across fill on L1 through LI.FI's compiled
 * ReceiverAcrossV4 and Executor into `DepositRouter.bridgeFromCaller`, found by `discoverCrossChain`, then claimed on
 * L2 with the Fee Juice the same send bridged; and `fill-testnet.ts`'s self-fill against the sandbox pools.
 */
import { type Address, erc20Abi, type Hex, pad, zeroHash } from "viem"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CHAIN_ID } from "../../scripts/sandbox/constants"
import { FillRefused, fillSourceDeposit } from "../../scripts/fill-testnet"
import {
	type CrossChainRig,
	type Filler,
	flowCrossChainFuelOnly,
	flowCrossChainPausedRecovers,
	flowCrossChainTokenPlusGas,
	openCrossChainRig,
	sandboxFillDeps,
} from "../../scripts/sandbox/flows-crosschain"
import { deployEvm, erc20BalanceOf, mint, writeL1 } from "../../scripts/sandbox/l1"
import { evmArtifact } from "../../scripts/script-artifacts"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("the LI.FI rail on the sandbox", () => {
	let rig: CrossChainRig
	beforeAll(async () => {
		rig = await openCrossChainRig((await sandbox()).clients.handle)
	})
	afterAll(async () => {
		await rig?.close()
	})

	/** Runs `fn` with the relay loop skipping every deposit it sees, so only the caller fills. */
	async function withoutTheLoop<T>(fn: () => Promise<T>): Promise<T> {
		rig.relayer.setMode({ kind: "never" })
		try {
			return await fn()
		} finally {
			rig.relayer.setMode({ kind: "now" })
		}
	}

	const relayerNonce = () => rig.cc.relayer.pub.getTransactionCount({ address: rig.cc.relayer.account.address })

	describe("source chain to L2, the claim paid by the bridged fuel", () => {
		it("token + gas, public", async () => {
			const a = await freshActor()
			const { usdc } = await sandbox()
			expect(await flowCrossChainTokenPlusGas(a.s, rig, usdc, await a.l2TokenOf(usdc), false)).toContain("claim public")
		})

		it("token + gas, private: the PrivateFPC pays the claim from the private fuel", async () => {
			const a = await freshActor()
			const { usdc } = await sandbox()
			expect(await flowCrossChainTokenPlusGas(a.s, rig, usdc, await a.l2TokenOf(usdc), true)).toContain("claim private")
		})

		it("gas only, public, self-filled through fill-testnet: a claim with no app call pays for itself", async () => {
			const a = await freshActor()
			const { usdc } = await sandbox()
			const fill: Filler = async (sent) => {
				await mint(rig.cc.relayer, usdc.erc20 as Address, rig.cc.relayer.account.address, sent.outputAmount)
				const r = await fillSourceDeposit(sandboxFillDeps(rig), sent.srcTxHash)
				expect(r).toMatchObject({ relayHash: sent.relayHash, alreadyFilled: false })
				return r.fillTxHash as Hex
			}
			expect(await withoutTheLoop(() => flowCrossChainFuelOnly(a.s, rig, usdc, false, fill))).toContain("paid for itself")
		})

		it("gas only, private: the delivery becomes PrivateFPC credit less the fee ceiling", async () => {
			const a = await freshActor()
			const { usdc } = await sandbox()
			expect(await flowCrossChainFuelOnly(a.s, rig, usdc, true)).toContain("private credit")
		})

		it("deposits paused: the delivery is recovered whole to the user's L1 address and nothing stays behind", async () => {
			const a = await freshActor()
			const { usdc } = await sandbox()
			expect(await flowCrossChainPausedRecovers(a.s, rig, usdc)).toContain("recovered to the user's L1 address")
		})
	})

	describe("fill-testnet's self-fill", () => {
		const RECIPIENT: Address = "0x00000000000000000000000000000000000c0ffe"
		const OTHER_RELAYER: Address = "0x0000000000000000000000000000000000000b0b"
		const INPUT = 1_000_000n
		const OUTPUT = 990_000n

		/** A bare `deposit` on `pool` from the source user, with no message, bound for L1. */
		async function rawDeposit(
			pool: Address,
			over: { fillDeadline?: number; exclusiveRelayer?: Address; exclusivityParameter?: number } = {},
		) {
			const src = rig.cc.source
			const token = rig.cc.handle.source.token as Address
			await mint(src, token, src.account.address, INPUT)
			await writeL1(src, token, erc20Abi, "approve", [pool, INPUT])
			const [srcHead, l1Head] = await Promise.all([src.pub.getBlock(), rig.cc.l1.pub.getBlock()])
			return writeL1(src, pool, evmArtifact("TestSpokePool").abi, "deposit", [
				pad(src.account.address, { size: 32 }),
				pad(RECIPIENT, { size: 32 }),
				pad(token, { size: 32 }),
				pad(rig.cc.handle.destination.token as Address, { size: 32 }),
				INPUT,
				OUTPUT,
				BigInt(CHAIN_ID),
				over.exclusiveRelayer ? pad(over.exclusiveRelayer, { size: 32 }) : zeroHash,
				Number(srcHead.timestamp),
				over.fillDeadline ?? Number(l1Head.timestamp + 3_600n),
				over.exclusivityParameter ?? 0,
				"0x",
			])
		}

		const refusal = (p: Promise<unknown>) =>
			p.then(
				() => "sent",
				(e) => (e instanceof FillRefused ? e.reason : `threw ${e}`),
			)

		it("refuses a transaction with no deposit from the pinned pool, a look-alike pool's included", async () => {
			await withoutTheLoop(async () => {
				const lookAlike = await deployEvm(rig.cc.source, "TestSpokePool", [])
				const hash = await rawDeposit(lookAlike)
				const nonce = await relayerNonce()
				expect(await refusal(fillSourceDeposit(sandboxFillDeps(rig), hash))).toBe("no-deposit")
				expect(await refusal(fillSourceDeposit(sandboxFillDeps(rig), `0x${"77".repeat(32)}`))).toBe("no-receipt")
				expect(await relayerNonce()).toBe(nonce)
			})
		})

		it("refuses past the fill deadline and inside another relayer's exclusivity window, sending nothing", async () => {
			await withoutTheLoop(async () => {
				const pool = rig.cc.handle.source.spokePool as Address
				const expired = await rawDeposit(pool, { fillDeadline: 1 })
				// Above Across's one-year boundary, the parameter is an absolute timestamp.
				const exclusive = await rawDeposit(pool, { exclusiveRelayer: OTHER_RELAYER, exclusivityParameter: 4_000_000_000 })
				await mint(rig.cc.relayer, rig.cc.handle.destination.token as Address, rig.cc.relayer.account.address, OUTPUT)
				const nonce = await relayerNonce()
				expect(await refusal(fillSourceDeposit(sandboxFillDeps(rig), expired))).toBe("deadline")
				expect(await refusal(fillSourceDeposit(sandboxFillDeps(rig), exclusive))).toBe("exclusive")
				expect(await relayerNonce()).toBe(nonce)
			})
		})

		it("approves exactly the output, and treats an already-filled relay as success without sending", async () => {
			await withoutTheLoop(async () => {
				const pool = rig.cc.handle.source.spokePool as Address
				const destPool = rig.cc.handle.destination.spokePool as Address
				const token = rig.cc.handle.destination.token as Address
				const filler = rig.cc.relayer.account.address
				const hash = await rawDeposit(pool)
				await mint(rig.cc.relayer, token, filler, OUTPUT)
				const before = await erc20BalanceOf(rig.cc.l1, token, RECIPIENT)
				const first = await fillSourceDeposit(sandboxFillDeps(rig), hash)
				expect(first.alreadyFilled).toBe(false)
				expect(first.fillTxHash).toMatch(/^0x[0-9a-f]{64}$/)
				expect((await erc20BalanceOf(rig.cc.l1, token, RECIPIENT)) - before).toBe(OUTPUT)
				const allowance = await rig.cc.l1.pub.readContract({
					address: token,
					abi: erc20Abi,
					functionName: "allowance",
					args: [filler, destPool],
				})
				expect(allowance).toBe(0n)
				const nonce = await relayerNonce()
				expect(await fillSourceDeposit(sandboxFillDeps(rig), hash)).toEqual({
					fillTxHash: null,
					relayHash: first.relayHash,
					alreadyFilled: true,
				})
				expect(await relayerNonce()).toBe(nonce)
			})
		})
	})
})
