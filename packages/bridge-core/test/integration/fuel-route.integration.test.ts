/**
 * The fuel-only route rehearsed on the sandbox through the core mainnet's conductor drives, with a journal and
 * candidate of its own: a crash before the router and the resume, an identical re-run, the strict verifier over what
 * it wrote, and gas-only sends through the route claimed as public Fee Juice and as PrivateFPC credit.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Address } from "viem"
import { afterAll, describe, expect, it } from "vitest"
import { type L1Ctx, fuelRouteOf } from "@unleashed/sdk/internal"
import { parseManifestV2Strict } from "@unleashed/sdk/protocol"
import { readCandidate, readDeployJournal } from "../../scripts/deploy-manifest"
import { deployFuelRoute, type FuelRouteOptions, type FuelRouteResult } from "../../scripts/fuel-route"
import { MIN_FJ, PERMIT2 } from "../../scripts/sandbox/constants"
import { flowGasOnly } from "../../scripts/sandbox/flows"
import { flowGasOnlyPrivate } from "../../scripts/sandbox/flows-matrix"
import { sandboxFuelBlock } from "../../scripts/sandbox/manifest"
import { evmArtifact } from "../../scripts/script-artifacts"
import { sendL1 } from "../../scripts/script-l1"
import { verifyL1Manifest } from "../../scripts/verify-l1"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("fuel-only route, rehearsed on the sandbox", () => {
	const dir = mkdtempSync(join(tmpdir(), "fuel-route-rehearsal-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))
	let options: FuelRouteOptions
	let first: FuelRouteResult

	const setUp = async (): Promise<FuelRouteOptions> => {
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
			// The sandbox's own network without its generation: the placeholder a route is for.
			base: { ...manifest, bridge: null },
			fuel: { slippageBps: 300, minFuelFj: MIN_FJ.toString(), fjPerTx: sandboxFuelBlock().fjPerTx },
			candidatePath: join(dir, "candidate.json"),
		}
	}
	const pendingNonce = () => options.l1.pub.getTransactionCount({ address: options.l1.account.address, blockTag: "pending" })
	const kinds = () => readDeployJournal(options.journalPath).map((s) => s.kind)

	it("a crash before the router resumes without redeploying the gate or the swapper", async () => {
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
		await expect(deployFuelRoute({ ...options, l1: crashing })).rejects.toThrow(/simulated crash/)
		expect(kinds()).toEqual(["identity", "fuel-gate-deployed", "fuel-swapper-deployed"])

		const before = await pendingNonce()
		first = await deployFuelRoute(options)
		expect(first.gate.adopted).toBe(true)
		expect(first.fuelSwapper?.adopted).toBe(true)
		expect(first.depositRouter.adopted).toBe(false)
		expect((await pendingNonce()) - before).toBe(1)
		expect(kinds()).toEqual(["identity", "fuel-gate-deployed", "fuel-swapper-deployed", "deposit-router-deployed"])
	})

	it("an identical re-run adopts everything and sends no transaction", async () => {
		const before = await pendingNonce()
		const again = await deployFuelRoute(options)
		expect(again.gate).toEqual({ address: first.gate.address, adopted: true })
		expect(again.depositRouter).toEqual({ address: first.depositRouter.address, adopted: true })
		expect(await pendingNonce()).toBe(before)
		expect(kinds()).toHaveLength(4)
	})

	it("the candidate names the route, parses strictly and passes verify:l1 --strict, but not while the gate is paused", async () => {
		const candidate = readCandidate(options.candidatePath)
		if (!candidate?.fuelRoute) throw new Error("the conductor wrote no fuel route")
		await parseManifestV2Strict(candidate)
		expect(candidate.bridge).toBeNull()
		expect(candidate.fuelRoute).toMatchObject({
			depositRouter: first.depositRouter.address,
			gate: first.gate.address,
			fuelSwapper: first.fuelSwapper?.address,
			guardian: options.l1.account.address.toLowerCase(),
		})
		const { clients } = await sandbox()
		const anvil = clients.handle.anvilUrl
		expect(await verifyL1Manifest(candidate, anvil, { strict: true })).toBe(0)

		const pause = (paused: boolean) =>
			sendL1(options.l1, {
				address: first.gate.address,
				abi: evmArtifact("FuelOnlyGate").abi,
				functionName: "setDepositsPaused",
				args: [paused],
			})
		await pause(true)
		expect(await verifyL1Manifest(candidate, anvil, { strict: true })).toBe(1)
		expect(await verifyL1Manifest(candidate, anvil)).toBe(0)
		await pause(false)
	})

	it("gas-only sends through the route claim as public Fee Juice and as PrivateFPC credit", async () => {
		const candidate = readCandidate(options.candidatePath)
		const route = candidate && fuelRouteOf(candidate)
		if (!route) throw new Error("the candidate names no route")
		const a = await freshActor()
		const s = { ...a.s, route }
		expect(await flowGasOnly(s)).toContain("claimed as fee juice")
		expect(await flowGasOnlyPrivate(s)).toContain("private gas")
	})
})
