/**
 * The router-only conductor rehearsed on the sandbox's live generation, through the same core the live run drives,
 * with a journal and candidate of its own: a crash between the swapper and the router, the resume, an identical
 * re-run, a changed router, and the strict verifier over what it wrote.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address } from "viem"
import { afterAll, describe, expect, it } from "vitest"
import type { L1Ctx } from "../../src/flows"
import { parseManifestV2Strict } from "../../src/manifest-v2"
import { openDeployJournal, readCandidate, readDeployJournal } from "../../scripts/deploy-manifest"
import { deployDepositRouter } from "../../scripts/generation"
import { deployRouterOnly, type RouterOnlyOptions, type RouterOnlyResult } from "../../scripts/generation-router"
import { evmArtifact } from "../../scripts/script-artifacts"
import { verifyL1Manifest } from "../../scripts/verify-l1"
import { INTEGRATION, sandbox } from "./sandbox"

/** Canonical Permit2, which the sandbox installs at its real address. */
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"

describe.skipIf(!INTEGRATION)("router-only deploy, rehearsed on the sandbox generation", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-only-rehearsal-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))
	let options: RouterOnlyOptions
	let first: RouterOnlyResult

	const setUp = async (): Promise<RouterOnlyOptions> => {
		const { clients, manifest } = await sandbox()
		const d = clients.handle.deployment
		return {
			l1: clients.l1,
			network: {
				l1ChainId: clients.handle.l1ChainId,
				rollupVersion: clients.handle.rollupVersion,
				registry: d.registry as Address,
				feeJuicePortal: d.feeJuicePortal as Address,
				feeJuice: d.feeJuice as Address,
				permit2: PERMIT2,
			},
			journalPath: join(dir, "journal.jsonl"),
			base: manifest,
			rates: Object.fromEntries((manifest.bridge?.tokens ?? []).map((t) => [t.erc20.toLowerCase(), 10n ** 18n])),
			candidatePath: join(dir, "candidate.json"),
		}
	}
	const pendingNonce = () => options.l1.pub.getTransactionCount({ address: options.l1.account.address, blockTag: "pending" })
	const kinds = () => readDeployJournal(options.journalPath).map((s) => s.kind)

	it("a crash between the swapper and the router resumes without redeploying the swapper", async () => {
		options = await setUp()
		const routerCode = evmArtifact("DepositRouter").bytecode
		const wallet = options.l1.wallet
		const crashing = {
			...options.l1,
			wallet: {
				...wallet,
				deployContract: async (args: { bytecode: string }) => {
					if (args.bytecode === routerCode) throw new Error("simulated crash before the router's broadcast")
					return wallet.deployContract(args as never)
				},
			},
		} as unknown as L1Ctx
		await expect(deployRouterOnly({ ...options, l1: crashing })).rejects.toThrow(/simulated crash/)
		expect(kinds()).toEqual(["identity", "fuel-swapper-deployed"])
		const [crashed] = readDeployJournal(options.journalPath).flatMap((s) => (s.kind === "fuel-swapper-deployed" ? [s.address] : []))

		const before = await pendingNonce()
		first = await deployRouterOnly(options)
		expect(first.fuelSwapper).toEqual({ address: crashed, adopted: true })
		expect(first.depositRouter.adopted).toBe(false)
		// The rates and the inventory landed before the crash: the resume sends the router alone.
		expect((await pendingNonce()) - before).toBe(1)
		expect(kinds()).toEqual(["identity", "fuel-swapper-deployed", "deposit-router-deployed"])
	})

	it("an identical re-run adopts both and sends no transaction", async () => {
		const before = await pendingNonce()
		const again = await deployRouterOnly(options)
		expect(again.fuelSwapper).toEqual({ address: first.fuelSwapper.address, adopted: true })
		expect(again.depositRouter).toEqual({ address: first.depositRouter.address, adopted: true })
		expect(await pendingNonce()).toBe(before)
		expect(kinds()).toHaveLength(3)
	})

	it("a changed router deploys beside the first and appends a step; the unchanged one still adopts", async () => {
		const { clients } = await sandbox()
		const journal = openDeployJournal(options.journalPath)
		const changed = await deployDepositRouter(options.l1, journal, {
			permit2: PERMIT2,
			feeJuicePortal: options.network.feeJuicePortal,
			factory: options.base.bridge?.l1.factory as Address,
			swapTarget: first.fuelSwapper.address,
			owner: clients.l1b.account.address,
		})
		expect(changed.adopted).toBe(false)
		expect(changed.address).not.toBe(first.depositRouter.address)
		const routers = readDeployJournal(options.journalPath).flatMap((s) => (s.kind === "deposit-router-deployed" ? [s.address] : []))
		expect(routers).toEqual([first.depositRouter.address, changed.address])

		const before = await pendingNonce()
		expect((await deployRouterOnly(options)).depositRouter).toEqual({ address: first.depositRouter.address, adopted: true })
		expect(await pendingNonce()).toBe(before)
	})

	it("the candidate names the new router, parses strictly and passes verify:l1 --strict", async () => {
		const candidate = readCandidate(options.candidatePath)
		if (!candidate?.bridge) throw new Error("the conductor wrote no candidate")
		await parseManifestV2Strict(candidate)
		expect(candidate.bridge.l1).toMatchObject({
			depositRouter: first.depositRouter.address,
			fuelSwapper: first.fuelSwapper.address,
		})
		const { clients } = await sandbox()
		expect(await verifyL1Manifest(candidate, clients.handle.anvilUrl, { strict: true })).toBe(0)
	})
})
