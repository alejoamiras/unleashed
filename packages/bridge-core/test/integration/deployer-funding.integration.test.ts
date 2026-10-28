import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import type { Address } from "viem"
import { describe, expect, it } from "vitest"
import { FAUCET_TOKENS } from "../../src/faucet-catalog"
import { fundingSecret, isClaimed, matchFundings, scanFundings } from "../../scripts/deployer-funding"
import { catalogStatus, dripCatalog, isInitialized, type SelfFundedDeployOptions, runSelfFundedDeploy } from "../../scripts/drip-deploy"
import { ACCOUNT_CLAIM_DEPLOY_GAS, feeLimitOf, selfPaidClaimGas } from "../../scripts/fee-juice-l2"
import { mintFeeAsset } from "../../scripts/sandbox/l1"
import { l2CtxFor } from "../../scripts/sandbox/l2"
import { INTEGRATION, sandbox } from "./sandbox"

class Killed extends Error {}

/** A salt nobody has deployed at, so the catalog starts with all of its work left. */
const freshSalt = () => Math.floor(Math.random() * 2 ** 31)

describe.skipIf(!INTEGRATION)("the self-funded Drip deploy", () => {
	it("funds a fresh deployer, survives a kill after the deposit and after the claim, tops up, then sends nothing", async () => {
		const { clients } = await sandbox()
		const { l1, l2 } = clients
		const funder = l1.account.address
		const portal = clients.deployment.feeJuicePortal as Address
		const asset = clients.deployment.feeJuice as Address
		const seed = Fr.random()
		const { signingKey, secretKey } = await deriveNuloAccountKeys(seed)
		const manager = await (
			l2.wallet as unknown as {
				createSchnorrAccount: (
					s: unknown,
					salt: Fr,
					k: unknown,
				) => Promise<
					SelfFundedDeployOptions["deployer"]["manager"] & {
						getAccount: () => Promise<{ getAddress: () => AztecAddress }>
					}
				>
			}
		).createSchnorrAccount(secretKey, Fr.random(), signingKey)
		const address = (await manager.getAccount()).getAddress()
		const catalog = await dripCatalog({ dripperSalt: freshSalt(), tokens: FAUCET_TOKENS.map((t) => ({ ...t, salt: freshSalt() })) })
		const scanFrom = await l1.pub.getBlockNumber()
		// The account's own deploy and little more, so the catalog runs short before it is done.
		const bootstrap = (feeLimitOf(await selfPaidClaimGas(l2.node, ACCOUNT_CLAIM_DEPLOY_GAS)) * 105n) / 100n
		const topUp = bootstrap * 1000n
		await mintFeeAsset(l1, asset, funder, bootstrap + topUp)

		const run = (o: Partial<SelfFundedDeployOptions> = {}) =>
			runSelfFundedDeploy({
				l1,
				portal,
				asset,
				funder,
				scanFrom,
				node: l2.node,
				wallet: l2.wallet,
				deployer: { address, seed, manager },
				catalog,
				cap: bootstrap + topUp,
				log: (line) => console.log(`  [drip-deploy] ${line}`),
				forceBlock: l2CtxFor(l2, l2.relayer).forceBlock,
				...o,
			})
		const fundings = async () => {
			const found = await scanFundings(l1.pub, {
				portal,
				recipient: address.toString(),
				funder,
				fromBlock: scanFrom,
				toBlock: await l1.pub.getBlockNumber(),
			})
			return (await matchFundings(found, seed)).matched
		}
		const accountUp = () => isInitialized(l2.node, address, manager.getInstance().initializationHash)
		const quiet = async () => ({
			nonce: await l1.pub.getTransactionCount({ address: funder, blockTag: "pending" }),
			balance: await getFeeJuiceBalance(address, l2.node),
		})
		const killAt = (stage: "deposited" | "claimed") => (s: string) => {
			if (s === stage) throw new Killed(stage)
		}

		await expect(run({ fund: bootstrap, onStage: killAt("deposited") })).rejects.toBeInstanceOf(Killed)
		expect((await fundings()).map((f) => f.n)).toEqual([1])
		expect(await accountUp()).toBe(false)

		await expect(run({ fund: bootstrap, onStage: killAt("claimed") })).rejects.toBeInstanceOf(Killed)
		const [first] = await fundings()
		expect(first?.n, "no second deposit after the kill").toBe(1)
		expect(await accountUp()).toBe(true)
		expect(await isClaimed(l2.node, { key: first?.key ?? "0x", secret: fundingSecret(seed, 1) })).toBe(true)

		const { nonce } = await quiet()
		await expect(run()).rejects.toThrow(/re-run with --fund/)
		expect((await quiet()).nonce, "no deposit after the kill").toBe(nonce)
		expect(await fundings()).toHaveLength(1)
		expect(
			(await catalogStatus(l2.node, catalog)).some((s) => !s.initialized),
			"work left at a short balance",
		).toBe(true)

		await run({ fund: topUp })
		const all = await fundings()
		expect(all.map((f) => f.n)).toEqual([1, 2])
		expect(await isClaimed(l2.node, all[1] as (typeof all)[number])).toBe(true)
		expect((await catalogStatus(l2.node, catalog)).every((s) => s.initialized)).toBe(true)

		const done = await quiet()
		await run({ fund: topUp })
		expect(await quiet(), "a finished catalog sends nothing").toEqual(done)
		expect(await fundings()).toHaveLength(2)
	})
})
