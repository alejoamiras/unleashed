/**
 * An `@aztec-labs/wallets` embedded wallet with the two things tools needs from a wallet-sdk wallet
 * and the base class does not give it: a capability grant, and — per profile — the wallet-specific
 * RPCs. The profile only DECORATES a standard wallet; every bridge transaction still runs through
 * the stock `BaseWallet` path, which is what the suite is testing tools against.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import {
	getContractInstanceFromInstantiationParams,
	type InteractionWaitOptions,
	NO_WAIT,
	type SendReturn,
} from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { SendOptions, SimulateOptions } from "@aztec-labs/aztec.js/wallet"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import { FunctionSelector } from "@aztec-labs/stdlib/abi"
import { ExecutionPayload, PendingTxReceipt, type Tx } from "@aztec-labs/stdlib/tx"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { DAPP_SELF_PAY_FEATURE, type Seed, type TestWalletIdentity, type TestWalletProfile } from "./profile"

/** The call `FeeJuicePaymentMethodWithClaim` emits: a self-payer WITH it is a claim in setup. */
const CLAIM_AND_END_SETUP = "claim_and_end_setup((Field),u128,Field,Field)"

const unsupported = (method: string) => new Error(`Unsupported wallet method: ${method}`)

type Manifest = { capabilities: Array<Record<string, unknown> & { type: string }> }

/** A transaction as this wallet handed it to the node: the FPC keeps exactly its fee limit. */
export interface SubmittedTx {
	hash: string
	feeLimit: bigint
	daGas: number
	l2Gas: number
}

export class TestWallet extends EmbeddedWallet {
	/** Every transaction handed to the node since this wallet booted, in order. */
	readonly submitted: SubmittedTx[] = []
	profile: TestWalletProfile = "plain"
	private claimSelector = FunctionSelector.empty()
	private readonly registeredTokens = new Set<string>()
	private imported = 0

