/**
 * The wallet grant the SDK's claims need, as `@aztec-labs/wallet-sdk` capability entries to merge into the
 * integrator's own request. Exact addresses only: a wallet that enforces scopes refuses every call a grant does not
 * name, and a wildcard would let any contract's call through.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { refusal } from "./errors.ts"
import { assertNetwork, type Network } from "./network.ts"
import { feeJuiceAddress } from "./protocol/fee-juice.ts"

export interface ScopedFunction {
	contract: AztecAddress
	function: string
}

export type Capability =
	| { type: "accounts"; canGet: true; canCreateAuthWit: false }
	| { type: "contracts"; contracts: AztecAddress[]; canRegister: true; canGetMetadata: true }
	| { type: "simulation"; utilities: { scope: ScopedFunction[] }; transactions: { scope: ScopedFunction[] } }
	| { type: "transaction"; scope: ScopedFunction[] }

/** The Fee Juice claims: a public self-paid claim ends setup in its fee payment, a private one mints into the FPC. */
const FEE_JUICE_SENDS = ["claim_and_end_setup", "claim"] as const
const FPC_SENDS = ["mint_and_pay_fee", "pay_fee"] as const
/** Registration is send-only: no wallet can simulate the constructor of a token instance it does not hold yet. */
const HUB_SENDS = ["register_token", "register_and_claim_public", "claim_public", "claim_private"] as const
const HUB_DRY_RUNS = ["token_for", "claim_public", "claim_private"] as const

/** What a grant reads of a resolved token: structural, so this root module stays clear of the hub's graph. */
interface GrantedToken {
	network: Network
	l2Token: string
}

const at = (contract: AztecAddress, functions: readonly string[]): ScopedFunction[] => functions.map((fn) => ({ contract, function: fn }))

/**
 * What a claim of this network's gas (`fuel`) and of these tokens' deposits calls. Throws `invalid-request` for a token
 * resolved on another network, or any token on a network without a token route.
 */
export function capabilitiesFor(net: Network, need: { fuel?: true; tokens?: readonly GrantedToken[] }): Capability[] {
	assertNetwork(net)
	const tokens = need.tokens ?? []
	if (tokens.some((t) => t.network !== net)) throw refusal("invalid-request", "a token was resolved on another network")
	if (tokens.length > 0 && !net.bridge) throw refusal("invalid-request", "this network has no token route")
	const feeJuice = AztecAddress.fromStringUnsafe(feeJuiceAddress)
	const fpc = AztecAddress.fromStringUnsafe(net.privateFpc)
	const fees = [...at(feeJuice, FEE_JUICE_SENDS), ...at(fpc, FPC_SENDS)]
	const hub = net.bridge && tokens.length > 0 ? AztecAddress.fromStringUnsafe(net.bridge.hub) : undefined
	const l2Tokens = [...new Set(tokens.map((t) => t.l2Token.toLowerCase()))].map((a) => AztecAddress.fromStringUnsafe(a))
	return [
		{ type: "accounts", canGet: true, canCreateAuthWit: false },
		{ type: "contracts", contracts: [...(hub ? [hub, ...l2Tokens] : []), fpc], canRegister: true, canGetMetadata: true },
		{
			type: "simulation",
			// A claim with no fresh Fee Juice pays from what the account already holds, read first.
			utilities: { scope: hub ? at(fpc, ["balance_of"]) : [] },
			transactions: {
				scope: [...fees, ...(hub ? [...at(hub, HUB_DRY_RUNS), ...at(feeJuice, ["balance_of_public"])] : [])],
			},
		},
		{ type: "transaction", scope: [...fees, ...(hub ? at(hub, HUB_SENDS) : [])] },
	]
}
