/**
 * L2-side helpers shared by the operator scripts: deterministic instance derivation, the
 * manifest-bound hub and hub-token registration (recompute the recorded address, then teach the
 * wallet the instance), and the claim loop the smoke gates share while an L1→L2 message syncs.
 */
import type { ContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
	Contract,
	type ContractBase,
	type ContractInstanceWithAddress,
	getContractInstanceFromInstantiationParams,
} from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { tokenBridgeHubArtifact } from "../src/artifacts"
import { claimViaHub, hubAt, type HubClaimOutcome, type HubClaimParams } from "../src/hub-l2"
import { deriveHubTokenInstance } from "../src/hub-token"
import type { SendOpts } from "../src/hub-l2"
import type { ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { type DeployerNetwork, resolveDeployerKeys } from "./deployer-keys"

/** The manifest's hub record: address + the salt and constructor args it derives from. */
export type ManifestHub = NonNullable<ManifestV2["bridge"]>["l2"]["hub"]

/**
 * The deterministic instance for a set of instantiation params. Both the salt and the deployer are
 * the caller's: the hub is salted with the full field of its L1 factory, and a hub-derived token
 * carries the hub itself as deployer — a wrong deployer silently yields a different address.
 */
export function deriveInstance(
	art: ContractArtifact,
	args: unknown[],
	ctor: string,
	salt: Fr,
	deployer: AztecAddress,
): Promise<ContractInstanceWithAddress> {
	return getContractInstanceFromInstantiationParams(art, {
		constructorArgs: args,
		salt,
		publicKeys: PublicKeys.default(),
		deployer,
		constructorArtifact: ctor,
	})
}

function assertDerived(label: string, instance: ContractInstanceWithAddress, recorded: string): void {
	const derived = instance.address.toString()
	if (derived.toLowerCase() !== recorded.toLowerCase()) {
		throw new Error(`manifest ${label} mismatch: derived ${derived} != recorded ${recorded}`)
	}
}

/** Teaching a wallet a contract it already knows throws; that is not a failure worth aborting on. */
async function teachWallet(wallet: Wallet, instance: ContractInstanceWithAddress, art: ContractArtifact): Promise<void> {
	try {
		await wallet.registerContractClass(art)
	} catch {}
	try {
		await wallet.registerContract(instance, art)
	} catch {}
}

/**
 * Register (never deploy) the manifest's hub, asserting the recorded address is what its salt and
 * constructor args derive. The hub is a universal deploy, so the deployer is zero.
 */
/** The hub instance the manifest record derives to; its address commits to every constructor arg. */
export function deriveHubInstance(hub: ManifestHub): Promise<ContractInstanceWithAddress> {
	const [tokenClassId, factory, guardian] = hub.constructorArgs
	return deriveInstance(
		tokenBridgeHubArtifact,
		[Fr.fromHexString(String(tokenClassId)), EthAddress.fromString(String(factory)), AztecAddress.fromStringUnsafe(String(guardian))],
		hub.constructorArtifact,
		Fr.fromHexString(hub.salt),
		AztecAddress.ZERO,
	)
}

export async function registerHub(wallet: Wallet, hub: ManifestHub): Promise<ContractBase> {
	const instance = await deriveHubInstance(hub)
	assertDerived("hub", instance, hub.address)
	await teachWallet(wallet, instance, tokenBridgeHubArtifact)
	return hubAt(wallet, hub.address)
}

/**
 * Register the L2 Token the hub derives for one manifest token. The wallet needs this instance to
 * simulate a claim (the hub calls into the Token), and the assert is what proves the manifest names
 * the address the hub would actually mint to.
 */
export async function registerHubToken(
	wallet: Wallet,
	hub: AztecAddress,
	token: ManifestToken,
	tokenClassId: string,
): Promise<ContractBase> {
	const instance = await deriveHubTokenInstance(hub, token.erc20, token, tokenClassId)
	assertDerived(`token ${token.displaySymbol}`, instance, token.l2Token)
	await teachWallet(wallet, instance, TokenContractArtifact)
	return Contract.at(instance.address, TokenContractArtifact, wallet)
}

/** The L1→L2 message is not in the tree yet — the ONE failure a claim retries. Every other revert
 *  (a wrong amount, a stale leaf, a paused hub) is final and must surface on the first attempt. */
/** The deposit's message is not in the L2 tree yet — worded by the public `consume` assert
 *  (`nonexistent L1-to-L2 message`) or the private witness helper (`No L1 to L2 message found`).
 *  `No non-nullified …` is the opposite case, an already-consumed message: waiting never helps. */
function isMessageNotSynced(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e)
	return /nonexistent L1-to-L2 message|l1_to_l2_msg_exists|message not in state|(?<!non-nullified )No L1 to L2 message found/i.test(msg)
}

