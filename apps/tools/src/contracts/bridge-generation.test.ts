// @vitest-environment node
/**
 * The generation reader, pinned against a REAL manifest a sandbox deploy produced. Its addresses
 * are not reproducible, but every derivation the app performs off it must hold — so a reader that
 * carries a value instead of re-deriving it, or a schema drift, reds here.
 *
 * Node environment (not jsdom): bb.js's sync poseidon throws std::bad_cast under jsdom, and both
 * rebuilds derive real Aztec addresses.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PRIVATE_FPC_ADDRESS, parseManifestV2 } from "@unleashed/bridge-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, "..", "..", "..", "..", "packages", "bridge-core", "fixtures", "sandbox-manifest.json")
const PUBLIC_DIR = join(HERE, "..", "..", "public")
/** Each network's FPC descriptor: mainnet keeps its own deployed FPC while testnet follows the installed package. */
const descriptorFor = (network: string) =>
	JSON.parse(
		readFileSync(
			join(
				HERE,
				"..",
				"..",
				"..",
				"..",
				"packages",
				"bridge-core",
				"src",
				`private-fpc-canonical${network === "mainnet" ? "-mainnet" : ""}.json`,
			),
			"utf8",
		),
	) as { aztecVersion: string; artifactSha256: string; expectedAddress: string }
const sandbox = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
	bridge: {
		l1: { factory: string; router: string }
		l2: { hub: { address: string }; tokenClassId: string }
		tokens: Array<{ erc20: string; l2Token: string; nameWord: string; symbolWord: string; decimals: number }>
	}
}

/** The reader parses at module init, so each shape needs its own fresh evaluation. */
async function readerFor(manifest: unknown) {
	vi.stubEnv("VITE_BRIDGE_MANIFEST_JSON", JSON.stringify(manifest))
	vi.resetModules()
	return await import("./bridge-generation")
}

beforeEach(() => {
	vi.resetModules()
})
afterEach(() => {
	vi.unstubAllEnvs()
})

describe("the sandbox generation", () => {
	it("binds every send to the manifest's own router, factory, hub and token class", async () => {
		const { SEND_GENERATION, HUB, IS_PLACEHOLDER } = await readerFor(sandbox)
		expect(IS_PLACEHOLDER).toBe(false)
		expect(SEND_GENERATION?.router).toBe(sandbox.bridge.l1.router)
		expect(SEND_GENERATION?.factory).toBe(sandbox.bridge.l1.factory)
		expect(SEND_GENERATION?.hub).toBe(sandbox.bridge.l2.hub.address)
		expect(SEND_GENERATION?.tokenClassId).toBe(sandbox.bridge.l2.tokenClassId)
		expect(HUB?.toString()).toBe(sandbox.bridge.l2.hub.address)
	})

	it("exposes every pre-created token, portal-only ones included", async () => {
		const { MANIFEST_TOKENS } = await readerFor(sandbox)
		expect(MANIFEST_TOKENS).toHaveLength(3)
		expect(MANIFEST_TOKENS.map((t) => t.erc20)).toEqual(sandbox.bridge.tokens.map((t) => t.erc20))
	})

	it("re-derives the hub instead of carrying its address", async () => {
		const { rebuildHubInstance } = await readerFor(sandbox)
		const instance = await rebuildHubInstance()
		expect(instance.address.toString()).toBe(sandbox.bridge.l2.hub.address)
	})

	it("re-derives a token's L2 instance from the hub and the attested words", async () => {
		const { rebuildHubTokenInstance } = await readerFor(sandbox)
		const token = sandbox.bridge.tokens[0]
		const instance = await rebuildHubTokenInstance(token.erc20, {
			nameWord: token.nameWord,
			symbolWord: token.symbolWord,
			decimals: token.decimals,
		})
		expect(instance.address.toString()).toBe(token.l2Token)
	})
})

describe("the shipped manifests", () => {
	it.each([
		["testnet-bridge.json", "testnet", 11155111, 2904119610],
		["mainnet-bridge.json", "mainnet", 1, 4248422646],
	])("%s is a valid v2 manifest for its own chain", (file, network, l1ChainId, walletChainId) => {
		const m = parseManifestV2(JSON.parse(readFileSync(join(PUBLIC_DIR, file as string), "utf8")))
		expect(m.network).toBe(network)
		expect(m.l1ChainId).toBe(l1ChainId)
		expect(m.walletChainId).toBe(walletChainId)
		expect(m.feeJuice.portal).toMatch(/^0x[0-9a-f]{40}$/)
		// The whole canonical triple, so a manifest that names another FPC, version or artifact reds here.
		const descriptor = descriptorFor(network as string)
		expect(m.privateFpc).toEqual({
			address: descriptor.expectedAddress,
			version: descriptor.aztecVersion,
			artifactDigest: descriptor.artifactSha256,
		})
		// The app deposits private fuel to PRIVATE_FPC_ADDRESS on every network, so only a network whose
		// descriptor names that address may enable a bridge.
		if (m.bridge !== null) expect(descriptor.expectedAddress).toBe(PRIVATE_FPC_ADDRESS)
	})
})

describe("a network with no bridge", () => {
	it("is a placeholder with nothing to send against", async () => {
		const { IS_PLACEHOLDER, HUB, SEND_GENERATION, MANIFEST_TOKENS, TOKEN_CLASS_ID } = await readerFor({ ...sandbox, bridge: null })
		expect(IS_PLACEHOLDER).toBe(true)
		expect(HUB).toBeUndefined()
		expect(SEND_GENERATION).toBeUndefined()
		expect(TOKEN_CLASS_ID).toBeUndefined()
		expect(MANIFEST_TOKENS).toEqual([])
	})

	it("refuses to rebuild the hub rather than deriving one from nothing", async () => {
		const { rebuildHubInstance } = await readerFor({ ...sandbox, bridge: null })
		await expect(rebuildHubInstance()).rejects.toThrow(/no bridge/)
	})
})
