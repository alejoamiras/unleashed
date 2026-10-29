import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	catalogStatus,
	deployDripCatalogOnMainnet,
	deployEntry,
	dripCatalog,
	runSelfFundedDeploy,
	type SelfFundedDeployOptions,
} from "./drip-deploy"

/** Any read or write on this L1 fails the test: a finished catalog must never reach it. */
const untouchableL1 = new Proxy(
	{},
	{
		get: (_, k) => {
			throw new Error(`touched L1: ${String(k)}`)
		},
	},
) as SelfFundedDeployOptions["l1"]

const nodeWhere = (initialized: boolean, published: boolean) =>
	({
		getNullifierMembershipWitness: vi.fn(async () => (initialized ? {} : undefined)),
		getContract: vi.fn(async () => (published ? {} : undefined)),
	}) as unknown as SelfFundedDeployOptions["node"]

afterEach(() => vi.restoreAllMocks())

describe("the Drip catalog deploy", () => {
	it("sends nothing and never reaches L1 when every contract is initialized", async () => {
		const catalog = await dripCatalog()
		const log = vi.fn()
		await runSelfFundedDeploy({
			l1: untouchableL1,
			portal: "0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3",
			asset: "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2",
			funder: `0x${"f1".repeat(20)}`,
			scanFrom: 0n,
			confirmations: 0n,
			node: nodeWhere(true, true),
			wallet: new Proxy({}, { get: (_, k) => () => Promise.reject(new Error(`touched the wallet: ${String(k)}`)) }) as never,
			deployer: {
				address: AztecAddress.ZERO,
				seed: Fr.ONE,
				manager: {
					getDeployMethod: () => Promise.reject(new Error("deployed the account")),
					getInstance: () => ({ initializationHash: Fr.ZERO }),
				},
			},
			catalog,
			fund: 1n,
			cap: 1n,
			log,
		})
		expect(log).toHaveBeenCalledWith(expect.stringMatching(/nothing to send/))
	})

	it("refuses a mainnet run before any network call while no funding key is pinned", async () => {
		const fetch = vi.spyOn(globalThis, "fetch")
		await expect(
			deployDripCatalogOnMainnet({
				nodeUrl: "http://127.0.0.1:1",
				l1RpcUrl: "http://127.0.0.1:1",
				funderKey: `0x${"ab".repeat(32)}`,
				manifest: {} as never,
				rollupVersion: 0,
				wallet: {} as never,
				deployer: {} as never,
				catalog: [],
				fund: 1n,
				cap: 1n,
				log: vi.fn(),
			}),
		).rejects.toThrow(/no pinned Drip funding key/)
		expect(fetch).not.toHaveBeenCalled()
	})

	it("initializes a published instance without publishing it again", async () => {
		const [dripper] = await dripCatalog()
		if (!dripper) throw new Error("the catalog has no Dripper")
		const [status] = await catalogStatus(nodeWhere(false, true), [dripper])
		expect(status).toMatchObject({ initialized: false, published: true })
		const send = vi.fn(async () => ({ receipt: { transactionFee: 7n } }))
		const deploy = vi.spyOn(Contract, "deploy").mockReturnValue({ send } as never)
		const from = AztecAddress.ZERO
		await expect(deployEntry({} as never, status as never, { from, fee: "fee" })).resolves.toBe(7n)
		expect(deploy).toHaveBeenCalledWith({}, dripper.artifact, [], "constructor", { salt: dripper.salt, universalDeploy: true })
		expect(send).toHaveBeenCalledWith(expect.objectContaining({ from, fee: "fee", skipInstancePublication: true }))
		await expect(deployEntry({} as never, { ...status, initialized: true } as never, { from, fee: "fee" })).rejects.toThrow(
			/already initialized/,
		)
	})
})
