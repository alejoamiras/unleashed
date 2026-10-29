/**
 * The Drip catalog's deploy: the Dripper and its tokens, deployed universally at fixed salts so every network gets
 * the same addresses. {@link runSelfFundedDeploy} is the path for a network without a sponsor, where the deployer pays
 * every fee from Fee Juice it funds on L1 itself (`deployer-funding.ts`). Every run reads what is already on chain
 * first, so the same command resumes after any interruption and a finished catalog sends nothing.
 */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractInstanceWithAddress, type DeployMethod } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { getFeeJuiceBalance } from "@aztec-labs/aztec.js/utils"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Gas, GasFees } from "@aztec-labs/stdlib/gas"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import type { Address, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { FAUCET_DRIPPER_SALT, FAUCET_TOKENS, type FaucetToken } from "../src/faucet-catalog"
import { predictedWorstMinFees, preexistingFeeJuicePayment } from "../src/fee-juice"
import type { L1Ctx } from "../src/flows"
import { planPublicFuelDeposit } from "../src/fuel"
import type { ManifestV2 } from "../src/manifest-v2"
import { PUBLIC_FUEL_CLAIM_GAS } from "../src/private-fuel"
import {
	assertFundingDestination,
	type Claimable,
	decideFunding,
	fj,
	fundingSecret,
	isClaimed,
	MAINNET_SCAN_CONFIRMATIONS,
	matchFundings,
	requireMainnetDripFunder,
	scanFundings,
	scanStartFor,
} from "./deployer-funding"
import {
	ACCOUNT_CLAIM_DEPLOY_GAS,
	admittedLimits,
	claimAndDeployAccount,
	claimFeeJuiceSelfPaid,
	depositFeeJuicePublic,
	feeLimitOf,
	selfPaidClaimGas,
} from "./fee-juice-l2"
import { waitForL1ToL2Message } from "./generation"
import { authenticatedMainnetNode } from "./live-intent"
import { createL1Clients, createNode, mainnetChain } from "./script-bootstrap"
import { deployAccountIfAbsent, deriveInstance } from "./script-l2"

export { fj, parseFj } from "./deployer-funding"

/** One contract of a universally deployed catalog: deployer zero, so the instance depends on these fields alone. */
export interface CatalogEntry {
	label: string
	artifact: ContractArtifact
	args: unknown[]
	constructorArtifact: string
	salt: Fr
	instance: ContractInstanceWithAddress
}

async function entry(e: Omit<CatalogEntry, "instance">): Promise<CatalogEntry> {
	return { ...e, instance: await deriveInstance(e.artifact, e.args, e.constructorArtifact, e.salt, AztecAddress.ZERO) }
}

/** The Dripper, then each token with the Dripper as its minter and no authorization contract. Other salts serve
 *  only a rehearsal that needs instances nobody has deployed. */
export async function dripCatalog(
	c: { dripperSalt: number; tokens: readonly FaucetToken[] } = { dripperSalt: FAUCET_DRIPPER_SALT, tokens: FAUCET_TOKENS },
): Promise<CatalogEntry[]> {
	const dripper = await entry({
		label: "Dripper",
		artifact: DripperContractArtifact as unknown as ContractArtifact,
		args: [],
		constructorArtifact: "constructor",
		salt: new Fr(c.dripperSalt),
	})
	const tokens = await Promise.all(
		c.tokens.map((t) =>
			entry({
				label: `Token ${t.symbol}`,
				artifact: TokenContractArtifact,
				args: [t.name, t.symbol, t.decimals, dripper.instance.address, AztecAddress.ZERO],
				constructorArtifact: "constructor_with_minter",
				salt: new Fr(t.salt),
			}),
		),
	)
	return [dripper, ...tokens]
}

export interface EntryStatus {
	entry: CatalogEntry
	/** Its initialization nullifier exists: nothing is left to send for it. */
	initialized: boolean
	/** Its instance is public; a published instance that is not initialized still needs its constructor. */
	published: boolean
}

type StatusNode = Pick<AztecNode, "getContract" | "getNullifierMembershipWitness">

/** Whether `address`, an instance with this initialization hash, has run its initializer: both a private and a
 *  public initializer emit this nullifier, and an account, which publishes no instance, leaves nothing else. */
export async function isInitialized(node: Pick<AztecNode, "getNullifierMembershipWitness">, address: AztecAddress, initializationHash: Fr) {
	const nullifier = await computeSiloedPrivateInitializationNullifier(address, initializationHash)
	return Boolean(await node.getNullifierMembershipWitness("latest", nullifier))
}

export function catalogStatus(node: StatusNode, catalog: readonly CatalogEntry[]): Promise<EntryStatus[]> {
	return Promise.all(
		catalog.map(async (e) => ({
			entry: e,
			initialized: await isInitialized(node, e.instance.address, e.instance.initializationHash),
			published: Boolean(await node.getContract(e.instance.address)),
		})),
	)
}

const deployMethodOf = (wallet: Wallet, e: CatalogEntry): DeployMethod =>
	Contract.deploy(wallet, e.artifact, e.args, e.constructorArtifact, { salt: e.salt, universalDeploy: true })

/** Publishes the class and instance if they are not yet public, then initializes. A class already published is
 *  skipped by aztec.js itself. */
export async function deployEntry(wallet: Wallet, s: EntryStatus, opts: { from: AztecAddress; fee: unknown }): Promise<bigint> {
	if (s.initialized) throw new Error(`${s.entry.label} is already initialized — nothing to send`)
	const sent = (await deployMethodOf(wallet, s.entry).send({
		from: opts.from,
		fee: opts.fee,
		skipInstancePublication: s.published,
		wait: { waitForStatus: TxStatus.PROPOSED },
	} as never)) as unknown as { receipt: { transactionFee?: bigint } }
	return sent.receipt.transactionFee ?? 0n
}

export interface SelfFundedDeployOptions {
	/** Signs the funding; it must be `funder`. */
	l1: L1Ctx
	/** The canonical Fee Juice portal and its asset, authenticated by the caller. */
	portal: Address
	asset: Address
	/** The only key whose deposits count as fundings. */
	funder: Address
	/** No funding can be older than this block. */
	scanFrom: bigint
	/** The scan stops this many blocks below the head; a funder transaction above it makes the run wait. */
	confirmations: bigint
	node: AztecNode
	wallet: Wallet
	deployer: {
		address: AztecAddress
		/** Derives the funding secrets; the account's own keys derive from it too. */
		seed: Fr
		manager: {
			getDeployMethod: () => Promise<{ send: (o: never) => Promise<unknown> }>
			getInstance: () => { initializationHash: Fr }
		}
	}
	catalog: readonly CatalogEntry[]
	/** What a new funding deposits; without it a shortfall stops the run. */
	fund?: bigint
	/** The most every authenticated funding from `funder` to this deployer may reach together, this one included. */
	cap: bigint
	log: (line: string) => void
	/** Runs after a funding lands on L1, and after its claim lands on L2. */
	onStage?: (stage: "deposited" | "claimed") => Promise<void> | void
	/** See `L2Ctx.forceBlock`: only a network that builds blocks on demand needs it. */
	forceBlock?: () => Promise<unknown>
	messageTimeoutMs?: number
}

type SendGas = { gasLimits: Gas; teardownGasLimits: Gas; maxFeesPerGas: GasFees }

/** The settings the next send of `s` commits to: its simulated gas plus the wallet's 10%, at the predicted worst
 *  fee. The balance is checked against exactly these, so the check and the send cannot disagree. */
async function sendGasOf(o: SelfFundedDeployOptions, s: EntryStatus): Promise<SendGas> {
	const from = o.deployer.address
	const sim = await deployMethodOf(o.wallet, s.entry).simulate({
		from,
		fee: { paymentMethod: preexistingFeeJuicePayment(from) },
		skipInstancePublication: s.published,
	})
	if (!sim.gasUsed) throw new Error(`${s.entry.label}: the simulation reported no gas — STOP`)
	const used = sim.gasUsed.totalGas
	const max = (await o.node.getNodeInfo()).txsLimits.gas
	// Only the padding may be clamped: a limit below the simulated use would be proven and then revert.
	if (used.l2Gas > max.l2Gas || used.daGas > max.daGas) {
		throw new Error(`${s.entry.label}: needs ${used.l2Gas} L2 / ${used.daGas} DA gas, above the node's per-transaction limit — STOP`)
	}
	const pad = (g: Gas) => ({ daGas: Math.ceil(g.daGas * 1.1), l2Gas: Math.ceil(g.l2Gas * 1.1) })
	const [gasLimits, teardownGasLimits, maxFeesPerGas] = await Promise.all([
		admittedLimits(o.node, pad(sim.gasUsed.totalGas)),
		admittedLimits(o.node, pad(sim.gasUsed.teardownGas)),
		predictedWorstMinFees(o.node),
	])
	return { gasLimits, teardownGasLimits, maxFeesPerGas }
}

/** The scan is a snapshot at one block. The funder's nonce there refuses a decision while any of its transactions
 *  is newer, and binds the new funding's writes, so a second run deciding on the same snapshot cannot fund again. */
async function settleFunding(o: SelfFundedDeployOptions, next: EntryStatus, accountInitialized: boolean): Promise<readonly Claimable[]> {
	const address = o.deployer.address
	// Uncached: viem reuses a block number for seconds, and an older one would show the funder's last mined
	// transaction as still in flight.
	const scannedAt = (await o.l1.pub.getBlockNumber({ cacheTime: 0 })) - o.confirmations
	const fundings = await scanFundings(o.l1.pub, {
		portal: o.portal,
		recipient: address.toString(),
		funder: o.funder,
		fromBlock: o.scanFrom,
		toBlock: scannedAt,
	})
	const { matched, next: n } = await matchFundings(fundings, o.deployer.seed)
	const claimed = await Promise.all(matched.map((f) => isClaimed(o.node, f)))
	const claimFee = feeLimitOf(await selfPaidClaimGas(o.node, accountInitialized ? PUBLIC_FUEL_CLAIM_GAS : ACCOUNT_CLAIM_DEPLOY_GAS))
	const [balance, nextFee, nonceAtScan, nonceNow] = await Promise.all([
		getFeeJuiceBalance(address, o.node),
		accountInitialized ? sendGasOf(o, next).then(feeLimitOf) : claimFee,
		o.l1.pub.getTransactionCount({ address: o.funder, blockNumber: scannedAt }),
		o.l1.pub.getTransactionCount({ address: o.funder, blockTag: "pending" }),
	])
	const unclaimed = matched.filter((_, i) => !claimed[i])
	const decision = decideFunding({
		accountInitialized,
		balance,
		nextFee,
		claimFee,
		unclaimed,
		funded: fundings.reduce((sum, f) => sum + f.amount, 0n),
		...(o.fund === undefined ? {} : { fund: o.fund }),
		cap: o.cap,
		signer: o.l1.account.address,
		funder: o.funder,
		nonceAtScan,
		nonceNow,
	})
	o.log(`${fundings.length} funding(s) on L1, ${unclaimed.length} of ours unclaimed; balance ${fj(balance)}`)
	if (decision.kind !== "deposit") return decision.kind === "claim" ? decision.fundings : []
	const secret = fundingSecret(o.deployer.seed, n)
	const plan = await planPublicFuelDeposit(address, decision.amount, secret)
	o.log(`funding #${n}: depositing ${fj(decision.amount)} to ${address}`)
	const deposit = await depositFeeJuicePublic(o.l1, {
		asset: o.asset,
		portal: o.portal,
		plan,
		firstNonce: nonceAtScan,
		onBroadcast: (hash) => o.log(`funding #${n}: deposit broadcast ${hash}`),
	})
	await o.onStage?.("deposited")
	return [{ amount: deposit.amount, key: deposit.key, leafIndex: deposit.leafIndex, n, secret }]
}

/** The account's first funding deploys it; every later one is claimed with no app call. */
async function claimFundings(o: SelfFundedDeployOptions, fundings: readonly Claimable[], accountInitialized: boolean): Promise<void> {
	let initialized = accountInitialized
	for (const f of fundings) {
		await waitForL1ToL2Message(o.node, f.key, { timeoutMs: o.messageTimeoutMs ?? 30 * 60_000, forceBlock: o.forceBlock })
		const claim = { claimAmount: f.amount, claimSecret: f.secret, messageLeafIndex: f.leafIndex }
		const from = o.deployer.address
		const fee = initialized
			? await claimFeeJuiceSelfPaid({ wallet: o.wallet, node: o.node, from, claim })
			: await claimAndDeployAccount({ node: o.node, manager: o.deployer.manager, from, claim })
		o.log(`funding #${f.n}: claimed ${fj(f.amount)}${initialized ? "" : " and deployed the account"} (fee ${fj(fee)})`)
		initialized = true
	}
	if (fundings.length > 0) await o.onStage?.("claimed")
}

/** Each send is checked against the balance before it is proven, so a short balance stops between sends. */
async function deployPending(o: SelfFundedDeployOptions, pending: readonly EntryStatus[]): Promise<void> {
	const from = o.deployer.address
	for (const s of pending) {
		const gasSettings = await sendGasOf(o, s)
		const [limit, balance] = [feeLimitOf(gasSettings), await getFeeJuiceBalance(from, o.node)]
		if (balance < limit) {
			throw new Error(
				`${s.entry.label}: the balance ${fj(balance)} is below this send's maximum fee ${fj(limit)}; re-run with --fund <AZTEC> — STOP`,
			)
		}
		const fee = await deployEntry(o.wallet, s, { from, fee: { paymentMethod: preexistingFeeJuicePayment(from), gasSettings } })
		o.log(`${s.entry.label}: initialized at ${s.entry.instance.address} (fee ${fj(fee)})`)
	}
}

/**
 * Deploys whatever of `catalog` is not initialized, funding and deploying the deployer's account first when needed.
 * Returns without touching L1 when the whole catalog is initialized.
 *
 * @throws before any send on a refused funding (`decideFunding`), and between sends when the balance falls short.
 */
export async function runSelfFundedDeploy(o: SelfFundedDeployOptions): Promise<void> {
	const pending = (await catalogStatus(o.node, o.catalog)).filter((s) => !s.initialized)
	const [next] = pending
	if (!next) {
		o.log("every catalog contract is initialized; nothing to send")
		return
	}
	const accountInitialized = await isInitialized(o.node, o.deployer.address, o.deployer.manager.getInstance().initializationHash)
	const claimable = await settleFunding(o, next, accountInitialized)
	await claimFundings(o, claimable, accountInitialized)
	await deployPending(o, pending)
}

/** A network with a sponsor: the account and every contract send with `fee`. */
export async function deploySponsoredCatalog(o: {
	wallet: Wallet
	node: StatusNode
	deployer: Pick<SelfFundedDeployOptions["deployer"], "address" | "manager">
	catalog: readonly CatalogEntry[]
	fee: unknown
	log: (line: string) => void
}): Promise<void> {
	const from = o.deployer.address
	await deployAccountIfAbsent({
		node: o.node,
		manager: o.deployer.manager,
		from,
		fee: o.fee,
		log: (stage) => o.log(`account ${stage}: ${from}`),
	})
	for (const s of await catalogStatus(o.node, o.catalog)) {
		if (s.initialized) {
			o.log(`${s.entry.label}: already initialized at ${s.entry.instance.address}`)
			continue
		}
		await deployEntry(o.wallet, s, { from, fee: o.fee })
		o.log(`${s.entry.label}: initialized at ${s.entry.instance.address}`)
	}
}

export interface MainnetDripDeployOptions {
	nodeUrl: string
	l1RpcUrl: string
	/** Signs the fundings; it must be the pinned funding key. */
	funderKey: Hex
	/** The committed mainnet manifest: its portal and asset are where fundings go. */
	manifest: ManifestV2
	/** The rollup version this build pins for mainnet. */
	rollupVersion: number
	wallet: Wallet
	deployer: SelfFundedDeployOptions["deployer"]
	catalog: readonly CatalogEntry[]
	fund?: bigint
	cap: bigint
	log: (line: string) => void
}

/**
 * The mainnet run: refuses unless the signer is the pinned funding key and the destination authenticates
 * ({@link assertFundingDestination}), then {@link runSelfFundedDeploy} from the portal's first block.
 */
export async function deployDripCatalogOnMainnet(o: MainnetDripDeployOptions): Promise<void> {
	const funder = requireMainnetDripFunder()
	if (!/^0x[0-9a-fA-F]{64}$/.test(o.funderKey)) throw new Error("the funding key is not a 32-byte hex key — STOP")
	const account = privateKeyToAccount(o.funderKey)
	if (account.address.toLowerCase() !== funder.toLowerCase()) {
		throw new Error(`the funding key is ${account.address}, not the pinned ${funder} — STOP`)
	}
	const l1: L1Ctx = { ...createL1Clients({ chain: mainnetChain(o.l1RpcUrl), rpcUrl: o.l1RpcUrl, account }), account }
	await assertFundingDestination(l1, await authenticatedMainnetNode(o.nodeUrl, o.manifest), o.manifest, o.rollupVersion)
	const portal = o.manifest.feeJuice.portal as Address
	await runSelfFundedDeploy({
		l1,
		portal,
		asset: o.manifest.feeJuice.asset as Address,
		funder,
		scanFrom: scanStartFor(portal),
		confirmations: MAINNET_SCAN_CONFIRMATIONS,
		node: createNode(o.nodeUrl),
		wallet: o.wallet,
		deployer: o.deployer,
		catalog: o.catalog,
		...(o.fund === undefined ? {} : { fund: o.fund }),
		cap: o.cap,
		log: o.log,
	})
}