/** Claim through the hub on the smoke cadence until the deposit's message syncs. Registration of a
 *  first-seen token happens inside the claim, so the outcome names which path ran. */
export async function claimTokensUntilSynced(p: {
	hub: ContractBase
	claim: HubClaimParams
	sendOpts: SendOpts
	attempts?: number
	intervalMs?: number
}): Promise<HubClaimOutcome> {
	const attempts = p.attempts ?? 300
	let last: unknown
	for (let i = 0; i < attempts; i++) {
		try {
			return await claimViaHub(p.hub, p.claim, p.sendOpts)
		} catch (e) {
			if (!isMessageNotSynced(e)) throw e
			last = e
			await new Promise((r) => setTimeout(r, p.intervalMs ?? 6000))
		}
	}
	throw new Error(
		`hub claim gave up after ${attempts} attempts — the L1→L2 message never synced (${last instanceof Error ? last.message : String(last)})`,
	)
}

/** A throwaway Schnorr account from fresh randomness — the smoke/canary recipient shape. */
export async function freshSchnorrAccount(ewallet: {
	createSchnorrAccount: (
		secretKey: unknown,
		salt: Fr,
		signingKey: unknown,
	) => Promise<{ getAccount: () => Promise<{ getAddress: () => AztecAddress }> }>
}) {
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.random())
	const manager = await ewallet.createSchnorrAccount(secretKey, Fr.random(), signingKey)
	const from = (await manager.getAccount()).getAddress()
	return { manager, from }
}

/** The STABLE deployer account (never Fr.random()): derived from the network's
 *  BRIDGE_DEPLOYER_SECRET so a crash mid-generation keeps control of the account (and any
 *  funds) — a re-run with the same env resumes. */
export async function deployerSchnorrAccount(
	ewallet: {
		createSchnorrAccount: (
			secretKey: unknown,
			salt: Fr,
			signingKey: unknown,
		) => Promise<{ getAccount: () => Promise<{ getAddress: () => AztecAddress }> }>
	},
	network: DeployerNetwork,
) {
	const { secret, salt } = resolveDeployerKeys(network)
	const { signingKey, secretKey } = await deriveNuloAccountKeys(secret)
	const manager = await ewallet.createSchnorrAccount(secretKey, salt, signingKey)
	const from = (await manager.getAccount()).getAddress()
	return { manager, from, secret }
}

/** Register the canonical SponsoredFPC and build its fee payment — the testnet scripts'
 *  standard gas sponsor. Registration failures are swallowed (already registered). */
export async function sponsoredFpcFee(ewallet: unknown) {
	const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	try {
		await (ewallet as { registerContract: (i: unknown, a: unknown) => Promise<unknown> }).registerContract(
			fpc,
			SponsoredFPCContract.artifact,
		)
	} catch {}
	return { fpc, fee: { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) } }
}

/** First-account bootstrap: deploy the Schnorr account when the node doesn't serve it yet.
 *  NO_FROM — the first deploy can't route through its own (not-yet-deployed) entrypoint.
 *  `log` fires with "deploying" before the (minutes-long real proof) send and "deployed"
 *  after; a caller that never logged one of the stages passes a filter. */
export async function deployAccountIfAbsent(p: {
	node: {
		getContract: (a: AztecAddress) => Promise<unknown>
		getNullifierMembershipWitness: (block: "latest", nullifier: Fr) => Promise<unknown>
	}
	manager: {
		getDeployMethod: () => Promise<{ send: (o: never) => Promise<unknown> }>
		getInstance: () => { initializationHash: Fr }
	}
	from: AztecAddress
	fee: unknown
	log: (stage: "deploying" | "deployed") => void
}): Promise<void> {
	if (await p.node.getContract(p.from)) return
	// An account deploy publishes no instance, so the node never "serves" it: its initialization
	// nullifier is the one on-chain trace, and a re-deploy over it is rejected as an existing nullifier.
	const initNullifier = await computeSiloedPrivateInitializationNullifier(p.from, p.manager.getInstance().initializationHash)
	if (await p.node.getNullifierMembershipWitness("latest", initNullifier)) return
	p.log("deploying")
	const deployMethod = await p.manager.getDeployMethod()
	await deployMethod.send({ fee: p.fee, from: "NO_FROM" as never } as never)
	p.log("deployed")
}
