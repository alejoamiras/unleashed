import { readFileSync } from "node:fs"
import { join } from "node:path"
import { decodeRouterMessage, depositsIn, type SourceDeposit, TESTNET_FILLER } from "@unleashed/bridge-core/across-fill"
import { DEPOSIT_ROUTER_ABI, LIFI_RECEIVER_MESSAGE_PARAMS } from "@unleashed/sdk/l1"
import { type Address, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, type Hex, pad, zeroAddress } from "viem"
import { describe, expect, it } from "vitest"
import manifest from "../../../apps/tools/public/testnet-bridge.json"
import { appDeposit, LEGACY_ROUTER, USER } from "../test/app-deposit"
import { type RelayerRoute, testnetRoute } from "./route"
import { classify, MAX_MESSAGE_BYTES } from "./select"

const FILLER = TESTNET_FILLER
const route: RelayerRoute = testnetRoute(manifest, FILLER)
const STRANGER = pad("0xbad", { size: 32 })

const withRelay = (d: SourceDeposit, over: Partial<SourceDeposit["relay"]>): SourceDeposit => ({ ...d, relay: { ...d.relay, ...over } })

/** `d` with its message's one step, or the router call inside it, rewritten. */
function withStep(d: SourceDeposit, edit: (step: Record<string, unknown>) => Record<string, unknown>, receiver?: Hex): SourceDeposit {
	const [txId, steps, user] = decodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, d.relay.message)
	const step = edit({ ...steps[0] }) as (typeof steps)[number]
	return withRelay(d, { message: encodeAbiParameters(LIFI_RECEIVER_MESSAGE_PARAMS, [txId, [step], (receiver as never) ?? user]) })
}

describe("classify", () => {
	it("admits what the app builds, an odd amount and a send to the legacy router included", () => {
		for (const input of [5_000_000n, 1_234_567n, 8_000_000n, 3n])
			expect(classify(appDeposit({ input, filler: FILLER }), route)).toBeNull()
		expect(classify(appDeposit({ input: 5_000_000n, filler: FILLER, router: LEGACY_ROUTER }), route)).toBeNull()
	})

	it("ignores a deposit for each field outside the envelope", () => {
		const d = appDeposit({ input: 5_000_000n, filler: FILLER })
		const cases: [string, SourceDeposit][] = [
			["destination", { ...d, destinationChainId: 1n }],
			["relayer", withRelay(d, { exclusiveRelayer: STRANGER })],
			["relayer", withRelay(d, { exclusivityDeadline: d.relay.fillDeadline - 1 })],
			["token", withRelay(d, { outputToken: STRANGER })],
			["token", withRelay(d, { inputToken: STRANGER })],
			["recipient", withRelay(d, { recipient: pad(USER, { size: 32 }) })],
			["amount", appDeposit({ input: 8_000_001n, filler: FILLER })],
			["amount", withRelay(d, { inputAmount: 0n })],
			["output", withRelay(d, { outputAmount: d.relay.outputAmount + 1n })],
			["output", withRelay(d, { outputAmount: 0n })],
			["window", withRelay(d, { fillDeadline: d.relay.fillDeadline + 1, exclusivityDeadline: d.relay.fillDeadline + 1 })],
			["window", withRelay(d, { fillDeadline: d.quoteTimestamp - 1, exclusivityDeadline: d.quoteTimestamp - 1 })],
			["message", withRelay(d, { message: `${d.relay.message}${"00".repeat(MAX_MESSAGE_BYTES)}` as Hex })],
			["message", withStep(d, (s) => s, zeroAddress)],
			["message", withStep(d, (s) => ({ ...s, fromAmount: (s.fromAmount as bigint) - 1n }))],
			["message", withStep(d, (s) => ({ ...s, requiresDeposit: true }))],
			["message", withStep(d, (s) => ({ ...s, sendingAssetId: USER }))],
			["message", withStep(d, (s) => ({ ...s, receivingAssetId: USER }))],
			["router", withStep(d, (s) => ({ ...s, callTo: USER, approveTo: USER }))],
			["router", withStep(d, (s) => ({ ...s, approveTo: USER }))],
		]
		for (const [reason, deposit] of cases) expect(classify(deposit, route), reason).toBe(reason)
	})

	it("ignores a router call that pulls other than the output", () => {
		const d = appDeposit({ input: 5_000_000n, filler: FILLER })
		const out = d.relay.outputAmount
		const intent = { ...appIntent(d), token: zeroAddress as Address }
		const call = (i: typeof intent, min: bigint, max: bigint) =>
			encodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, functionName: "bridgeFromCaller", args: [i, "0x", min, max] })
		expect(
			classify(
				withStep(d, (s) => ({ ...s, callData: call(intent, out, out) })),
				route,
			),
		).toBe("intent")
		for (const [min, max] of [
			[out, out + 1n],
			[out - 1n, out],
		])
			expect(
				classify(
					withStep(d, (s) => ({ ...s, callData: call(appIntent(d), min, max) })),
					route,
				),
			).toBe("intent")
	})

	it("ignores the recorded Base Sepolia deposit, which names no exclusive relayer", () => {
		const fixtures = join(import.meta.dirname, "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
		const rail = JSON.parse(readFileSync(join(fixtures, "testnet-rail.json"), "utf8"))
		const receipts = JSON.parse(readFileSync(join(fixtures, "testnet-rail.router.receipts.json"), "utf8"))
		const [recorded] = depositsIn(receipts.source.logs, rail.source.spokePool, 84532n)
		expect(recorded && classify(recorded, route)).toBe("relayer")
	})
})

function appIntent(d: SourceDeposit) {
	const decoded = decodeRouterMessage(d.relay.message)
	if (!decoded.ok) throw new Error(`an app message did not decode: ${decoded.reason}`)
	return decoded.decoded.router.intent
}
