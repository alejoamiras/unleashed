import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LIFI_DENY_EXCHANGES, LIFI_MIN_COMPOSE_GAS, LIFI_TO_CONTRACT_GAS_LIMIT } from "./lifi-gas"

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
})
