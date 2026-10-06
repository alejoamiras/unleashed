import { ACROSS_TESTNET_API, SOURCE_CHAINS, TESTNET_NODE_URL, TOKEN_LIST_URL } from "@unleashed/bridge-core"
import { describe, expect, it } from "vitest"
import { localTarget, MAINNET_TARGET, resolveToolsTarget, TESTNET_TARGET } from "./network-targets"

/** `connect-src` is generated into `dist/_headers` per target; an origin missing here is a runtime
 *  fetch the browser blocks with no visible error, so both targets pin their exact reach. */
describe("cspConnectSrc", () => {
	it("testnet reaches exactly its node, by path, and no other node host", () => {
		expect(TESTNET_TARGET.nodeUrl).toBe(TESTNET_NODE_URL)
		expect(TESTNET_TARGET.cspConnectSrc.split(" ")).toContain(TESTNET_NODE_URL)
		expect(TESTNET_TARGET.cspConnectSrc).not.toMatch(/\*|aztec-labs\.com|aztec\.network|wss:/)
	})

	it("testnet reaches the community token list the catalog loads", () => {
		expect(TESTNET_TARGET.cspConnectSrc.split(" ")).toContain(TOKEN_LIST_URL)
	})

	it("mainnet allows no remote origin at all (it serves the placeholder only)", () => {
		expect(MAINNET_TARGET.cspConnectSrc).toBe("'self' data: blob:")
	})

	it("mainnet no longer reaches its node or the token list", () => {
		expect(MAINNET_TARGET.cspConnectSrc).not.toContain("drpc.live")
		expect(MAINNET_TARGET.cspConnectSrc).not.toContain(TOKEN_LIST_URL)
	})

	it("testnet reaches exactly the read RPCs and the Across API a cross-chain send is quoted and watched through", () => {
		const remote = TESTNET_TARGET.cspConnectSrc.split(" ").filter((s) => s.startsWith("https://"))
		expect(remote.sort()).toEqual(
			[
				TESTNET_NODE_URL,
				TOKEN_LIST_URL,
				"https://ethereum-sepolia-rpc.publicnode.com",
				"https://base-sepolia-rpc.publicnode.com",
				"https://sepolia.base.org",
				"https://testnet.across.to",
			].sort(),
		)
		// The Node-safe copies stay equal to the catalogue the decoder and discovery use.
		expect(TESTNET_TARGET.readRpcUrls[84532]).toEqual(SOURCE_CHAINS[84532].rpcUrls)
		expect(TESTNET_TARGET.acrossApiUrl).toBe(ACROSS_TESTNET_API)
		expect(MAINNET_TARGET.readRpcUrls).toEqual({})
		expect(MAINNET_TARGET.acrossApiUrl).toBeUndefined()
	})

	it("both targets keep the self/data/blob base every build needs", () => {
		for (const target of [TESTNET_TARGET, MAINNET_TARGET]) {
			expect(target.cspConnectSrc.startsWith("'self' data: blob:")).toBe(true)
		}
	})
})

describe("local target", () => {
	const cfg = {
		nodeUrl: "http://127.0.0.1:18080",
		rollupVersion: 12345,
		walletChainId: (31337 ^ 12345) >>> 0,
		host: "127.0.0.1",
		webWalletUrls: ["http://127.0.0.1:17777/?profile=plain", "http://127.0.0.1:17777/?profile=selfpay"],
	}

	it("is chain 31337 with the run's identity and node", () => {
		const t = localTarget(cfg)
		expect(t.key).toBe("local")
		expect(t.l1ChainId).toBe(31337)
		expect(t.walletChainId).toBe(cfg.walletChainId)
		expect(t.nodeUrl).toBe(cfg.nodeUrl)
		expect(t.host).toBe("127.0.0.1")
	})

	it("reaches only loopback, its wallet origins, and the token list the suite answers from a fixture", () => {
		const csp = localTarget(cfg).cspConnectSrc
		expect(csp.startsWith("'self' data: blob:")).toBe(true)
		expect(csp).toContain("http://127.0.0.1:*")
		expect(csp).toContain("ws://localhost:*")
		expect(csp).toContain("http://127.0.0.1:17777")
		expect(csp.split(" ")).toContain(TOKEN_LIST_URL)
		expect(csp).not.toContain("aztec")
	})

	it("reads its own two anvils, and asks its own Across API", () => {
		const t = localTarget({
			...cfg,
			l1RpcUrl: "http://127.0.0.1:18545",
			source: { chainId: 31338, rpcUrl: "http://127.0.0.1:18546" },
			acrossApiUrl: "http://127.0.0.1:18600",
		})
		expect(t.readRpcUrls).toEqual({ 31337: ["http://127.0.0.1:18545"], 31338: ["http://127.0.0.1:18546"] })
		expect(t.acrossApiUrl).toBe("http://127.0.0.1:18600")
		expect(localTarget(cfg).readRpcUrls).toEqual({})
	})

	it("is the only target that lists web wallets", () => {
		expect(localTarget(cfg).webWalletUrls).toEqual(cfg.webWalletUrls)
		expect(TESTNET_TARGET.webWalletUrls).toBeUndefined()
		expect(MAINNET_TARGET.webWalletUrls).toBeUndefined()
	})

	it("is the only target that accepts a token list other than the pinned one", () => {
		expect(localTarget({ ...cfg, tokenListSha256: ["ab"] }).tokenListSha256).toEqual(["ab"])
		expect(TESTNET_TARGET.tokenListSha256).toBeUndefined()
		expect(MAINNET_TARGET.tokenListSha256).toBeUndefined()
	})

	it("is absent from every shipped build's resolution (no define → testnet fallback)", () => {
		expect(resolveToolsTarget().key).toBe("testnet")
	})
})
