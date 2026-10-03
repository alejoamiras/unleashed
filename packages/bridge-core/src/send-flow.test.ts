import { Fr } from "@aztec-labs/aztec.js/fields"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "./flows"
import { predictPortal } from "./portal-address"
import { SWAP_BRIDGE_ROUTER_ABI } from "./router-abi"
import {
	MissingBridgeAmountError,
	readSendReceiptLeaves,
	runSend,
	type SendGeneration,
	type SendParams,
	sendEntrypoint,
	sendPortalFor,
} from "./send-flow"

const ROUTER = "0x1111111111111111111111111111111111111111" as const
const FACTORY = "0x3333333333333333333333333333333333333333" as const
const IMPL = "0x2222222222222222222222222222222222222222" as const
const FEE_PORTAL = "0x4444444444444444444444444444444444444444" as const
const FEE_ASSET = "0x5555555555555555555555555555555555555555" as const
const USDC = "0x00000000000000000000000000000000000e2c20" as const
const RECIPIENT = `0x${"a".padStart(64, "0")}` as const
const ZERO32 = `0x${"0".repeat(64)}` as const

const gen: SendGeneration = {
	router: ROUTER,
	routerAbi: SWAP_BRIDGE_ROUTER_ABI,
	permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
	factory: FACTORY,
	implementation: IMPL,
	feeJuicePortal: FEE_PORTAL,
	feeAsset: FEE_ASSET,
	swapTarget: "0x6666666666666666666666666666666666666666",
	chainId: 31337,
	hub: `0x${"7".padStart(64, "0")}`,
	tokenClassId: "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505",
}

const usdcPortal = predictPortal(FACTORY, IMPL, USDC)

describe("send-flow — portal + entrypoint derivation", () => {
	it("derives the portal from the token, per intent", () => {
		expect(sendPortalFor(gen, { intent: "token", erc20: USDC, isPrivate: false })).toBe(usdcPortal)
		expect(sendPortalFor(gen, { intent: "token+gas", erc20: USDC, isPrivate: true })).toBe(usdcPortal)
		expect(sendPortalFor(gen, { intent: "gas", erc20: USDC, isPrivate: false })).toBe("0x0000000000000000000000000000000000000000")
		// The fee asset's public gas-only goes straight into the canonical FeeJuicePortal…
		expect(sendPortalFor(gen, { intent: "gas", erc20: FEE_ASSET, isPrivate: false })).toBe(FEE_PORTAL)
		expect(sendEntrypoint(gen, { intent: "gas", erc20: FEE_ASSET, isPrivate: false })).toBe("bridge")
		// …while its private gas-only and its "+ gas" shape use the fueled entrypoint.
		expect(sendEntrypoint(gen, { intent: "gas", erc20: FEE_ASSET, isPrivate: true })).toBe("bridgeWithFuel")
		expect(sendPortalFor(gen, { intent: "token+gas", erc20: FEE_ASSET, isPrivate: false })).toBe(
			predictPortal(FACTORY, IMPL, FEE_ASSET),
		)
		expect(sendEntrypoint(gen, { intent: "token", erc20: USDC, isPrivate: false })).toBe("bridge")
		expect(sendEntrypoint(gen, { intent: "token+gas", erc20: USDC, isPrivate: false })).toBe("bridgeWithFuel")
	})
})

const logMeta = { blockNumber: 1n, blockHash: ZERO32, transactionHash: ZERO32, transactionIndex: 0, removed: false }

function bridgeLog(index: bigint, key = `0x${"b".repeat(64)}`, emitter: string = ROUTER, logIndex = 0, amount = 500n) {
	return {
		...logMeta,
		address: emitter,
		logIndex,
		topics: [keccak256(toHex("Bridge(bytes32,bytes32,uint256,uint256,bytes32,bool)")), RECIPIENT],
		data: encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }],
			[key as `0x${string}`, index, amount, ZERO32, false],
		),
	}
}

function bridgeWithFuelLog(tokenIndex: bigint, fuelIndex: bigint, fuelAmount: bigint) {
	return {
		...logMeta,
		address: ROUTER,
		logIndex: 0,
		topics: [
			keccak256(toHex("BridgeWithFuel(bytes32,bytes32,uint256,uint256,bytes32,bytes32,uint256,uint256,bytes32,bool)")),
			RECIPIENT,
		],
		data: encodeAbiParameters(
			[
				{ type: "bytes32" },
				{ type: "uint256" },
				{ type: "uint256" },
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "uint256" },
				{ type: "uint256" },
				{ type: "bytes32" },
				{ type: "bool" },
			],
			[`0x${"1".repeat(64)}`, tokenIndex, 60n, ZERO32, `0x${"2".repeat(64)}`, fuelIndex, fuelAmount, ZERO32, false],
		),
	}
}

