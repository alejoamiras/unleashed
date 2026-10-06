import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractInstanceWithAddress } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { type Abi, encodeDeployData, getContractAddress, type Hex, keccak256, TransactionNotFoundError } from "viem"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { L1Ctx } from "../src/flows"
import { toWord } from "../src/register-hash"
import { openDeployJournal } from "./deploy-manifest"
import type { PreCreateTokenOptions } from "./generation"
import { deriveHubInstance } from "./script-l2"

vi.mock("@aztec-labs/aztec.js/deployment", () => ({
	publishContractClass: vi.fn(async () => ({ send: vi.fn(async () => ({})) })),
}))
vi.mock("@aztec-labs/aztec.js/contracts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aztec-labs/aztec.js/contracts")>()
	return {
		...actual,
		Contract: {
			...actual.Contract,
			at: actual.Contract.at,
			deploy: vi.fn(() => ({ send: vi.fn(async () => ({ receipt: { txHash: "0xhubtx" } })) })),
		},
	}
})
/** Appended to every mocked creation code: a non-empty suffix stands for a recompiled contract. */
const recompiled = vi.hoisted(() => ({ suffix: "" }))
vi.mock("./script-artifacts", () => {
	// The adoptable contracts' real constructor arities: an adoption check re-encodes their arguments.
	const arity: Record<string, number> = { TestnetFuelSwapper: 3, DepositRouter: 5 }
	const inputs = (name: string) => Array.from({ length: arity[name] ?? 0 }, () => ({ type: "address" }))
	return {
		evmArtifact: (name: string) => ({
			abi: [{ type: "constructor", stateMutability: "nonpayable", inputs: inputs(name) }],
			bytecode: `0x${name.length.toString(16).padStart(2, "0")}${recompiled.suffix}`,
		}),
	}
})
vi.mock("../src/hub-l2", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/hub-l2")>()
	return {
		...actual,
		hubAt: vi.fn((wallet: FakeWallet, address: string) => ({ wallet, address })),
		// The PXE refuses to simulate an instance it was never taught; a stub that answered anyway would
		// hide a run whose fresh wallet store never learned the hub.
		hubTokenFor: vi.fn(async (hub: { wallet: FakeWallet; address: string }, erc20: string) => {
			if (!hub.wallet.known.has(hub.address.toLowerCase())) throw new Error(`No artifact registered for ${hub.address}`)
			return BigInt(erc20) === 0n ? undefined : `0x${"ab".repeat(32)}`
		}),
	}
})

const { deployDepositRouter, deployFuelSwapper, deployGeneration, findAdoptable, fuelSwapperArgs, preCreateToken } = await import(
	"./generation"
)

/** A wallet that, like a PXE on a fresh store, knows only the instances it was taught this run. */
function freshWallet() {
	const known = new Set<string>()
	return {
		known,
		registerContractClass: vi.fn(async () => {}),
		registerContract: vi.fn(async (instance: ContractInstanceWithAddress) => {
			known.add(instance.address.toString().toLowerCase())
		}),
	}
}
type FakeWallet = ReturnType<typeof freshWallet>

const DEPLOYER = "0x7777777777777777777777777777777777777777" as const
const GUARDIAN_L2 = `0x${"7".padStart(64, "0")}`
const inputs = {
	registry: "0x1111111111111111111111111111111111111111",
	permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
	feeJuicePortal: "0x2222222222222222222222222222222222222222",
	feeJuice: "0x3333333333333333333333333333333333333333",
	guardianL1: DEPLOYER,
	guardianL2: GUARDIAN_L2,
	swapTarget: "0x4444444444444444444444444444444444444444",
} as const

interface ChainOptions {
	/** How many of the deployer's nonces belong to transactions that have not been mined, so `latest`
	 *  and `pending` disagree exactly as they do around a queued transaction. */
	pending?: bigint
	/** A hub the chain already carries at the derived address, as a crashed earlier run would leave. */
	landedHub?: ContractInstanceWithAddress
	/** Class ids the network already carries — on a shared network the Token class is never ours to publish. */
	publishedClasses?: Set<string>
}

/** What the deployed contracts answer for every constant read; the factory's `L2_HUB` is per test. */
function constantReads(chain: { expected: { factory: () => string; implementation: () => string } }): Record<string, string> {
	return {
		IMPLEMENTATION: chain.expected.implementation(),
		FACTORY: chain.expected.factory(),
		FEE_ASSET: inputs.feeJuice,
		permit2: inputs.permit2,
		feeJuicePortal: inputs.feeJuicePortal,
		swapTarget: inputs.swapTarget,
	}
}

