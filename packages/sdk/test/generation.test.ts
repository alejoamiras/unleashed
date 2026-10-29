import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { type Address, hexToBytes, keccak256, toHex } from "viem"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hubArtifact, resolveToken } from "../src/bridge/index.ts"
import { parseNetwork, type Reads } from "../src/network.ts"
import { tokenBridgeHubArtifact } from "../src/protocol/artifacts.ts"
import { CODE_PINS } from "../src/protocol/code-hash.ts"
import { codeOf, keptEvmArtifact, LIVE_RECORDS } from "../src/protocol/generation-record.ts"
import { readsOf, testnet, type World, worldOf } from "./fakes.ts"

// A contract source edit on main moves this release's pins and its hub target: here every HEAD pin hashes other code,
// and the HEAD hub artifact has another class and another `token_of` slot. The promoted generation still runs the
// code its record pins, so it must keep resolving.
vi.mock("../src/protocol/code-hash.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/protocol/code-hash.ts")>()
	const moved = Object.fromEntries(
		Object.entries(real.CODE_PINS).map(([c, pin]) => [c, { ...pin, hash: keccak256(toHex(`edited ${c}`)) }]),
	)
	return { ...real, CODE_PINS: moved }
})
vi.mock("../src/protocol/artifacts.ts", async (importOriginal) => {
	const real = (await importOriginal<typeof import("../src/protocol/artifacts.ts")>()).tokenBridgeHubArtifact
	const { Fr: Field } = await import("@aztec-labs/aztec.js/fields")
	const storageLayout = { ...real.storageLayout, token_of: { slot: new Field(4242n) } }
	return { tokenBridgeHubArtifact: { ...real, name: `${real.name}Edited`, storageLayout } }
})
const bundles = vi.hoisted(() => new Map<number, unknown>())
vi.mock("../src/networks.ts", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/networks.ts")>()
	return { ...real, bundledManifest: (id: number) => (bundles.has(id) ? bundles.get(id) : real.bundledManifest(id)) }
})
afterEach(() => bundles.clear())

const GENERATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "generations")
const RECORD = LIVE_RECORDS.find((r) => r.network === "testnet")

/** A world whose L1 code is what the testnet generation's kept artifacts hold, and whose hub has bound `erc20`. */
async function keptWorld(): Promise<{ w: World; r: Reads; erc20: Address; l2Token: string }> {
	if (!RECORD) throw new Error("the testnet record is committed")
	const w = worldOf(testnet())
	for (const [contract, entry] of Object.entries(RECORD.evm)) {
		const kept = JSON.parse(readFileSync(join(GENERATIONS, "testnet", keptEvmArtifact(contract as never)), "utf8"))
		w.code.set(entry.address, hexToBytes(kept.deployedBytecode.object))
	}
	const token = w.m.bridge?.tokens[0]
	if (!token || !w.m.bridge) throw new Error("the testnet manifest lists a token")
	const { decimals, nameWord, symbolWord, portal } = token
	w.reads.set(`${w.m.bridge.l1.factory.toLowerCase()}:registrationOf`, {
		portal,
		decimals,
		registerIndex: 1n,
		nameWord,
		symbolWord,
		registerKey: `0x${"ab".repeat(32)}`,
	})
	const keptSlot = (await codeOf(w.m).hubArtifact()).storageLayout.token_of?.slot
	if (!keptSlot) throw new Error("the kept hub declares token_of")
	const bound = (await deriveStorageSlotInMap(keptSlot, EthAddress.fromString(token.erc20))).toString()
	const reads = readsOf(w)
	const aztecNode = {
		...(reads.aztecNode as object),
		getPublicStorageAt: async (_: "latest", _hub: unknown, slot: Fr) =>
			slot.toString() === bound ? Fr.fromString(token.l2Token) : Fr.ZERO,
	}
	return { w, r: { ...reads, aztecNode: aztecNode as never }, erc20: token.erc20 as Address, l2Token: token.l2Token }
}

describe("a promoted generation after a contract source edit", () => {
	it("the edit moves every HEAD pin and the HEAD hub's class", async () => {
		if (!RECORD?.aztec) throw new Error("the testnet record has a hub")
		for (const [contract, entry] of Object.entries(RECORD.evm)) expect(CODE_PINS[contract as never]).not.toEqual(entry.pin)
		expect((await getContractClassFromArtifact(tokenBridgeHubArtifact)).id.toString()).not.toBe(RECORD.aztec.TokenBridgeHub.classId)
	})

	it("still parses and resolves tokens over the kept runtimes, the kept hub artifact and its slot", async () => {
		const { w, r, erc20, l2Token } = await keptWorld()
		const net = await parseNetwork(w.m, r)
		expect((await hubArtifact(net)).name).toBe("TokenBridgeHub")
		const token = await resolveToken(net, r, erc20)
		expect(token.state).toBe("registered")
		expect(token.l2Token.toLowerCase()).toBe(l2Token.toLowerCase())
	})

	it("a sandbox chain is checked against the edited sources instead, and refused", async () => {
		const { w } = await keptWorld()
		const sandbox = worldOf({ ...structuredClone(w.m), l1ChainId: 31337 })
		sandbox.code = w.code
		await expect(parseNetwork(sandbox.m, readsOf(sandbox))).rejects.toMatchObject({
			code: "invalid-network",
			message: expect.stringMatching(/not the instantiation of its own record/),
		})
	})

	it("a bundled chain with no committed record is refused before any read, as is any chain codeOf does not know", async () => {
		const m = { ...testnet(), l1ChainId: 8453 }
		bundles.set(8453, m)
		await expect(parseNetwork(m, {} as Reads)).rejects.toMatchObject({
			code: "invalid-network",
			message: expect.stringMatching(/chain 8453 has no committed generation record/),
		})
		expect(() => codeOf({ ...testnet(), l1ChainId: 10 })).toThrow(/chain 10 has no committed generation record/)
	})
})
