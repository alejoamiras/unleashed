// @vitest-environment node
/**
 * Specification pins for deposit-flow.ts: secret-derivation math, both fee multipliers, the
 * fee-juice builder's latch callbacks, and the send leg's receipt recovery.
 */

const storageBacking = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
	getItem: (k: string) => storageBacking.get(k) ?? null,
	setItem: (k: string, v: string) => void storageBacking.set(k, String(v)),
	removeItem: (k: string) => void storageBacking.delete(k),
	clear: () => void storageBacking.clear(),
	key: (i: number) => [...storageBacking.keys()][i] ?? null,
	get length() {
		return storageBacking.size
	},
}

import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { GasFees } from "@aztec-labs/stdlib/gas"
import {
	type DepositJournalRecord,
	deriveBridgeSecret,
	deriveTokenClaimSecret,
	type SendDepositRecord,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	PUBLIC_HUB_CLAIM_GAS,
	PUBLIC_HUB_REGISTER_CLAIM_GAS,
} from "@unleashed/bridge-core"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import { beforeEach, describe, expect, test, vi } from "vitest"

const h = vi.hoisted(() => {
	const calls: Array<[string, unknown]> = []
	return {
		calls,
		t: (n: string, d?: unknown) => void calls.push([n, d]),
		updateRecordThrows: false,
		/** What the node answers for a claim hash's receipt; unset = throws (unreachable). */
		receiptStatus: undefined as string | undefined,
		/** The PERSISTED record `currentRecord` answers with; undefined = nothing in the journal. */
		persisted: undefined as unknown,
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
	}
})

vi.mock("@/contracts/bridge-generation", () => ({
	FUEL_MIN_FJ: 1000n,
	FUEL: undefined,
	LEGACY_ROUTERS: [],
}))

// The Fee Juice balances as the wallet's reads answer them; a throw = unreadable.
vi.mock("./useTokenBalance", () => ({
	readBalance: async (_aztec: unknown, _contract: unknown, fn: string) => {
		const balance = fn === "balance_of_public" ? h.publicFj : h.privateFj
		if (balance === undefined) throw new Error(`${fn} failed`)
		return balance
	},
}))
vi.mock("@/lib/wallet-features", () => ({
	DAPP_SELF_PAY_FEATURE: "dapp-self-pay",
	walletSupports: async () => h.selfPay,
}))
vi.mock("@unleashed/bridge-core/private-fpc-artifact", () => ({ PrivateFPCContractArtifact: {} }))
vi.mock("@aztec-labs/aztec.js/contracts", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aztec-labs/aztec.js/contracts")>()),
	Contract: { at: async () => ({}) },
}))

vi.mock("./useBridgeJournal", async (importOriginal) => {
	const real = (await importOriginal()) as typeof import("./useBridgeJournal")
	return {
		...real,
		updateRecord: (id: string, patch: unknown) => {
			if (h.updateRecordThrows) throw new Error("storage full")
			h.t("updateRecord", { id, patch })
		},
		currentRecord: () => h.persisted,
		updateRecordWhen: (id: string, when: (r: unknown) => boolean, patch: unknown) => {
			if (h.updateRecordThrows) throw new Error("storage full")
			// A missing fixture stands for a record without a fuel block, so the captured fallback is exercised.
			const live = h.persisted ?? { id }
			if (!when(live)) return undefined
			const fields = typeof patch === "function" ? patch(live) : patch
			h.t("updateRecord", { id, patch: fields })
			return { ...(live as object), ...(fields as object) }
		},
		discard: (id: string) => h.t("discard", id),
		flagRecordError: (id: string, msg: string) => h.t("flagRecordError", { id, msg }),
	}
})

