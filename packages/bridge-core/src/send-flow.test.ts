import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Hex, keccak256 } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ScanIncomplete } from "./chain-scan"
import type { DepositedFacts } from "./crosschain-discovery"
import type { L1Ctx } from "./flows"
import { depositWitness } from "./l1"
import { predictPortal } from "./portal-address"
import { runSend, type SendGeneration, type SendParams } from "./send-flow"

const { readRouterDeposit } = vi.hoisted(() => ({ readRouterDeposit: vi.fn() }))
vi.mock("./crosschain-discovery", async (importOriginal) => ({
	...(await importOriginal<typeof import("./crosschain-discovery")>()),
	readRouterDeposit,
}))

const ROUTER = "0x1111111111111111111111111111111111111111" as const
const FACTORY = "0x3333333333333333333333333333333333333333" as const
const IMPL = "0x2222222222222222222222222222222222222222" as const
const FEE_PORTAL = "0x4444444444444444444444444444444444444444" as const
const FEE_ASSET = "0x5555555555555555555555555555555555555555" as const
const INBOX = "0x6666666666666666666666666666666666666666" as const
const USDC = "0x00000000000000000000000000000000000e2c20" as const
const RECIPIENT = `0x${"a".padStart(64, "0")}` as const
const FPC = `0x${"b".padStart(64, "0")}` as const
const ZERO32 = `0x${"0".repeat(64)}` as const
const SWAP_DATA = "0x4666fc80c0ffee" as Hex
const TX = `0x${"c".repeat(64)}` as Hex

const gen: SendGeneration = {
	router: ROUTER,
	permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
	factory: FACTORY,
	implementation: IMPL,
	feeJuicePortal: FEE_PORTAL,
	feeAsset: FEE_ASSET,
	chainId: 31337,
	hub: `0x${"7".padStart(64, "0")}`,
	tokenClassId: "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505",
}

const usdcPortal = predictPortal(FACTORY, IMPL, USDC)

const facts = (legs: Partial<DepositedFacts>): DepositedFacts => ({ depositTxHash: TX, received: "100", ...legs })
const TOKEN_LEG = { amount: "60", leafIndex: "7", messageHash: `0x${"1".repeat(64)}` as Hex }
const FUEL_LEG = { consumed: "40", received: "123", leafIndex: "8", messageHash: `0x${"2".repeat(64)}` as Hex }

function fakeL1(status: "success" | "reverted" = "success") {
	const writes: { functionName: string; address: string; args: unknown[] }[] = []
	const signed: { message: { spender: string; witness: ReturnType<typeof depositWitness> } }[] = []
	const reads: string[] = []
	const l1 = {
		account: { address: "0x7777777777777777777777777777777777777777" },
		wallet: {
			chain: undefined,
			signTypedData: vi.fn(async (td: (typeof signed)[number]) => {
				signed.push(td)
				return "0xsig"
			}),
			writeContract: vi.fn(async (req: (typeof writes)[number]) => {
				writes.push(req)
				return TX
			}),
		},
		pub: {
			waitForTransactionReceipt: vi.fn(async () => ({ status, logs: [] })),
			readContract: vi.fn(async (req: { functionName: string }) => {
				reads.push(req.functionName)
				if (req.functionName === "INBOX") return INBOX
				if (req.functionName === "ROLLUP_VERSION") return 9n
				return {
					portal: usdcPortal,
					decimals: 6,
					registerIndex: 41n,
					nameWord: `0x00${"4e".repeat(31)}`,
					symbolWord: `0x00${"55534443".padEnd(62, "0")}`,
					registerKey: `0x${"d".repeat(64)}`,
				}
			}),
		},
	}
	return { l1: l1 as unknown as L1Ctx, writes, signed, reads }
}

const base = { erc20: USDC, aztecRecipient: RECIPIENT, nonce: 1n, deadline: 2n } as const
type Intent = Record<string, unknown>

beforeEach(() => readRouterDeposit.mockReset())

