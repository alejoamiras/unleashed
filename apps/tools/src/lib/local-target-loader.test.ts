// @vitest-environment node
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseManifestV2 } from "@unleashed/bridge-core"
import { afterEach, describe, expect, it } from "vitest"
import { loadLocalRun } from "./local-target-loader"

const MANIFEST = fileURLToPath(new URL("../../../../packages/bridge-core/fixtures/sandbox-manifest.json", import.meta.url))
const USDC = "0x7cb3dccd91a0723f61145b7a18e588771ca5a54d"
const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`

const crossChain = {
	sourceUrl: "http://127.0.0.1:18546",
	sourceChainId: 31338,
	source: { spokePool: at(1), diamond: at(2), token: at(3) },
	destination: { spokePool: at(4), executor: at(5), receiverAcrossV4: at(6), token: USDC },
}

const dirs: string[] = []
function artifacts(handle: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "local-target-"))
	dirs.push(dir)
	copyFileSync(MANIFEST, join(dir, "manifest.json"))
	writeFileSync(join(dir, "deployments.json"), "{}")
	const base = {
		anvilUrl: "http://127.0.0.1:18545",
		nodeUrl: "http://127.0.0.1:18080",
		rollupVersion: 1,
		walletChainId: 31336,
		l1ChainId: 31337,
	}
	writeFileSync(join(dir, "handle.json"), JSON.stringify({ ...base, ...handle }))
	return dir
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("loadLocalRun", () => {
	it("routes the source anvil's token into the rail token and books the sandbox's LI.FI stand-ins, for the local build only", () => {
		const run = loadLocalRun(artifacts({ crossChain }))
		const m = parseManifestV2(JSON.parse(run.manifestJson))
		expect(m.bridge?.routing).toEqual({
			provider: "lifi",
			sources: [{ chainId: 31338, rail: "acrossV4", tokens: [{ address: at(3), symbol: "USDC", decimals: 6, destToken: USDC }] }],
		})
		expect(run.target.sandboxLifi).toEqual({
			source: { chainId: 31338, diamond: at(2), spokePool: at(1) },
			ethereum: { chainId: 31337, executor: at(5), receiverAcrossV4: at(6), spokePool: at(4) },
		})
		expect(run.target.readRpcUrls[31338]).toEqual([crossChain.sourceUrl])
	})

	it("leaves a handle without the cross-chain half routing nothing", () => {
		const run = loadLocalRun(artifacts({}))
		expect(parseManifestV2(JSON.parse(run.manifestJson)).bridge?.routing).toBeUndefined()
		expect(run.target.sandboxLifi).toBeUndefined()
	})

	it("refuses a rail token the manifest does not carry", () => {
		const dir = artifacts({ crossChain: { ...crossChain, destination: { ...crossChain.destination, token: at(7) } } })
		expect(() => loadLocalRun(dir)).toThrow(/no token .* to route into/)
	})
})
