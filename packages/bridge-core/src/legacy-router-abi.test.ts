import { toEventSelector, toFunctionSelector } from "viem"
import { describe, expect, it } from "vitest"
import { LEGACY_ROUTER_ABI } from "./legacy-router-abi"

// The deployed router's selectors and topics, taken while the ABI was still pinned against its forge artifact.
const DEPLOYED: Record<string, string> = {
	bridgeWithFuel: "0xc6efb233",
	bridge: "0xb1ec1968",
	BridgeWithFuel: "0x9e153cf9d2bfd0a86a4f333387d61ceb87e24643ad3857c67f18d175471d2eec",
	Bridge: "0x22b66e41944484143f17a0b560e4c6be934901122250b409823caeb0edcc1fee",
}

describe("the frozen legacy router ABI", () => {
	it("decodes exactly the deployed router's calls and events", () => {
		const ours = Object.fromEntries(
			LEGACY_ROUTER_ABI.map((item) => [item.name, item.type === "function" ? toFunctionSelector(item) : toEventSelector(item)]),
		)
		expect(ours).toEqual(DEPLOYED)
	})
})
