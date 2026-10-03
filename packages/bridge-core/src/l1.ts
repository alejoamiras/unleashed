/**
 * L1 side of the bridge: build the Permit2 witness-bound `bridgeWithFuel` /
 * `bridge` calls for SwapBridgeRouter (viem). The witness + route hashing here
 * MUST match the Solidity router's `_hashBridgeWitness` / `_hashRoute`
 * byte-for-byte — a mismatch makes the Permit2 signature invalid and the bridge
 * reverts. Pinned by l1.test.ts against the on-chain typehash.
 */
import { type Address, type Hex, encodeAbiParameters, keccak256, toHex } from "viem"

/** Mirrors SwapBridgeRouter.BRIDGE_WITNESS_TYPEHASH. */
export const BRIDGE_WITNESS_TYPE =
	"BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 routeHash,bool isPrivate,address swapTarget)"

export const BRIDGE_WITNESS_TYPEHASH = keccak256(toHex(BRIDGE_WITNESS_TYPE))

/** A V4 pool hop, matching SwapBridgeRouter.IUniswapFuelSwap.PoolKey. */
export interface PoolKey {
	currency0: Address
	currency1: Address
	fee: number
	tickSpacing: number
	hooks: Address
}

export interface BridgeWitness {
	tokenPortal: Address
	bridgeToken: Address
	totalAmount: bigint
	fuelAmount: bigint
	aztecRecipient: Hex // bytes32 (L2 address)
	fuelRecipient: Hex // bytes32 (L2 address / FPC)
	tokenSecretHash: Hex // bytes32
	fuelSecretHash: Hex // bytes32
	minFuelOutput: bigint
	routeHash: Hex // bytes32
	isPrivate: boolean
	swapTarget: Address // the router's current swap target — witness-bound (F-004)
}

/** keccak256(abi.encode(path, zeroForOnes)) — matches SwapBridgeRouter._hashRoute. */
export function hashRoute(path: PoolKey[], zeroForOnes: boolean[]): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{
					type: "tuple[]",
					components: [
						{ name: "currency0", type: "address" },
						{ name: "currency1", type: "address" },
						{ name: "fee", type: "uint24" },
						{ name: "tickSpacing", type: "int24" },
						{ name: "hooks", type: "address" },
					],
				},
				{ type: "bool[]" },
			],
			[path, zeroForOnes],
		),
	)
}

/** Permit2 `PermitWitnessTransferFrom` inputs (the SignatureTransfer half). */
export interface Permit2Transfer {
	permitted: { token: Address; amount: bigint }
	spender: Address // the SwapBridgeRouter
	nonce: bigint
	deadline: bigint
}

/**
 * EIP-712 types for Permit2 `PermitWitnessTransferFrom` bound to our
 * `BridgeWitness`. The `BridgeWitness` member list MUST stay byte-identical to
 * `BRIDGE_WITNESS_TYPE` (pinned by l1.test.ts) — Permit2 hashes the witness with
 * this struct, and the router re-derives it via `_hashBridgeWitness`.
 */
export const BRIDGE_WITNESS_PERMIT_TYPES = {
	PermitWitnessTransferFrom: [
		{ name: "permitted", type: "TokenPermissions" },
		{ name: "spender", type: "address" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "witness", type: "BridgeWitness" },
	],
	TokenPermissions: [
		{ name: "token", type: "address" },
		{ name: "amount", type: "uint256" },
	],
	BridgeWitness: [
		{ name: "tokenPortal", type: "address" },
		{ name: "bridgeToken", type: "address" },
		{ name: "totalAmount", type: "uint256" },
		{ name: "fuelAmount", type: "uint256" },
		{ name: "aztecRecipient", type: "bytes32" },
		{ name: "fuelRecipient", type: "bytes32" },
		{ name: "tokenSecretHash", type: "bytes32" },
		{ name: "fuelSecretHash", type: "bytes32" },
		{ name: "minFuelOutput", type: "uint256" },
		{ name: "routeHash", type: "bytes32" },
		{ name: "isPrivate", type: "bool" },
		{ name: "swapTarget", type: "address" },
	],
} as const