describe("runSend", () => {
	it("signs the deposit witness of exactly the call it sends, and reads the leaves of that deposit alone", async () => {
		readRouterDeposit.mockResolvedValueOnce(facts({ token: TOKEN_LEG }))
		const { l1, writes, signed } = fakeL1()
		const res = await runSend(l1, gen, { ...base, intent: "token", amount: 100n, isPrivate: false })

		const call = writes[0]
		expect([call.address, call.functionName]).toEqual([ROUTER, "bridgeWithPermit"])
		const [intent, swapData, amount] = call.args as [Intent, Hex, bigint]
		expect([swapData, amount]).toEqual(["0x", 100n])
		expect(intent).toMatchObject({ token: USDC, aztecRecipient: RECIPIENT, isPrivate: false, fuelSlice: 0n, fuelSecretHash: ZERO32 })
		expect(intent.tokenSecretHash).toBe(res.tokenSecretHashHex)
		expect(signed[0].message.spender).toBe(ROUTER)
		expect(signed[0].message.witness).toEqual(depositWitness(intent as never, "0x"))

		const [, txHash, ctx, expected] = readRouterDeposit.mock.calls[0]
		expect(txHash).toBe(TX)
		expect(ctx).toMatchObject({ router: ROUTER, feeJuicePortal: FEE_PORTAL, tokenPortal: usdcPortal })
		expect(ctx.inbox).toMatchObject({ address: INBOX, rollupVersion: 9n, shape: "artifact", l2Hub: gen.hub })
		expect(expected).toEqual({
			l1ChainId: 31337,
			isPrivate: false,
			recipient: RECIPIENT,
			token: { erc20: USDC, secretHash: res.tokenSecretHashHex },
		})
		expect([res.tokenLeafIndex, res.tokenMessageHashHex, res.fuelLeafIndex]).toEqual([7n, TOKEN_LEG.messageHash, undefined])
		expect(res.token).toMatchObject({ registerIndex: "41", displaySymbol: "USDC", decimals: 6 })
	})

	it("binds a fuel quote's bytes into the witness and the call, and takes the gas leg's facts from the deposit", async () => {
		readRouterDeposit.mockResolvedValueOnce(facts({ token: TOKEN_LEG, fuel: FUEL_LEG }))
		const { l1, writes, signed } = fakeL1()
		const gas = { fuelAmount: 40n, fuelRecipient: RECIPIENT, minFuelOutput: 99n, swapData: SWAP_DATA }
		const res = await runSend(l1, gen, { ...base, intent: "token+gas", amount: 100n, isPrivate: false, gas })

		const [intent, swapData] = writes[0].args as [Intent, Hex]
		expect(swapData).toBe(SWAP_DATA)
		expect(intent).toMatchObject({
			fuelSlice: 40n,
			fuelRecipient: RECIPIENT,
			minFuelOutput: 99n,
			fuelSecretHash: res.fuelSecretHashHex,
		})
		expect(signed[0].message.witness.swapDataHash).toBe(keccak256(SWAP_DATA))
		expect(readRouterDeposit.mock.calls[0][3].fuel).toEqual({ secretHash: res.fuelSecretHashHex, recipient: RECIPIENT })
		expect([res.fuelLeafIndex, res.fuelReceived, res.tokenLeafIndex]).toEqual([8n, 123n, 7n])
	})

	it("sends gas only in the fuel-only shape, naming the gas recipient and no token leg", async () => {
		readRouterDeposit.mockResolvedValueOnce(facts({ fuel: FUEL_LEG }))
		const { l1, writes, reads } = fakeL1()
		const gas = { fuelAmount: 100n, fuelRecipient: FPC, minFuelOutput: 99n, swapData: SWAP_DATA }
		const res = await runSend(l1, gen, { ...base, intent: "gas", amount: 100n, isPrivate: false, gas })

		const [intent] = writes[0].args as [Intent]
		expect(intent).toMatchObject({ aztecRecipient: ZERO32, tokenSecretHash: ZERO32, fuelSlice: 100n, fuelRecipient: FPC })
		const [, , ctx, expected] = readRouterDeposit.mock.calls[0]
		expect(ctx.tokenPortal).toBeUndefined()
		expect(expected).toMatchObject({ recipient: FPC, fuel: { recipient: FPC } })
		expect(expected.token).toBeUndefined()
		expect([res.token, res.tokenLeafIndex, res.fuelLeafIndex]).toEqual([undefined, undefined, 8n])
		expect(reads).not.toContain("registrationOf")
	})

	it("commits a private recipient through its secret and never publishes it", async () => {
		readRouterDeposit.mockResolvedValueOnce(facts({ token: TOKEN_LEG }))
		const { l1, writes } = fakeL1()
		const res = await runSend(l1, gen, { ...base, intent: "token", amount: 100n, isPrivate: true, claimSalt: new Fr(0x5a17n) })
		expect((writes[0].args[0] as Intent).aztecRecipient).toBe(ZERO32)
		expect(res.tokenClaimValueHex).toBe(new Fr(0x5a17n).toString())
	})

	it("refuses the shapes the router would refuse, before signing", async () => {
		const { l1, signed } = fakeL1()
		const p = { ...base, amount: 100n, isPrivate: false } as const
		const gas = (over: Partial<NonNullable<SendParams["gas"]>> = {}) => ({
			fuelAmount: 40n,
			fuelRecipient: RECIPIENT,
			minFuelOutput: 1n,
			swapData: SWAP_DATA,
			...over,
		})
		const refusals: [Partial<SendParams>, RegExp][] = [
			[{ intent: "token", isPrivate: true }, /claimSalt/],
			[{ intent: "token+gas", gas: gas({ fuelAmount: 100n }) }, /0 < fuelAmount < amount/],
			[{ intent: "gas", gas: gas() }, /fuelAmount == amount/],
			[{ intent: "token+gas" }, /requires a gas leg/],
			[{ intent: "token+gas", gas: gas({ swapData: "0x" }) }, /needs a fuel quote's swapData/],
			[{ intent: "token+gas", erc20: FEE_ASSET, gas: gas() }, /needs no swap/],
			[{ intent: "token+gas", gas: gas({ minFuelOutput: 0n }) }, /positive minFuelOutput/],
			[{ intent: "token+gas", isPrivate: true, claimSalt: Fr.random(), gas: gas() }, /injected fuelSecret/],
			[{ intent: "token", aztecRecipient: ZERO32 }, /zero address/],
			[{ intent: "token", amount: 0n }, /positive/],
			// Non-zero but off the curve: nothing could ever decrypt a note sent there.
			[{ intent: "token", aztecRecipient: `0x${"ff".repeat(31)}00` }, /not a valid Aztec address/],
			[{ intent: "gas", amount: 40n, gas: gas({ fuelRecipient: ZERO32 }) }, /gas recipient/],
		]
		for (const [over, why] of refusals) await expect(runSend(l1, gen, { ...p, ...over } as SendParams)).rejects.toThrow(why)
		expect(signed).toHaveLength(0)
	})

	it("reports a reverted send as reverted, and a receipt that does not authenticate the deposit as a failure", async () => {
		const reverted = fakeL1("reverted")
		const p: SendParams = { ...base, intent: "token", amount: 1n, isPrivate: false }
		await expect(runSend(reverted.l1, gen, p)).rejects.toThrow(/REVERTED/)
		expect(readRouterDeposit).not.toHaveBeenCalled()

		readRouterDeposit.mockRejectedValueOnce(
			new ScanIncomplete("the transaction carries 0 router Deposited events for this intent, not one"),
		)
		const sent: Hex[] = []
		await expect(runSend(fakeL1().l1, gen, p, undefined, { onSent: (h) => sent.push(h) })).rejects.toThrow(/0 router Deposited/)
		expect(sent).toEqual([TX])
	})
})
