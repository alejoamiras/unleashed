import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { describe, expect, it } from "vitest"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import {
	claimSendOpts,
	claimViaHub,
	type HubClaimParams,
	hubBindingAt,
	hubExitsPaused,
	hubTokenOfSlot,
	isRegisterRace,
	preflightHubExit,
} from "./hub-l2"
import type { JournalTokenBlock } from "./journal"

const token: JournalTokenBlock = {
	erc20: "0x00000000000000000000000000000000000e2c20",
	portal: "0x00000000000000000000000000000000000000a1",
	l2Token: `0x${"11".repeat(32)}`,
	nameWord: `0x00${"4e".repeat(31)}`,
	symbolWord: `0x00${"54".repeat(31)}`,
	decimals: 18,
	displaySymbol: "TST",
	registerIndex: "5",
}
const USER = `0x${"22".repeat(32)}`

/** A hub whose `token_for` answers as scripted and whose sends record their method name. */
interface FakeHubOpts {
	registered: boolean
	failRegister?: string
	/** Whether a failed registration leaves the hub knowing the token (a lost race) or not (unsynced leaf). */
	registeredAfterFailure?: boolean
	boundTo?: string
	/** A successful registration makes the hub know the token (as the real hub does). */
	registerBinds?: boolean
	paused?: boolean | string
	/** How many claim simulations fail before the claimer's view catches up with the node; traced in `calls`. */
	claimSimulateFailures?: number
	/** The execution result a landed registration reports (a reverted one is mined and has a hash). */
	registerExecution?: string
	/** The wallet hands the registration's receipt back before it is mined (the Nulo wallet's shape). */
	registerPending?: boolean
}

function fakeHub(opts: FakeHubOpts) {
	const calls: string[] = []
	const sentWith: Array<[string, Record<string, unknown>]> = []
	let registered = opts.registered
	let claimFailuresLeft = opts.claimSimulateFailures ?? 0
	const views = (): Record<string, unknown> => ({
		token_for: registered ? (opts.boundTo ?? token.l2Token) : `0x${"0".repeat(64)}`,
		exits_paused: opts.paused ?? false,
	})
	// The claimer's view catching up with the node: the first N claim simulations fail as an
	// uninitialized binding read would, the ones after pass.
	const simulateClaim = (name: string): void => {
		calls.push(`simulate:${name}`)
		if (claimFailuresLeft <= 0) return
		claimFailuresLeft--
		throw new Error("Assertion failed: PublicImmutable not initialized")
	}
	// A registration's outcome as scripted: a throw (a lost race or a broken block), a binding, a status.
	const registrationLands = (): string => {
		if (opts.failRegister) {
			registered = opts.registeredAfterFailure ?? true
			throw new Error(opts.failRegister)
		}
		if (opts.registerBinds) registered = true
		return opts.registerExecution ?? "success"
	}
	const simulateOf = async (name: string): Promise<unknown> => {
		const v = views()
		if (name in v) return { result: v[name] }
		if (name.startsWith("exit_")) calls.push(`simulate:${name}`)
		if (name.startsWith("claim_") && opts.claimSimulateFailures !== undefined) simulateClaim(name)
		return {}
	}
	const method = (name: string) => {
		return (..._args: unknown[]) => ({
			simulate: () => simulateOf(name),
			send: async (o?: Record<string, unknown>) => {
				calls.push(name)
				sentWith.push([name, o ?? {}])
				const execution = name.startsWith("register") ? registrationLands() : "success"
				const pending = name.startsWith("register") && opts.registerPending
				return {
					receipt: {
						txHash: `0x${name}`,
						status: pending ? "pending" : "proposed",
						executionResult: pending ? undefined : execution,
					},
				}
			},
		})
	}
	const methods = new Proxy({}, { get: (_t, name: string) => method(name) })
	return { hub: { methods } as unknown as ContractBase, calls, sentWith }
}

