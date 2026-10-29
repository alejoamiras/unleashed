/**
 * The bundled testnet manifest against the live chain, opt-in (`TESTNET_LIVE=1`), through the keyless endpoints the
 * testnet bundle reads. Every send refuses before its first prompt unless `parseNetwork` accepts the network, so a
 * redeploy or a code-pin drift shows here before a user meets it.
 */
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { createPublicClient, http } from "viem"
import { describe, expect, it } from "vitest"
import { parseNetwork } from "../src/network.ts"
import { TESTNET_MANIFEST } from "../src/networks.ts"

describe.skipIf(!process.env.TESTNET_LIVE)("parseNetwork, live testnet", () => {
	it("accepts the bundled testnet manifest against Sepolia and the Aztec testnet node", async () => {
		const l1 = createPublicClient({ transport: http("https://ethereum-sepolia-rpc.publicnode.com") })
		const aztecNode = createAztecNodeClient("https://aztec-testnet.drpc.org")
		const net = await parseNetwork(TESTNET_MANIFEST, { l1: l1 as never, aztecNode })
		expect(net.l1ChainId).toBe(11155111)
		expect(net.bridge?.factory).toBeDefined()
	})
})