/** An L1 whose deployer nonce advances per deploy and whose reads answer what a real generation would. */
function fakeChain(startNonce: bigint, predictedAt = startNonce, opts: ChainOptions = {}) {
	const pending = opts.pending ?? 0n
	let nonce = startNonce
	const deployed: string[] = []
	const factory = () => getContractAddress({ from: DEPLOYER, nonce: predictedAt }).toLowerCase()
	const implementation = () => getContractAddress({ from: factory() as `0x${string}`, nonce: 1n }).toLowerCase()
	const router = () => getContractAddress({ from: DEPLOYER, nonce: predictedAt + 1n }).toLowerCase()
	const l1 = {
		account: { address: DEPLOYER },
		wallet: {
			chain: undefined,
			deployContract: vi.fn(async ({ bytecode, nonce: pinned }: { bytecode: string; nonce?: number }) => {
				// A pinned nonce a queued transaction already took is rejected, never re-assigned.
				if (pinned !== undefined && BigInt(pinned) !== nonce) throw new Error("nonce too low")
				const address = getContractAddress({ from: DEPLOYER, nonce }).toLowerCase()
				nonce += 1n
				deployed.push(bytecode)
				return `0x${address.slice(2).padStart(64, "0")}`
			}),
		},
		pub: {
			getTransactionCount: vi.fn(async ({ blockTag }: { blockTag?: string }) =>
				Number(blockTag === "pending" ? nonce : nonce - pending),
			),
			getCode: vi.fn(async () => undefined),
			waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => ({
				status: "success",
				contractAddress: `0x${hash.slice(-40)}`,
			})),
			readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
				const answer = constantReads({ expected: { factory, implementation } })[functionName]
				if (answer === undefined) throw new Error(`unexpected read ${functionName}`)
				return answer
			}),
		},
	}
	// The node answers a hub only once one is on chain: seeded by `landedHub`, or put there by the
	// deploy. What the deploy leaves needs no preimage — only the adopt path reads one.
	let hub: unknown = opts.landedHub
	vi.mocked(Contract.deploy).mockImplementation(
		() =>
			({
				send: async () => {
					hub = { landed: true }
					return { receipt: { txHash: "0xhubtx" } }
				},
			}) as never,
	)
	const l2 = {
		wallet: freshWallet(),
		node: {
			getContract: vi.fn(async () => hub),
			getContractClass: vi.fn(async (id: Fr) => (opts.publishedClasses?.has(id.toString()) ? {} : undefined)),
		},
		from: AztecAddress.fromStringUnsafe(GUARDIAN_L2),
		deployOpts: {},
		sendOpts: {},
	}
	return {
		l1: l1 as unknown as L1Ctx,
		l2: l2 as never,
		wallet: l2.wallet,
		deployed,
		expected: { factory, implementation, router },
	}
}

/** The factory's `L2_HUB` read answers with whatever the hub step journalled — the binding under test. */
function answerReads(journal: ReturnType<typeof openDeployJournal>, chain: ReturnType<typeof fakeChain>): void {
	;(chain.l1.pub.readContract as unknown as ReturnType<typeof vi.fn>).mockImplementation(
		async ({ functionName }: { functionName: string }) => {
			const answer = constantReads(chain)[functionName]
			if (answer !== undefined) return answer
			const hubStep = journal.steps.find((s) => s.kind === "hub-deployed")
			return hubStep && hubStep.kind === "hub-deployed" ? hubStep.hub : ""
		},
	)
}

