/**
 * L1 side of the bridge: the Permit2 witness-bound call for DepositRouter's `bridgeWithPermit` (viem). The
 * witness hashing here MUST match the Solidity router byte-for-byte — a mismatch makes the Permit2 signature
 * invalid and the bridge reverts. Pinned by l1.test.ts against DepositWitness.t.sol's shared vector.
 */
import { type Address, type Hex, encodeAbiParameters, keccak256, toHex } from "viem"

/** Permit2 `PermitWitnessTransferFrom` inputs (the SignatureTransfer half). */
export interface Permit2Transfer {
	permitted: { token: Address; amount: bigint }
	spender: Address // the router the signature authorizes
	nonce: bigint
	deadline: bigint
}

/** Mirrors `DepositRouter.DEPOSIT_WITNESS_TYPEHASH`'s preimage. */
export const DEPOSIT_WITNESS_TYPE =
	"DepositWitness(bytes32 aztecRecipient,bytes32 tokenSecretHash,bool isPrivate,uint256 fuelSlice,bytes32 fuelRecipient,bytes32 fuelSecretHash,uint256 minFuelOutput,bytes32 swapDataHash)"

/** Permit2's `witnessTypeString` for `DepositRouter.bridgeWithPermit` (`DEPOSIT_WITNESS_TYPE_STRING`). */
export const DEPOSIT_WITNESS_TYPE_STRING = `DepositWitness witness)${DEPOSIT_WITNESS_TYPE}TokenPermissions(address token,uint256 amount)`

export const DEPOSIT_WITNESS_TYPEHASH = keccak256(toHex(DEPOSIT_WITNESS_TYPE))

/**
 * What `DepositRouter.bridgeWithPermit` binds beyond Permit2's own token, amount, spender, nonce and deadline. The
 * token is not a member: it is `permitted.token`, which the router reads from the intent.
 */
export interface DepositWitness {
	aztecRecipient: Hex
	tokenSecretHash: Hex
	isPrivate: boolean
	fuelSlice: bigint
	fuelRecipient: Hex
	fuelSecretHash: Hex
	minFuelOutput: bigint
	/** `keccak256(swapData)`; a plain send signs the hash of empty bytes. */
	swapDataHash: Hex
}

/** The witness for an intent and the exact `swapData` the router will receive. */
export function depositWitness(intent: Omit<DepositWitness, "swapDataHash">, swapData: Hex): DepositWitness {
	return {
		aztecRecipient: intent.aztecRecipient,
		tokenSecretHash: intent.tokenSecretHash,
		isPrivate: intent.isPrivate,
		fuelSlice: intent.fuelSlice,
		fuelRecipient: intent.fuelRecipient,
		fuelSecretHash: intent.fuelSecretHash,
		minFuelOutput: intent.minFuelOutput,
		swapDataHash: keccak256(swapData),
	}
}

/** keccak256(abi.encode(TYPEHASH, ...fields)): `DepositRouter.hashWitness`. */
export function hashDepositWitness(w: DepositWitness): Hex {
	return keccak256(
		encodeAbiParameters(
			[
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "bool" },
				{ type: "uint256" },
				{ type: "bytes32" },
				{ type: "bytes32" },
				{ type: "uint256" },
				{ type: "bytes32" },
			],
			[
				DEPOSIT_WITNESS_TYPEHASH,
				w.aztecRecipient,
				w.tokenSecretHash,
				w.isPrivate,
				w.fuelSlice,
				w.fuelRecipient,
				w.fuelSecretHash,
				w.minFuelOutput,
				w.swapDataHash,
			],
		),
	)
}

/** EIP-712 types for Permit2 `PermitWitnessTransferFrom` bound to `DepositWitness`; members mirror `DEPOSIT_WITNESS_TYPE`. */
export const DEPOSIT_WITNESS_PERMIT_TYPES = {
	PermitWitnessTransferFrom: [
		{ name: "permitted", type: "TokenPermissions" },
		{ name: "spender", type: "address" },
		{ name: "nonce", type: "uint256" },
		{ name: "deadline", type: "uint256" },
		{ name: "witness", type: "DepositWitness" },
	],
	TokenPermissions: [
		{ name: "token", type: "address" },
		{ name: "amount", type: "uint256" },
	],
	DepositWitness: [
		{ name: "aztecRecipient", type: "bytes32" },
		{ name: "tokenSecretHash", type: "bytes32" },
		{ name: "isPrivate", type: "bool" },
		{ name: "fuelSlice", type: "uint256" },
		{ name: "fuelRecipient", type: "bytes32" },
		{ name: "fuelSecretHash", type: "bytes32" },
		{ name: "minFuelOutput", type: "uint256" },
		{ name: "swapDataHash", type: "bytes32" },
	],
} as const

/** The viem `signTypedData` payload for `bridgeWithPermit`; `transfer.spender` is the DepositRouter. */
export function depositWitnessPermitTypedData(transfer: Permit2Transfer, witness: DepositWitness, permit2: Address, chainId: number) {
	return {
		domain: { name: "Permit2", chainId, verifyingContract: permit2 },
		types: DEPOSIT_WITNESS_PERMIT_TYPES,
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