const params = (isPrivate: boolean): HubClaimParams => ({
	token,
	recipient: USER,
	amount: 5n,
	claimValue: new Fr(1n),
	leafIndex: 9n,
	isPrivate,
	from: USER,
})

describe("hub L2 claims", () => {
	it("a registered token is a plain claim", async () => {
		const { hub, calls } = fakeHub({ registered: true })
		expect(await claimViaHub(hub, params(false), {})).toEqual({ path: "claim", claimTxHash: "0xclaim_public" })
		expect(await claimViaHub(hub, params(true), {})).toMatchObject({ path: "claim", claimTxHash: "0xclaim_private" })
		expect(calls).toEqual(["claim_public", "claim_private"])
	})

	it("an unregistered token: public registers + claims in one tx, private registers in its own tx first", async () => {
		const { hub, calls } = fakeHub({ registered: false })
		expect(await claimViaHub(hub, params(false), {})).toEqual({ path: "register+claim", claimTxHash: "0xregister_and_claim_public" })
		expect(await claimViaHub(hub, params(true), {})).toEqual({
			path: "register,claim",
			registerTxHash: "0xregister_token",
			claimTxHash: "0xclaim_private",
		})
		expect(calls).toEqual(["register_and_claim_public", "register_token", "claim_private"])
	})

	it("a private first claim pays its registration with `registerFee`, the claim with `fee`, and the wallet never sees the seam key", async () => {
		// A fuel claim's fee consumes the bridged Fee Juice message — one transaction can spend it,
		// so the registration ahead of it must be paid by something else.
		const { hub, sentWith } = fakeHub({ registered: false })
		await claimViaHub(hub, params(true), { from: USER, fee: "fuel", registerFee: "sponsor" })
		expect(sentWith).toEqual([
			["register_token", { from: USER, fee: "sponsor", wait: { dontThrowOnRevert: true } }],
			["claim_private", { from: USER, fee: "fuel" }],
		])
		// Without the seam the registration and the claim share one fee, as before.
		const plain = fakeHub({ registered: false })
		await claimViaHub(plain.hub, params(true), { from: USER, fee: "fuel" })
		expect(plain.sentWith.map(([, o]) => o)).toEqual([
			{ from: USER, fee: "fuel", wait: { dontThrowOnRevert: true } },
			{ from: USER, fee: "fuel" },
		])
		// A registered token strips it too.
		const known = fakeHub({ registered: true })
		await claimViaHub(known.hub, params(true), { from: USER, fee: "fuel", registerFee: "sponsor" })
		expect(known.sentWith).toEqual([["claim_private", { from: USER, fee: "fuel" }]])
		// A simulation of the claim uses the same stripped options — the wallet's option parser
		// spreads unknown keys straight through.
		expect(
			claimSendOpts({
				from: USER,
				fee: "fuel",
				registerFee: "sponsor",
				registeredClaimFee: "credit",
				onRegisterSend: () => {},
				onRegistered: () => {},
				onClaimSend: () => {},
				registrationWait: { intervalMs: 1 },
			}),
		).toEqual({ from: USER, fee: "fuel" })
	})

	it("when the registration itself spends the fuel, the claim that follows it pays with `registeredClaimFee`; a lost race keeps the plain fee", async () => {
		// The registration consumed the bridged Fee Juice and left the remainder as credit at the
		// FPC — the claim draws on that credit, never on the message a second time.
		const own = fakeHub({ registered: false })
		await claimViaHub(own.hub, params(true), { from: USER, fee: "fuel", registerFee: "fuel", registeredClaimFee: "credit" })
		expect(own.sentWith).toEqual([
			["register_token", { from: USER, fee: "fuel", wait: { dontThrowOnRevert: true } }],
			["claim_private", { from: USER, fee: "credit" }],
		])
		// Someone else registered first: this call spent nothing, so the claim is the plain claim
		// with the plain fee — the fuel message is still the claim's to consume.
		const raced = fakeHub({ registered: false, failRegister: "No non-nullified L1 to L2 message found for message hash 0xabc" })
		await claimViaHub(raced.hub, params(true), { from: USER, fee: "fuel", registerFee: "fuel", registeredClaimFee: "credit" })
		expect(raced.sentWith.map(([name, o]) => [name, o.fee])).toEqual([
			["register_token", "fuel"],
			["claim_private", "fuel"],
		])
		// A registered token never sees either seam.
		const known = fakeHub({ registered: true })
		await claimViaHub(known.hub, params(true), { from: USER, fee: "fuel", registerFee: "fuel", registeredClaimFee: "credit" })
		expect(known.sentWith).toEqual([["claim_private", { from: USER, fee: "fuel" }]])
	})

	it("a registration that reverts past its setup is reported by hash and the claim is NOT sent — its fee setup spent the fuel", async () => {
		// The registration's wait must not throw on the revert, or the hash (the only evidence the
		// bridged gas is now credit at the FPC) would be lost with the error.
		const order: string[] = []
		const h = fakeHub({ registered: false, registerExecution: "reverted" })
		await expect(
			claimViaHub(h.hub, params(true), {
				from: USER,
				fee: "fuel",
				registerFee: "fuel",
				registeredClaimFee: "credit",
				wait: { waitForStatus: "proposed" },
				onRegistered: (hash) => order.push(`onRegistered:${hash}`),
				onClaimSend: () => order.push("onClaimSend"),
			}),
		).rejects.toThrow(/registration 0xregister_token reverted after its setup spent the bridged gas/)
		expect(order).toEqual(["onRegistered:0xregister_token"])
		expect(h.calls).toEqual(["register_token"])
		expect(h.sentWith[0][1].wait).toEqual({ waitForStatus: "proposed", dontThrowOnRevert: true })
		// The claim's own wait is untouched: a reverted claim must still surface as an error.
		const clean = fakeHub({ registered: false })
		await claimViaHub(clean.hub, params(true), { from: USER, wait: { waitForStatus: "proposed" } })
		expect(clean.sentWith.map(([name, o]) => [name, o.wait])).toEqual([
			["register_token", { waitForStatus: "proposed", dontThrowOnRevert: true }],
			["claim_private", { waitForStatus: "proposed" }],
		])
	})

	it("a registration handed back unmined is followed on the node until its fate is known: mined claims on, reverted reports the hash, dropped spent nothing", async () => {
		const noSleep = { intervalMs: 10, deadlineMs: 1_000, sleep: async () => {} }
		const receipts = (...answers: Array<{ status: string; executionResult?: string }>) => {
			const queue = [...answers]
			return async () => queue.shift() ?? answers[answers.length - 1]
		}
		// Mined after one more read: the claim follows as usual.
		const mined = fakeHub({ registered: false, registerBinds: true, registerPending: true })
		const outcome = await claimViaHub(mined.hub, params(true), {
			from: USER,
			receiptOf: receipts({ status: "pending" }, { status: "proposed", executionResult: "success" }),
			registrationWait: noSleep,
		})
		expect(outcome).toMatchObject({ path: "register,claim", registerTxHash: "0xregister_token", claimTxHash: "0xclaim_private" })

		// Reverted past its setup: the hash is reported, the claim is not sent.
		const order: string[] = []
		const reverted = fakeHub({ registered: false, registerPending: true })
		await expect(
			claimViaHub(reverted.hub, params(true), {
				from: USER,
				receiptOf: receipts({ status: "pending" }, { status: "checkpointed", executionResult: "reverted" }),
				registrationWait: noSleep,
				onRegistered: (hash) => order.push(`onRegistered:${hash}`),
			}),
		).rejects.toThrow(/reverted after its setup spent the bridged gas/)
		expect(order).toEqual(["onRegistered:0xregister_token"])
		expect(reverted.calls).toEqual(["register_token"])

		// Dropped: nothing was spent; the hash is still reported (the journal's own receipt probe reads
		// it as dropped and lets the fuel retry) and the whole claim retries.
		order.length = 0
		const dropped = fakeHub({ registered: false, registerPending: true })
		await expect(
			claimViaHub(dropped.hub, params(true), {
				from: USER,
				receiptOf: receipts({ status: "pending" }, { status: "dropped" }),
				registrationWait: noSleep,
				onRegistered: (hash) => order.push(`onRegistered:${hash}`),
			}),
		).rejects.toThrow(/was dropped before inclusion/)
		expect(order).toEqual(["onRegistered:0xregister_token"])

		// A node read that fails says nothing: the hash was reported before it, and the poll goes on.
		order.length = 0
		let reads = 0
		const flaky = fakeHub({ registered: false, registerBinds: true, registerPending: true })
		const flakyOutcome = await claimViaHub(flaky.hub, params(true), {
			from: USER,
			receiptOf: async () => {
				reads++
				if (reads === 1) throw new Error("node unreachable")
				return { status: "proposed", executionResult: "success" }
			},
			registrationWait: noSleep,
			onRegistered: (hash) => order.push(`onRegistered:${hash}`),
		})
		expect(flakyOutcome).toMatchObject({ path: "register,claim", registerTxHash: "0xregister_token" })
		expect(order).toEqual(["onRegistered:0xregister_token"])
		expect(reads).toBe(2)

		// Without a node read the fate stays unknown and the claim's own simulation decides, as before.
		const blind = fakeHub({ registered: false, registerBinds: true, registerPending: true })
		expect(await claimViaHub(blind.hub, params(true), { from: USER, registrationWait: noSleep })).toMatchObject({
			path: "register,claim",
		})
		// The node read never reaches the wallet.
		expect(mined.sentWith.every(([, o]) => !("receiptOf" in o))).toBe(true)
	})

	it("a private first claim reports its registration the moment it exists, then waits for the claim to simulate in the claimer's view before sending it", async () => {
		// The registration is proposed on the node, but the claim reads the binding at the wallet's
		// synced block, which lags — the claim is sent only once its own simulation passes.
		const slept: number[] = []
		const order: string[] = []
		const h = fakeHub({ registered: false, registerBinds: true, claimSimulateFailures: 2 })
		const outcome = await claimViaHub(h.hub, params(true), {
			from: USER,
			fee: "fuel",
			onRegisterSend: () => order.push("onRegisterSend"),
			onRegistered: (hash) => order.push(`onRegistered:${hash}`),
			onClaimSend: () => order.push("onClaimSend"),
			registrationWait: { intervalMs: 7, deadlineMs: 1_000, sleep: async (ms) => void slept.push(ms) },
		})
		expect(outcome).toEqual({ path: "register,claim", registerTxHash: "0xregister_token", claimTxHash: "0xclaim_private" })
		expect(h.calls).toEqual([
			"register_token",
			"simulate:claim_private",
			"simulate:claim_private",
			"simulate:claim_private",
			"claim_private",
		])
		expect(order).toEqual(["onRegisterSend", "onRegistered:0xregister_token", "onClaimSend"])
		expect(slept).toEqual([7, 7])
		// The wait uses the claim's own options, seams stripped — what the send will use.
		expect(h.sentWith.every(([, o]) => !("registrationWait" in o) && !("onRegistered" in o))).toBe(true)

		// A lost race sent no registration: nothing to report, nothing to wait for.
		const raced = fakeHub({
			registered: false,
			failRegister: "No non-nullified L1 to L2 message found for message hash 0xabc",
			claimSimulateFailures: 0,
		})
		order.length = 0
		await claimViaHub(raced.hub, params(true), {
			from: USER,
			onRegisterSend: () => order.push("onRegisterSend"),
			onRegistered: () => order.push("onRegistered"),
			onClaimSend: () => order.push("onClaimSend"),
		})
		expect(order).toEqual(["onRegisterSend", "onClaimSend"])
		expect(raced.calls).toEqual(["register_token", "claim_private"])

		// Past the deadline the claim is NOT sent: the failure names the registration so a retry
		// claims plainly against the now-bound hub.
		const stuck = fakeHub({ registered: false, registerBinds: true, claimSimulateFailures: Number.POSITIVE_INFINITY })
		await expect(
			claimViaHub(stuck.hub, params(true), {
				from: USER,
				registrationWait: { intervalMs: 10, deadlineMs: 35, sleep: async () => {} },
			}),
		).rejects.toThrow(/registration 0xregister_token landed but the claim is not yet visible.*not initialized/)
		expect(stuck.calls.filter((c) => c === "claim_private")).toEqual([])
		expect(stuck.calls.filter((c) => c === "simulate:claim_private").length).toBeGreaterThanOrEqual(2)
	})

	it("`onClaimSend` fires once, right before the claim's own transaction, after any registration", async () => {
		// A caller's "claim attempted" latch must not cover a registration that failed without
		// spending the fuel — so the stage callback is the claim's, never the registration's.
		const order: string[] = []
		const onClaimSend = () => order.push("onClaimSend")
		const privateFirst = fakeHub({ registered: false })
		await claimViaHub(privateFirst.hub, params(true), { from: USER, fee: "fuel", registerFee: "sponsor", onClaimSend })
		expect([...privateFirst.calls.slice(0, 1), ...order, ...privateFirst.calls.slice(1)]).toEqual([
			"register_token",
			"onClaimSend",
			"claim_private",
		])
		expect(privateFirst.sentWith.every(([, o]) => !("onClaimSend" in o))).toBe(true)

		for (const [hubOpts, isPrivate, expected] of [
			[{ registered: false }, false, ["register_and_claim_public"]],
			[{ registered: true }, true, ["claim_private"]],
		] as const) {
			order.length = 0
			const h = fakeHub(hubOpts)
			await claimViaHub(h.hub, params(isPrivate), { from: USER, fee: "fuel", onClaimSend })
			expect(order).toEqual(["onClaimSend"])
			expect(h.calls).toEqual(expected)
		}

		// A lost public registration race falls back to the plain claim inside the SAME attempt: once.
		order.length = 0
		const raced = fakeHub({ registered: false, failRegister: "No non-nullified L1 to L2 message found for message hash 0xabc" })
		await claimViaHub(raced.hub, params(false), { from: USER, fee: "fuel", onClaimSend })
		expect(raced.calls).toEqual(["register_and_claim_public", "claim_public"])
		expect(order).toEqual(["onClaimSend"])

		// A registration that throws (not a lost race) never reaches the callback.
		order.length = 0
		const broken = fakeHub({ registered: false, failRegister: "Assertion failed: word does not decompose" })
		await expect(
			claimViaHub(broken.hub, params(true), { from: USER, fee: "fuel", registerFee: "sponsor", onClaimSend }),
		).rejects.toThrow()
		expect(order).toEqual([])
	})

	it("a lost registration race falls back to the plain claim; any other failure propagates", async () => {
		const notFound = "No non-nullified L1 to L2 message found for message hash 0xabc"
		const raced = fakeHub({ registered: false, failRegister: notFound })
		expect(await claimViaHub(raced.hub, params(false), {})).toEqual({ path: "claim", claimTxHash: "0xclaim_public" })
		const racedPrivate = fakeHub({ registered: false, failRegister: notFound })
		expect(await claimViaHub(racedPrivate.hub, params(true), {})).toEqual({ path: "register,claim", claimTxHash: "0xclaim_private" })

		// The same message with the hub still ignorant means the leaf is not consumable yet — the
		// caller's sync retry owns that, not a plain claim that would fail on the unbound token.
		const unsynced = fakeHub({ registered: false, failRegister: notFound, registeredAfterFailure: false })
		await expect(claimViaHub(unsynced.hub, params(false), {})).rejects.toThrow(/non-nullified/)
		expect(unsynced.calls).toEqual(["register_and_claim_public"])

		const broken = fakeHub({ registered: false, failRegister: "Assertion failed: word does not decompose" })
		await expect(claimViaHub(broken.hub, params(false), {})).rejects.toThrow(/decompose/)

		expect(isRegisterRace(new Error("EMITNULLIFIER: Attempted to emit duplicate nullifier 0x1"))).toBe(true)
		expect(isRegisterRace(new Error("Balance too low"))).toBe(false)
	})

	it("a hub that binds the ERC-20 to a different L2 token than the journal refuses the claim", async () => {
		const { hub, calls } = fakeHub({ registered: true, boundTo: `0x${"33".repeat(32)}` })
		await expect(claimViaHub(hub, params(false), {})).rejects.toThrow(/binds .* refusing to claim/)
		expect(calls).toEqual([])
		// A private first claim learns the binding from its own registration, before the claim.
		const tampered = fakeHub({ registered: false, boundTo: `0x${"33".repeat(32)}`, registerBinds: true })
		await expect(claimViaHub(tampered.hub, params(true), {})).rejects.toThrow(/binds .* refusing to claim/)
		expect(tampered.calls).toEqual(["register_token"])
	})

	it("a token block without a registerIndex cannot register", async () => {
		const { hub } = fakeHub({ registered: false })
		await expect(claimViaHub(hub, { ...params(false), token: { ...token, registerIndex: undefined } }, {})).rejects.toThrow(
			/registerIndex/,
		)
	})

	it("the exit preflight simulates the chosen exit and refuses a zero recipient before simulating", async () => {
		const { hub, calls } = fakeHub({ registered: true })
		const base = {
			l2Token: token.l2Token,
			recipientL1: "0x00000000000000000000000000000000000000ee",
			amount: 1n,
			callerOnL1: "0x00000000000000000000000000000000000000ee",
			authwitNonce: new Fr(7n),
		}
		await preflightHubExit(hub, { ...base, isPrivate: false }, USER)
		await preflightHubExit(hub, { ...base, isPrivate: true }, USER)
		expect(calls).toEqual(["simulate:exit_to_l1_public", "simulate:exit_to_l1_private"])
		await expect(preflightHubExit(hub, { ...base, recipientL1: `0x${"0".repeat(40)}`, isPrivate: false }, USER)).rejects.toThrow(
			/zero address/,
		)
	})

	it("the pause view reads the guardian switch without simulating an exit", async () => {
		expect(await hubExitsPaused(fakeHub({ registered: true }).hub, USER)).toBe(false)
		const paused = fakeHub({ registered: true, paused: true })
		expect(await hubExitsPaused(paused.hub, USER)).toBe(true)
		expect(paused.calls).toEqual([])
		await expect(hubExitsPaused(fakeHub({ registered: true, paused: "maybe" }).hub, USER)).rejects.toThrow(/not a boolean/)
	})
})

describe("hub binding from public storage", () => {
	const HUB = `0x00${"33".repeat(31)}`

	function fakeNode(answer: Fr) {
		const reads: Array<[string, string]> = []
		return {
			reads,
			getPublicStorageAt: async (_block: "latest", contract: { toString(): string }, slot: Fr) => {
				reads.push([contract.toString(), slot.toString()])
				return answer
			},
		}
	}

	it("reads the token_of entry at the slot the map derives for the ERC-20, on the hub", async () => {
		const node = fakeNode(Fr.fromString(token.l2Token))
		expect(await hubBindingAt(node, HUB, token.erc20)).toBe(token.l2Token)
		const expected = (await deriveStorageSlotInMap(hubTokenOfSlot(), EthAddress.fromString(token.erc20))).toString()
		expect(node.reads).toEqual([[AztecAddress.fromStringUnsafe(HUB).toString(), expected]])
	})

	it("an unwritten slot reads as zero, which is no binding", async () => {
		expect(await hubBindingAt(fakeNode(Fr.ZERO), HUB, token.erc20)).toBeUndefined()
	})
})
