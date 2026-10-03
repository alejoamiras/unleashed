import type { Address, Hex } from "viem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ResolvedToken } from "@/lib/send-model"

/**
 * The session is faked down to what the grant reads: a status, the granted-contract list, and a
 * `retryCapabilities` that records how it was called. `onPrompt` is each test's script for what the
 * wallet does while the prompt is up.
 */
const wallet = vi.hoisted(() => ({
	status: { value: "connected" as string },
	grantedContracts: { value: [] as string[] },
	prompts: 0,
	inFlight: 0,
	maxInFlight: 0,
	requested: [] as string[],
	/** What the session answers: false = another flow owned the wallet, so nothing was asked. */
	runs: true,
	onPrompt: async (): Promise<void> => {},
}))

vi.mock("@/composables/useWalletConnection", () => ({
	useWalletConnection: () => ({
		status: wallet.status,
		grantedContracts: wallet.grantedContracts,
		retryCapabilities: async () => {
			if (!wallet.runs) return false
			wallet.prompts++
			wallet.inFlight++
			wallet.maxInFlight = Math.max(wallet.maxInFlight, wallet.inFlight)
			try {
				await wallet.onPrompt()
			} finally {
				wallet.inFlight--
			}
			return true
		},
	}),
	requestHubToken: (token: { l2Token: string }) => {
		wallet.requested.push(token.l2Token)
	},
}))

import { __resetTokenGrantQueueForTests, useTokenGrant } from "./useTokenGrant"

const L2_A = `0x${"a".repeat(64)}` as Hex
const L2_B = `0x${"b".repeat(64)}` as Hex
const ERC20_A = "0x1111111111111111111111111111111111111111" as Address
const ERC20_B = "0x2222222222222222222222222222222222222222" as Address

function tokenOf(l2Token: Hex, erc20: Address): ResolvedToken {
	return {
		chainId: 31337,
		address: erc20,
		symbol: "TKN",
		name: "Token",
		decimals: 6,
		source: "list",
		logoKey: `31337:${erc20}`,
		state: { kind: "first-time" },
		portal: "0x3333333333333333333333333333333333333333" as Address,
		words: { nameWord: `0x${"0".repeat(64)}` as Hex, symbolWord: `0x${"0".repeat(64)}` as Hex },
		l2Token,
	}
}

const TOKEN_A = tokenOf(L2_A, ERC20_A)
const TOKEN_B = tokenOf(L2_B, ERC20_B)

/** A prompt that grants exactly the listed tokens. */
function grants(...addresses: Hex[]) {
	return async () => {
		wallet.grantedContracts.value = [...wallet.grantedContracts.value, ...addresses]
	}
}

const fixedEpoch = () => 1

beforeEach(() => {
	__resetTokenGrantQueueForTests()
	wallet.status.value = "connected"
	wallet.grantedContracts.value = []
	wallet.prompts = 0
	wallet.inFlight = 0
	wallet.maxInFlight = 0
	wallet.requested = []
	wallet.runs = true
	wallet.onPrompt = async () => {}
})

describe("useTokenGrant", () => {
	it("isGranted matches the granted list case-insensitively", () => {
		wallet.grantedContracts.value = [L2_A.toUpperCase()]
		const grant = useTokenGrant()
		expect(grant.isGranted(L2_A)).toBe(true)
		expect(grant.isGranted(L2_B)).toBe(false)
	})

	it("short-circuits on an already-granted token without prompting", async () => {
		wallet.grantedContracts.value = [L2_A]
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("granted")
		expect(wallet.prompts).toBe(0)
		// Still recorded: the requested set is what a later request re-grants and a reconnect registers.
		expect(wallet.requested).toEqual([L2_A])
	})

	it("prompts once for a new token and reports granted", async () => {
		wallet.onPrompt = grants(L2_A)
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("granted")
		expect(wallet.prompts).toBe(1)
		expect(wallet.requested).toEqual([L2_A])
	})

	it("reports declined when the grant comes back without the token", async () => {
		wallet.onPrompt = grants(L2_B)
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("declined")
		expect(wallet.prompts).toBe(1)
	})

	it("reports declined when the session left 'connected' during the prompt", async () => {
		wallet.onPrompt = async () => {
			wallet.grantedContracts.value = [L2_A]
			wallet.status.value = "error"
		}
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("declined")
	})

	it("reports busy - not declined - while the session is mid-flow", async () => {
		// The wallet was never asked, so nothing was refused: telling the user their wallet declined
		// would name a decision that never happened.
		wallet.status.value = "capability-approval"
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("busy")
		expect(wallet.prompts).toBe(0)
	})

	it("reports busy when the session no-ops the prompt because another flow took the wallet", async () => {
		wallet.runs = false
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("busy")
		expect(wallet.prompts).toBe(0)
	})

	it("declines without prompting when the session is not connected", async () => {
		wallet.status.value = "idle"
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("declined")
		expect(wallet.prompts).toBe(0)
	})

	it("discards a completion whose selection epoch moved", async () => {
		let epoch = 1
		wallet.onPrompt = async () => {
			epoch = 2
			await grants(L2_A)()
		}
		const grant = useTokenGrant()
		// Granted by the wallet, but for a selection the user has already left.
		await expect(grant.ensureGranted(TOKEN_A, () => epoch)).resolves.toBe("stale")
	})

	it("serializes two requests for the SAME token: the second sees the first's grant", async () => {
		wallet.onPrompt = grants(L2_A)
		const grant = useTokenGrant()
		const both = await Promise.all([grant.ensureGranted(TOKEN_A, fixedEpoch), grant.ensureGranted(TOKEN_A, fixedEpoch)])
		expect(both).toEqual(["granted", "granted"])
		expect(wallet.prompts).toBe(1)
	})

	it("serializes two requests for DIFFERENT tokens: one prompt at a time", async () => {
		wallet.onPrompt = async () => {
			await Promise.resolve()
			wallet.grantedContracts.value = [L2_A, L2_B]
		}
		const grant = useTokenGrant()
		const both = await Promise.all([grant.ensureGranted(TOKEN_A, fixedEpoch), grant.ensureGranted(TOKEN_B, fixedEpoch)])
		expect(both).toEqual(["granted", "granted"])
		expect(wallet.maxInFlight).toBe(1)
	})

	it("keeps the queue usable after a prompt rejects", async () => {
		wallet.onPrompt = async () => {
			throw new Error("wallet channel closed")
		}
		const grant = useTokenGrant()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).rejects.toThrow("wallet channel closed")

		wallet.onPrompt = grants(L2_B)
		await expect(grant.ensureGranted(TOKEN_B, fixedEpoch)).resolves.toBe("granted")
		expect(wallet.prompts).toBe(2)
	})

	it("dispose() stops any further prompting", async () => {
		const grant = useTokenGrant()
		grant.dispose()
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("stale")
		expect(wallet.prompts).toBe(0)
		expect(wallet.requested).toEqual([])
	})

	it("dispose() during a prompt discards its completion", async () => {
		const grant = useTokenGrant()
		wallet.onPrompt = async () => {
			grant.dispose()
			await grants(L2_A)()
		}
		await expect(grant.ensureGranted(TOKEN_A, fixedEpoch)).resolves.toBe("stale")
	})
})