vi.mock("./fuelClaim", () => ({
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

vi.mock("@aztec-labs/aztec.js/node", () => ({
	createAztecNodeClient: () => ({
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
	}),
}))

// Only the Wonderland payment method is faked, so the salt the private claim actually pays with is
// observable; every derivation around it stays real.
vi.mock("@unleashed/bridge-core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@unleashed/bridge-core")>()),
	privateMintAndPayFee: (_fpc: unknown, amount: bigint, secret: { toString(): string }, salt: { toString(): string }) => {
		h.t("privateMintAndPayFee", { amount, secret: secret.toString(), salt: salt.toString() })
		return { kind: "private-fpc" }
	},
	privateFeeJuicePayment: (fpc: { toString(): string }) => {
		h.t("privateFeeJuicePayment", { fpc: fpc.toString() })
		return { kind: "fpc-credit" }
	},
	selfPaidFeeJuicePayment: (payer: { toString(): string }) => {
		h.t("selfPaidFeeJuicePayment", { payer: payer.toString() })
		return { kind: "self-paid-fj" }
	},
	// The deposit router's receipt is authenticated in bridge-core; here only what the recovery hands it.
	readSendInbox: async (_pub: unknown, g: { factory: string }) => ({ fromFactory: g.factory }),
	readSendReceiptLeaves: async (g: { router: string }, inbox: unknown, expected: unknown) => {
		h.t("readSendReceiptLeaves", { router: g.router, inbox, expected })
		if (h.depositLeaves instanceof Error) throw h.depositLeaves
		return h.depositLeaves
	},
}))

import { feeJuiceMessageNullifier } from "@/lib/message-nullifier"
import {
	buildFeeJuiceClaimDep,
	patchFuel,
	recoverDepositLeg,
	resolveHubClaimSendOpts,
	resolvePrivateFuelFee,
	sendStandaloneFjClaim,
} from "./deposit-flow"

const RECIPIENT = "0x1018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d"

function mkRec(over: Partial<DepositJournalRecord> = {}): DepositJournalRecord {
	return {
		schema: 1,
		id: "0xspec1",
		direction: "deposit",
		isPrivate: false,
		amount: "900",
		createdAt: 1,
		updatedAt: 1,
		chainId: 11155111,
		portal: "0x00000000000000000000000000000000000000bb",
		bridge: "0x2018808f2c17794badb361c02c945582b8198b495a7e8d01154f7eeb7d719c0d",
		recipient: RECIPIENT,
		secret: "0xsecret",
		secretHashHex: "0xspec1",
		fuel: { amount: "10", secret: "0xf", secretHashHex: "0xfh", minOutput: "9" },
		...over,
	} as DepositJournalRecord
}

beforeEach(() => {
	h.calls.length = 0
	h.updateRecordThrows = false
	h.receiptStatus = undefined
	h.publicFj = undefined
	h.selfPay = false
	h.persisted = undefined
	h.sendThrows = undefined
	h.witness = []
	vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000)
})

describe("secret-derivation conservation", () => {
	test("the private token commit hashes the DERIVED secret, never the raw salt", async () => {
		const salt = new Fr(0x5555n)
		const recipient = AztecAddress.fromStringUnsafe(RECIPIENT)
		const derived = deriveTokenClaimSecret(salt, recipient)
		const committed = await computeSecretHash(derived)
		const rawCommitted = await computeSecretHash(salt)
		expect(derived.toString()).not.toBe(salt.toString())
		expect(committed.toString()).not.toBe(rawCommitted.toString())
	})

	test("the private fuel secret is claimer-committed (recipient-bound, salt-recoverable)", () => {
		const salt = new Fr(0x8888n)
		const a = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(RECIPIENT))
		const b = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(RECIPIENT))
		const other = deriveBridgeSecret(salt, AztecAddress.fromStringUnsafe(`0x2018${RECIPIENT.slice(6)}`))
		expect(a.toString()).toBe(b.toString())
		expect(a.toString()).not.toBe(other.toString())
	})
})

