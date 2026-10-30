/**
 * The claim fee ladder against a fake host: the record store, the node and the account's balances are the
 * environment's, so every write and every stop code is observable without a journal or a wallet.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { GasFees } from "@aztec-labs/stdlib/gas"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import { beforeEach, describe, expect, test, vi } from "vitest"

const h = vi.hoisted(() => {
	const calls: Array<[string, unknown]> = []
	return {
		calls,
		t: (n: string, d?: unknown) => void calls.push([n, d]),
		/** What the node answers for a claim hash's receipt; unset = throws (unreachable). */
		receiptStatus: undefined as string | undefined,
		/** The PERSISTED record the store answers with; undefined = nothing stored. */
		persisted: undefined as { fuel?: import("../records.ts").DepositFuelBlock } | undefined,
		/** The account's private Fee Juice credit at the FPC; undefined = the read fails. */
		privateFj: undefined as bigint | undefined,
		/** The account's public Fee Juice; undefined = the read fails. */
		publicFj: undefined as bigint | undefined,
		/** Whether the connected wallet routes a dApp-named public payer. */
		selfPay: false,
		/** What the claim's `send` throws; unset = it lands. */
		sendThrows: undefined as string | undefined,
		/** The checkpointed nullifier witness per read, consumed in order (the last answer repeats);
		 *  undefined = absent, "throw" = the node cannot answer, "hang" = it never answers. */
		witness: [] as unknown[],
		/** What the deposit router's receipt reader authenticates, or the refusal it throws. */
		depositLeaves: {} as Record<string, unknown> | Error,
		/** The highest max fees per gas a quote may carry: above the node's 10/20 unless a case tightens it. */
		bound: { feePerDaGas: 10n, feePerL2Gas: 60n },
	}
})

vi.mock("./fuel-claim.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./fuel-claim.ts")>()),
	buildFuelClaimInteraction: (_rec: unknown, opts: Record<string, unknown>) => {
		h.t("builderOpts", opts)
		return {
			simulate: async () => ({}),
			send: async () => {
				if (h.sendThrows) throw new Error(h.sendThrows)
				return { txHash: "0x1" }
			},
		}
	},
}))

// The deposit router's receipt is authenticated by send-flow; here only what the recovery hands it.
vi.mock("./send-flow.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("./send-flow.ts")>()),
	readSendInbox: async (_pub: unknown, g: { factory: string }) => ({ fromFactory: g.factory }),
	readSendReceiptLeaves: async (g: { router: string }, inbox: unknown, expected: unknown) => {
		h.t("readSendReceiptLeaves", { router: g.router, inbox, expected })
		if (h.depositLeaves instanceof Error) throw h.depositLeaves
		return h.depositLeaves
	},
}))

// Only the payment methods are faked, so the salt the private claim pays with is observable; every
// derivation around them stays real.
vi.mock("../protocol/private-fuel.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../protocol/private-fuel.ts")>()),
	privateMintAndPayFee: (_fpc: unknown, amount: bigint, secret: { toString(): string }, salt: { toString(): string }) => {
		h.t("privateMintAndPayFee", { amount, secret: secret.toString(), salt: salt.toString() })
		return { kind: "private-fpc" }
	},
	privateFeeJuicePayment: (fpc: { toString(): string }) => {
		h.t("privateFeeJuicePayment", { fpc: fpc.toString() })
		return { kind: "fpc-credit" }
	},
}))
vi.mock("../protocol/fee-juice.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../protocol/fee-juice.ts")>()),
	selfPaidFeeJuicePayment: (payer: { toString(): string }) => {
		h.t("selfPaidFeeJuicePayment", { payer: payer.toString() })
		return { kind: "self-paid-fj" }
	},
}))

import { deriveTokenClaimSecret } from "../protocol/claim-secret.ts"
import {
	deriveBridgeSecret,
	PRIVATE_FPC_ADDRESS,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	PUBLIC_HUB_CLAIM_GAS,
	PUBLIC_HUB_REGISTER_CLAIM_GAS,
} from "../protocol/private-fuel.ts"
import type { DepositFuelBlock, DepositRecord } from "../records.ts"
import {
	buildFeeJuiceClaim,
	type FeeLadderEnv,
	type FeeLadderRecord,
	type FeeStop,
	patchFuel,
	recoverDepositLeg,
	resolveHubClaimSendOpts,
	resolvePrivateFuelFee,
	sendStandaloneFjClaim,
} from "./fee-ladder.ts"
import { feeJuiceMessageNullifier } from "./message-nullifier.ts"