	static async createFor(profile: TestWalletProfile, identity: TestWalletIdentity): Promise<TestWallet> {
		// Ephemeral: nothing outlives the page. Proving off: the local network synthesizes proofs.
		const wallet = await TestWallet.create(identity.nodeUrl, { ephemeral: true, pxe: { proverEnabled: false } })
		wallet.observeSubmissions()
		wallet.profile = profile
		wallet.claimSelector = await FunctionSelector.fromSignature(CLAIM_AND_END_SETUP)
		// A wallet on a network with a sponsor knows the SponsoredFPC — a dApp names it as payer and
		// never registers it (tools: `sponsored-fpc.ts`). The local network pre-deploys it at the
		// protocol salt.
		const sponsor = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
			salt: new Fr(SPONSORED_FPC_SALT),
		})
		await wallet.registerContract(sponsor, SponsoredFPCContract.artifact)
		return wallet
	}

	/** Registers the Schnorr account a seed derives to; the suite deployed it in Node. */
	async importSeed(seed: Seed): Promise<AztecAddress> {
		const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.fromHexString(seed.secret))
		const manager = await this.createSchnorrAccount(secretKey, new Fr(BigInt(seed.salt)), signingKey, `actor-${++this.imported}`)
		return manager.address
	}

	/** Armed by the suite: the next grant answers without any contract scope — what a user who
	 *  declines the token prompt leaves the dApp with. One shot. */
	declineNextGrant = false

	/** Armed by the suite: the next transaction handed to the node is recorded and never forwarded,
	 *  and the wallet answers a pending receipt instead of waiting on a node that never saw it — the
	 *  page holds a hash the node will only ever report as dropped. One shot. */
	dropNextSubmission = false

	/** Grants exactly what was asked, with every imported account — the suite's whole actor pool. */
	// biome-ignore lint/suspicious/noExplicitAny: the SDK's manifest/grant types are zod-inferred and not exported usably.
	override async requestCapabilities(manifest: any): Promise<any> {
		const accounts = await this.getAccounts()
		const declining = this.declineNextGrant
		this.declineNextGrant = false
		const granted = (manifest as Manifest).capabilities
			.filter((c) => !(declining && c.type === "contracts"))
			.map((c) =>
				c.type === "accounts" ? { ...c, canGet: c.canGet ?? true, canCreateAuthWit: c.canCreateAuthWit ?? false, accounts } : c,
			)
		return { version: "1.0", granted, wallet: { name: `Test wallet (${this.profile})`, version: "0.0.0" } }
	}

	// ── Wallet-specific RPCs (reachable only when the schema patch is loaded — never on `plain`) ──

	getWalletFeatures(): Promise<string[]> {
		return Promise.resolve(this.profile === "plain" ? [] : [DAPP_SELF_PAY_FEATURE])
	}

	registerToken(account: AztecAddress, token: AztecAddress): Promise<void> {
		if (this.profile !== "full") throw unsupported("registerToken")
		this.registeredTokens.add(`${account.toString()}:${token.toString()}`)
		return Promise.resolve()
	}

	isTokenRegistered(token: AztecAddress): Promise<boolean> {
		if (this.profile !== "full") throw unsupported("isTokenRegistered")
		const suffix = `:${token.toString()}`
		return Promise.resolve([...this.registeredTokens].some((k) => k.endsWith(suffix)))
	}

	grantPublicAuthwit(): Promise<string> {
		throw unsupported("grantPublicAuthwit")
	}

	// ── Self-pay routing (`selfpay` and `full`) ──

	/** A payload naming its sender as payer with no claim call is tools asking for the account's held
	 *  public Fee Juice; BaseWallet would read that shape as a claim in setup and build an invalid
	 *  transaction, so the payer is dropped and the account's own balance pays. A payload carrying
	 *  `claim_and_end_setup` to the protocol FeeJuice really is a claim and passes through. */
	/** The hand-off to the node is where the fees are final — the SDK completes them after `sendTx`'s
	 *  options — so that is where a submission is recorded. Observation only, unless the suite armed
	 *  a drop: then the recorded transaction is not forwarded at all. */
	private observeSubmissions(): void {
		const node = this.aztecNode
		const observed = new Proxy(node, {
			get: (target, prop, receiver) => {
				if (prop !== "sendTx") return Reflect.get(target, prop, receiver)
				return async (tx: Tx) => {
					const gas = tx.getGasSettings()
					this.submitted.push({
						hash: tx.getTxHash().toString(),
						feeLimit: gas.getFeeLimit().toBigInt(),
						daGas: Number(gas.gasLimits.daGas),
						l2Gas: Number(gas.gasLimits.l2Gas),
					})
					if (this.dropNextSubmission) {
						this.dropNextSubmission = false
						return
					}
					return (Reflect.get(target, "sendTx", target) as (t: Tx) => Promise<void>)(tx)
				}
			},
		})
		;(this as unknown as { aztecNode: unknown }).aztecNode = observed
	}

	private routed(payload: ExecutionPayload, from: unknown): ExecutionPayload {
		if (this.profile === "plain" || !(from instanceof AztecAddress) || !payload.feePayer?.equals(from)) return payload
		const claims = payload.calls.some((c) => c.to.equals(ProtocolContractAddress.FeeJuice) && c.selector.equals(this.claimSelector))
		if (claims) return payload
		return new ExecutionPayload(payload.calls, payload.authWitnesses, payload.capsules, payload.extraHashedArgs, undefined)
	}

	override async sendTx<W extends InteractionWaitOptions = undefined>(
		payload: ExecutionPayload,
		opts: SendOptions<W>,
	): Promise<SendReturn<W>> {
		if (!this.dropNextSubmission || opts.wait === NO_WAIT) return super.sendTx(this.routed(payload, opts.from), opts)
		const { txHash, ...offchain } = await super.sendTx(this.routed(payload, opts.from), { ...opts, wait: NO_WAIT })
		return { receipt: new PendingTxReceipt(txHash, undefined), ...offchain } as unknown as SendReturn<W>
	}

	override simulateTx(payload: ExecutionPayload, opts: SimulateOptions) {
		return super.simulateTx(this.routed(payload, opts.from), opts)
	}
}