describe("fee-juice claim builder", () => {
	test("gets RAW predicted-worst fees (no padding) and per-privacy claim material", async () => {
		await buildFeeJuiceClaimDep(mkRec({ isPrivate: false }), "0xsecrethex", undefined, {})
		await buildFeeJuiceClaimDep(mkRec({ isPrivate: true }), "0xsecrethex", { salt: "0xenvsalt" }, {})
		const [pub, priv] = h.calls.filter(([n]) => n === "builderOpts").map(([, d]) => d as Record<string, unknown>)
		expect((pub.maxFeesPerGas as { feePerDaGas: bigint }).feePerDaGas).toBe(10n)
		expect((pub.maxFeesPerGas as { feePerL2Gas: bigint }).feePerL2Gas).toBe(20n)
		expect(pub.resolvedSecret).toBe("0xsecrethex")
		expect(pub.resolvedSalt).toBeUndefined()
		expect(priv.resolvedSalt).toBe("0xenvsalt")
		expect(priv.resolvedSecret).toBeUndefined()
	})

	test("latch callbacks write journal-first shapes and insufficiency separately", async () => {
		await buildFeeJuiceClaimDep(mkRec(), "0xs", undefined, {})
		const opts = h.calls.find(([n]) => n === "builderOpts")?.[1] as {
			onAttempt: () => void
			onTxHash: (tx: string) => void
			onSetupInsufficiency: () => void
		}
		opts.onAttempt()
		opts.onTxHash("0xtx")
		opts.onSetupInsufficiency()
		const patches = h.calls.filter(([n]) => n === "updateRecord").map(([, d]) => (d as { patch: { fuel: unknown } }).patch.fuel)
		expect(patches[0]).toMatchObject({ claimAttempt: true, claimAttemptAt: 1_700_000_000_000, setupInsufficiency: false })
		expect(patches[1]).toMatchObject({ claimAttempt: true, claimTxHash: "0xtx" })
		expect(patches[2]).toMatchObject({ setupInsufficiency: true })
	})
})

describe("fee-juice claim builder — a prior claim on the PERSISTED block gates the rebuild", () => {
	// A field-sized hash: the well-formedness check is 64 hex digits AND the TxHash parser.
	const HASH = `0x${"00".repeat(31)}ab`
	const built = () => h.calls.some(([n]) => n === "builderOpts")
	const stopWhy = async (rec: DepositJournalRecord) => {
		const dep = await buildFeeJuiceClaimDep(rec, "0xs", undefined, {})
		return dep.simulate().then(
			() => undefined,
			(e: Error) => e.message,
		)
	}

	test("a consumed block never rebuilds", async () => {
		expect(await stopWhy(mkRec({ fuel: { ...mkRec().fuel, consumed: true } as never }))).toMatch(/already included/)
		expect(built()).toBe(false)
	})

	test("an included prior claim stops; a dropped one rebuilds; a pending or unreachable one waits", async () => {
		const withHash = mkRec({ fuel: { ...mkRec().fuel, claimTxHash: HASH } as never })
		h.receiptStatus = "success"
		expect(await stopWhy(withHash)).toMatch(/already included/)
		h.receiptStatus = "pending"
		expect(await stopWhy(withHash)).toMatch(/still pending/)
		h.receiptStatus = undefined
		expect(await stopWhy(withHash)).toMatch(/still pending/)
		expect(built()).toBe(false)
		h.receiptStatus = "dropped"
		expect(await stopWhy(withHash)).toBeUndefined()
		expect(built()).toBe(true)
	})

	test("a malformed persisted hash is a record fault, not a receipt to wait on", async () => {
		expect(await stopWhy(mkRec({ fuel: { ...mkRec().fuel, claimTxHash: "0xnothex" } as never }))).toMatch(/malformed/)
		expect(built()).toBe(false)
	})

	test("a patch computed for a fuel block the journal has since swapped out is refused", () => {
		h.persisted = mkRec({ fuel: { ...mkRec().fuel, secretHashHex: "0xanother-deposit" } as never })
		expect(patchFuel("0xspec1", mkRec().fuel, { consumed: true })).toBe(false)
		expect(h.calls.some(([n]) => n === "updateRecord")).toBe(false)
		// A block that has since learnt its message key is still the same block; a different key is not.
		h.persisted = mkRec({ fuel: { ...mkRec().fuel, messageHash: "0xkey-a", leafIndex: "7" } as never })
		expect(patchFuel("0xspec1", mkRec().fuel, { consumed: true })).toBe(true)
		expect(patchFuel("0xspec1", { ...mkRec().fuel, messageHash: "0xkey-b" } as never, { consumed: true })).toBe(false)
		// A record without a fuel block falls back to the captured one; nothing captured, nothing to merge.
		h.persisted = mkRec({ fuel: undefined })
		expect(patchFuel("0xspec1", mkRec().fuel, { consumed: true })).toBe(true)
		expect(patchFuel("0xspec1", undefined, { consumed: true })).toBe(false)
	})

	test("the gate reads the PERSISTED block over the captured one, and latches merge into it", async () => {
		// The captured record has no prior claim; the journal holds one that dropped, plus a field the
		// captured copy never saw. The latch must carry that field, not overwrite it from the copy.
		h.persisted = mkRec({ fuel: { ...mkRec().fuel, claimTxHash: HASH, leafIndex: "7" } as never })
		h.receiptStatus = "dropped"
		await buildFeeJuiceClaimDep(mkRec(), "0xs", undefined, {})
		expect(built()).toBe(true)
		const opts = h.calls.find(([n]) => n === "builderOpts")?.[1] as { onAttempt: () => void }
		opts.onAttempt()
		const patch = h.calls
			.filter(([n]) => n === "updateRecord")
			.map(([, d]) => (d as { patch: { fuel: unknown } }).patch.fuel)
			.at(-1)
		expect(patch).toMatchObject({ leafIndex: "7", claimTxHash: HASH, claimAttempt: true })
	})
})

