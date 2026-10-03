// @vitest-environment node
// Real derivation: bb.js's sync poseidon needs a WASM init that jsdom lacks and node has.
import { describe, expect, it } from "vitest"
import { checkDeploymentRecords, type DeploymentsJson, rebuildTokenInstanceFrom, type TokenDeployment } from "./deployment-records.js"
import live from "./deployments.json"

const record = (authContract?: string): TokenDeployment => ({
	address: `0x${"ab".repeat(32)}`,
	salt: 1,
	deployer: `0x${"00".repeat(32)}`,
	constructorArtifact: "constructor_with_minter",
	constructorArgs: {
		name: "SIGNAL",
		symbol: "SIGNAL",
		decimals: 6,
		minter: `0x${"11".repeat(32)}`,
		...(authContract === undefined ? {} : { authContract }),
	},
})

describe("rebuildTokenInstanceFrom — 5.0.1 record validation", () => {
	it("rejects a pre-5.0.1 record (no authContract) with a targeted error, not an arity crash", async () => {
		await expect(rebuildTokenInstanceFrom(record())).rejects.toThrow(/pre-5\.0\.1 record lacks constructorArgs\.authContract/)
	})

	it("names the offending token symbol in the error", async () => {
		await expect(rebuildTokenInstanceFrom(record())).rejects.toThrow(/token SIGNAL/)
	})
})

describe("checkDeploymentRecords", () => {
	const data = live as DeploymentsJson
	const failed = async (d: DeploymentsJson) => (await checkDeploymentRecords(d)).filter((c) => !c.ok).map((c) => c.name)

	it("passes the live file", async () => {
		const checks = await checkDeploymentRecords(data)
		expect(checks.every((c) => c.ok)).toBe(true)
		expect(checks).toHaveLength(2 + 2 * data.tokens.length)
	})

	it("fails a token whose committed address was tampered with", async () => {
		const [first, ...rest] = data.tokens
		const tampered = { ...data, tokens: [{ ...first, address: `0x${"12".repeat(32)}` }, ...rest] }
		expect(await failed(tampered)).toEqual([first.constructorArgs.symbol])
	})

	it("fails a token another contract mints, and a file with no tokens", async () => {
		const [first, ...rest] = data.tokens
		const foreign = { ...first, constructorArgs: { ...first.constructorArgs, minter: `0x${"04".repeat(32)}` } }
		expect(await failed({ ...data, tokens: [foreign, ...rest] })).toContain(`${first.constructorArgs.symbol} minter`)
		expect(await failed({ ...data, tokens: [] })).toEqual(["catalog"])
	})

	it("fails a file that drops a catalog token, repeats one, or re-salts one with its address re-derived to match", async () => {
		const [first, ...rest] = data.tokens
		expect(await failed({ ...data, tokens: [first] })).toEqual(["catalog"])
		expect(await failed({ ...data, tokens: [first, ...data.tokens] })).toEqual(["catalog", first.constructorArgs.symbol])
		const resalted = { ...first, salt: 9999 }
		const address = (await rebuildTokenInstanceFrom(resalted)).address.toString()
		expect(await failed({ ...data, tokens: [{ ...resalted, address }, ...rest] })).toEqual(["catalog"])
	})
})
