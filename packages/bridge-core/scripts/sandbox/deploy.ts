/** Deploys one bridge generation onto a running local network and writes the run's artifacts. */
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import type { L1Ctx } from "../../src/flows"
import type { ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { type DeployJournal, openDeployJournal, writeCandidateAtomically } from "../deploy-manifest"
import { deployGeneration, type GenerationRecord, type L2Ctx, preCreateToken } from "../generation"
import { createL1Clients, stopwatch } from "../script-bootstrap"
import {
	anvilKey,
	CHAIN_ID,
	CROSSCHAIN_USER_INDEX,
	HARNESS_KEY,
	lc,
	PERMIT2,
	RELAYER_INDEX,
	SOURCE_CHAIN_ID,
	sandboxChain,
	sandboxSourceChain,
} from "./constants"
import { ensurePrivateFpc } from "./context"
import { type CrossChainDeployment, deployCrossChain } from "./crosschain"
import { deployDripFixture } from "./drip"
import { ensureForgeArtifacts } from "./forge"
import type { SandboxClients, SandboxHandle } from "./handle"
import { copyCanonicalCode, deployL1Fixtures, type L1Deployment } from "./l1"
import { type Actor, adoptGuardian, connectL2, createActor, l2CtxFor, SANDBOX_ACTOR_SALT, SANDBOX_ACTOR_SECRET } from "./l2"
import { buildManifest, sandboxFuelBlock, writeArtifacts } from "./manifest"

export interface DeployedSandbox {
	clients: SandboxClients
	manifest: ManifestV2
	handle: SandboxHandle
	actor: Actor
}

export interface DeployOptions {
	/** Where `manifest.json` / `handle.json` land (and the deploy journal). */
	artifactsDir: string
	/** How many anvil actor keys (indices 1..n) the handle lists for browser spec files. */
	actorKeys?: number
	mins?: () => string
}

export interface SandboxNetwork {
	anvilUrl: string
	nodeUrl: string
	/** The source-chain anvil cross-chain sends start on. */
	sourceUrl: string
}

/** The harness key on the source anvil, which funds the same mnemonic. */
function sourceHarness(url: string): L1Ctx {
	const account = privateKeyToAccount(HARNESS_KEY)
	return { ...createL1Clients({ chain: sandboxSourceChain(url), rpcUrl: url, account }), account }
}

/** The router, the swapper and the LI.FI rail: the swapper rates every manifest token, and the rail delivers the
 *  sandbox's USDC. */
function deployRail(l1: L1Ctx, net: SandboxNetwork, gen: GenerationRecord, d: L1Deployment): Promise<CrossChainDeployment> {
	return deployCrossChain(l1, sourceHarness(net.sourceUrl), {
		factory: gen.l1.factory,
		feeJuicePortal: d.feeJuicePortal,
		feeJuice: d.feeJuice,
		fuelTokens: [d.tokens.usdc, d.tokens.usdt, d.tokens.pxo],
		railToken: d.tokens.usdc,
	})
}

function crossChainHandle(net: SandboxNetwork, rail: CrossChainDeployment): NonNullable<SandboxHandle["crossChain"]> {
	return {
		sourceUrl: net.sourceUrl,
		sourceChainId: SOURCE_CHAIN_ID,
		userKey: anvilKey(CROSSCHAIN_USER_INDEX),
		relayerKey: anvilKey(RELAYER_INDEX),
		source: { spokePool: rail.source.spokePool, diamond: rail.source.diamond, token: rail.source.token },
		destination: rail.destination,
	}
}

async function deployTokens(
	l1: L1Ctx,
	l2: L2Ctx,
	gen: GenerationRecord,
	d: L1Deployment,
	journal: DeployJournal,
): Promise<ManifestToken[]> {
	return [
		await preCreateToken(l1, l2, gen, d.tokens.usdc, journal, { maxWholePerTx: 1_000_000 }),
		await preCreateToken(l1, l2, gen, d.tokens.usdt, journal, { maxWholePerTx: 1_000_000 }),
		await preCreateToken(l1, l2, gen, d.tokens.pxo, journal, { register: false, maxWholePerTx: 1_000_000 }),
	]
}

export async function deployEverything(net: SandboxNetwork, opts: DeployOptions): Promise<DeployedSandbox> {
	const mins = opts.mins ?? stopwatch()
	ensureForgeArtifacts()
	const chain = sandboxChain(net.anvilUrl)
	const actorKeyCount = opts.actorKeys ?? 12
	if (actorKeyCount >= CROSSCHAIN_USER_INDEX) {
		throw new Error(
			`actorKeys must stay below ${CROSSCHAIN_USER_INDEX} (anvil indices 1..${CROSSCHAIN_USER_INDEX - 1}); got ${actorKeyCount}`,
		)
	}
	const account = privateKeyToAccount(HARNESS_KEY)
	const second = privateKeyToAccount(anvilKey(1))
	const l1: L1Ctx = { ...createL1Clients({ chain, rpcUrl: net.anvilUrl, account }), account }
	const l1b: L1Ctx = { ...createL1Clients({ chain, rpcUrl: net.anvilUrl, account: second }), account: second }

	await copyCanonicalCode(l1, "permit2")
	await copyCanonicalCode(l1, "multicall3")

	const l2base = await connectL2(net.nodeUrl)
	const actor = await createActor(l2base.wallet, l2base.node, l2base.fee, SANDBOX_ACTOR_SECRET, SANDBOX_ACTOR_SALT)
	await adoptGuardian(l2base, SANDBOX_ACTOR_SECRET, SANDBOX_ACTOR_SALT)
	const l2 = l2CtxFor(l2base, actor.address)
	// Part of the network like the sponsor is: tools pre-registers the pinned PrivateFPC at connect
	// and a wallet syncs it from the node, so it must be published before any browser reads it.
	await ensurePrivateFpc(l2)
	const info = await l2.node.getNodeInfo()
	const addrs = {
		feeJuice: lc(info.l1ContractAddresses.feeJuiceAddress.toString()),
		feeJuicePortal: lc(info.l1ContractAddresses.feeJuicePortalAddress.toString()),
		registry: lc(info.l1ContractAddresses.registryAddress.toString()),
	}
	console.log(`  node L1: registry ${addrs.registry}, feeJuice ${addrs.feeJuice}, feeJuicePortal ${addrs.feeJuicePortal}`)
	const deployment = await deployL1Fixtures(l1, addrs)

	mkdirSync(opts.artifactsDir, { recursive: true })
	// Keyed by the L1 genesis hash — anvil stamps its boot time into genesis, so a freshly booted
	// chain gets a fresh journal (its predecessor's addresses exist nowhere) while re-attaching to a
	// kept one resumes that history. The rollup address is NOT an identity: a fresh boot replays the
	// same deployer nonces and lands the rollup at the same address every time.
	const genesis = await l1.pub.getBlock({ blockNumber: 0n })
	const journal = openDeployJournal(join(opts.artifactsDir, `journal-${genesis.hash.slice(2, 18)}.jsonl`), {
		l1ChainId: CHAIN_ID,
		rollupVersion: Number(info.rollupVersion),
		deployer: lc(l1.account.address),
		registry: addrs.registry,
		feeJuicePortal: addrs.feeJuicePortal,
	})
	console.log(`\n=== generation (${mins()}) ===`)
	const gen = await deployGeneration(
		l1,
		l2,
		{
			registry: addrs.registry,
			permit2: PERMIT2,
			feeJuicePortal: addrs.feeJuicePortal,
			guardianL1: l1.account.address,
			guardianL2: l2.from.toString(),
		},
		journal,
	)

	console.log(`\n=== tokens (${mins()}) ===`)
	const tokens = await deployTokens(l1, l2, gen, deployment, journal)
	console.log(`\n=== cross-chain rail (${mins()}) ===`)
	const rail = await deployRail(l1, net, gen, deployment)
	Object.assign(deployment, { depositRouter: rail.depositRouter, fuelSwapper: rail.fuelSwapper })
	console.log(`\n=== faucet (${mins()}) ===`)
	const drip = await deployDripFixture(l2)
	const router = { depositRouter: rail.depositRouter, fuelSwapper: rail.fuelSwapper, fuel: sandboxFuelBlock() }
	const manifest = buildManifest(gen, deployment, tokens, Number(info.rollupVersion), router)
	const manifestPath = join(opts.artifactsDir, "manifest.json")
	writeCandidateAtomically(manifestPath, manifest)
	journal.append({ kind: "candidate-written", path: manifestPath })

	const handle: SandboxHandle = {
		anvilUrl: net.anvilUrl,
		nodeUrl: net.nodeUrl,
		l1ChainId: CHAIN_ID,
		rollupVersion: Number(info.rollupVersion),
		walletChainId: manifest.walletChainId,
		artifactsDir: opts.artifactsDir,
		// Keys 1..N of anvil's mnemonic: funded, below the relayer's and the harness's, and never the node's index 0.
		l1: { deployerKey: HARNESS_KEY, actorKeys: Array.from({ length: actorKeyCount }, (_, i) => anvilKey(i + 1)) },
		l2: { relayer: l2base.relayer.toString(), actorSecret: SANDBOX_ACTOR_SECRET, actorSalt: SANDBOX_ACTOR_SALT.toString() },
		deployment,
		crossChain: crossChainHandle(net, rail),
	}
	writeArtifacts(opts.artifactsDir, { manifest, handle, deployments: drip })
	console.log(`\nwrote ${manifestPath} (${mins()})`)

	const clients: SandboxClients = { handle, l1, l1b, l2: l2base, deployment, mins }
	return { clients, manifest, handle, actor }
}