describe("private fuel fee — the sealed salt is authoritative", () => {
	const SEALED_SALT = new Fr(0x5eaedn).toString()
	const TAMPERED_SALT = new Fr(0xbadn).toString()
	const recipient = AztecAddress.fromStringUnsafe(RECIPIENT)

	const fueled = (bridgeSecretSalt: string): SendDepositRecord =>
		mkRec({
			schema: 3,
			intent: "token+gas",
			isPrivate: true,
			secret: undefined,
			fuel: {
				amount: "10",
				secret: "0xf",
				secretHashHex: "0xfh",
				minOutput: "9",
				received: "100000000",
				leafIndex: "8",
				bridgeSecretSalt,
			},
		} as never) as unknown as SendDepositRecord

	const paidWith = () => h.calls.find(([n]) => n === "privateMintAndPayFee")?.[1] as { secret: string; salt: string }

	test("a rewritten journal salt loses to the envelope's, and the record is corrected", async () => {
		const fee = await resolvePrivateFuelFee(fueled(TAMPERED_SALT), recipient, SEALED_SALT)

		expect(fee.kind).toBe("fee")
		expect(paidWith().salt).toBe(SEALED_SALT)
		expect(paidWith().secret).toBe(deriveBridgeSecret(Fr.fromString(SEALED_SALT), recipient).toString())
		// The record is rewritten from the sealed copy, so the next retry no longer disagrees.
		const patches = h.calls
			.filter(([n]) => n === "updateRecord")
			.map(([, d]) => (d as { patch: { fuel: { bridgeSecretSalt: string } } }).patch)
		expect(patches.at(0)?.fuel.bridgeSecretSalt).toBe(SEALED_SALT)
		expect((fee as { fuel: { bridgeSecretSalt: string } }).fuel.bridgeSecretSalt).toBe(SEALED_SALT)
	})

	test("an agreeing journal salt is left alone - no rewrite, same claim", async () => {
		const fee = await resolvePrivateFuelFee(fueled(SEALED_SALT), recipient, SEALED_SALT)

		expect(fee.kind).toBe("fee")
		expect(paidWith().salt).toBe(SEALED_SALT)
		expect(h.calls.filter(([n]) => n === "updateRecord")).toHaveLength(0)
	})

	test("with no envelope opened the journal copy still drives the claim", async () => {
		await resolvePrivateFuelFee(fueled(TAMPERED_SALT), recipient)
		expect(paidWith().salt).toBe(TAMPERED_SALT)
	})

	test("the FPC claim declares explicit gas limits with the raw predicted-worst fees (no padding)", async () => {
		// Without limits the wallet declares the network's per-tx maximum and the FPC's ceiling
		// (limits × fees) outgrows any realistic fuel slice.
		const fee = await resolvePrivateFuelFee(fueled(SEALED_SALT), recipient, SEALED_SALT)
		const gas = (
			fee as { fee: { gasSettings: { gasLimits: { daGas: number; l2Gas: number }; maxFeesPerGas: { feePerL2Gas: bigint } } } }
		).fee.gasSettings
		expect({ daGas: gas.gasLimits.daGas, l2Gas: gas.gasLimits.l2Gas }).toEqual(PRIVATE_HUB_CLAIM_GAS)
		expect(gas.maxFeesPerGas.feePerL2Gas).toBe(20n)
	})

	test("a bridged amount under the committed ceiling stops before the FPC can reject it", async () => {
		// Mocked fees 10/20 → ceiling = 2_000_000·20 + 100_000·10 = 41_000_000 FJ-wei.
		const short = fueled(SEALED_SALT)
		short.fuel = { ...(short.fuel as object), received: "40999999" } as never
		const fee = await resolvePrivateFuelFee(short, recipient, SEALED_SALT)
		expect(fee.kind).toBe("stop")
		expect((fee as { why: string }).why).toMatch(/fee ceiling/)
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee")).toBe(false)
	})

	type Resolved = {
		kind: string
		fuelOnRegister?: boolean
		onRegistered?: (h: string) => void
		opts: Record<string, { paymentMethod: unknown; gasSettings: { gasLimits: { daGas: number; l2Gas: number } } } | undefined>
	}
	const resolve = (rec: SendDepositRecord, registers: boolean) =>
		resolveHubClaimSendOpts({
			rec: rec as never,
			recipientAddr: recipient,
			aztec: {},
			userOverride: false,
			sealedSalt: SEALED_SALT,
			registers,
		}) as Promise<Resolved>

	test("on a first-time token the registration spends the fuel, sized for a registration, and the claim after it pays from the FPC credit", async () => {
		// Mocked fees 10/20 → register ceiling 4M·20 + 100k·10 = 81M, claim ceiling 41M: both must fit.
		const rec = fueled(SEALED_SALT)
		rec.fuel = { ...(rec.fuel as object), received: "122000000" } as never
		const resolved = await resolve(rec, true)
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
		const write = h.calls.findLast(([n]) => n === "updateRecord")?.[1] as {
			patch: { registerTxHash?: string; fuel: { claimTxHash?: string } }
		}
		expect(write.patch.registerTxHash).toBe("0xreg")
		expect(write.patch.fuel.claimTxHash).toBe("0xreg")

		// An amount that covers one ceiling but not both stops before either transaction.
		const short = fueled(SEALED_SALT)
		short.fuel = { ...(short.fuel as object), received: "121999999" } as never
		const refused = await resolve(short, true)
		expect(refused.kind).toBe("stop")
		expect((refused as unknown as { why: string }).why).toMatch(/registering the token and claiming it/)
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
		const spent = fueled(SEALED_SALT)
		spent.fuel = { ...(spent.fuel as object), claimAttempt: true, claimTxHash: `0x${"00".repeat(31)}ab`, consumed: true } as never
		h.privateFj = 41_000_000n
		const resolved = await resolve(spent, false)
		expect(resolved).toMatchObject({ kind: "opts" })
		expect(resolved.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(h.calls.some(([n]) => n === "privateMintAndPayFee")).toBe(false)

		h.privateFj = 40_999_999n
		expect((await resolve(spent, false)).kind).toBe("stop")
		h.privateFj = undefined
		const unreadable = await resolve(spent, false)
		expect(unreadable.kind).toBe("stop")
		expect((unreadable as unknown as { why: string }).why).toMatch(/Couldn't check/)
	})

	test("spent fuel on a still-unregistered token registers from the credit too: both ceilings, both seams from pay_fee", async () => {
		// A registration that reverted past its setup spent the fuel without binding the token: it is
		// mined like any other transaction, so its receipt reads as spent, never as pending.
		const spent = fueled(SEALED_SALT)
		spent.fuel = { ...(spent.fuel as object), claimAttempt: true, claimTxHash: `0x${"00".repeat(31)}ab` } as never
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
		const short = await resolve(spent, true)
		expect(short.kind).toBe("stop")
		expect((short as unknown as { why: string }).why).toMatch(/registering the token and claiming it/)
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
	} as unknown as SendDepositRecord

	test("a deposit-router send's leaves come from its authenticated Deposited, checked against the record's own facts", async () => {
		const client = { ...reads, getTransactionReceipt: async () => ({ status: "success", logs: [{ address: DEPOSIT_ROUTER }] }) }
		h.depositLeaves = { tokenLeafIndex: 7n, tokenMessageHashHex: `0x${"e".repeat(64)}` }
		await expect(recoverDepositLeg(record, client, generation as never, [ROUTER])).resolves.toBe("recovered")
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
		expect(h.calls.at(-1)).toEqual(["updateRecord", { id: "send-1", patch: { leafIndex: "7", messageHash: `0x${"e".repeat(64)}` } }])
		// A receipt that does not authenticate is never recovered.
		h.depositLeaves = new Error("no Deposited for this record")
		await expect(recoverDepositLeg(record, client, generation as never, [ROUTER])).rejects.toThrow(/no Deposited/)
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
		await expect(recoverDepositLeg(record, client, generation as never, [ROUTER])).resolves.toBe("recovered")
		expect(h.calls.some(([n]) => n === "readSendReceiptLeaves")).toBe(false)
		expect(h.calls.at(-1)).toEqual(["updateRecord", { id: "send-1", patch: { leafIndex: "41", messageHash: `0x${"b".repeat(64)}` } }])
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
		const fueled = { ...record, intent: "token+gas", fuel: mkRec().fuel } as unknown as SendDepositRecord
		h.persisted = { ...fueled, fuel: { ...mkRec().fuel, secretHashHex: "0xanother-deposit" } }
		await expect(recoverDepositLeg(fueled, client, generation as never, [ROUTER])).rejects.toThrow(/changed while/)
		expect(h.calls.some(([n]) => n === "updateRecord")).toBe(false)
		h.persisted = fueled
		await expect(recoverDepositLeg(fueled, client, generation as never, [ROUTER])).resolves.toBe("recovered")
	})

	test("a send record without a generation recovers only through a retired router", async () => {
		const client = { ...reads, getTransactionReceipt: async () => ({ status: "success", logs: [] }) }
		await expect(recoverDepositLeg(record, client)).rejects.toThrow(/no bridge/)
	})
})

describe("own gas - a claim with no Fee Juice message of its own pays from the private balance at the FPC, and names it", () => {
	const recipient = AztecAddress.fromStringUnsafe(RECIPIENT)
	type Fee = { paymentMethod: unknown; gasSettings: { gasLimits: { daGas: number; l2Gas: number } } }
	type Resolved = { kind: string; why?: string; opts: Record<string, Fee | undefined> }
	const noFuel = (isPrivate: boolean): SendDepositRecord =>
		mkRec({ schema: 3, intent: "token", isPrivate, secret: undefined, fuel: undefined } as never) as unknown as SendDepositRecord
	const resolve = (rec: SendDepositRecord, registers: boolean) =>
		resolveHubClaimSendOpts({
			rec: rec as never,
			recipientAddr: recipient,
			aztec: {},
			userOverride: false,
			registers,
		}) as Promise<Resolved>

	// Mocked fees 10/20: a public claim's ceiling 3M·20 + 100k·10 = 61M, a registering one 3.5M·20 + 100k·10 = 71M;
	// a private claim 41M, a private registration 81M.
	test("a public claim pays through the FPC at the public claim's ceiling, sized for a registration when the hub does not know the token", async () => {
		h.privateFj = 61_000_000n
		const plain = await resolve(noFuel(false), false)
		expect(plain.opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		expect(plain.opts.fee?.gasSettings.gasLimits).toMatchObject(PUBLIC_HUB_CLAIM_GAS)
		expect(plain.opts.registerFee).toBeUndefined()
		// Registering costs more, in the same one transaction: under its ceiling the claim stops before the FPC refuses.
		const short = await resolve(noFuel(false), true)
		expect(short.kind).toBe("stop")
		expect(short.why).toMatch(/gas is under/)
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
		expect((await resolve(noFuel(true), true)).kind).toBe("stop")
	})

	test("nothing held stops, and an unreadable balance stops as unread rather than as empty - never a payerless claim", async () => {
		h.privateFj = 0n
		expect(await resolve(noFuel(false), false)).toMatchObject({ kind: "stop", why: expect.stringMatching(/No gas/) })
		h.privateFj = undefined
		expect(await resolve(noFuel(false), false)).toMatchObject({ kind: "stop", why: expect.stringMatching(/Couldn't check/) })
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
	})

	test("a private record pays only from its private balance: public Fee Juice never pays it, and the stop says why", async () => {
		h.selfPay = true
		h.publicFj = 999_000_000n
		h.privateFj = 41_000_000n
		expect((await resolve(noFuel(true), false)).opts.fee?.paymentMethod).toEqual({ kind: "fpc-credit" })
		h.privateFj = 40_999_999n
		expect(await resolve(noFuel(true), false)).toMatchObject({ kind: "stop", why: expect.stringMatching(/private gas is under/) })
		h.privateFj = 0n
		expect(await resolve(noFuel(true), false)).toMatchObject({
			kind: "stop",
			why: expect.stringMatching(/only from private gas.*link your account/),
		})
		expect(h.calls.some(([n]) => n === "selfPaidFeeJuicePayment")).toBe(false)
	})

	test("a wallet that cannot route a public payer never gets one, whatever the public balance", async () => {
		h.selfPay = false
		h.publicFj = 999_000_000n
		h.privateFj = 0n
		expect(await resolve(noFuel(false), false)).toMatchObject({ kind: "stop", why: expect.stringMatching(/No gas/) })
		expect(h.calls.some(([n]) => n === "selfPaidFeeJuicePayment")).toBe(false)
	})
})

describe("standalone gas claim — a consumed-shaped refusal settles only on the CHECKPOINTED nullifier", () => {
	const MESSAGE = `0x00${"7d".repeat(31)}`
	const fuel = () =>
		({ ...mkRec().fuel, messageHash: MESSAGE, received: "10", leafIndex: "3" }) as NonNullable<DepositJournalRecord["fuel"]>
	const latched = () =>
		h.calls.some(
			([n, d]) =>
				n === "updateRecord" && (d as { patch: { fuel?: { standaloneClaimed?: boolean } } }).patch.fuel?.standaloneClaimed === true,
		)
	const quick = { tries: 2, pollMs: 0, readMs: 20 }
	const claim = (f = fuel()) => sendStandaloneFjClaim({}, AztecAddress.fromStringUnsafe(RECIPIENT), f, "0xspec1", quick)

	test("the read is the fuel message's own nullifier at the checkpointed floor", async () => {
		h.sendThrows = "L1-to-L2 message is already nullified"
		h.witness = [{ leafIndex: 1n }]
		await claim()
		expect(latched()).toBe(true)
		const expected = (await feeJuiceMessageNullifier({ messageHash: MESSAGE, secret: fuel().secret })).toString()
		expect(h.calls.find(([n]) => n === "witness")?.[1]).toEqual({ tag: "checkpointed", nullifier: expected })
	})

	test("a checkpoint that lands during the poll latches; one that never lands leaves the affordance", async () => {
		h.sendThrows = "L1-to-L2 message is already nullified"
		h.witness = [undefined, { leafIndex: 1n }]
		await claim()
		expect(latched()).toBe(true)
		h.calls.length = 0
		h.witness = [undefined]
		await expect(claim()).rejects.toThrow(/could not be confirmed/)
		expect(h.calls.filter(([n]) => n === "witness")).toHaveLength(2)
		expect(latched()).toBe(false)
	})

	test("a node that cannot or never answers, or a record without its message key, leaves the affordance", async () => {
		h.sendThrows = "message has already been nullified"
		h.witness = ["throw"]
		await expect(claim()).rejects.toThrow(/could not be read/)
		h.witness = ["hang"]
		await expect(claim()).rejects.toThrow(/could not be read/)
		h.witness = [{ leafIndex: 1n }]
		await expect(claim({ ...fuel(), messageHash: undefined })).rejects.toThrow(/could not be read/)
		expect(latched()).toBe(false)
	})

	test("any other refusal is the caller's, unchanged", async () => {
		h.sendThrows = "Amount too low to cover gas cost"
		await expect(claim()).rejects.toThrow(/too low/)
		expect(latched()).toBe(false)
	})
})