const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"
const recipient = AztecAddress.fromStringUnsafe(RECIPIENT)

/** A node answering fees 10/20, the receipt and the witnesses the test sets. A fresh one per case keeps the
 *  per-node gas maximum unread, so limits pass through unclamped. */
function fakeNode(): AztecNode {
	return {
		getCurrentMinFees: async () => GasFees.from({ feePerDaGas: 10n, feePerL2Gas: 20n }),
		getTxReceipt: async () => {
			if (h.receiptStatus === undefined) throw new Error("node unreachable")
			return { status: h.receiptStatus }
		},
		getNullifierMembershipWitness: (tag: string, nullifier: { toString(): string }) => {
			h.t("witness", { tag, nullifier: nullifier.toString() })
			const answer = h.witness.length > 1 ? h.witness.shift() : h.witness[0]
			if (answer === "throw") return Promise.reject(new Error("node unreachable"))
			if (answer === "hang") return new Promise(() => {})
			return Promise.resolve(answer)
		},
	} as unknown as AztecNode
}

const balance = (fn: string, value: bigint | undefined) => {
	if (value === undefined) throw new Error(`${fn} failed`)
	return value
}

let node: AztecNode
const env = (): FeeLadderEnv => ({
	records: {
		current: () => h.persisted as never,
		mergeWhen: (id, when, patch) => {
			// No stored record stands for one without a fuel block, so the captured fallback is exercised.
			const live = (h.persisted ?? {}) as never
			if (!when(live)) return false
			h.t("write", { id, patch: patch(live) })
			return true
		},
		merge: (id, patch) => h.t("write", { id, patch }),
	},
	node,
	privateFpc: PRIVATE_FPC_ADDRESS,
	fuel: undefined,
	minFloorFj: 1000n,
	readPublicFeeJuice: async () => {
		h.t("readPublicFeeJuice")
		return balance("balance_of_public", h.publicFj)
	},
	readPrivateFeeJuice: async () => balance("balance_of", h.privateFj),
	feeBound: async () => h.bound,
	log: () => {},
})

/** A wallet with no simulation of its own: priced from the node's prediction. */
const wallet = () => ({ getWalletFeatures: async () => (h.selfPay ? ["dapp-self-pay"] : []) })

type Rec = FeeLadderRecord & { recipient: string; fuel?: DepositFuelBlock }
const FUEL: DepositFuelBlock = { amount: "10", secret: "0xf", secretHashHex: "0xfh", minOutput: "9" }
const mkRec = (over: Partial<Rec> = {}): Rec => ({ schema: 1, id: "0xspec1", isPrivate: false, recipient: RECIPIENT, fuel: FUEL, ...over })

const writes = () => h.calls.filter(([n]) => n === "write").map(([, d]) => (d as { patch: { fuel?: DepositFuelBlock } }).patch)
const stopOf = (p: Promise<unknown>): Promise<FeeStop | undefined> =>
	p.then(
		() => undefined,
		(e: { stop: FeeStop }) => e.stop,
	)

beforeEach(() => {
	h.calls.length = 0
	h.receiptStatus = undefined
	h.publicFj = undefined
	h.privateFj = undefined
	h.selfPay = false
	h.persisted = undefined
	h.sendThrows = undefined
	h.witness = []
	h.bound = { feePerDaGas: 10n, feePerL2Gas: 60n }
	node = fakeNode()
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
})

describe("secret-derivation conservation", () => {
	test("the private token commit hashes the DERIVED secret, never the raw salt", async () => {
		const salt = new Fr(0x5555n)
		const derived = deriveTokenClaimSecret(salt, recipient)
		const committed = await computeSecretHash(derived)
		const rawCommitted = await computeSecretHash(salt)
		expect(derived.toString()).not.toBe(salt.toString())
		expect(committed.toString()).not.toBe(rawCommitted.toString())
	})

	test("the private fuel secret is claimer-committed (recipient-bound, salt-recoverable)", () => {
		const salt = new Fr(0x8888n)
		const a = deriveBridgeSecret(salt, recipient)
		const b = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(RECIPIENT))
		const other = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(`0x2018${RECIPIENT.slice(6)}`))
		expect(a.toString()).toBe(b.toString())
		expect(a.toString()).not.toBe(other.toString())
	})
})

