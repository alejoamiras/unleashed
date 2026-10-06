import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, type PublicClient, pad, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it, vi } from "vitest"
import { type AcrossRelayData, acrossRelayHash } from "../src/crosschain-discovery"
import { BASE_SEPOLIA_RPC_DEFAULT, FILL_ROUTE, fillCli, fillConfigFromEnv, fillSourceDeposit, SEPOLIA_RPC_DEFAULT } from "./fill-testnet"
import { AllowanceStillLive, type Destination, FILL_STATUS } from "./sandbox/relayer"
import { createL1Clients, createL1PublicClient } from "./script-bootstrap"

vi.mock("./script-bootstrap", async (importOriginal) => ({
	...(await importOriginal<typeof import("./script-bootstrap")>()),
	createL1Clients: vi.fn(() => {
		throw new Error("built a signing client")
	}),
	createL1PublicClient: vi.fn(() => {
		throw new Error("built a client")
	}),
}))

const HASH = `0x${"ab".repeat(32)}`
const KEY = `0x${"11".repeat(32)}` as const
const PINNED = privateKeyToAccount(KEY).address
const argv = (...rest: string[]) => ["bun", "scripts/fill-testnet.ts", ...rest]

describe("fill-testnet's configuration", () => {
	it("signs with CANARY_PRIVATE_KEY alone and defaults both endpoints to PublicNode", () => {
		const cfg = fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(HASH), PINNED)
		expect(cfg.account.address).toBe(PINNED)
		expect([cfg.sourceRpcUrl, cfg.destinationRpcUrl]).toEqual([BASE_SEPOLIA_RPC_DEFAULT, SEPOLIA_RPC_DEFAULT])
		const overridden = fillConfigFromEnv(
			{ CANARY_PRIVATE_KEY: KEY, BASE_SEPOLIA_RPC_URL: "http://b", SEPOLIA_RPC_URL: "http://s" },
			argv(HASH),
			PINNED,
		)
		expect([overridden.sourceRpcUrl, overridden.destinationRpcUrl]).toEqual(["http://b", "http://s"])
		expect(() => fillConfigFromEnv({ PRIVATE_KEY: KEY }, argv(HASH), PINNED)).toThrow(/CANARY_PRIVATE_KEY is not set/)
	})

	it("refuses anything but exactly one 32-byte source hash", () => {
		for (const args of [[], ["0x1234"], [HASH.slice(2)], [HASH, HASH]]) {
			expect(() => fillConfigFromEnv({ CANARY_PRIVATE_KEY: KEY }, argv(...args), PINNED)).toThrow(/exactly one 32-byte/)
		}
	})

	it("never echoes a key it refuses", () => {
		for (const bad of [`0x${"zz".repeat(32)}`, `0x${"00".repeat(32)}`, "11".repeat(32), `0x${"ff".repeat(32)}`]) {
			let message = ""
			try {
				fillConfigFromEnv({ CANARY_PRIVATE_KEY: bad }, argv(HASH), PINNED)
			} catch (e) {
				message = String(e)
			}
			expect(message).toMatch(/CANARY_PRIVATE_KEY is not a valid/)
			expect(message).not.toContain(bad.replace(/^0x/, "").slice(0, 8))
		}
	})

	it("refuses an unpinned canary or a key that is not the pin before any client exists", async () => {
		const env = { CANARY_PRIVATE_KEY: KEY }
		await expect(fillCli(env, argv(HASH), null)).rejects.toThrow(/no testnet canary is pinned/)
		await expect(fillCli(env, argv(HASH), `0x${"cb".repeat(20)}`)).rejects.toThrow(/not the pinned canary/)
		expect(createL1PublicClient).not.toHaveBeenCalled()
		expect(createL1Clients).not.toHaveBeenCalled()
		// The pinned key passes the gate and reaches the clients.
		await expect(fillCli(env, argv(HASH), PINNED.toLowerCase())).rejects.toThrow(/built a client/)
	})
})

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

describe("fillSourceDeposit", () => {
	it("revokes an approval that landed but could not be confirmed, so another relayer's fill is no cover for a live allowance", async () => {
		// The recorded Base Sepolia deposit, filled while our approval's receipt read times out.
		const rail = fixture("testnet-rail.json")
		const receipt = { status: "success", logs: fixture("testnet-rail.router.receipts.json").source.logs }
		const run = async (revokeConfirms: boolean) => {
			const approvals = new Map<Hex, bigint>()
			const pub = {
				getChainId: async () => FILL_ROUTE.destination,
				getBlock: async () => ({ timestamp: BigInt(rail.source.timestamp) }),
				readContract: async (r: { functionName: string; args: readonly unknown[] }) => {
					if (r.functionName === "getV3RelayHash") return acrossRelayHash(r.args[0] as AcrossRelayData, FILL_ROUTE.destination)
					if (r.functionName === "fillStatuses") return approvals.size ? FILL_STATUS.filled : FILL_STATUS.unfilled
					return 10n ** 12n
				},
				waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
					if (approvals.get(hash) === 0n && revokeConfirms) return { status: "success" }
					throw new Error(`timed out waiting for ${hash}`)
				},
			}
			const writeContract = async (w: { args: readonly [Address, bigint] }) => {
				const hash = pad(toHex(approvals.size + 1))
				approvals.set(hash, w.args[1])
				return hash
			}
			const deps = {
				source: {
					getChainId: async () => FILL_ROUTE.source,
					getTransactionReceipt: async () => receipt,
				} as unknown as PublicClient,
				destination: { public: pub, wallet: { account: { address: PINNED }, writeContract } } as unknown as Destination,
				sourceSpokePool: rail.source.spokePool as Address,
				destinationSpokePool: `0x${"5b".repeat(20)}` as Address,
			}
			const result = await fillSourceDeposit(deps, HASH as Hex).catch((e: unknown) => e)
			return { result, approvals: [...approvals.values()] }
		}

		const live = await run(false)
		expect(live.approvals).toEqual([BigInt(rail.inputs.outputAmount), 0n])
		expect(live.result).toBeInstanceOf(AllowanceStillLive)
		expect(live.result).toMatchObject({ cause: { message: expect.stringMatching(/^timed out waiting for 0x0+1$/) } })

		// A confirmed revoke leaves nothing live, so the relay filled by another is the success it reports.
		const cleared = await run(true)
		expect(cleared.approvals).toEqual([BigInt(rail.inputs.outputAmount), 0n])
		expect(cleared.result).toMatchObject({ alreadyFilled: true, fillTxHash: null })
	})
})
