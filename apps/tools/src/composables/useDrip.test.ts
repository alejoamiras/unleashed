import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/*
 * Mock the SDK boundary so the composable can be exercised end-to-end
 * without a live wallet. The contract proxy's `.request({ fee })`
 * receives the SponsoredFeePaymentMethod and returns an ExecutionPayload
 * that already has feePayer + the sponsor call merged - that's what
 * aztec.js does in real usage. We mimic the shape here.
 *
 * SponsoredFeePaymentMethod is also mocked so the test doesn't try to
 * construct the real class (which needs Aztec internals).
 */

const mockDripperMethods = {
	drip_to_public: vi.fn(),
	drip_to_private: vi.fn(),
}
const mockDripper = { methods: mockDripperMethods }

vi.mock("@aztec-labs/aztec.js/contracts", () => ({
	Contract: { at: vi.fn(async () => mockDripper) },
}))

vi.mock("@aztec-labs/aztec.js/fee", () => ({
	SponsoredFeePaymentMethod: class {
		readonly _kind = "sponsored"
		constructor(public readonly address: { toString: () => string }) {}
	},
}))

vi.mock("@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js", () => ({
	DripperContractArtifact: { name: "Dripper" },
}))

vi.mock("@/contracts/sponsored-fpc", () => ({
	getSponsoredFpcInstance: async () => ({
		address: { toString: () => "0xfpc" },
	}),
}))

vi.mock("@/contracts/deployments", () => ({
	DRIPPER: { toString: () => "0xdripper" },
}))

// The sponsored path pads maxFeesPerGas from predicted-worst min fees; both
// the node client and the predictor are mocked so no network is dialed and
// the padding multiplier is observable via the `_paddedBy` marker.
vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: vi.fn(() => ({ _node: true })),
}))

// The drip reads the shared session's readiness before it touches the wallet. Default connected +
// ready; cases flip these to exercise the gate. The gate itself is the pure predicate, reproduced
// here (its live copy is unit-tested in useWalletConnection.test.ts).
const wc = vi.hoisted(() => ({
	status: { value: "connected" as string },
	contractsReady: { value: true },
	error: { value: null as { message: string } | null },
}))

vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => ({ status: wc.status, contractsReady: wc.contractsReady, error: wc.error }),
	contractsReadinessRefusal: (s: {
		status: { value: string }
		error: { value: { message: string } | null }
		contractsReady: { value: boolean }
	}) => {
		if (s.status.value !== "connected") return s.error.value?.message ?? "Connect your Aztec wallet first."
		if (!s.contractsReady.value) return "Your wallet is still setting up the app's contracts. Try again in a moment."
		return undefined
	},
	// These cases never inject CONTRACT_NOT_REGISTERED; the retry's own branches are pinned in
	// useWalletConnection.test.ts. Pass through so the send is the real one.
	retryOnUnregistered: (_s: unknown, _w: unknown, op: () => Promise<unknown>) => op(),
}))

vi.mock("@unleashed/bridge-core", () => ({
	predictedWorstMinFees: vi.fn(async () => ({
		mul: (scalar: number) => ({ _paddedBy: scalar }),
	})),
}))

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { __resetDripForTests, useDrip } from "./useDrip"

const SIGNAL_ADDR = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000002")
const NOISE_ADDR = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000003")
const ACCOUNT = AztecAddress.fromStringUnsafe("0x000000000000000000000000000000000000000000000000000000000000000a")

const SIGNAL = { symbol: "SIGNAL", decimals: 6, displayAmount: "1,000", onchainAmount: 1_000_000_000n } as const
const NOISE = { symbol: "NOISE", decimals: 18, displayAmount: "1", onchainAmount: 1_000_000_000_000_000_000n } as const

function makeWallet() {
	const calls: { exec: unknown; opts: unknown }[] = []
	return {
		_calls: calls,
		sendTx: vi.fn(async (exec: unknown, opts: unknown) => {
			calls.push({ exec, opts })
			return { txHash: "0xdeadbeef0001" }
		}),
	}
}

/**
 * Build an interaction whose `.request({ fee })` mimics aztec.js's
 * actual behavior: merges the sponsor call + feePayer into the payload
 * so the test can assert the dApp passes the merged exec to sendTx.
 */
