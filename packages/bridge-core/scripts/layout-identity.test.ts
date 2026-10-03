import { existsSync } from "node:fs"
import { resolvePackageAsset } from "@alejoamiras/nulo-resolve-asset"
import { expect, it } from "vitest"

/**
 * The package assets bridge-core's scripts read resolve from bridge-core, the workspace that declares
 * them, under the isolated linker: a failure means an undeclared dependency or an asset the package
 * moved.
 */
const from = new URL("../package.json", import.meta.url).href

it("resolves the private-fee-juice artifact and the l1-artifacts contract sources", () => {
	expect(existsSync(resolvePackageAsset("@alejoamiras/private-fee-juice", "target/private_contract-PrivateFPC.json", { from }))).toBe(
		true,
	)
	expect(existsSync(resolvePackageAsset("@aztec-foundation/l1-artifacts", "l1-contracts/src", { from }))).toBe(true)
})
