/** L2 side of the sandbox: the embedded scripting wallet, the genesis relayer, and the actors —
 *  constructor-based Schnorr accounts under the Nulo wallet's key derivation, the shape that wallet deploys,
 *  deployed through the sponsor so a fresh actor costs the harness nothing but a transaction. */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec-labs/wallets/testing"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import type { Hex } from "viem"
import type { L2Ctx } from "../generation"
import { createL2Wallet, createNode } from "../script-bootstrap"
import { deployAccountIfAbsent, sponsoredFpcFee } from "../script-l2"
import { FEE_CEILING } from "./constants"

/** The base actor's key material is a fixed sandbox constant of the same kind as anvil's keys —
 *  not a credential — so a `--keep` re-attach finds the deployer that owns the generation. */
export const SANDBOX_ACTOR_SECRET = "0x00000000000000000000000000000000000000000000000000005a5db0c7a0b1" as Hex
export const SANDBOX_ACTOR_SALT = 1n

export interface Actor {
	secret: Hex
	salt: bigint
	address: AztecAddress
}

type EmbeddedLike = {
	createSchnorrAccount: (
		secretKey: unknown,
		salt: Fr,
		signingKey: unknown,
	) => Promise<{ getAccount: () => Promise<{ getAddress: () => AztecAddress }> }>
}

/** The address an actor secret derives to — the same derivation the browser test wallet runs, so a
 *  fixture can fund an account before any wallet holds it. */
export async function actorAddress(wallet: unknown, secret: Hex, salt: bigint = SANDBOX_ACTOR_SALT): Promise<AztecAddress> {
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.fromHexString(secret))
	const manager = await (wallet as EmbeddedLike).createSchnorrAccount(secretKey, new Fr(salt), signingKey)
	return (await manager.getAccount()).getAddress()
}

export async function createActor(
	wallet: unknown,
	node: L2Ctx["node"],
	fee: unknown,
	secret: Hex,
	salt: bigint = SANDBOX_ACTOR_SALT,
	log: (line: string) => void = console.log,
): Promise<Actor> {
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.fromHexString(secret))
	const manager = await (wallet as EmbeddedLike).createSchnorrAccount(secretKey, new Fr(salt), signingKey)
	const address = (await manager.getAccount()).getAddress()
	await deployAccountIfAbsent({
		node: node as never,
		manager: manager as never,
		from: address,
		fee,
		log: (stage) => log(`  actor account ${stage}: ${address.toString()}`),
	})
	return { secret, salt, address }
}

export const freshActorSecret = (): Hex => Fr.random().toString() as Hex

export interface L2Base {
	wallet: Wallet
	node: L2Ctx["node"]
	/** The sponsor-paid fee the harness's scaffolding rides (actor deploys, standalone claims, the
	 *  sends a cell does not price); every cell that asserts a payer names its own fee instead. */
	fee: Record<string, unknown>
	relayer: AztecAddress
	relayerOpts: Record<string, unknown>
	/** Sends as the base actor, the hub's guardian; set once the wallet holds that account. */
	guardianOpts: Record<string, unknown>
}

/** Registers the base actor in this wallet and makes it the guardian sender. */
export async function adoptGuardian(base: L2Base, secret: Hex, salt: bigint): Promise<AztecAddress> {
	const guardian = await actorAddress(base.wallet, secret, salt)
	base.guardianOpts = { from: guardian, fee: base.fee, wait: { waitForStatus: TxStatus.PROPOSED } }
	return guardian
}

export async function connectL2(nodeUrl: string): Promise<L2Base> {
	const node = createNode(nodeUrl)
	// Proving off: this is a local correctness loop, not a proof-system gate.
	const wallet = await createL2Wallet({ nodeUrl, proverEnabled: false, sandboxKeysOnly: true })
	// A local network pre-deploys its funded accounts at genesis; the relayer is one of them.
	const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet as never)
	const relayer = accounts[1]
	if (!relayer) throw new Error("the local network served fewer than two funded accounts")
	const { fee } = await sponsoredFpcFee(wallet)
	const paid = { ...fee, gasSettings: FEE_CEILING }
	return {
		wallet: wallet as unknown as Wallet,
		node,
		fee: paid,
		relayer,
		relayerOpts: { from: relayer, fee: paid, wait: { waitForStatus: TxStatus.PROPOSED } },
		guardianOpts: {},
	}
}

/** The L2 context an actor acts through. This network builds a block only when a transaction
 *  arrives, so the L1→L2 anchor stands still between flows; revoking a random, never-granted public
 *  authwit is the cheapest universally available public transaction: it needs no contract of ours
 *  and changes nothing. */
export function l2CtxFor(base: L2Base, from: AztecAddress): L2Ctx {
	const sendOpts = { from, fee: base.fee, wait: { waitForStatus: TxStatus.PROPOSED } }
	const forceBlock = async () => {
		const revoke = await SetPublicAuthwitContractInteraction.create(base.wallet as never, from, Fr.random(), false)
		return revoke.send(sendOpts as never)
	}
	return {
		wallet: base.wallet,
		node: base.node,
		from,
		deployOpts: { from, fee: base.fee, wait: { waitForStatus: TxStatus.CHECKPOINTED } },
		sendOpts,
		forceBlock,
	}
}

/** Keeps blocks coming while an operation waits on chain PROGRESS rather than on a message. */
export async function withBlockHeartbeat<T>(l2: L2Ctx, fn: () => Promise<T>): Promise<T> {
	let beating = true
	const heartbeat = (async () => {
		while (beating) {
			await l2.forceBlock?.().catch(() => {})
			await new Promise((r) => setTimeout(r, 2000))
		}
	})()
	try {
		return await fn()
	} finally {
		beating = false
		await heartbeat
	}
}
