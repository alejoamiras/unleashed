import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const h = vi.hoisted(() => ({
	retried: [] as string[],
	network: vi.fn(async () => ({ l1ChainId: 11155111, rollupVersion: 7 })),
}))

vi.mock("@/contracts/bridge-generation", () => ({ bridgeNetwork: h.network }))
vi.mock("@/lib/aztec-node", () => ({ appNode: () => ({}) }))
vi.mock("./useEthereumReader", () => ({ readClientFor: () => ({}) }))
vi.mock("./useWalletConnection", () => ({
	retryOnUnregistered: (_s: unknown, _w: unknown, op: () => Promise<unknown>) => {
		h.retried.push("simulateTx")
		return op()
	},
}))

import { claimContextOf, claimWallet } from "./claim-context"

const RECIPIENT = `0x${"10".repeat(32)}`

/** A wallet whose methods read a private field, as a real one may: a proxy that called them on itself would throw. */
class FakeWallet {
	#sent: string[] = []
	gates = new Map<string, Promise<void>>()
	async sendTx(tag: string) {
		await this.gates.get(tag)
		this.#sent.push(tag)
		return tag
	}
	async simulateTx() {
		return "simulated"
	}
	sent() {
		return this.#sent
	}
}

const session = (wallet: unknown) => ({ wallet: ref(wallet) }) as never

describe("claimWallet", () => {
	it("re-registers on a simulate, queues each send on the Aztec lane, and leaves every other call to the wallet", async () => {
		const a = new FakeWallet()
		const b = new FakeWallet()
		let open = (): void => {}
		a.gates.set("first", new Promise((r) => (open = r)))
		const wa = claimWallet(session(a), a as unknown as Wallet)
		const wb = claimWallet(session(b), b as unknown as Wallet)
		const first = (wa.sendTx as unknown as (t: string) => Promise<string>)("first")
		const second = (wb.sendTx as unknown as (t: string) => Promise<string>)("second")
		await new Promise((r) => setTimeout(r, 5))
		expect(b.sent()).toEqual([])
		open()
		await Promise.all([first, second])
		expect([a.sent(), b.sent()]).toEqual([["first"], ["second"]])
		expect(await (wa as unknown as FakeWallet).simulateTx()).toBe("simulated")
		expect(h.retried).toEqual(["simulateTx"])
		expect((wa as unknown as FakeWallet).sent()).toEqual(["first"])
	})
})

describe("claimContextOf", () => {
	it("refuses a claim that may prompt without a wallet; a watching one reads the network through a stand-in", async () => {
		await expect(claimContextOf(session(null), { publicClient: {} }, RECIPIENT, false)).rejects.toThrow(
			"Connect your Aztec wallet first.",
		)
		const ctx = await claimContextOf(session(null), { publicClient: {} }, RECIPIENT, true)
		const info = await ctx.aztec.wallet.getChainInfo()
		expect([info.chainId.toBigInt(), info.version.toBigInt()]).toEqual([11155111n, 7n])
		await expect(ctx.aztec.wallet.sendTx({} as never, {} as never)).rejects.toThrow("Connect your Aztec wallet first.")
		expect(ctx.aztec.account.toString()).toBe(RECIPIENT)
	})
})