function makeInteraction(target: "public" | "private") {
	return {
		request: vi.fn(async (opts?: { fee?: { paymentMethod: { address?: { toString: () => string } } } }) => {
			const sponsorAddr = opts?.fee?.paymentMethod?.address
			return {
				calls: [{ target }, ...(sponsorAddr ? [{ kind: "sponsor_unconditionally", on: sponsorAddr.toString() }] : [])],
				feePayer: sponsorAddr,
			}
		}),
	}
}

beforeEach(() => {
	__resetDripForTests()
	mockDripperMethods.drip_to_public.mockReset()
	mockDripperMethods.drip_to_private.mockReset()
	mockDripperMethods.drip_to_public.mockImplementation(() => makeInteraction("public"))
	mockDripperMethods.drip_to_private.mockImplementation(() => makeInteraction("private"))
	wc.status.value = "connected"
	wc.contractsReady.value = true
	wc.error.value = null
})

afterEach(() => {
	vi.clearAllMocks()
})

describe("useDrip", () => {
	it("drip-public uses the drip_to_public method with the SIGNAL onchain amount", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(mockDripperMethods.drip_to_public).toHaveBeenCalledWith(SIGNAL_ADDR, 1_000_000_000n)
		expect(mockDripperMethods.drip_to_private).not.toHaveBeenCalled()
	})

	it("refuses with SETUP_PENDING while contracts are still registering - the wallet is never touched", async () => {
		wc.contractsReady.value = false
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const result = await useDrip(w as any, ACCOUNT).drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(result).toEqual({ kind: "error", value: "Your wallet is still setting up the app's contracts. Try again in a moment." })
		expect(mockDripperMethods.drip_to_public).not.toHaveBeenCalled()
	})

	it("refuses with the session's own message when it is not connected", async () => {
		wc.status.value = "error"
		wc.error.value = { message: "Alpha-testnet is not responding. Try again." }
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const result = await useDrip(w as any, ACCOUNT).drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(result).toEqual({ kind: "error", value: "Alpha-testnet is not responding. Try again." })
		expect(mockDripperMethods.drip_to_public).not.toHaveBeenCalled()
	})

	it("drip-private uses the drip_to_private method", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "private")
		expect(mockDripperMethods.drip_to_private).toHaveBeenCalledWith(SIGNAL_ADDR, 1_000_000_000n)
	})

	it("NOISE drips use the 1e18 onchain amount", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(NOISE, NOISE_ADDR, "public")
		expect(mockDripperMethods.drip_to_public).toHaveBeenCalledWith(NOISE_ADDR, 1_000_000_000_000_000_000n)
	})

	it("passes a SponsoredFeePaymentMethod to interaction.request({fee}) so the sponsor call is embedded", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		const interactionInstance = mockDripperMethods.drip_to_public.mock.results[0]?.value as ReturnType<typeof makeInteraction>
		expect(interactionInstance.request).toHaveBeenCalledWith({
			fee: { paymentMethod: expect.objectContaining({ _kind: "sponsored" }) },
		})
	})

	it("sendTx opts carry the padded maxFeesPerGas — the wallet reads fees from SEND options only", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		// Load-bearing: without an explicit padded cap the wallet pins the
		// sponsored tx at getCurrentMinFees() (zero headroom) and any base-fee
		// uptick during proving gets it silently dropped by the pool.
		const opts = w._calls[0]?.opts as { fee?: { gasSettings?: { maxFeesPerGas?: unknown } } }
		expect(opts.fee?.gasSettings?.maxFeesPerGas).toEqual({ _paddedBy: 1.5 })
	})

	it("fee-padding failure degrades to wallet defaults — the drip still sends", async () => {
		const { predictedWorstMinFees } = await import("@unleashed/bridge-core")
		vi.mocked(predictedWorstMinFees).mockRejectedValueOnce(new Error("node unreachable"))
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const res = await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(res.kind).toBe("txHash")
		const opts = w._calls[0]?.opts as { from?: unknown; fee?: unknown }
		expect(opts.fee).toBeUndefined()
	})

	it("sendTx receives the merged exec (sponsor call + feePayer) and the selected account", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(w.sendTx).toHaveBeenCalledTimes(1)
		const [exec, opts] = w.sendTx.mock.calls[0]
		const execObj = exec as {
			feePayer?: { toString: () => string }
			calls: Array<{ kind?: string; target?: string }>
		}
		expect(execObj.feePayer?.toString()).toBe("0xfpc")
		// Both the dripper call and the sponsor_unconditionally call land in exec.calls.
		expect(execObj.calls.some((c) => c.target === "public")).toBe(true)
		expect(execObj.calls.some((c) => c.kind === "sponsor_unconditionally")).toBe(true)
		expect((opts as { from: AztecAddress }).from).toBe(ACCOUNT)
	})

	it("on success, stores the tx hash under '<symbol>:<target>' in `last`", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const result = await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(result.kind).toBe("txHash")
		expect(result.value).toBe("0xdeadbeef0001")
		expect(drip.last["SIGNAL:public"]).toEqual({ kind: "txHash", value: "0xdeadbeef0001" })
	})

	it("on wallet error, normalizes the error and stores it in `last`", async () => {
		const w = {
			sendTx: vi.fn(async () => {
				throw new Error("Transaction reverted on-chain")
			}),
		}
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const result = await drip.drip(SIGNAL, SIGNAL_ADDR, "private")
		expect(result.kind).toBe("error")
		expect(result.category).toBe("tx-reverted")
		expect(drip.last["SIGNAL:private"]?.kind).toBe("error")
	})

	it("clears `inflight` after a successful drip (returns to null)", async () => {
		const w = makeWallet()
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		expect(drip.inflight.value).toBeNull()
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(drip.inflight.value).toBeNull()
	})

	it("clears `inflight` even after a wallet error", async () => {
		const w = {
			sendTx: vi.fn(async () => {
				throw new Error("Capability denied by user")
			}),
		}
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		await drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		expect(drip.inflight.value).toBeNull()
	})

	it("global in-flight gate: a concurrent drip while one is active returns an error", async () => {
		let resolveSend: (v: { txHash: string }) => void = () => {}
		const w = {
			sendTx: vi.fn(
				() =>
					new Promise<{ txHash: string }>((r) => {
						resolveSend = r
					}),
			),
		}
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const p1 = drip.drip(SIGNAL, SIGNAL_ADDR, "public")
		await new Promise((r) => setTimeout(r, 0))
		const second = await drip.drip(NOISE, NOISE_ADDR, "public")
		expect(second.kind).toBe("error")
		expect(second.value).toMatch(/another drip is in flight/i)
		resolveSend({ txHash: "0x1" })
		await p1
	})

	it("stamps the lock with its start time while sendTx is pending", async () => {
		let resolveSend: (v: { txHash: string }) => void = () => {}
		const w = {
			sendTx: vi.fn(
				() =>
					new Promise<{ txHash: string }>((r) => {
						resolveSend = r
					}),
			),
		}
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const before = Date.now()
		const p = drip.drip(SIGNAL, SIGNAL_ADDR, "private")
		await vi.waitFor(() => expect(w.sendTx).toHaveBeenCalled())
		const startedAt = drip.inflight.value?.startedAt
		expect(typeof startedAt).toBe("number")
		expect(startedAt).toBeGreaterThanOrEqual(before)
		expect(startedAt).toBeLessThanOrEqual(Date.now())
		resolveSend({ txHash: "0x1" })
		await p
		expect(drip.inflight.value).toBeNull()
	})

	it("isActive() reports the currently-running (token, target) pair", async () => {
		let resolveSend: (v: { txHash: string }) => void = () => {}
		const w = {
			sendTx: vi.fn(
				() =>
					new Promise<{ txHash: string }>((r) => {
						resolveSend = r
					}),
			),
		}
		// biome-ignore lint/suspicious/noExplicitAny: test stub
		const drip = useDrip(w as any, ACCOUNT)
		const p = drip.drip(SIGNAL, SIGNAL_ADDR, "private")
		await new Promise((r) => setTimeout(r, 0))
		expect(drip.isActive("SIGNAL", "private")).toBe(true)
		expect(drip.isActive("NOISE", "public")).toBe(false)
		resolveSend({ txHash: "0x1" })
		await p
		expect(drip.isActive("SIGNAL", "private")).toBe(false)
	})
})