/** Build the viem `signTypedData` payload for a witness-bound Permit2 transfer. */
export function bridgeWitnessPermitTypedData(transfer: Permit2Transfer, witness: BridgeWitness, permit2: Address, chainId: number) {
	return {
		domain: { name: "Permit2", chainId, verifyingContract: permit2 },
		types: BRIDGE_WITNESS_PERMIT_TYPES,
		primaryType: "PermitWitnessTransferFrom" as const,
		message: {
			permitted: transfer.permitted,
			spender: transfer.spender,
			nonce: transfer.nonce,
			deadline: transfer.deadline,
			witness,
		},
	}
}

/** keccak256(abi.encode(TYPEHASH, ...fields)) — matches SwapBridgeRouter._hashBridgeWitness. */
export function hashBridgeWitness(w: BridgeWitness): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32" }, // typehash
				{ type: "address" }, // tokenPortal
				{ type: "address" }, // bridgeToken
				{ type: "uint256" }, // totalAmount
				{ type: "uint256" }, // fuelAmount
				{ type: "bytes32" }, // aztecRecipient
				{ type: "bytes32" }, // fuelRecipient
				{ type: "bytes32" }, // tokenSecretHash
				{ type: "bytes32" }, // fuelSecretHash
				{ type: "uint256" }, // minFuelOutput
				{ type: "bytes32" }, // routeHash
				{ type: "bool" }, // isPrivate
				{ type: "address" }, // swapTarget
			],
			[
				BRIDGE_WITNESS_TYPEHASH,
				w.tokenPortal,
				w.bridgeToken,
				w.totalAmount,
				w.fuelAmount,
				w.aztecRecipient,
				w.fuelRecipient,
				w.tokenSecretHash,
				w.fuelSecretHash,
				w.minFuelOutput,
				w.routeHash,
				w.isPrivate,
				w.swapTarget,
			],
		),
	)
}

/** Permit signature validity, in seconds. Bounds the window in which a signed fuel-leg intent can be
 *  executed after the quote it was derived from: the slippage floor bounds LOSS per execution, but the
 *  deadline bounds how long an unexecuted signature stays executable against a moved market. 10 minutes
 *  covers congestion without handing MEV a half-hour window; re-signing is free (a fresh quote comes
 *  with it). Pinned by l1.test.ts — a convenience bump back toward `Date.now() + huge` trips CI. */
export const PERMIT_DEADLINE_SECONDS = 600n

/** Stages of the one-time Permit2 approval, surfaced to UIs/smokes via `onStatus`. */
export type Permit2ApprovalStatus = "sufficient" | "approving" | "waiting" | "approved"

/**
 * The ONE Permit2 approval state machine — used by the app's deposit/fuel legs AND the candidate
 * smokes, so what the smokes rehearse is exactly what users run. Sequence:
 * read allowance → short-circuit when sufficient → approve(Permit2, max) → wait receipt (revert =
 * throw) → RE-READ the allowance (belt+braces: a "successful" approve against the wrong token/spender
 * wiring still fails closed here) → done. Callers inject the transport (viem app clients, script
 * clients, jsdom fakes) via the three callbacks.
 */
export async function ensurePermit2Allowance(deps: {
	allowance: () => Promise<bigint>
	approveMax: () => Promise<Hex>
	waitReceipt: (txHash: Hex) => Promise<{ status?: string }>
	needed: bigint
	onStatus?: (status: Permit2ApprovalStatus, txHash?: Hex) => void
}): Promise<{ approved: boolean; txHash?: Hex }> {
	if ((await deps.allowance()) >= deps.needed) {
		deps.onStatus?.("sufficient")
		return { approved: false }
	}
	deps.onStatus?.("approving")
	const txHash = await deps.approveMax()
	deps.onStatus?.("waiting", txHash)
	const receipt = await deps.waitReceipt(txHash)
	if (receipt.status !== undefined && receipt.status !== "success") {
		throw new Error(`Permit2 approval reverted (${txHash}) — token refuses the approve; cannot bridge`)
	}
	if ((await deps.allowance()) < deps.needed) {
		throw new Error(`Permit2 allowance still insufficient after approval ${txHash} — wrong token/spender wiring; STOP`)
	}
	deps.onStatus?.("approved", txHash)
	return { approved: true, txHash }
}
