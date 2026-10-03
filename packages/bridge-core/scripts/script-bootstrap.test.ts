import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import {
	loadManifestFromConfigArg,
	loadManifestV2FromConfigArg,
	mainnetChain,
	requireBridge,
	sepoliaChain,
	stopwatch,
} from "./script-bootstrap"

describe("chain factories", () => {
	test("sepoliaChain carries the caller's RPC url in the canonical descriptor", () => {
		const chain = sepoliaChain("https://rpc.example/sepolia")
		expect(chain.id).toBe(11155111)
		expect(chain.name).toBe("sepolia")
		expect(chain.nativeCurrency).toEqual({ decimals: 18, name: "Ether", symbol: "ETH" })
		expect(chain.rpcUrls.default.http).toEqual(["https://rpc.example/sepolia"])
	})

	test("mainnetChain carries the caller's RPC url in the canonical descriptor", () => {
		const chain = mainnetChain("https://rpc.example/eth")
		expect(chain.id).toBe(1)
		expect(chain.name).toBe("ethereum")
		expect(chain.rpcUrls.default.http).toEqual(["https://rpc.example/eth"])
	})
})

describe("stopwatch", () => {
	test("formats elapsed minutes with one decimal", () => {
		const mins = stopwatch()
		expect(mins()).toMatch(/^\d+\.\dm$/)
	})
})

describe("loadManifestFromConfigArg", () => {
	const dir = mkdtempSync(join(tmpdir(), "bootstrap-test-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	const write = (name: string, value: unknown): string => {
		const p = join(dir, name)
		writeFileSync(p, JSON.stringify(value))
		return p
	}

	test("required mode: loads and parses the --config path", () => {
		const p = write("candidate.json", { l1: { portal: "0xabc" } })
		const parsed = loadManifestFromConfigArg(["bun", "script.ts", "--config", p], {
			mode: "required",
			requiredHint: "path/to/candidate.json",
			parse: (raw) => raw as { l1: { portal: string } },
		})
		expect(parsed.l1.portal).toBe("0xabc")
	})

	test("required mode: throws with the hint when --config is absent", () => {
		expect(() =>
			loadManifestFromConfigArg(["bun", "script.ts"], {
				mode: "required",
				requiredHint: "apps/tools/public/testnet-bridge.candidate.json",
				parse: (raw) => raw,
			}),
		).toThrow(/pass --config .*testnet-bridge\.candidate\.json/)
	})

	test("fallback mode: absent --config reads the fallback path (the canary's retained live-manifest behavior)", () => {
		const live = write("live.json", { kind: "live" })
		const parsed = loadManifestFromConfigArg(["bun", "script.ts"], {
			mode: "fallback",
			fallbackPath: live,
			parse: (raw) => raw as { kind: string },
		})
		expect(parsed.kind).toBe("live")
	})

	test("fallback mode: present --config wins over the fallback", () => {
		const live = write("live2.json", { kind: "live" })
		const candidate = write("candidate2.json", { kind: "candidate" })
		const parsed = loadManifestFromConfigArg(["bun", "script.ts", "--config", candidate], {
			mode: "fallback",
			fallbackPath: live,
			parse: (raw) => raw as { kind: string },
		})
		expect(parsed.kind).toBe("candidate")
	})

	test("the injected parser runs on the loaded JSON", () => {
		const p = write("strict.json", { n: 1 })
		expect(() =>
			loadManifestFromConfigArg(["x", "y", "--config", p], {
				mode: "required",
				requiredHint: "h",
				parse: () => {
					throw new Error("schema rejected")
				},
			}),
		).toThrow("schema rejected")
	})

	test("the v2 loader parses strictly and requireBridge refuses a placeholder network by name", () => {
		const placeholder = write("placeholder.json", {
			schema: 2,
			network: "mainnet",
			l1ChainId: 1,
			walletChainId: 2,
			bridge: null,
			feeJuice: { portal: `0x${"1".repeat(40)}`, asset: `0x${"2".repeat(40)}`, minFj: "1" },
			privateClaimMode: "salt-v2",
		})
		const m = loadManifestV2FromConfigArg(["x", "y", "--config", placeholder], { mode: "required" })
		expect(m.bridge).toBeNull()
		expect(() => requireBridge(m)).toThrow(/mainnet.*placeholder/)
		const v1 = write("v1.json", { network: "testnet", l1: { usdc: "0x" } })
		expect(() => loadManifestV2FromConfigArg(["x", "y", "--config", v1], { mode: "required" })).toThrow()
	})
})
