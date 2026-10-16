import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LIFI_ALLOW_EXCHANGES, LIFI_DENY_EXCHANGES, LIFI_MIN_COMPOSE_GAS, LIFI_TO_CONTRACT_GAS_LIMIT } from "./lifi-gas"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"))

// The mainnet forks prove these figures against the recorded fixtures through Solidity mirrors; a constant changed
// here without re-recording and re-running them would ship unproven.
describe("lifi-gas", () => {
	it("every constant equals what the fork-proven fixtures were recorded with", () => {
		const mainnet = fixture("mainnet.json")
		expect(BigInt(mainnet.crossChain.baseUsdc.toContractGasLimit)).toBe(LIFI_TO_CONTRACT_GAS_LIMIT)
		expect(BigInt(fixture("mainnet.compose.json").composeGas)).toBe(LIFI_MIN_COMPOSE_GAS)
		expect(mainnet.expiringRfqExchanges).toEqual([...LIFI_DENY_EXCHANGES])
	})

	// The recorder asks with the deny list only, so a recording in which LI.FI picks an unproven venue fails here.
	it("the venue LI.FI picked for the recorded deadline-free quote is a proven one, and no venue is both", () => {
		const allowed: readonly string[] = LIFI_ALLOW_EXCHANGES
		expect(allowed).toContain(fixture("mainnet.json").sameChain.deadlineFree.tool)
		expect(LIFI_DENY_EXCHANGES.filter((v) => allowed.includes(v))).toEqual([])
	})
})
