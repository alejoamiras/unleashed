import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Address } from "viem"
import { beforeAll, describe, expect, it, vi } from "vitest"
import type { BridgeError } from "../src/errors.ts"
import { depositFuel, quoteFuel } from "../src/fuel/index.ts"
import { type Network, parseNetwork, type Reads } from "../src/network.ts"
import { allowanceAfterApprove, readsOf, type Step, testnet, type World, walletOf, worldOf } from "./fakes.ts"

vi.mock("../src/protocol/generation-record.ts", async (importOriginal) =>
	(await import("./fakes.ts")).withSyntheticCode(await importOriginal()),
)
// Leaves come from the router's own mined `Deposited`; this file is about what happens before them.
vi.mock("../src/execution/send-flow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/execution/send-flow.ts")>()),
	confirmSend: async (_l1: unknown, _g: unknown, s: { fuel?: { secretHash: string } }, txHash: string) => ({
		txHash,
		fuelLeafIndex: 7n,
		fuelMessageHashHex: `0x${"77".repeat(32)}`,
		fuelReceived: 1n,
		fuelSecretHashHex: s.fuel?.secretHash,
	}),
}))

let recipient: string
let net: Network
let r: Reads
let log: Step[]
let feeAsset: Address
let world: World

beforeAll(async () => {
	recipient = (await AztecAddress.random()).toString()
})

async function setup(chainId?: number) {
	log = []
	const w = worldOf(testnet())
	world = w
	feeAsset = w.m.feeJuice.asset as Address
	w.reads.set(`${feeAsset.toLowerCase()}:allowance`, allowanceAfterApprove(log))
	r = readsOf(w)
	net = await parseNetwork(w.m, r)
	const quote = await quoteFuel(net, r, { token: feeAsset, amount: 40n * 10n ** 18n, recipient, privacy: "private" })
	return { quote, wallet: walletOf(log, chainId ?? net.l1ChainId) }
}

const failure = (p: Promise<unknown>) =>
	p.then(
		() => undefined,
		(e: unknown) => e as BridgeError,
	)

describe("persist before every prompt", () => {
	it("asks for no approval and no signature until the first persist resolves", async () => {
		const { quote, wallet } = await setup()
		let release!: () => void
		const first = new Promise<void>((resolve) => {
			release = resolve
		})
		const persist = vi.fn(async (_record: unknown, _secrets?: unknown) => {
			log.push({ kind: "persist", detail: null })
			if (persist.mock.calls.length === 1) await first
		})
		const run = depositFuel(net, r, wallet, quote, { persist })
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(log.map((s) => s.kind)).toEqual(["persist"])
		release()
		await run
		const kinds = log.map((s) => s.kind)
		expect(kinds.indexOf("persist")).toBeLessThan(kinds.indexOf("write"))
		expect(kinds.indexOf("persist")).toBeLessThan(kinds.indexOf("sign"))
		// The private gas leg's salt reached storage with the first persist.
		expect(Object.keys(persist.mock.calls[0]?.[1] ?? {})).toEqual(["fuelSalt"])
	})

	it("a rejected persist ends the run with persist-failed, nothing signed and nothing sent", async () => {
		const { quote, wallet } = await setup()
		const e = await failure(depositFuel(net, r, wallet, quote, { persist: async () => Promise.reject(new Error("quota")) }))
		expect([e?.code, e?.submission, e?.retry]).toEqual(["persist-failed", "none", "safe"])
		expect(log).toEqual([])
	})

	it("a wallet on the wrong chain costs no prompt and no persist", async () => {
		const { quote, wallet } = await setup(1)
		const persist = vi.fn(async () => {})
		const e = await failure(depositFuel(net, r, wallet, quote, { persist }))
		expect([e?.code, e?.submission]).toEqual(["wrong-chain", "none"])
		expect(persist).not.toHaveBeenCalled()
		expect(log).toEqual([])
	})

	it("a paused route costs no prompt and no persist", async () => {
		const { quote, wallet } = await setup()
		world.reads.set(`${String(net.bridge?.factory).toLowerCase()}:depositsPaused`, true)
		const persist = vi.fn(async () => {})
		const e = await failure(depositFuel(net, r, wallet, quote, { persist }))
		expect([e?.code, e?.submission]).toEqual(["paused", "none"])
		expect(persist).not.toHaveBeenCalled()
		expect(log).toEqual([])
	})

	it("an abort once the deposit is sent says never: a second deposit call would move the funds again", async () => {
		const { quote, wallet } = await setup()
		const controller = new AbortController()
		const onEvent = (e: { type: string }) => e.type === "deposit-sent" && controller.abort()
		const e = await failure(depositFuel(net, r, wallet, quote, { persist: async () => {}, onEvent, signal: controller.signal }))
		expect([e?.code, e?.submission, e?.retry]).toEqual(["aborted", "submitted", "never"])
		expect(e?.message).toMatch(/claimFuel or claimToken/)
	})
})