const MOCK_PATH = [
	{ currency0: USDC, currency1: FEE_ASSET, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" as const },
]

function fakeL1(logs: unknown[]) {
	const writes: unknown[] = []
	const signed: unknown[] = []
	const l1 = {
		account: { address: "0x7777777777777777777777777777777777777777" },
		wallet: {
			chain: undefined,
			signTypedData: vi.fn(async (td: unknown) => {
				signed.push(td)
				return "0xsig"
			}),
			writeContract: vi.fn(async (req: unknown) => {
				writes.push(req)
				return `0x${"c".repeat(64)}`
			}),
		},
		pub: {
			waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs })),
			readContract: vi.fn(async () => ({
				portal: usdcPortal,
				decimals: 6,
				registerIndex: 41n,
				nameWord: `0x00${"4e".repeat(31)}`,
				symbolWord: `0x00${"55534443".padEnd(62, "0")}`,
				registerKey: `0x${"d".repeat(64)}`,
			})),
		},
	}
	return { l1: l1 as unknown as L1Ctx, writes, signed }
}

describe("send-flow — runSend", () => {
	it("a public token send signs the factory portal, calls bridge(), reads the leaf and the registration", async () => {
		const { l1, writes, signed } = fakeL1([bridgeLog(9n)])
		const p: SendParams = {
			intent: "token",
			erc20: USDC,
			amount: 500n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			nonce: 1n,
			deadline: 2n,
		}
		const secrets: unknown[] = []
		const res = await runSend(l1, gen, p, undefined, { onSecrets: (s) => secrets.push(s) })

		const td = signed[0] as { message: { witness: { tokenPortal: string; totalAmount: bigint; fuelAmount: bigint } } }
		expect(td.message.witness.tokenPortal).toBe(usdcPortal)
		expect(td.message.witness.fuelAmount).toBe(0n)
		const w = writes[0] as { functionName: string; args: [{ tokenPortal: string; secretHash: string }] }
		expect(w.functionName).toBe("bridge")
		expect(w.args[0].tokenPortal).toBe(usdcPortal)
		expect(w.args[0].secretHash).toBe(res.tokenSecretHashHex)
		expect(res.tokenLeafIndex).toBe(9n)
		expect(res.token?.registerIndex).toBe("41")
		expect(res.token?.displaySymbol).toBe("USDC")
		expect(res.token?.decimals).toBe(6)
		expect(res.token?.l2Token).toMatch(/^0x[0-9a-f]{64}$/)
		expect(secrets).toHaveLength(1)
		expect(res.fuelLeafIndex).toBeUndefined()
	})

	it("the fee asset's public gas-only is a bridge() into the FeeJuicePortal whose message is the gas leg", async () => {
		const { l1, writes, signed } = fakeL1([bridgeLog(3n, undefined, ROUTER, 0, 16n)])
		const p: SendParams = {
			intent: "gas",
			erc20: FEE_ASSET,
			amount: 16n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			gas: { fuelAmount: 16n, fuelRecipient: RECIPIENT, minFuelOutput: 16n, path: [], zeroForOnes: [] },
			nonce: 1n,
			deadline: 2n,
		}
		const res = await runSend(l1, gen, p)
		expect((writes[0] as { functionName: string }).functionName).toBe("bridge")
		// The plain entrypoint hashes the gas leg as the token fields and every fuel field as zero.
		const w = (signed[0] as { message: { witness: Record<string, unknown> } }).message.witness
		const call = (writes[0] as { args: [{ aztecRecipient: string; secretHash: string }] }).args[0]
		expect(w.aztecRecipient).toBe(RECIPIENT)
		expect(w.tokenSecretHash).toBe(call.secretHash)
		expect(w.tokenSecretHash).toBe(res.fuelSecretHashHex)
		expect([w.fuelAmount, w.fuelRecipient, w.fuelSecretHash, w.minFuelOutput, w.routeHash]).toEqual([0n, ZERO32, ZERO32, 0n, ZERO32])
		expect(res.fuelLeafIndex).toBe(3n)
		expect(res.fuelReceived).toBe(16n)
		expect(res.token).toBeUndefined()
		expect(res.tokenLeafIndex).toBeUndefined()
	})

	it("refuses the shapes the router would refuse, before signing", async () => {
		const { l1, signed } = fakeL1([])
		const base = { erc20: USDC, amount: 100n, aztecRecipient: RECIPIENT, nonce: 1n, deadline: 2n } as const
		await expect(runSend(l1, gen, { ...base, intent: "token", isPrivate: true })).rejects.toThrow(/claimSalt/)
		await expect(
			runSend(l1, gen, {
				...base,
				intent: "token+gas",
				isPrivate: false,
				gas: { fuelAmount: 100n, fuelRecipient: RECIPIENT, minFuelOutput: 1n, path: [], zeroForOnes: [] },
			}),
		).rejects.toThrow(/0 < fuelAmount < amount/)
		await expect(
			runSend(l1, gen, {
				...base,
				intent: "gas",
				isPrivate: false,
				gas: { fuelAmount: 100n, fuelRecipient: RECIPIENT, minFuelOutput: 1n, path: [], zeroForOnes: [] },
			}),
		).rejects.toThrow(/identity swap/)
		await expect(runSend(l1, gen, { ...base, intent: "token+gas", isPrivate: false })).rejects.toThrow(/requires a gas leg/)
		// Nothing is minted to nobody, and nothing is signed for an empty amount.
		await expect(runSend(l1, gen, { ...base, intent: "token", isPrivate: false, aztecRecipient: ZERO32 })).rejects.toThrow(
			/zero address/,
		)
		await expect(runSend(l1, gen, { ...base, intent: "token", isPrivate: false, amount: 0n })).rejects.toThrow(/positive/)
		// Non-zero but off the curve: nothing could ever decrypt a note sent there.
		await expect(
			runSend(l1, gen, { ...base, intent: "token", isPrivate: false, aztecRecipient: `0x${"ff".repeat(31)}00` }),
		).rejects.toThrow(/not a valid Aztec address/)
		await expect(
			runSend(l1, gen, {
				...base,
				intent: "gas",
				erc20: FEE_ASSET,
				isPrivate: false,
				gas: { fuelAmount: 100n, fuelRecipient: ZERO32, minFuelOutput: 1n, path: [], zeroForOnes: [] },
			}),
		).rejects.toThrow(/gas recipient/)
		expect(signed).toHaveLength(0)
	})

	it("a reverted bridge() is reported as such, never as a missing event", async () => {
		const { l1 } = fakeL1([])
		;(l1.pub.waitForTransactionReceipt as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: "reverted", logs: [] })
		const p: SendParams = {
			intent: "token",
			erc20: USDC,
			amount: 1n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			nonce: 1n,
			deadline: 2n,
		}
		await expect(runSend(l1, gen, p)).rejects.toThrow(/REVERTED/)
	})

	it("a private token send commits the recipient through the secret and publishes a zero recipient", async () => {
		const { l1, writes, signed } = fakeL1([bridgeLog(9n)])
		const p: SendParams = {
			intent: "token",
			erc20: USDC,
			amount: 500n,
			aztecRecipient: RECIPIENT,
			isPrivate: true,
			claimSalt: new Fr(0x5a17n),
			nonce: 1n,
			deadline: 2n,
		}
		const res = await runSend(l1, gen, p)
		expect((signed[0] as { message: { witness: { aztecRecipient: string } } }).message.witness.aztecRecipient).toBe(ZERO32)
		expect((writes[0] as { args: [{ aztecRecipient: string; isPrivate: boolean }] }).args[0].isPrivate).toBe(true)
		expect(res.tokenClaimValueHex).toBe(new Fr(0x5a17n).toString())
	})

	it("a token+gas send maps the gas leg onto the fueled entrypoint and reads both legs from the router's event", async () => {
		const { l1, writes, signed } = fakeL1([bridgeWithFuelLog(7n, 8n, 123n)])
		const p: SendParams = {
			intent: "token+gas",
			erc20: USDC,
			amount: 100n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			gas: { fuelAmount: 40n, fuelRecipient: RECIPIENT, minFuelOutput: 99n, path: MOCK_PATH, zeroForOnes: [true] },
			nonce: 1n,
			deadline: 2n,
		}
		const res = await runSend(l1, gen, p)
		const w = signed[0] as { message: { witness: Record<string, unknown> } }
		const call = (writes[0] as { functionName: string; args: [Record<string, unknown>] }).args[0]
		expect((writes[0] as { functionName: string }).functionName).toBe("bridgeWithFuel")
		// Every witness field the router hashes is the field the call carries.
		for (const k of [
			"tokenPortal",
			"fuelAmount",
			"aztecRecipient",
			"fuelRecipient",
			"tokenSecretHash",
			"fuelSecretHash",
			"minFuelOutput",
		]) {
			expect(call[k], k).toBe(w.message.witness[k])
		}
		expect(call.totalAmount).toBe(100n)
		expect(call.path).toEqual(MOCK_PATH)
		expect(w.message.witness.tokenPortal).toBe(usdcPortal)
		expect(res.tokenLeafIndex).toBe(7n)
		expect(res.fuelLeafIndex).toBe(8n)
		expect(res.fuelReceived).toBe(123n)
		expect(res.fuelSecretHashHex).toBe(call.fuelSecretHash)
	})

	it("a non-fee-asset gas-only send signs the fuel-only shape the router demands: zero portal, recipient and token secret", async () => {
		const { l1, signed, writes } = fakeL1([bridgeWithFuelLog(0n, 8n, 100n)])
		const p: SendParams = {
			intent: "gas",
			erc20: USDC,
			amount: 100n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			gas: { fuelAmount: 100n, fuelRecipient: RECIPIENT, minFuelOutput: 99n, path: MOCK_PATH, zeroForOnes: [true] },
			nonce: 1n,
			deadline: 2n,
		}
		const res = await runSend(l1, gen, p)
		const w = (signed[0] as { message: { witness: Record<string, unknown> } }).message.witness
		expect([w.tokenPortal, w.aztecRecipient, w.tokenSecretHash]).toEqual(["0x0000000000000000000000000000000000000000", ZERO32, ZERO32])
		expect(w.fuelAmount).toBe(100n)
		expect((writes[0] as { functionName: string }).functionName).toBe("bridgeWithFuel")
		expect(res.token).toBeUndefined()
		expect(res.tokenLeafIndex).toBeUndefined()
		expect(res.fuelLeafIndex).toBe(8n)
	})

	it("only the router's own event counts — a same-signature log the token emitted during the pull is ignored", async () => {
		const forged = bridgeLog(999n, `0x${"e".repeat(64)}`, USDC, 0)
		const { l1 } = fakeL1([forged, bridgeLog(9n, `0x${"b".repeat(64)}`, ROUTER, 1)])
		const p: SendParams = {
			intent: "token",
			erc20: USDC,
			amount: 500n,
			aztecRecipient: RECIPIENT,
			isPrivate: false,
			nonce: 1n,
			deadline: 2n,
		}
		const res = await runSend(l1, gen, p)
		expect(res.tokenLeafIndex).toBe(9n)
		expect(res.tokenMessageHashHex).toBe(`0x${"b".repeat(64)}`)

		const onlyForged = fakeL1([forged])
		await expect(runSend(onlyForged.l1, gen, p)).rejects.toThrow(/emitted 0 Bridge events/)
	})

	it("recovers a landed send's leaves from its receipt alone, ignoring the register leaf a first deposit also carries", () => {
		const registerLeaf = {
			...logMeta,
			address: FACTORY,
			logIndex: 0,
			topics: [keccak256(toHex("MessageSent(bytes32,uint256,bytes32,uint256)"))],
			data: "0x" as `0x${string}`,
		}
		const leaves = readSendReceiptLeaves(gen, "token", ZERO32, [
			registerLeaf,
			bridgeLog(41n, `0x${"b".repeat(64)}`, ROUTER, 1),
		] as never)
		expect(leaves).toEqual({ tokenLeafIndex: 41n, tokenMessageHashHex: `0x${"b".repeat(64)}` })
		const gas = readSendReceiptLeaves(gen, "gas", ZERO32, [bridgeLog(3n, undefined, ROUTER, 0, 16n)] as never)
		expect(gas).toEqual({ fuelLeafIndex: 3n, fuelMessageHashHex: `0x${"b".repeat(64)}`, fuelReceived: 16n })
		const fueled = readSendReceiptLeaves(gen, "token+gas", ZERO32, [bridgeWithFuelLog(7n, 8n, 123n)] as never)
		expect(fueled).toMatchObject({ tokenLeafIndex: 7n, fuelLeafIndex: 8n, fuelReceived: 123n })
	})

	it("refuses a gas-only recovery whose event carries no amount rather than recording zero received", () => {
		// A router whose Bridge event names no amount: the receipt alone then says nothing about what
		// landed, and there is no signed amount behind a recovery to stand in for it.
		const amountlessAbi = [
			{
				type: "event",
				name: "Bridge",
				inputs: [
					{ name: "aztecRecipient", type: "bytes32", indexed: true },
					{ name: "key", type: "bytes32", indexed: false },
					{ name: "index", type: "uint256", indexed: false },
				],
			},
		] as const
		const log = {
			...logMeta,
			address: ROUTER,
			logIndex: 0,
			topics: [keccak256(toHex("Bridge(bytes32,bytes32,uint256)")), RECIPIENT],
			data: encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [`0x${"b".repeat(64)}` as `0x${string}`, 3n]),
		}
		const amountless = { ...gen, routerAbi: amountlessAbi as unknown as typeof gen.routerAbi }
		expect(() => readSendReceiptLeaves(amountless, "gas", ZERO32, [log] as never)).toThrow(MissingBridgeAmountError)
		// The token leg never depended on the amount, so it still recovers from the same event.
		expect(readSendReceiptLeaves(amountless, "token", ZERO32, [log] as never)).toEqual({
			tokenLeafIndex: 3n,
			tokenMessageHashHex: `0x${"b".repeat(64)}`,
		})
	})
})
