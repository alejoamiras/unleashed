/**
 * Cross-chain flow orchestrations the frontend drives and the sandbox smoke proves:
 * the router deposit legs and the L2→L1 withdraw consumption. Each takes a connected
 * L1 (viem) context + the generation's addresses, runs the cross-chain dance, and
 * reports stage transitions for the loading bar. Framework-agnostic (no Vue).
 *
 * The proven reference for these sequences is `scripts/deploy-sandbox.ts --smoke`.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { waitForProven } from "@aztec-labs/aztec.js/contracts"
import { computeSecretHash } from "@aztec-labs/aztec.js/crypto"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { computeL2ToL1MembershipWitness, getL2ToL1MessageLeafId } from "@aztec-labs/stdlib/messaging"
import { OutboxContract } from "@aztec-labs/ethereum/contracts"
import { type Abi, type Account, type Address, type Hex, parseEventLogs, type PublicClient, type WalletClient } from "viem"
import { deriveTokenClaimSecret } from "./claim-secret"
import { type BridgeWitness, bridgeWitnessPermitTypedData, hashRoute, type PoolKey } from "./l1"
import { PRIVATE_FPC_ADDRESS } from "./private-fuel"

/** bytes32 zero — the fuel fields a bridge-only witness (and the router's bridge()) leave unset. */
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex

/** The connected L1 surface the flows need (a viem wallet + public client + account). */
export interface L1Ctx {
	pub: PublicClient
	wallet: WalletClient
	account: Account
}

/**
 * Persistence hooks so a crash/refresh between the (irreversible) deposit and the
 * claim can't strand funds: the secret is saved BEFORE broadcast, the leaf index
 * once the deposit lands, and the record cleared on a successful claim. The caller
 * (the app) owns the storage + encryption via `recovery.ts`/`recovery-crypto.ts`.
 *
 * SECURITY (recipient-committed, F-007 closed): a PRIVATE claim is NO LONGER bearer — `secretHex`
 * carries the per-deposit `claim_salt`, and `claim_private` re-derives the consumption secret from
 * `(claim_salt, recipient)`, so a leaked salt only lets someone claim to the ORIGINALLY-BOUND recipient
 * (a relayer can finish the deposit, never redirect it). Still seal `secretHex` at rest and NEVER log
 * it: losing it strands the deposit (it's the sole recovery input), and leaking it reveals the
 * recipient↔amount↔leaf linkage (a privacy loss, not a theft vector).
 */
export interface RecoveryHooks {
	onSecret?: (r: { secretHex: string; secretHashHex: string; isPrivate: boolean }) => void
	onDeposited?: (leafIndex: bigint) => void
	onClaimed?: () => void
}

// ─── Bridge-only via the router's Permit2 bridge() entrypoint ───
// The single deposit path: bridge-only ERC20 AND fuel-only (tokenPortal =
// FeeJuicePortal) both go through bridge(). Signs a Permit2 witness (fuel fields zeroed) and
// calls bridge(); returns the L1 result. The L2 claim runs separately (claimPublic/claimPrivate),
// mirroring runSwapBridge. The direct approve+portal path (runDeposit/depositPublic/depositPrivate)
// is DELETED — bridge-only now goes through bridge() everywhere (tools inlines the same witness).

/** L1 stages for a router deposit, surfaced to the UI. */
export type RouterDepositStage = "signing" | "depositing" | "syncing" | "done"

export interface RouterDepositParams {
	router: Address
	routerAbi: Abi
	permit2: Address
	/** For fuel-only this is the canonical FeeJuicePortal; for bridge-only, the token portal. */
	tokenPortal: Address
	bridgeToken: Address
	amount: bigint
	aztecRecipient: Hex
	isPrivate: boolean
	/** The router's current swap target — witness-bound even for bridge-only (F-004). */
	swapTarget: Address
	/** PRIVATE only — the recipient-committed `claim_salt` (required; fail-closed if absent). */
	claimSalt?: Fr
	nonce: bigint
	deadline: bigint
	chainId: number
}

