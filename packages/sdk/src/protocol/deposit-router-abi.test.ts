import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { type AbiEntry as Entry, missingFrom } from "./abi-shape.ts"
import { DEPOSIT_ROUTER_ABI } from "./deposit-router-abi.ts"

const ARTIFACT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"contracts",
	"bridge",
	"evm",
	"out",
	"DepositRouter.sol",
	"DepositRouter.json",
)

// Read lazily inside each `it`: `skipIf` still runs the describe factory at collection time, and the unit-test
// job has no forge `out/`.
const loadAbi = () => (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Entry[] }).abi
const ours = DEPOSIT_ROUTER_ABI as unknown as Entry[]

describe.skipIf(!existsSync(ARTIFACT))("deposit-router-abi pin (forge artifact)", () => {
	it("every entry matches the artifact's whole entry", () => {
		expect(missingFrom(ours, loadAbi())).toEqual([])
	})

	it("carries every error the router can raise", () => {
		const names = (abi: Entry[]) =>
			abi
				.filter((e) => e.type === "error")
				.map((e) => e.name)
				.sort()
		expect(names(ours)).toEqual(names(loadAbi()))
	})
})
