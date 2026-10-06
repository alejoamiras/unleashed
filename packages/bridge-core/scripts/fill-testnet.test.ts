import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, type PublicClient, pad, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it, vi } from "vitest"
import { type AcrossRelayData, acrossRelayHash } from "../src/crosschain-discovery"
import { BASE_SEPOLIA_RPC_DEFAULT, FILL_ROUTE, fillCli, fillConfigFromEnv, fillSourceDeposit, SEPOLIA_RPC_DEFAULT } from "./fill-testnet"
import { fillWay } from "./lifi-canary-run"
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
	// The recorded Base Sepolia deposit, filled on a destination whose receipt reads time out where `o` says.
	const rail = fixture("testnet-rail.json")
	const receipt = { status: "success", logs: fixture("testnet-rail.router.receipts.json").source.logs }
	const RELAYER = `0x${"4e".repeat(20)}` as Address
	const fillWith = async (o: { revokeConfirms: boolean; ourFillLands: boolean }) => {
		const approvals = new Map<Hex, bigint>()
		const fills: Hex[] = []
		const confirms = (hash: Hex) => (o.ourFillLands ? approvals.has(hash) : approvals.get(hash) === 0n && o.revokeConfirms)
		const pub = {
			getChainId: async () => FILL_ROUTE.destination,
			getBlock: async () => ({ timestamp: BigInt(rail.source.timestamp) }),
			readContract: async (r: { functionName: string; args: readonly unknown[] }) => {
				if (r.functionName === "getV3RelayHash") return acrossRelayHash(r.args[0] as AcrossRelayData, FILL_ROUTE.destination)
				// Another relayer fills once our approval is out, or our own fill lands.
				const filled = o.ourFillLands ? fills.length > 0 : approvals.size > 0
				if (r.functionName === "fillStatuses") return filled ? FILL_STATUS.filled : FILL_STATUS.unfilled
				return 10n ** 12n
			},
			simulateContract: async () => ({}),
			waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
				if (confirms(hash)) return { status: "success" }
				throw new Error(`timed out waiting for ${hash}`)
			},
			getTransaction: async ({ hash }: { hash: Hex }) => ({ from: fills.includes(hash) ? PINNED : RELAYER }),
		}
		const writeContract = async (w: { functionName: string; args: readonly unknown[] }) => {
			const hash = pad(toHex(approvals.size + fills.length + 1))
			if (w.functionName === "fillRelay") fills.push(hash)
			else approvals.set(hash, w.args[1] as bigint)
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
		return { result, approvals: [...approvals.values()], fills, pub }
	}

	it("revokes an approval that landed but could not be confirmed, so another relayer's fill is no cover for a live allowance", async () => {
		const live = await fillWith({ revokeConfirms: false, ourFillLands: false })
		expect(live.approvals).toEqual([BigInt(rail.inputs.outputAmount), 0n])
		expect(live.result).toBeInstanceOf(AllowanceStillLive)
		expect(live.result).toMatchObject({ cause: { message: expect.stringMatching(/^timed out waiting for 0x0+1$/) } })

		// A confirmed revoke leaves nothing live, so the relay filled by another is the success it reports.
		const cleared = await fillWith({ revokeConfirms: true, ourFillLands: false })
		expect(cleared.approvals).toEqual([BigInt(rail.inputs.outputAmount), 0n])
		expect(cleared.result).toMatchObject({ alreadyFilled: true, fillTxHash: null })
	})

	it("reads a fill of ours whose receipt wait failed as already filled, which the canary attributes by its signer", async () => {
		const ours = await fillWith({ revokeConfirms: true, ourFillLands: true })
		expect(ours.result).toMatchObject({ alreadyFilled: true, fillTxHash: null })
		expect(ours.fills).toHaveLength(1)
		const [fill] = ours.fills as [Hex]
		expect(await fillWay(ours.pub, fill, PINNED)).toBe("self")
		expect(await fillWay(ours.pub, pad("0x77"), PINNED)).toBe("organic")
	})
})