describe("fee-juice claim builder", () => {
	test("gets RAW predicted-worst fees (no padding) and per-privacy claim material", async () => {
		await buildFeeJuiceClaim(env(), mkRec({ isPrivate: false }), "0xsecrethex", undefined, {})
		await buildFeeJuiceClaim(env(), mkRec({ isPrivate: true }), "0xsecrethex", { salt: "0xenvsalt" }, {})
		const [pub, priv] = h.calls.filter(([n]) => n === "builderOpts").map(([, d]) => d as Record<string, unknown>)
		expect((pub.maxFeesPerGas as { feePerDaGas: bigint }).feePerDaGas).toBe(10n)
		expect((pub.maxFeesPerGas as { feePerL2Gas: bigint }).feePerL2Gas).toBe(20n)
		expect(pub.resolvedSecret).toBe("0xsecrethex")
		expect(pub.resolvedSalt).toBeUndefined()
		expect(priv.resolvedSalt).toBe("0xenvsalt")
		expect(priv.resolvedSecret).toBeUndefined()
	})

	test("latch callbacks write store-first shapes and insufficiency separately", async () => {
		await buildFeeJuiceClaim(env(), mkRec(), "0xs", undefined, {})
		const opts = h.calls.find(([n]) => n === "builderOpts")?.[1] as {
			onAttempt: () => void
			onTxHash: (tx: string) => void
			onSetupInsufficiency: () => void
		}
		opts.onAttempt()
		opts.onTxHash("0xtx")
		opts.onSetupInsufficiency()
		const patches = writes().map((p) => p.fuel)
		expect(patches[0]).toMatchObject({ claimAttempt: true, claimAttemptAt: 1_700_000_000_000, setupInsufficiency: false })
		expect(patches[1]).toMatchObject({ claimAttempt: true, claimTxHash: "0xtx" })
		expect(patches[2]).toMatchObject({ setupInsufficiency: true })
	})
})

describe("fee-juice claim builder — a prior claim on the PERSISTED block gates the rebuild", () => {
	// A field-sized hash: the well-formedness check is 64 hex digits AND the TxHash parser.
	const HASH = `0x${"00".repeat(31)}ab`
	const built = () => h.calls.some(([n]) => n === "builderOpts")
	const stopOfClaim = async (rec: Rec) => stopOf((await buildFeeJuiceClaim(env(), rec, "0xs", undefined, {})).simulate())

	test("a consumed block never rebuilds", async () => {
		expect(await stopOfClaim(mkRec({ fuel: { ...FUEL, consumed: true } }))).toBe("fuel-already-claimed")
		expect(built()).toBe(false)
	})

	test("an included prior claim stops; a dropped one rebuilds; a pending or unreachable one waits", async () => {
		const withHash = mkRec({ fuel: { ...FUEL, claimTxHash: HASH } })
		h.receiptStatus = "success"
		expect(await stopOfClaim(withHash)).toBe("fuel-already-claimed")
		h.receiptStatus = "pending"
		expect(await stopOfClaim(withHash)).toBe("fuel-claim-pending")
		h.receiptStatus = undefined
		expect(await stopOfClaim(withHash)).toBe("fuel-claim-pending")
		expect(built()).toBe(false)
		h.receiptStatus = "dropped"
		expect(await stopOfClaim(withHash)).toBeUndefined()
		expect(built()).toBe(true)
	})

	test("a malformed persisted hash is a record fault, not a receipt to wait on", async () => {
		expect(await stopOfClaim(mkRec({ fuel: { ...FUEL, claimTxHash: "0xnothex" } }))).toBe("malformed-claim-hash")
		expect(built()).toBe(false)
	})

	test("a patch computed for a fuel block the store has since swapped out is refused", () => {
		h.persisted = { fuel: { ...FUEL, secretHashHex: "0xanother-deposit" } }
		expect(patchFuel(env(), "0xspec1", FUEL, { consumed: true })).toBe(false)
		expect(writes()).toHaveLength(0)
		// A block that has since learnt its message key is still the same block; a different key is not.
		h.persisted = { fuel: { ...FUEL, messageHash: "0xkey-a", leafIndex: "7" } }
		expect(patchFuel(env(), "0xspec1", FUEL, { consumed: true })).toBe(true)
		expect(patchFuel(env(), "0xspec1", { ...FUEL, messageHash: "0xkey-b" }, { consumed: true })).toBe(false)
		// A record without a fuel block falls back to the captured one; nothing captured, nothing to merge.
		h.persisted = { fuel: undefined }
		expect(patchFuel(env(), "0xspec1", FUEL, { consumed: true })).toBe(true)
		expect(patchFuel(env(), "0xspec1", undefined, { consumed: true })).toBe(false)
	})

	test("the gate reads the PERSISTED block over the captured one, and latches merge into it", async () => {
		// The captured record has no prior claim; the store holds one that dropped, plus a field the
		// captured copy never saw. The latch must carry that field, not overwrite it from the copy.
		h.persisted = { fuel: { ...FUEL, claimTxHash: HASH, leafIndex: "7" } }
		h.receiptStatus = "dropped"
		await buildFeeJuiceClaim(env(), mkRec(), "0xs", undefined, {})
		expect(built()).toBe(true)
		const opts = h.calls.find(([n]) => n === "builderOpts")?.[1] as { onAttempt: () => void }
		opts.onAttempt()
		expect(writes().at(-1)?.fuel).toMatchObject({ leafIndex: "7", claimTxHash: HASH, claimAttempt: true })
	})
})