describe("deployGeneration — crash-resume at every journalled step", () => {
	const dir = mkdtempSync(join(tmpdir(), "generation-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))
	beforeEach(() => vi.clearAllMocks())

	it("a clean run journals the five steps in order and binds the hub to the predicted factory", async () => {
		const chain = fakeChain(5n)
		const journal = openDeployJournal(join(dir, "clean.jsonl"))
		answerReads(journal, chain)
		const record = await deployGeneration(chain.l1, chain.l2, inputs, journal)
		expect(journal.steps.map((s) => s.kind)).toEqual([
			"classes-published",
			"factory-predicted",
			"factory-deployed",
			"router-deployed",
			"hub-deployed",
		])
		expect(record.l1.factory).toBe(chain.expected.factory())
		expect(record.l1.implementation).toBe(chain.expected.implementation())
		expect(record.l1.router).toBe(chain.expected.router())
		expect(record.l2.hub.salt).toBe(`0x${chain.expected.factory().slice(2).padStart(64, "0")}`)
		expect(record.l2.hub.constructorArgs).toEqual([record.l2.tokenClassId, chain.expected.factory(), GUARDIAN_L2])
		expect(chain.deployed).toHaveLength(2)
	})

	it("a class the network already carries is not re-published, and a lost publication race is a no-op", async () => {
		// The Token class is shared on a live network: the node already answers it, so no publication is
		// sent for it — only the hub class goes out.
		const { publishContractClass } = await import("@aztec-labs/aztec.js/deployment")
		const learn = fakeChain(5n)
		const learnJournal = openDeployJournal(join(dir, "classes-learn.jsonl"))
		answerReads(learnJournal, learn)
		const reference = await deployGeneration(learn.l1, learn.l2, inputs, learnJournal)

		vi.mocked(publishContractClass).mockClear()
		const shared = fakeChain(5n, 5n, { publishedClasses: new Set([reference.l2.tokenClassId]) })
		const sharedJournal = openDeployJournal(join(dir, "classes-shared.jsonl"))
		answerReads(sharedJournal, shared)
		await expect(deployGeneration(shared.l1, shared.l2, inputs, sharedJournal)).resolves.toEqual(reference)
		expect(publishContractClass).toHaveBeenCalledTimes(1)

		// The node said absent, but the publication lost the race: the registry's nullifier rejection,
		// in the live node's wording, is the same no-op — once the node serves the class.
		const racedClasses = new Set<string>()
		vi.mocked(publishContractClass).mockImplementationOnce(
			async () =>
				({
					send: async () => {
						racedClasses.add(reference.l2.tokenClassId)
						throw new Error("Invalid tx: Existing nullifier")
					},
				}) as never,
		)
		const raced = fakeChain(5n, 5n, { publishedClasses: racedClasses })
		const racedJournal = openDeployJournal(join(dir, "classes-raced.jsonl"))
		answerReads(racedJournal, raced)
		await expect(deployGeneration(raced.l1, raced.l2, inputs, racedJournal)).resolves.toEqual(reference)

		// The same wording with the class still absent is not a race — nothing was published.
		vi.mocked(publishContractClass).mockImplementationOnce(
			async () =>
				({
					send: async () => {
						throw new Error("Invalid tx: Existing nullifier")
					},
				}) as never,
		)
		const phantom = fakeChain(5n)
		const phantomJournal = openDeployJournal(join(dir, "classes-phantom.jsonl"))
		answerReads(phantomJournal, phantom)
		await expect(deployGeneration(phantom.l1, phantom.l2, inputs, phantomJournal)).rejects.toThrow(/does not serve it/)
		expect(phantomJournal.steps.map((s) => s.kind)).toEqual([])
		// Four full generation runs take a CI runner about 5 s, the default timeout.
	}, 30_000)

	it("predicts and pins the factory nonce from the PENDING count, not the mined one", async () => {
		// One of this key's transactions is still queued: `latest` says 5, but the factory can only ever
		// be the deployer's 6th CREATE, and a prediction from `latest` would name an unreachable hub.
		const chain = fakeChain(6n, 6n, { pending: 1n })
		const journal = openDeployJournal(join(dir, "pending.jsonl"))
		answerReads(journal, chain)
		const record = await deployGeneration(chain.l1, chain.l2, inputs, journal)
		expect(record.l1.factory).toBe(getContractAddress({ from: DEPLOYER, nonce: 6n }).toLowerCase())
		expect(vi.mocked(chain.l1.wallet.deployContract)).toHaveBeenCalledWith(expect.objectContaining({ nonce: 6 }))
	})

	it("re-running after a crash past each step skips the landed steps and reuses the recorded identities", async () => {
		const clean = fakeChain(5n)
		const full = openDeployJournal(join(dir, "full.jsonl"))
		answerReads(full, clean)
		const reference = await deployGeneration(clean.l1, clean.l2, inputs, full)

		for (let crashAfter = 1; crashAfter < full.steps.length; crashAfter++) {
			const partial = openDeployJournal(join(dir, `crash-${crashAfter}.jsonl`))
			for (const step of full.steps.slice(0, crashAfter)) partial.append(step)
			// The chain state after the crash: every L1 deploy that was journalled has consumed its nonce.
			const l1Deploys = full.steps
				.slice(0, crashAfter)
				.filter((s) => s.kind === "factory-deployed" || s.kind === "router-deployed").length
			const resumed = fakeChain(5n + BigInt(l1Deploys), 5n)
			answerReads(partial, resumed)
			const record = await deployGeneration(resumed.l1, resumed.l2, inputs, partial)
			expect(record, `crash after step ${crashAfter}`).toEqual(reference)
			expect(resumed.deployed.length, `L1 deploys after crash ${crashAfter}`).toBe(2 - l1Deploys)
			expect(partial.steps.map((s) => s.kind)).toEqual(full.steps.map((s) => s.kind))
		}
	})

	it("a moved deployer nonce kills the generation instead of deploying a factory the hub is not bound to", async () => {
		const chain = fakeChain(5n)
		const journal = openDeployJournal(join(dir, "moved.jsonl"))
		journal.append({
			kind: "factory-predicted",
			factory: getContractAddress({ from: DEPLOYER, nonce: 4n }).toLowerCase(),
			implementation: getContractAddress({ from: getContractAddress({ from: DEPLOYER, nonce: 4n }), nonce: 1n }).toLowerCase(),
		})
		await expect(deployGeneration(chain.l1, chain.l2, inputs, journal)).rejects.toThrow(/this generation is dead/)
		expect(chain.deployed).toHaveLength(0)
	})

	it("a factory that landed before its journal entry is adopted, not redeployed — if its bindings agree", async () => {
		// A clean run, to learn this generation's class ids and the hub the factory must be bound to.
		const clean = fakeChain(5n)
		const cleanJournal = openDeployJournal(join(dir, "landed-clean.jsonl"))
		answerReads(cleanJournal, clean)
		const reference = await deployGeneration(clean.l1, clean.l2, inputs, cleanJournal)
		const classes = cleanJournal.steps.find((st) => st.kind === "classes-published")
		if (classes?.kind !== "classes-published") throw new Error("no class ids journalled")
		const predicted = { factory: reference.l1.factory, implementation: reference.l1.implementation }

		// The crash happened after the factory tx landed: the nonce moved on, the journal did not.
		const landed = (boundHub: string) => {
			const chain = fakeChain(6n, 5n)
			;(chain.l1.pub.getCode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("0x6001")
			;(chain.l1.pub.readContract as unknown as ReturnType<typeof vi.fn>).mockImplementation(
				async ({ functionName }: { functionName: string }) => constantReads(chain)[functionName] ?? boundHub,
			)
			const journal = openDeployJournal(join(dir, `landed-${boundHub.slice(-6)}.jsonl`))
			journal.append(classes)
			journal.append({ kind: "factory-predicted", ...predicted })
			return { chain, journal }
		}

		const ours = landed(reference.l2.hub.address)
		const record = await deployGeneration(ours.chain.l1, ours.chain.l2, inputs, ours.journal)
		expect(record).toEqual(reference)
		// Only the router was sent; the factory step was adopted with no transaction of its own.
		expect(ours.chain.deployed).toHaveLength(1)
		const adopted = ours.journal.steps.find((st) => st.kind === "factory-deployed")
		expect(adopted && adopted.kind === "factory-deployed" ? adopted.txHash : "missing").toBeUndefined()

		// A stranger's contract at the predicted address, bound to another hub, is refused.
		const foreign = landed(`0x${"f".repeat(64)}`)
		await expect(deployGeneration(foreign.chain.l1, foreign.chain.l2, inputs, foreign.journal)).rejects.toThrow(/landed factory L2_HUB/)
		expect(foreign.chain.deployed).toHaveLength(0)
	})

	it("a hub that landed before its journal entry is adopted, not redeployed — if its preimage agrees", async () => {
		const clean = fakeChain(5n)
		const cleanJournal = openDeployJournal(join(dir, "hub-clean.jsonl"))
		answerReads(cleanJournal, clean)
		const reference = await deployGeneration(clean.l1, clean.l2, inputs, cleanJournal)
		const instance = await deriveHubInstance(reference.l2.hub)

		// The crash happened after the hub's deploy landed: the chain carries it, the journal does not.
		const resumed = (landedHub: ContractInstanceWithAddress, label: string) => {
			const chain = fakeChain(7n, 5n, { landedHub })
			const journal = openDeployJournal(join(dir, `hub-landed-${label}.jsonl`))
			for (const step of cleanJournal.steps.filter((s) => s.kind !== "hub-deployed")) journal.append(step)
			answerReads(journal, chain)
			return { chain, journal }
		}

		const ours = resumed(instance, "ours")
		vi.mocked(Contract.deploy).mockClear()
		const record = await deployGeneration(ours.chain.l1, ours.chain.l2, inputs, ours.journal)
		expect(record).toEqual(reference)
		// A second deploy at the same salt would revert on the consumed deployment nullifier.
		expect(Contract.deploy).not.toHaveBeenCalled()
		const adopted = ours.journal.steps.find((st) => st.kind === "hub-deployed")
		expect(adopted && adopted.kind === "hub-deployed" ? adopted.txHash : "missing").toBeUndefined()

		// Another contract at the derived address, constructed with arguments of its own, is refused.
		const foreignHub = resumed({ ...instance, initializationHash: Fr.random() }, "foreign")
		await expect(deployGeneration(foreignHub.chain.l1, foreignHub.chain.l2, inputs, foreignHub.journal)).rejects.toThrow(
			/landed hub initializationHash/,
		)
	})
})

describe("preCreateToken", () => {
	const dir = mkdtempSync(join(tmpdir(), "pre-create-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	const portal = "0x5555555555555555555555555555555555555555"
	async function preCreated(journalName: string, opts?: PreCreateTokenOptions) {
		const deployRun = fakeChain(5n)
		const journal = openDeployJournal(join(dir, journalName))
		answerReads(journal, deployRun)
		const gen = await deployGeneration(deployRun.l1, deployRun.l2, inputs, journal)

		const preCreateRun = fakeChain(7n, 5n)
		;(preCreateRun.l1.pub.readContract as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
			portal,
			decimals: 6,
			registerIndex: 0n,
			nameWord: toWord(new TextEncoder().encode("Pound Coin")),
			symbolWord: toWord(new TextEncoder().encode("GBPC")),
			registerKey: `0x${"1".repeat(64)}`,
		})
		const erc20 = "0x6666666666666666666666666666666666666666"
		return { gen, preCreateRun, token: await preCreateToken(preCreateRun.l1, preCreateRun.l2, gen, erc20, journal, opts) }
	}

	it("teaches its own run's fresh wallet the hub before reading `token_for` on it", async () => {
		const { gen, preCreateRun, token } = await preCreated("generation.jsonl")
		expect(token).toMatchObject({ portal, displaySymbol: "GBPC", source: "permissionless-mint", sourceContract: "MintableERC20" })
		expect(preCreateRun.wallet.known).toContain(gen.l2.hub.address.toLowerCase())
		expect(preCreateRun.wallet.known).toContain(token.l2Token.toLowerCase())
	})

	it("labels a canonical token without the mint contract the app would offer a mint button for", async () => {
		const { token } = await preCreated("canonical.jsonl", { source: "canonical" })
		expect(token.source).toBe("canonical")
		expect(token).not.toHaveProperty("sourceContract")
	})
})

describe("deployFuelSwapper / deployDepositRouter — exact-match adoption", () => {
	const dir = mkdtempSync(join(tmpdir(), "router-only-"))
	afterAll(() => rmSync(dir, { recursive: true, force: true }))

	interface Creation {
		tx: { to: string | null; input: string }
		receipt: { status: string; contractAddress: string | null }
	}

	/** An L1 where each deploy lands at the deployer's next CREATE address, keeps its creation transaction and
	 *  receipt, and carries code from then on. */
	function landingChain() {
		let nonce = 3n
		const code = new Set<string>()
		const creations = new Map<string, Creation>()
		const creation = (hash: string): Creation => {
			const c = creations.get(hash)
			if (!c) throw new TransactionNotFoundError({ hash: hash as Hex })
			return c
		}
		type DeployArgs = { abi: Abi; bytecode: Hex; args: readonly unknown[]; nonce?: number }
		const l1 = {
			account: { address: DEPLOYER },
			wallet: {
				chain: undefined,
				deployContract: vi.fn(async ({ abi, bytecode, args, nonce: pinned }: DeployArgs) => {
					if (pinned === undefined || BigInt(pinned) !== nonce) throw new Error("deploy without the pinned nonce")
					const address = getContractAddress({ from: DEPLOYER, nonce }).toLowerCase()
					nonce += 1n
					code.add(address)
					const hash = `0x${address.slice(2).padStart(64, "0")}`
					creations.set(hash, {
						tx: { to: null, input: encodeDeployData({ abi, bytecode, args }) },
						receipt: { status: "success", contractAddress: address },
					})
					return hash
				}),
			},
			pub: {
				getTransactionCount: vi.fn(async () => Number(nonce)),
				getCode: vi.fn(async ({ address }: { address: string }) => (code.has(address.toLowerCase()) ? "0x60" : undefined)),
				waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => creation(hash).receipt),
				getTransaction: vi.fn(async ({ hash }: { hash: string }) => creation(hash).tx),
				getTransactionReceipt: vi.fn(async ({ hash }: { hash: string }) => creation(hash).receipt),
			},
		}
		return { l1: l1 as unknown as L1Ctx, code, creations, deploys: l1.wallet.deployContract }
	}

	it("adopts only an identical contract with code on chain; changed arguments or code deploy anew and append", async () => {
		const chain = landingChain()
		const journal = openDeployJournal(join(dir, "adopt.jsonl"))
		const swapperArgs = { feeAsset: inputs.feeJuice, owner: DEPLOYER }
		const swapper = await deployFuelSwapper(chain.l1, journal, swapperArgs)
		expect(swapper.adopted).toBe(false)
		expect(journal.steps[0]).toMatchObject({
			kind: "fuel-swapper-deployed",
			address: swapper.address,
			creationCodeHash: keccak256(`0x${"TestnetFuelSwapper".length.toString(16)}`),
			// An absent faucet is the zero address, exactly as the constructor receives it.
			constructorArgs: [inputs.feeJuice, `0x${"0".repeat(40)}`, DEPLOYER.toLowerCase()],
		})
		expect(await deployFuelSwapper(chain.l1, journal, swapperArgs)).toEqual({ address: swapper.address, adopted: true })

		const routerArgs = { ...inputs, factory: inputs.registry, swapTarget: swapper.address, owner: DEPLOYER }
		const router = await deployDepositRouter(chain.l1, journal, routerArgs)
		const otherOwner = await deployDepositRouter(chain.l1, journal, { ...routerArgs, owner: inputs.feeJuicePortal })
		recompiled.suffix = "ff"
		const otherCode = await deployDepositRouter(chain.l1, journal, routerArgs)
		recompiled.suffix = ""
		expect(new Set([router.address, otherOwner.address, otherCode.address]).size).toBe(3)
		expect([otherOwner.adopted, otherCode.adopted]).toEqual([false, false])
		// Each change is a step of its own; the step naming the first router is never rewritten, and still adopts.
		expect(journal.steps.map((s) => (s.kind === "deposit-router-deployed" ? s.address : s.kind))).toEqual([
			"fuel-swapper-deployed",
			router.address,
			otherOwner.address,
			otherCode.address,
		])
		expect(await deployDepositRouter(chain.l1, journal, routerArgs)).toEqual({ address: router.address, adopted: true })

		// A journalled match whose address has no code here is not adopted.
		chain.code.delete(swapper.address)
		expect((await deployFuelSwapper(chain.l1, journal, swapperArgs)).adopted).toBe(false)
		expect(chain.deploys).toHaveBeenCalledTimes(5)
	})

	it("adopts only what the journalled transaction provably created: a successful creation of that address from this code and these arguments", async () => {
		const chain = landingChain()
		const journal = openDeployJournal(join(dir, "provenance.jsonl"))
		const swapperArgs = { feeAsset: inputs.feeJuice, owner: DEPLOYER }
		const args = fuelSwapperArgs(swapperArgs)
		const { address } = await deployFuelSwapper(chain.l1, journal, swapperArgs)
		const [hash, landed] = [...chain.creations.entries()][0] as [string, Creation]
		const adoptable = () => findAdoptable(chain.l1, journal, "fuel-swapper-deployed", args)
		expect(await adoptable()).toBe(address)

		const tampered: Array<[string, Creation | undefined]> = [
			["other arguments", { ...landed, tx: { ...landed.tx, input: `${landed.tx.input.slice(0, -40)}${"ee".repeat(20)}` } }],
			["another address", { ...landed, receipt: { ...landed.receipt, contractAddress: inputs.registry } }],
			["reverted", { ...landed, receipt: { ...landed.receipt, status: "reverted" } }],
			["a call, not a creation", { ...landed, tx: { ...landed.tx, to: address } }],
			["absent from this chain", undefined],
		]
		for (const [label, creation] of tampered) {
			if (creation) chain.creations.set(hash, creation)
			else chain.creations.delete(hash)
			expect(await adoptable(), label).toBeUndefined()
		}
		chain.creations.set(hash, landed)
		expect(await adoptable()).toBe(address)
	})
})
