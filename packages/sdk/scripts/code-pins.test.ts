import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CODE_PINS } from "../src/protocol/code-hash.ts"
import { buildPin, FORGE_OUT, PINNED } from "./code-pins.ts"

// The SDK refuses any network whose contracts are not these builds: a source change without new pins would strand
// every integrator on the old code. CI's contract job builds first and asserts the output exists.
describe.skipIf(!existsSync(FORGE_OUT))("the SDK's code pins", () => {
	it.each(PINNED)("%s is this checkout's forge build", (contract) => {
		expect(buildPin(contract)).toEqual(CODE_PINS[contract])
	})
})
