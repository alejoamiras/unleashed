import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { balanceOf } from "../../scripts/sandbox/context"
import { type DripDeploymentRecord, dripTo, registerDripFixture } from "../../scripts/sandbox/drip"
import { ARTIFACT_FILES } from "../../scripts/sandbox/manifest"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("the faucet (cell 38)", () => {
	it("drips public and private balances of both tokens to a fresh account", async () => {
		const { clients } = await sandbox()
		const record = JSON.parse(
			readFileSync(join(clients.handle.artifactsDir, ARTIFACT_FILES.deployments), "utf8"),
		) as DripDeploymentRecord
		const a = await freshActor()
		const { dripper, tokens } = await registerDripFixture(a.s.l2.wallet, record)
		for (const [symbol, token] of tokens) {
			const decimals = record.tokens.find((t) => t.constructorArgs.symbol === symbol)?.constructorArgs.decimals ?? 0
			const amount = 5n * 10n ** BigInt(decimals)
			await dripTo(a.s.l2, dripper, token, amount, "public")
			await dripTo(a.s.l2, dripper, token, amount, "private")
			expect(await balanceOf(token, a.s.l2.from, "public"), `${symbol} public`).toBe(amount)
			expect(await balanceOf(token, a.s.l2.from, "private"), `${symbol} private`).toBe(amount)
		}
	})
})
