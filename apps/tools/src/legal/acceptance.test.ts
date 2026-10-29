import { PRIVACY, TERMS } from "@unleashed/legal"
import { type EIP1193Provider, type Hex, hexToString } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it, vi } from "vitest"
import { isUserRejection } from "@/lib/wallet-errors"
import {
	ACCEPTANCE_KEY,
	type AcceptanceRecord,
	acceptanceMessage,
	DIGESTS,
	type GetStorage,
	readAcceptance,
	recordAcceptance,
	signAcceptance,
	signFailure,
} from "./acceptance"

const SITE = "https://app.unleashed.systems"
const alice = privateKeyToAccount(`0x${"11".repeat(32)}`)
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`)

function storage(initial?: string) {
	const store = new Map<string, string>(initial === undefined ? [] : [[ACCEPTANCE_KEY, initial]])
	const get: GetStorage = () => ({
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => void store.set(k, v),
	})
	return { get, store }
}

async function signedRecord(origin = SITE): Promise<AcceptanceRecord> {
	const signature = await alice.signMessage({ message: acceptanceMessage(origin, alice.address) })
	return { v: 1, account: alice.address, signature, terms: DIGESTS.terms, privacy: DIGESTS.privacy }
}

const read = (value: unknown, origin = SITE) => readAcceptance(storage(JSON.stringify(value)).get, origin)

type Answer = (params: unknown) => unknown
function wallet(answers: Partial<Record<"eth_requestAccounts" | "personal_sign", Answer>> = {}) {
	const calls: string[] = []
	const defaults: Record<string, Answer> = {
		eth_requestAccounts: () => [alice.address.toLowerCase()],
		personal_sign: (params) => alice.signMessage({ message: { raw: (params as [Hex])[0] } }),
	}
	const provider = {
		request: async ({ method, params }: { method: string; params?: unknown }) => {
			calls.push(method)
			const answer = answers[method as keyof typeof answers] ?? defaults[method]
			if (!answer) throw new Error(`unexpected ${method}`)
			return answer(params)
		},
	} as unknown as EIP1193Provider
	return { provider, calls }
}

const rejected = (code: number) => () => {
	throw Object.assign(new Error("wallet error"), { code })
}

describe("acceptanceMessage", () => {
	const text = acceptanceMessage(SITE, alice.address)

	it("is the signed G2 text, filled from the documents", () => {
		expect(text).toBe(
			[
				"Unleashed: accept the Terms of Use",
				"",
				"I agree to the Unleashed Terms of Use, and I have read the Privacy Policy.",
				"",
				`Terms of Use, updated ${TERMS.updated}`,
				"https://unleashed.systems/terms",
				`Version ${DIGESTS.terms}`,
				"",
				`Privacy Policy, updated ${PRIVACY.updated}`,
				"https://unleashed.systems/privacy",
				`Version ${DIGESTS.privacy}`,
				"",
				`Site: ${SITE}`,
				`Account: ${alice.address}`,
				"",
				"Signing is free. It is not a transaction and moves no funds.",
			].join("\n"),
		)
	})

	it("is printable ASCII and never opens as an EIP-4361 sign-in", () => {
		const printable = (s: string) => /^[\x20-\x7e\n]*$/.test(s)
		expect(printable(text)).toBe(true)
		expect(printable(`${text}é`)).toBe(false)
		const signIn = /^\S+ wants you to sign in with your Ethereum account:$/
		expect(signIn.test(text.split("\n")[0])).toBe(false)
		expect(signIn.test("app.unleashed.systems wants you to sign in with your Ethereum account:")).toBe(true)
	})

	it("names each document by its own 32-byte digest", () => {
		expect(DIGESTS.terms).toMatch(/^0x[0-9a-f]{64}$/)
		expect(DIGESTS.terms).not.toBe(DIGESTS.privacy)
	})
})

describe("readAcceptance", () => {
	it("accepts a signed record for this site and these versions, and nothing else", async () => {
		const record = await signedRecord()
		expect(await read(record)).toBe("accepted")
		expect(await readAcceptance(storage().get, SITE)).toBe("none")
		expect(await read(record, "https://unleashed-mainnet.example")).toBe("none")
		expect(await read({ ...record, account: bob.address })).toBe("none")
		const other = await bob.signMessage({ message: acceptanceMessage(SITE, alice.address) })
		expect(await read({ ...record, signature: other })).toBe("none")
	})

	it("reads an old digest as changed, and an old signature relabelled as current as none", async () => {
		const record = await signedRecord()
		const old = `0x${"ab".repeat(32)}` as Hex
		expect(await read({ ...record, terms: old })).toBe("changed")
		expect(await read({ ...record, privacy: old })).toBe("changed")
		const oldText = acceptanceMessage(SITE, alice.address).replace(DIGESTS.terms, old)
		const oldSignature = await alice.signMessage({ message: oldText })
		expect(await read({ ...record, signature: oldSignature })).toBe("none")
	})

	it("reads every malformed record or failing storage as none", async () => {
		const record = await signedRecord()
		for (const bad of [
			null,
			[record],
			"accepted",
			{ ...record, v: 2 },
			{ ...record, account: 7 },
			{ ...record, signature: "0x1234" },
			{ ...record, terms: DIGESTS.terms.slice(0, 40) },
			{ ...record, privacy: DIGESTS.privacy.toUpperCase().replace("0X", "0x") },
		]) {
			expect(await read(bad)).toBe("none")
		}
		expect(await readAcceptance(storage("{not json").get, SITE)).toBe("none")
		const throwsOnRead: GetStorage = () => ({
			getItem: () => {
				throw new Error("SecurityError")
			},
			setItem: () => {},
		})
		expect(await readAcceptance(throwsOnRead, SITE)).toBe("none")
		const noStorage: GetStorage = () => {
			throw new Error("SecurityError")
		}
		expect(await readAcceptance(noStorage, SITE)).toBe("none")
	})
})

describe("readAcceptance with a slow verifier", () => {
	it("counts only an awaited true", async () => {
		const record = await signedRecord()
		const viem = await import("viem")
		for (const [answer, expected] of [
			[() => new Promise((r) => setTimeout(() => r(false), 20)), "none"],
			[() => Promise.reject(new Error("invalid signature length")), "none"],
			[() => new Promise((r) => setTimeout(() => r(true), 20)), "accepted"],
		] as const) {
			vi.resetModules()
			vi.doMock("viem", () => ({ ...viem, verifyMessage: answer }))
			const fresh = await import("./acceptance")
			expect(await fresh.readAcceptance(storage(JSON.stringify(record)).get, SITE)).toBe(expected)
		}
		vi.doUnmock("viem")
		vi.resetModules()
	})
})

describe("signAcceptance", () => {
	it("returns a checksummed record that reads as accepted", async () => {
		const { provider, calls } = wallet()
		const record = await signAcceptance(provider, SITE)
		expect(calls).toEqual(["eth_requestAccounts", "personal_sign"])
		expect(record.account).toBe(alice.address)
		const { get } = storage()
		recordAcceptance(get, record)
		expect(await readAcceptance(get, SITE)).toBe("accepted")
	})

	it("asks the wallet to sign the exact text", async () => {
		let signed = ""
		const { provider } = wallet({
			personal_sign: (params) => {
				signed = hexToString((params as [Hex])[0])
				return alice.signMessage({ message: signed })
			},
		})
		await signAcceptance(provider, SITE)
		expect(signed).toBe(acceptanceMessage(SITE, alice.address))
	})

	it("refuses a signature from another account, and an empty account list", async () => {
		const switched = wallet({ personal_sign: (params) => bob.signMessage({ message: { raw: (params as [Hex])[0] } }) })
		await expect(signAcceptance(switched.provider, SITE)).rejects.toThrow("does not verify")
		await expect(signAcceptance(wallet({ personal_sign: () => "0xdead" }).provider, SITE)).rejects.toThrow()
		await expect(signAcceptance(wallet({ eth_requestAccounts: () => [] }).provider, SITE)).rejects.toThrow("no account")
	})

	it("passes the wallet's refusals and pending requests through for signFailure", async () => {
		for (const method of ["eth_requestAccounts", "personal_sign"] as const) {
			const error = await signAcceptance(wallet({ [method]: rejected(4001) }).provider, SITE).catch((e) => e)
			expect(isUserRejection(error)).toBe(true)
			expect(signFailure(error)).toBe("refused")
		}
		const pending = await signAcceptance(wallet({ eth_requestAccounts: rejected(-32002) }).provider, SITE).catch((e) => e)
		expect(signFailure(pending)).toBe("busy")
		expect(signFailure(new Error("does not verify"))).toBe("failed")
	})
})

describe("recordAcceptance", () => {
	it("stores the record, and swallows a storage that cannot write", async () => {
		const record = await signedRecord()
		const { get, store } = storage()
		recordAcceptance(get, record)
		expect(JSON.parse(store.get(ACCEPTANCE_KEY) ?? "null")).toEqual(record)
		const full: GetStorage = () => ({
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError")
			},
		})
		expect(() => recordAcceptance(full, record)).not.toThrow()
	})
})