export interface RouterDepositResult {
	/** PRIVATE: the `claim_salt` (claim_private re-derives the secret). PUBLIC: the raw secret. */
	claimValueHex: string
	secretHashHex: string
	leafIndex: bigint
	/** The L1→L2 message hash (the router `Bridge` event `key`) — for waiting on L2 claimability. */
	messageHashHex: string
}

/**
 * Bridge-only deposit through the router's witness-bound Permit2 `bridge()`. Private deposits derive
 * the token secret from `(claimSalt, recipient)` so `claim_private` can re-derive it — the persisted +
 * returned value is the SALT, not the secret. The token pre-approves canonical Permit2 (AZLO) so there's
 * no approve tx; the canonical fee asset (fuel-only) needs a one-time `approve(Permit2)` done by the caller.
 */
export async function runRouterDeposit(
	l1: L1Ctx,
	p: RouterDepositParams,
	onStage?: (s: RouterDepositStage) => void,
	recovery?: RecoveryHooks,
): Promise<RouterDepositResult> {
	if (p.isPrivate && !p.claimSalt) {
		throw new Error(
			"runRouterDeposit: private deposit requires claimSalt (recipient-committed) — a random secret strands the deposit against claim_private",
		)
	}
	// A nonzero-but-invalid recipient (a field that isn't a point on Grumpkin) would be committed into
	// the deposit and then mint an undecryptable, unspendable note — the commitment makes it
	// unrecoverable. Fail closed before the irreversible L1 tx. (The Noir claim_private wants a matching
	// is_valid() assert on the next redeploy; today the tools app's wallet-sourced recipient is always valid.)
	if (!(await AztecAddress.fromStringUnsafe(p.aztecRecipient).isValid())) {
		throw new Error("runRouterDeposit: aztecRecipient is not a valid Aztec address (not a Grumpkin point) — refusing to deposit")
	}
	// PRIVATE: derive from (salt, recipient); the value to persist/claim is the SALT. PUBLIC: raw random secret.
	const claimValue = p.isPrivate ? (p.claimSalt as Fr) : Fr.random()
	const secret = p.isPrivate ? deriveTokenClaimSecret(p.claimSalt as Fr, AztecAddress.fromStringUnsafe(p.aztecRecipient)) : claimValue
	const secretHash = await computeSecretHash(secret)
	// Persist the claim value BEFORE the irreversible L1 tx — a lost salt/secret strands the deposit.
	recovery?.onSecret?.({ secretHex: claimValue.toString(), secretHashHex: secretHash.toString(), isPrivate: p.isPrivate })

	const witness: BridgeWitness = {
		tokenPortal: p.tokenPortal,
		bridgeToken: p.bridgeToken,
		totalAmount: p.amount,
		fuelAmount: 0n,
		// PRIVATE: recipient is committed via tokenSecretHash (H(derive(salt, recipient))) and is NOT
		// published — the router ignores it on the private path but EMITS it as an indexed event, so a
		// real value here would leak R and defeat recipient privacy. Zero on-chain; the claim re-derives
		// the secret from R (which stays only in the local recovery record).
		aztecRecipient: p.isPrivate ? ZERO_BYTES32 : p.aztecRecipient,
		fuelRecipient: ZERO_BYTES32,
		tokenSecretHash: secretHash.toString() as Hex,
		fuelSecretHash: ZERO_BYTES32,
		minFuelOutput: 0n,
		routeHash: ZERO_BYTES32,
		isPrivate: p.isPrivate,
		swapTarget: p.swapTarget,
	}
	const typedData = bridgeWitnessPermitTypedData(
		{ permitted: { token: p.bridgeToken, amount: p.amount }, spender: p.router, nonce: p.nonce, deadline: p.deadline },
		witness,
		p.permit2,
		p.chainId,
	)

	onStage?.("signing")
	const signature = await l1.wallet.signTypedData({ account: l1.account, ...typedData } as never)

	onStage?.("depositing")
	const bridgeParams = {
		tokenPortal: p.tokenPortal,
		bridgeToken: p.bridgeToken,
		amount: p.amount,
		aztecRecipient: p.isPrivate ? ZERO_BYTES32 : p.aztecRecipient,
		secretHash: secretHash.toString(),
		isPrivate: p.isPrivate,
	}
	const bridgeTxHash = await l1.wallet.writeContract({
		address: p.router,
		abi: p.routerAbi,
		functionName: "bridge",
		args: [bridgeParams, { nonce: p.nonce, deadline: p.deadline, signature }],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	const receipt = await l1.pub.waitForTransactionReceipt({ hash: bridgeTxHash })
	// A REVERTED bridge() has empty logs — without this check it would masquerade as the misleading
	// "no Bridge event" below (hit live during the cutover's rapid back-to-back deposits).
	if (receipt.status !== "success") {
		throw new Error(`bridge() REVERTED (${bridgeTxHash}) — no funds moved; inspect the tx and retry`)
	}

	onStage?.("syncing")
	// Leaf index + message key from the router's Bridge event (never a preflight simulate — see runDeposit's note).
	const events = parseEventLogs({ abi: p.routerAbi, eventName: "Bridge", logs: receipt.logs })
	const ev = events[0] as { args?: { index?: bigint; key?: Hex } } | undefined
	if (ev?.args?.index === undefined || ev.args.key === undefined)
		throw new Error(`bridge() succeeded but emitted no Bridge event (${bridgeTxHash}) — RPC log gap? re-fetch the receipt`)
	recovery?.onDeposited?.(ev.args.index)
	onStage?.("done")
	return {
		claimValueHex: claimValue.toString(),
		secretHashHex: secretHash.toString(),
		leafIndex: ev.args.index,
		messageHashHex: ev.args.key,
	}
}

type AztecNodeClient = ReturnType<typeof createAztecNodeClient>

/** L2→L1 withdraw finalization stages, surfaced to the UI for the loading bar. */
export type WithdrawFlowStage = "proving" | "consuming" | "done"

/** What the L1 Outbox `withdraw` consume needs: the L1 recipient + amount + the canonical portal. */
export interface WithdrawConsumeParams {
	recipientL1: Address
	amount: bigint
	portal: Address
	portalAbi: Abi
	/** Seconds to wait for the burn's epoch to prove (aztec.js default 600 — raise for slow networks like the live testnet). */
	provenTimeoutSec?: number
	/** The consume hash the moment it exists, before its receipt is awaited — a caller with a
	 *  journal records it here so a crash mid-wait still knows which transaction to finish. */
	onSent?: (txHash: Hex) => void
}

/**
 * Finalize an L2→L1 withdraw once the `exit_to_l1` tx has landed on L2: wait for it to be
 * proven, build the L2→L1 membership witness, and consume it on the L1 Outbox via the portal's
 * `withdraw`. Identical for public + private exits — only the L2 burn authwit (done by the
 * caller before the exit) differs. The sandbox smoke runs exactly this tail for both flows.
 */
export async function consumeWithdrawal(
	l1: L1Ctx,
	node: AztecNodeClient,
	exitReceipt: { txHash: unknown },
	p: WithdrawConsumeParams,
	onStage?: (s: WithdrawFlowStage) => void,
): Promise<{ consumeTxHash: Hex }> {
	onStage?.("proving")
	await waitForProven(node, exitReceipt as never, (p.provenTimeoutSec ? { provenTimeout: p.provenTimeoutSec } : undefined) as never)
	const eff = await node.getTxEffect(exitReceipt.txHash as never)
	if (!eff) throw new Error("no tx effect for exit")
	const messageHash = eff.data.l2ToL1Msgs[0]
	if (!messageHash) throw new Error("no L2→L1 message in exit tx")
	// 5.0: computeL2ToL1MembershipWitness needs the L1 Outbox roots reader (2nd arg) to pick the
	// partial-proof root covering the tx's checkpoint. OutboxContract.getRoots satisfies OutboxRootsReader.
	const { l1ContractAddresses } = await node.getNodeInfo()
	const outbox = new OutboxContract(l1.pub as never, l1ContractAddresses.outboxAddress)
	const wit = await computeL2ToL1MembershipWitness(node, outbox, messageHash, exitReceipt.txHash as never, 0)
	if (!wit) throw new Error("L2→L1 witness not available")
	const path = wit.siblingPath.toBufferArray().map((b: Buffer) => `0x${b.toString("hex")}` as `0x${string}`)
	onStage?.("consuming")
	const req = await l1.pub.simulateContract({
		address: p.portal,
		abi: p.portalAbi,
		functionName: "withdraw",
		// 5.0 portal `withdraw` args: (recipient, amount, withCaller, epoch, numCheckpointsInEpoch, leafIndex, path).
		// numCheckpointsInEpoch is new (sits BEFORE leafIndex) — the witness now carries it.
		args: [p.recipientL1, p.amount, false, BigInt(wit.epochNumber), BigInt(wit.numCheckpointsInEpoch), wit.leafIndex, path] as never,
		account: l1.account,
	})
	const consumeTxHash = (await l1.wallet.writeContract(req.request as never)) as Hex
	p.onSent?.(consumeTxHash)
	await l1.pub.waitForTransactionReceipt({ hash: consumeTxHash })
	onStage?.("done")
	return { consumeTxHash }
}

/**
 * Whether the Outbox has ALREADY consumed this exit's L2→L1 message. The message names its L1
 * recipient, so anyone may finish it and the funds still land where the burn said — which is why a
 * failed consume must ask this before it retries: a message someone else finished can never be
 * consumed again, and a caller that keeps trying reports a permanent failure over a completed exit.
 *
 * Unknowable answers read as NOT consumed (a missing effect, an unproven epoch): a false "already
 * done" would mark an exit complete whose funds are still sitting in the Outbox.
 */
export async function isOutboxMessageConsumed(l1: L1Ctx, node: AztecNodeClient, exitReceipt: { txHash: unknown }): Promise<boolean> {
	const eff = await node.getTxEffect(exitReceipt.txHash as never)
	const messageHash = eff?.data.l2ToL1Msgs[0]
	if (!messageHash) return false
	const { l1ContractAddresses } = await node.getNodeInfo()
	const outbox = new OutboxContract(l1.pub as never, l1ContractAddresses.outboxAddress)
	const wit = await computeL2ToL1MembershipWitness(node, outbox, messageHash, exitReceipt.txHash as never, 0)
	if (!wit) return false
	return outbox.hasMessageBeenConsumedAtEpoch(wit.epochNumber, getL2ToL1MessageLeafId(wit))
}

/** One-tx swap+fuel bridge stages, surfaced to the UI for the loading bar. */
export type SwapFlowStage = "signing" | "swapping" | "syncing" | "done"

/** Inputs for the headline `bridgeWithFuel`: swap `fuelAmount` of `bridgeToken` → Fee Juice, bridge the rest. */
export interface SwapBridgeParams {
	router: Address
	routerAbi: Abi
	permit2: Address
	tokenPortal: Address
	bridgeToken: Address
	totalAmount: bigint
	fuelAmount: bigint
	aztecRecipient: Hex
	fuelRecipient: Hex
	minFuelOutput: bigint
	path: PoolKey[]
	zeroForOnes: boolean[]
	isPrivate: boolean
	/** The router's current swap target — witness-bound (F-004); a setSwapTarget voids this signature. */
	swapTarget: Address
	/** PRIVATE fuel only — the injected bridge secret `deriveBridgeSecret(salt, claimer)`. Omitted ⇒
	 *  `Fr.random()` (correct for recipient-bound PUBLIC fuel). A random secret on the private path
	 *  would strand the Fee Juice forever: the claimer must reconstruct it from `msg_sender` inside
	 *  `PrivateFPC.mint_and_pay_fee`. The caller derives it (it owns the salt + claimer + persistence). */
	fuelSecret?: Fr
	/** PRIVATE token leg only — the recipient-committed `claim_salt` for the bridged TOKEN. Required when
	 *  isPrivate: the token leg's secret is `deriveTokenClaimSecret(tokenClaimSalt, aztecRecipient)` (NOT
	 *  Fr.random() — a random one would strand the token deposit against the recipient-committed
	 *  claim_private). Distinct from `fuelSecret` (the FPC gas leg). Public token leg ignores it. */
	tokenClaimSalt?: Fr
	nonce: bigint
	deadline: bigint
	chainId: number
}

/** What the L2 side needs after the L1 swap+bridge lands: the two claim secrets + leaf indices. */
export interface SwapBridgeResult {
	tokenSecretHex: string
	fuelSecretHex: string
	tokenLeafIndex: bigint
	fuelLeafIndex: bigint
	fuelReceived: bigint
}

/**
 * Persist BOTH claim secrets BEFORE the irreversible bridgeWithFuel; record leaf indices once it lands.
 *
 * SECURITY (recipient-committed): same contract as {@link RecoveryHooks}. For the PRIVATE path
 * `tokenSecretHex` is the token `claim_salt` (recipient-committed, not bearer); `fuelSecretHex` is the
 * FPC-bound fuel secret. Seal both at rest — losing either strands its leg; NEVER log/URL/plaintext them.
 */
export interface SwapRecoveryHooks {
	onSecrets?: (r: { tokenSecretHex: string; fuelSecretHex: string; aztecRecipient: Hex; isPrivate: boolean }) => void
	onBridged?: (r: { tokenLeafIndex: bigint; fuelLeafIndex: bigint }) => void
}

/** Fail closed on the private-fuel invariants BEFORE any secret generation or signing.
 *  Without this, a missing fuelSecret silently falls back to Fr.random() and strands the
 *  Fee Juice (the PrivateFPC claimer reconstructs the secret from msg_sender — a random
 *  one is unrecoverable), and a non-FPC fuelRecipient deposits the gas publicly to the
 *  wrong L2 address. The shipping tools always passes both; this guards every other
 *  caller of the exported helper. */
function assertPrivateFuelInvariants(p: SwapBridgeParams): void {
	if (!p.isPrivate) return
	if (!p.fuelSecret) {
		throw new Error(
			"runSwapBridge: private fuel requires an injected fuelSecret (deriveBridgeSecret(salt, claimer)) — a random secret strands the Fee Juice",
		)
	}
	if (!p.tokenClaimSalt) {
		throw new Error(
			"runSwapBridge: private token leg requires an injected tokenClaimSalt — a random token secret strands the deposit against the recipient-committed claim_private",
		)
	}
	if (p.fuelRecipient.toLowerCase() !== PRIVATE_FPC_ADDRESS.toLowerCase()) {
		throw new Error(
			`runSwapBridge: private fuel must target the PrivateFPC (${PRIVATE_FPC_ADDRESS}); got fuelRecipient=${p.fuelRecipient}`,
		)
	}
}

/**
 * The headline one-tx flow: sign a Permit2 witness-bound transfer, then call the router's
 * `bridgeWithFuel` — which pulls the token, swaps `fuelAmount` for Fee Juice, deposits the FJ to
 * L2, and bridges the remaining tokens, atomically. The witness binds every bridge field (the
 * hashing is cross-pinned to the Solidity router in l1.test.ts), so a relayer can't alter
 * recipients/amounts/route after signing. Returns the two claim secrets + the Inbox leaf indices
 * (read from the `BridgeWithFuel` event, not guessed from deposit order) the L2 side claims with.
 * viem-only; the L2 claims (token via claim_*, fuel via publicFeeJuicePayment) run separately.
 */
export async function runSwapBridge(
	l1: L1Ctx,
	p: SwapBridgeParams,
	onStage?: (s: SwapFlowStage) => void,
	recovery?: SwapRecoveryHooks,
): Promise<SwapBridgeResult> {
	assertPrivateFuelInvariants(p)
	// A nonzero-but-invalid recipient (not a Grumpkin point) strands the deposit — it would mint an
	// undecryptable note, and the commitment makes it unrecoverable. Fail closed before the L1 tx.
	if (!(await AztecAddress.fromStringUnsafe(p.aztecRecipient).isValid())) {
		throw new Error("runSwapBridge: aztecRecipient is not a valid Aztec address (not a Grumpkin point) — refusing to deposit")
	}
	// PRIVATE token leg: the secret is derived from (tokenClaimSalt, recipient) so claim_private can
	// re-derive it — the VALUE the L2 claim passes is the SALT (returned as tokenSecretHex). PUBLIC token
	// leg: claim_public binds the recipient in its content hash, so a random secret is correct.
	const tokenClaimValue = p.isPrivate ? (p.tokenClaimSalt as Fr) : Fr.random()
	const tokenSecret = p.isPrivate
		? deriveTokenClaimSecret(p.tokenClaimSalt as Fr, AztecAddress.fromStringUnsafe(p.aztecRecipient))
		: tokenClaimValue
	// PUBLIC fuel: recipient-bound, random is correct. PRIVATE fuel: the caller injects the derived
	// bridge secret so the FPC claimer can reconstruct it (a random one would strand the FJ).
	const fuelSecret = p.fuelSecret ?? Fr.random()
	const tokenSecretHash = (await computeSecretHash(tokenSecret)).toString() as Hex
	const fuelSecretHash = (await computeSecretHash(fuelSecret)).toString() as Hex
	// Persist BOTH secrets before the irreversible swap+bridge — a lost preimage strands the claim.
	recovery?.onSecrets?.({
		tokenSecretHex: tokenClaimValue.toString(),
		fuelSecretHex: fuelSecret.toString(),
		aztecRecipient: p.aztecRecipient,
		isPrivate: p.isPrivate,
	})

	const witness: BridgeWitness = {
		tokenPortal: p.tokenPortal,
		bridgeToken: p.bridgeToken,
		totalAmount: p.totalAmount,
		fuelAmount: p.fuelAmount,
		// PRIVATE recipient is committed via tokenSecretHash, never published — zero the on-chain field so
		// the router's indexed BridgeWithFuel event can't leak R (privacy); the private path ignores it.
		aztecRecipient: p.isPrivate ? ZERO_BYTES32 : p.aztecRecipient,
		fuelRecipient: p.fuelRecipient,
		tokenSecretHash,
		fuelSecretHash,
		minFuelOutput: p.minFuelOutput,
		routeHash: hashRoute(p.path, p.zeroForOnes),
		isPrivate: p.isPrivate,
		swapTarget: p.swapTarget,
	}
	const typedData = bridgeWitnessPermitTypedData(
		{ permitted: { token: p.bridgeToken, amount: p.totalAmount }, spender: p.router, nonce: p.nonce, deadline: p.deadline },
		witness,
		p.permit2,
		p.chainId,
	)

	onStage?.("signing")
	const signature = await l1.wallet.signTypedData({ account: l1.account, ...typedData } as never)

	onStage?.("swapping")
	const bridgeParams = {
		tokenPortal: p.tokenPortal,
		bridgeToken: p.bridgeToken,
		totalAmount: p.totalAmount,
		fuelAmount: p.fuelAmount,
		aztecRecipient: p.isPrivate ? ZERO_BYTES32 : p.aztecRecipient,
		fuelRecipient: p.fuelRecipient,
		tokenSecretHash,
		fuelSecretHash,
		minFuelOutput: p.minFuelOutput,
		path: p.path,
		zeroForOnes: p.zeroForOnes,
		isPrivate: p.isPrivate,
	}
	const receipt = await l1.pub.waitForTransactionReceipt({
		hash: await l1.wallet.writeContract({
			address: p.router,
			abi: p.routerAbi,
			functionName: "bridgeWithFuel",
			args: [bridgeParams, { nonce: p.nonce, deadline: p.deadline, signature }],
			account: l1.account,
			chain: l1.wallet.chain,
		} as never),
	})

	onStage?.("syncing")
	const events = parseEventLogs({ abi: p.routerAbi, eventName: "BridgeWithFuel", logs: receipt.logs })
	const ev = events[0] as { args?: { tokenIndex?: bigint; fuelIndex?: bigint; fuelAmount?: bigint } } | undefined
	if (ev?.args?.tokenIndex === undefined || ev.args.fuelIndex === undefined) {
		throw new Error("bridgeWithFuel emitted no BridgeWithFuel event")
	}
	recovery?.onBridged?.({ tokenLeafIndex: ev.args.tokenIndex, fuelLeafIndex: ev.args.fuelIndex })
	onStage?.("done")
	return {
		// PRIVATE: the claim_salt (claim_private re-derives the secret). PUBLIC: the raw secret.
		tokenSecretHex: tokenClaimValue.toString(),
		fuelSecretHex: fuelSecret.toString(),
		tokenLeafIndex: ev.args.tokenIndex,
		fuelLeafIndex: ev.args.fuelIndex,
		fuelReceived: ev.args.fuelAmount ?? 0n,
	}
}
