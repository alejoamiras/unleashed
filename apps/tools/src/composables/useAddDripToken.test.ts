import { describe, expect, it } from "vitest"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { useAddDripToken } from "./useAddDripToken"

const TOKEN_ADDR = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000002")
const ACCOUNT = "0x000000000000000000000000000000000000000000000000000000000000000a"

/**
 * Minimal Wallet mock - only `registerToken` is exercised. The composable
 * casts the wallet to `Wallet & { registerToken }` at the typed boundary,
 * so a partial mock is sufficient.
 */
function makeWallet(registerTokenImpl: (account: AztecAddress, token: AztecAddress) => Promise<void>): unknown {
	return { registerToken: registerTokenImpl }
}

describe("useAddDripToken", () => {
	it("happy path: status transitions idle → submitting → ok", async () => {
		const wallet = makeWallet(async () => undefined)
		const { status, addToken } = useAddDripToken()
		expect(status.value.kind).toBe("idle")

		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		const p = addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("submitting")
		await p
		expect(status.value.kind).toBe("ok")
	})

	it("user rejection: 4001 → rejected (a cancel is silent)", async () => {
		// The wallet-sdk's collapsed error shape: Error whose message is the
		// JSON envelope. normalizeError parses this via err.code===4001 OR
		// substring "user rejected" / "user cancelled".
		const wallet = makeWallet(async () => {
			throw new Error("User rejected")
		})
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("rejected")
	})

	it("user rejection via EIP-1193 code 4001 (structured payload): rejected", async () => {
		const wallet = makeWallet(async () => {
			const err = new Error("Transaction cancelled by user")
			;(err as Error & { code?: number }).code = 4001
			throw err
		})
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("rejected")
	})

	it("dispatcher returns 'Unsupported wallet method' → unsupported (distinguishes from network errors)", async () => {
		const wallet = makeWallet(async () => {
			throw new Error("Unsupported wallet method: registerToken")
		})
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("unsupported")
	})

	it("iframe transport answers 'Unknown wallet method' for a schema-less wallet → unsupported, not error", async () => {
		const wallet = makeWallet(async () => {
			throw new Error("Unknown wallet method: registerToken")
		})
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("unsupported")
	})

	it("generic error: status becomes error with normalized category", async () => {
		const wallet = makeWallet(async () => {
			throw new Error("Network timeout")
		})
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("error")
		if (status.value.kind === "error") {
			expect(status.value.error.category).toBe("network")
		}
	})

	it("re-entrancy guard: second call during submitting is ignored", async () => {
		// `let resolveFn: ... | null = null` - TS narrows the local to `never`
		// after the closure assignment. The explicit non-null cast below at
		// the call site is the simplest workaround.
		let resolveFn: (() => void) | null = null
		const wallet = makeWallet(
			() =>
				new Promise<void>((resolve) => {
					resolveFn = resolve
				}),
		)
		const { status, addToken } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		const first = addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("submitting")

		// Second call should be a no-op - status stays submitting, no extra
		// promise to await on the wallet side.
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("submitting")

		;(resolveFn as unknown as (() => void) | null)?.()
		await first
		expect(status.value.kind).toBe("ok")
	})

	it("reset() returns the composable to idle", async () => {
		const wallet = makeWallet(async () => undefined)
		const { status, addToken, reset } = useAddDripToken()
		// biome-ignore lint/suspicious/noExplicitAny: typed mock
		await addToken(wallet as any, ACCOUNT, TOKEN_ADDR)
		expect(status.value.kind).toBe("ok")
		reset()
		expect(status.value.kind).toBe("idle")
	})
})
