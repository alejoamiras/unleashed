import { describe, expect, it } from "vitest"
import { mintToPrivateContentHash, mintToPublicContentHash, withdrawContentHash } from "./content-hash"

// Same fixed vectors + expected values as the on-chain keystone
// (contracts/bridge/evm/test/ContentHash.t.sol + contracts/bridge/aztec/keystone). These three
// must stay byte-identical across all THREE toolchains (Solidity, Noir, TS) —
// a drift means a deposit's L1->L2 message is unconsumable and funds strand.
describe("content-hash (TS keystone — matches Solidity + Noir)", () => {
	it("mint_to_public(0x1234, 1_000_000)", async () => {
		expect(await mintToPublicContentHash("0x1234", 1_000_000n)).toBe(
			"0x00fb464b41c6a08b28bfe9b8a11c1c4dcd2d4c9c66e703988cb76eb00e140dcc",
		)
	})

	it("mint_to_private(1_000_000)", async () => {
		expect(await mintToPrivateContentHash(1_000_000n)).toBe("0x00009b1ee836fa551bb50bb45e2c8e698cc680c6e68e429370625119a2c63954")
	})

	it("withdraw(0xBEEF, 1_000_000, address(0))", async () => {
		expect(await withdrawContentHash("0xBEEF", 1_000_000n, "0x0")).toBe(
			"0x00ac390e12f1097130e1a7c2e5eea30780cd11d12002b8de22d608cf10a60775",
		)
	})
})