describe("private fuel fee — the sealed salt is authoritative", () => {
	const SEALED_SALT = new Fr(0x5eaedn).toString()
	const TAMPERED_SALT = new Fr(0xbadn).toString()

	const fueled = (bridgeSecretSalt: string, over: Partial<DepositFuelBlock> = {}): Rec =>
		mkRec({
			schema: 3,
			intent: "token+gas",
			isPrivate: true,
			fuel: { ...FUEL, received: "100000000", leafIndex: "8", bridgeSecretSalt, ...over },
		})

	const paidWith = () => h.calls.find(([n]) => n === "privateMintAndPayFee")?.[1] as { secret: string; salt: string }

	test("a rewritten record salt loses to the sealed one, and the record is corrected", async () => {
		const fee = await resolvePrivateFuelFee(env(), fueled(TAMPERED_SALT), recipient, SEALED_SALT)

		expect(fee.kind).toBe("fee")
		expect(paidWith().salt).toBe(SEALED_SALT)
		expect(paidWith().secret).toBe(deriveBridgeSecret(Fr.fromString(SEALED_SALT), recipient).toString())
		// The record is rewritten from the sealed copy, so the next retry no longer disagrees.
		expect(writes().at(0)?.fuel?.bridgeSecretSalt).toBe(SEALED_SALT)
		expect((fee as { fuel: DepositFuelBlock }).fuel.bridgeSecretSalt).toBe(SEALED_SALT)
	})

	test("an agreeing record salt is left alone - no rewrite, same claim", async () => {
		const fee = await resolvePrivateFuelFee(env(), fueled(SEALED_SALT), recipient, SEALED_SALT)

		expect(fee.kind).toBe("fee")
		expect(paidWith().salt).toBe(SEALED_SALT)
		expect(writes()).toHaveLength(0)
	})

	test("with no sealed copy the record's still drives the claim", async () => {
		await resolvePrivateFuelFee(env(), fueled(TAMPERED_SALT), recipient)
		expect(paidWith().salt).toBe(TAMPERED_SALT)
	})

	test("the FPC claim declares explicit gas limits with the raw predicted-worst fees (no padding)", async () => {
		// Without limits the wallet declares the network's per-tx maximum and the FPC's ceiling
		// (limits × fees) outgrows any realistic fuel slice.
		const fee = await resolvePrivateFuelFee(env(), fueled(SEALED_SALT), recipient, SEALED_SALT)
		const gas = (
			fee as { fee: { gasSettings: { gasLimits: { daGas: number; l2Gas: number }; maxFeesPerGas: { feePerL2Gas: bigint } } } }
		).fee.gasSettings
		expect({ daGas: gas.gasLimits.daGas, l2Gas: gas.gasLimits.l2Gas }).toEqual(PRIVATE_HUB_CLAIM_GAS)
		expect(gas.maxFeesPerGas.feePerL2Gas).toBe(20n)
	})

	test("a private claim stops before any prompt when the wallet's fee is over the bound, and pays within it", async () => {
		h.bound = { feePerDaGas: 10n, feePerL2Gas: 19n }
		expect(await resolvePrivateFuelFee(env(), fueled(SEALED_SALT), recipient, SEALED_SALT)).toEqual({
			kind: "stop",
			stop: "unpriced-by-wallet",
		})
		h.privateFj = 999_000_000n
		expect(
			await resolvePrivateFuelFee(env(), fueled(SEALED_SALT, { consumed: true }), recipient, SEALED_SALT, { aztec: wallet() }),
		).toEqual({
			kind: "stop",
			stop: "unpriced-by-wallet",
		})
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee" || n === "privateFeeJuicePayment")).toBe(false)
		h.bound = { feePerDaGas: 10n, feePerL2Gas: 20n }
		expect((await resolvePrivateFuelFee(env(), fueled(SEALED_SALT), recipient, SEALED_SALT)).kind).toBe("fee")
	})

	test("a bridged amount under the committed ceiling stops before the FPC can reject it", async () => {
		// Fees 10/20 → ceiling = 2_000_000·20 + 100_000·10 = 41_000_000 FJ-wei.
		const fee = await resolvePrivateFuelFee(env(), fueled(SEALED_SALT, { received: "40999999" }), recipient, SEALED_SALT)
		expect(fee).toEqual({ kind: "stop", stop: "fuel-short" })
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee")).toBe(false)
	})

	type Resolved = {
		kind: string
		stop?: FeeStop
		fuelOnRegister?: boolean
		onRegistered?: (h: string) => void
		opts: Record<string, { paymentMethod: unknown; gasSettings: { gasLimits: { daGas: number; l2Gas: number } } } | undefined>
	}
	const resolve = (rec: Rec, registers: boolean) =>
		resolveHubClaimSendOpts(env(), {
			rec,
			recipientAddr: recipient,
			aztec: wallet(),
			userOverride: false,
			sealedSalt: SEALED_SALT,
			registers,
		}) as Promise<Resolved>

	test("on a first-time token the registration spends the fuel, sized for a registration, and the claim after it pays from the FPC credit", async () => {
		// Fees 10/20 → register ceiling 4M·20 + 100k·10 = 81M, claim ceiling 41M: both must fit.
		const resolved = await resolve(fueled(SEALED_SALT, { received: "122000000" }), true)
		expect(resolved).toMatchObject({ kind: "opts" })
		expect(resolved.opts.registerFee?.paymentMethod).toEqual({ kind: "private-fpc" })
		expect(resolved.opts.registerFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_REGISTER_GAS)
		expect(resolved.opts.registeredClaimFee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(resolved.opts.registeredClaimFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_CLAIM_GAS)
		// A registration someone else wins leaves the fuel on the plain claim, which stays the fuel fee.
		expect(resolved.opts.fee?.paymentMethod).toEqual({ kind: "private-fpc" })
		expect(resolved.fuelOnRegister).toBe(true)
		// The registration's hash is the fuel's hash: one write carries both.
		resolved.onRegistered?.("0xreg")
		const write = writes().at(-1) as { registerTxHash?: string; fuel: { claimTxHash?: string } }
		expect(write.registerTxHash).toBe("0xreg")
		expect(write.fuel.claimTxHash).toBe("0xreg")

		// An amount that covers one ceiling but not both stops before either transaction.
		const refused = await resolve(fueled(SEALED_SALT, { received: "121999999" }), true)
		expect(refused).toEqual({ kind: "stop", stop: "fuel-short-registering" })
	})

	test("on a registered token the claim spends the fuel itself: no registration seams, no credit fee", async () => {
		const resolved = await resolve(fueled(SEALED_SALT), false)
		expect(resolved.opts.fee?.paymentMethod).toEqual({ kind: "private-fpc" })
		expect(resolved.opts.fee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_CLAIM_GAS)
		expect(resolved.opts.registerFee).toBeUndefined()
		expect(resolved.opts.registeredClaimFee).toBeUndefined()
		expect(resolved.fuelOnRegister).toBe(false)
		expect(resolved.onRegistered).toBeUndefined()
	})

	test("spent fuel pays the claim from the FPC credit it left — never re-minted, never public — and only when the credit covers the ceiling", async () => {
		const spent = fueled(SEALED_SALT, { claimAttempt: true, claimTxHash: `0x${"00".repeat(31)}ab`, consumed: true })
		h.privateFj = 41_000_000n
		const resolved = await resolve(spent, false)
		expect(resolved).toMatchObject({ kind: "opts" })
		expect(resolved.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee")).toBe(false)

		h.privateFj = 40_999_999n
		expect(await resolve(spent, false)).toEqual({ kind: "stop", stop: "credit-short" })
		h.privateFj = undefined
		expect(await resolve(spent, false)).toEqual({ kind: "stop", stop: "credit-unreadable" })
	})

	test("spent fuel on a still-unregistered token registers from the credit too: both ceilings, both seams from pay_fee", async () => {
		// A registration that reverted past its setup spent the fuel without binding the token: it is
		// mined like any other transaction, so its receipt reads as spent, never as pending.
		const spent = fueled(SEALED_SALT, { claimAttempt: true, claimTxHash: `0x${"00".repeat(31)}ab` })
		h.receiptStatus = "checkpointed"
		h.privateFj = 122_000_000n
		const resolved = await resolve(spent, true)
		expect(resolved).toMatchObject({ kind: "opts" })
		expect(resolved.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(resolved.opts.registerFee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(resolved.opts.registerFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_REGISTER_GAS)
		expect(resolved.opts.registeredClaimFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_CLAIM_GAS)
		expect(resolved.fuelOnRegister).toBeUndefined()
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee")).toBe(false)

		h.privateFj = 121_999_999n
		expect(await resolve(spent, true)).toEqual({ kind: "stop", stop: "credit-short-registering" })
	})
})

describe("recoverDepositLeg — send records", () => {
	/** The retired router; the generation sends through the deposit router. */
	const ROUTER = "0x1111111111111111111111111111111111111111" as const
	const DEPOSIT_ROUTER = "0x8888888888888888888888888888888888888888" as const
	const generation = {
		router: DEPOSIT_ROUTER,
		permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
		factory: "0x3333333333333333333333333333333333333333",
		implementation: "0x2222222222222222222222222222222222222222",
		feeJuicePortal: "0x4444444444444444444444444444444444444444",
		feeAsset: "0x5555555555555555555555555555555555555555",
		chainId: 31337,
		hub: `0x${"7".padStart(64, "0")}`,
		tokenClassId: `0x${"1".padStart(64, "0")}`,
	} as const
	const reads = { readContract: async () => 0n }
	const zero32 = `0x${"0".repeat(64)}` as const
	const bridgeLog = (emitter: string, index: bigint, logIndex: number) => ({
		address: emitter,
		logIndex,
		topics: [keccak256(toHex("Bridge(bytes32,bytes32,uint256,uint256,bytes32,bool)")), zero32],
		data: encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bool" }],
			[`0x${"b".repeat(64)}`, index, 5n, zero32, false],
		),
		blockNumber: 1n,
		blockHash: zero32,
		transactionHash: zero32,
		transactionIndex: 0,
		removed: false,
	})
	const record = {
		id: "send-1",
		schema: 3,
		direction: "deposit",
		intent: "token",
		depositTxHash: zero32,
		chainId: 31337,
		isPrivate: false,
		recipient: RECIPIENT,
		secretHashHex: `0x${"d".repeat(64)}`,
		token: { erc20: "0x9999999999999999999999999999999999999999" },
	} as unknown as DepositRecord
	const recover = (rec: DepositRecord, client: unknown) => recoverDepositLeg(env(), rec, client as never, generation as never, [ROUTER])

	test("a deposit-router send's leaves come from its authenticated Deposited, checked against the record's own facts", async () => {
		const client = { ...reads, getTransactionReceipt: async () => ({ status: "success", logs: [{ address: DEPOSIT_ROUTER }] }) }
		h.depositLeaves = { tokenLeafIndex: 7n, tokenMessageHashHex: `0x${"e".repeat(64)}` }
		await expect(recover(record, client)).resolves.toBe("recovered")
		expect(h.calls.find(([n]) => n === "readSendReceiptLeaves")?.[1]).toEqual({
			router: DEPOSIT_ROUTER,
			inbox: { fromFactory: generation.factory },
			expected: {
				l1ChainId: 31337,
				isPrivate: false,
				recipient: RECIPIENT,
				token: { erc20: "0x9999999999999999999999999999999999999999", secretHash: `0x${"d".repeat(64)}` },
			},
		})
		expect(h.calls.at(-1)).toEqual(["write", { id: "send-1", patch: { leafIndex: "7", messageHash: `0x${"e".repeat(64)}` } }])
		// A receipt that does not authenticate is never recovered.
		h.depositLeaves = new Error("no Deposited for this record")
		await expect(recover(record, client)).rejects.toThrow(/no Deposited/)
	})

	test("a retired router's send reads that router's own event, not the first Inbox leaf", async () => {
		const client = {
			...reads,
			getTransactionReceipt: async () => ({
				status: "success",
				// A first deposit's receipt: a foreign same-signature log first, then the router's.
				logs: [bridgeLog("0x00000000000000000000000000000000000e2c20", 999n, 0), bridgeLog(ROUTER, 41n, 1)],
			}),
		}
		await expect(recover(record, client)).resolves.toBe("recovered")
		expect(h.calls.some(([n]) => n === "readSendReceiptLeaves")).toBe(false)
		expect(h.calls.at(-1)).toEqual(["write", { id: "send-1", patch: { leafIndex: "41", messageHash: `0x${"b".repeat(64)}` } }])
	})

	test("a fueled send whose fuel block was swapped out meanwhile is a fault, never 'recovered'", async () => {
		const fuelLog = {
			...bridgeLog(ROUTER, 41n, 0),
			topics: [
				keccak256(toHex("BridgeWithFuel(bytes32,bytes32,uint256,uint256,bytes32,bytes32,uint256,uint256,bytes32,bool)")),
				zero32,
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
				[`0x${"b".repeat(64)}`, 41n, 5n, zero32, `0x${"c".repeat(64)}`, 42n, 7n, zero32, false],
			),
		}
		const client = { ...reads, getTransactionReceipt: async () => ({ status: "success", logs: [fuelLog] }) }
		const fueled = { ...record, intent: "token+gas", fuel: FUEL } as unknown as DepositRecord
		h.persisted = { fuel: { ...FUEL, secretHashHex: "0xanother-deposit" } }
		await expect(recover(fueled, client)).rejects.toMatchObject({ stop: "record-changed" })
		expect(writes()).toHaveLength(0)
		h.persisted = fueled
		await expect(recover(fueled, client)).resolves.toBe("recovered")
	})

	test("a send record without a generation recovers only through a retired router", async () => {
		const client = { ...reads, getTransactionReceipt: async () => ({ status: "success", logs: [] }) }
		await expect(recoverDepositLeg(env(), record, client, undefined, [])).rejects.toMatchObject({ stop: "no-bridge" })
	})
})

describe("own gas - a claim with no Fee Juice message of its own pays from the private balance at the FPC, and names it", () => {
	type Fee = { paymentMethod: unknown; gasSettings: { gasLimits: { daGas: number; l2Gas: number } } }
	type Resolved = { kind: string; stop?: FeeStop; opts: Record<string, Fee | undefined> }
	const noFuel = (isPrivate: boolean): Rec => mkRec({ schema: 3, intent: "token", isPrivate, fuel: undefined })
	const resolve = (rec: Rec, registers: boolean) =>
		resolveHubClaimSendOpts(env(), {
			rec,
			recipientAddr: recipient,
			aztec: wallet(),
			userOverride: false,
			registers,
		}) as Promise<Resolved>

	// Fees 10/20: a public claim's ceiling 3M·20 + 100k·10 = 61M, a registering one 3.5M·20 + 100k·10 = 71M;
	// a private claim 41M, a private registration 81M.
	test("a public claim pays through the FPC at the public claim's ceiling, sized for a registration when the hub does not know the token", async () => {
		h.privateFj = 61_000_000n
		const plain = await resolve(noFuel(false), false)
		expect(plain.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(plain.opts.fee?.gasSettings.gasLimits).toMatchObject(PUBLIC_HUB_CLAIM_GAS)
		expect(plain.opts.registerFee).toBeUndefined()
		// Registering costs more, in the same one transaction: under its ceiling the claim stops before the FPC refuses.
		expect(await resolve(noFuel(false), true)).toEqual({ kind: "stop", stop: "own-gas-short" })
		h.privateFj = 71_000_000n
		const registering = await resolve(noFuel(false), true)
		expect(registering.opts.fee?.gasSettings.gasLimits).toMatchObject(PUBLIC_HUB_REGISTER_CLAIM_GAS)
		expect(registering.opts.registerFee).toBeUndefined()
	})

	test("a private first-time token registers first, both transactions from the balance, refused unless it covers both", async () => {
		h.privateFj = 122_000_000n
		const r = await resolve(noFuel(true), true)
		expect(r.opts.registerFee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(r.opts.registerFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_REGISTER_GAS)
		expect(r.opts.registeredClaimFee?.gasSettings.gasLimits).toMatchObject(PRIVATE_HUB_CLAIM_GAS)
		expect(r.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		h.privateFj = 121_999_999n
		expect(await resolve(noFuel(true), true)).toEqual({ kind: "stop", stop: "private-own-gas-short" })
	})

	test("nothing held stops, and an unreadable balance stops as unread rather than as empty - never a payerless claim", async () => {
		h.privateFj = 0n
		expect(await resolve(noFuel(false), false)).toEqual({ kind: "stop", stop: "own-gas-none" })
		h.privateFj = undefined
		expect(await resolve(noFuel(false), false)).toEqual({ kind: "stop", stop: "own-gas-unverifiable" })
		expect(h.calls.some(([n]) => n === "privateFeeJuicePayment" || n === "selfPaidFeeJuicePayment")).toBe(false)
	})

	test("on a wallet that routes a dApp-named payer, public Fee Juice covering the ceiling pays a public claim as the account itself, capped at the predicted fees", async () => {
		h.selfPay = true
		h.publicFj = 61_000_000n
		h.privateFj = 0n
		const r = await resolve(noFuel(false), false)
		expect(r.opts.fee?.paymentMethod).toEqual({ kind: "self-paid-fj" })
		expect(r.opts.fee?.gasSettings).toEqual({ maxFeesPerGas: { feePerDaGas: 10n, feePerL2Gas: 20n } })
		expect(h.calls.find(([n]) => n === "selfPaidFeeJuicePayment")?.[1]).toEqual({ payer: RECIPIENT })
		expect(h.calls.some(([n]) => n === "readPublicFeeJuice")).toBe(true)
	})

	test("a private record pays only from its private balance: public Fee Juice never pays it, and the stop says why", async () => {
		h.selfPay = true
		h.publicFj = 999_000_000n
		h.privateFj = 41_000_000n
		expect((await resolve(noFuel(true), false)).opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		h.privateFj = 40_999_999n
		expect(await resolve(noFuel(true), false)).toEqual({ kind: "stop", stop: "private-own-gas-short" })
		h.privateFj = 0n
		expect(await resolve(noFuel(true), false)).toEqual({ kind: "stop", stop: "private-own-gas-none" })
		expect(h.calls.some(([n]) => n === "selfPaidFeeJuicePayment")).toBe(false)
		expect(
			h.calls.some(([n]) => n === "readPublicFeeJuice"),
			"a private record never reads public Fee Juice",
		).toBe(false)
	})

	test("a wallet that cannot route a public payer never gets one, whatever the public balance", async () => {
		h.selfPay = false
		h.publicFj = 999_000_000n
		h.privateFj = 0n
		expect(await resolve(noFuel(false), false)).toEqual({ kind: "stop", stop: "own-gas-none" })
		expect(h.calls.some(([n]) => n === "selfPaidFeeJuicePayment")).toBe(false)
	})
})

describe("standalone gas claim — a consumed-shaped refusal settles only on the CHECKPOINTED nullifier", () => {
	const MESSAGE = `0x00${"7d".repeat(31)}`
	const fuel = (): DepositFuelBlock => ({ ...FUEL, messageHash: MESSAGE, received: "10", leafIndex: "3" })
	const latched = () => writes().some((p) => p.fuel?.standaloneClaimed === true)
	const quick = { tries: 2, pollMs: 0, readMs: 20 }
	const claim = (f = fuel()) => sendStandaloneFjClaim(env(), {}, recipient, f, "0xspec1", quick)

	test("the read is the fuel message's own nullifier at the checkpointed floor", async () => {
		h.sendThrows = "L1-to-L2 message is already nullified"
		h.witness = [{ leafIndex: 1n }]
		await claim()
		expect(latched()).toBe(true)
		const expected = (await feeJuiceMessageNullifier({ messageHash: MESSAGE, secret: FUEL.secret as string })).toString()
		expect(h.calls.find(([n]) => n === "witness")?.[1]).toEqual({ tag: "checkpointed", nullifier: expected })
	})

	test("a checkpoint that lands during the poll latches; one that never lands leaves the affordance", async () => {
		h.sendThrows = "L1-to-L2 message is already nullified"
		h.witness = [undefined, { leafIndex: 1n }]
		await claim()
		expect(latched()).toBe(true)
		h.calls.length = 0
		h.witness = [undefined]
		expect(await stopOf(claim())).toBe("consumed-unconfirmed")
		expect(h.calls.filter(([n]) => n === "witness")).toHaveLength(2)
		expect(latched()).toBe(false)
	})

	test("a node that cannot or never answers, or a record without its message key, leaves the affordance", async () => {
		h.sendThrows = "message has already been nullified"
		h.witness = ["throw"]
		expect(await stopOf(claim())).toBe("consumed-unreadable")
		h.witness = ["hang"]
		expect(await stopOf(claim())).toBe("consumed-unreadable")
		h.witness = [{ leafIndex: 1n }]
		expect(await stopOf(claim({ ...fuel(), messageHash: undefined }))).toBe("consumed-unreadable")
		expect(latched()).toBe(false)
	})

	test("any other refusal is the caller's, unchanged", async () => {
		h.sendThrows = "Amount too low to cover gas cost"
		await expect(claim()).rejects.toThrow(/too low/)
		expect(latched()).toBe(false)
	})
})
