import { PRIVATE_FPC_ADDRESS, feeJuiceAddress } from "@unleashed/bridge-core"

/** The canonical L2 FeeJuice protocol contract (identical on every network). */
const FEE_JUICE_L2 = AztecAddress.fromStringUnsafe(feeJuiceAddress)
/** The Wonderland PrivateFPC L2 address (pinned from the installed artifact). The wallet auto-registers
 *  it when a tx USES it as fee payer (`fpc/service.ts`), but the no-fuel-claim gate reads its
 *  `balance_of` BEFORE any such tx, and 5.0.1's registerContract conformance (dev #288) stops the read's
 *  on-the-fly Contract.at() from registering the artifact — so the app now pre-registers it at connect
 *  (`useWalletConnection` + `@/contracts/private-fpc`) and it is IN `contracts` (registerable). */
const PRIVATE_FPC_L2 = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { STANDARD_AUTH_REGISTRY_ADDRESS } from "@aztec-labs/standard-contracts/auth-registry/constants"

/**
 * Build the wallet-sdk capability manifest for the Drip tab.
 *
 * Scope is tight:
 *  - `accounts.canCreateAuthWit: false` (Dripper has no auth guards).
 *  - `contracts` lists [DRIPPER, SIGNAL, NOISE]. SponsoredFPC stays OUT of
 *    `contracts` (we don't `wallet.registerContract` it) but its sponsor
 *    call must be in `transaction.scope` because Nulo enforces every
 *    `exec.calls` entry against the granted tx scope.
 *  - `simulation.utilities.scope` - `#[external("utility")]` functions only.
 *    `balance_of_private` lives here.
 *  - `simulation.transactions.scope` - `#[external("public")] #[view]`
 *    functions are routed through public_dispatch as tx-shaped
 *    simulations, even when they don't write state. `balance_of_public`
 *    lives here. Mis-scoping surfaces as "Function artifact not found".
 *  - `transaction.scope` - actual sendTx calls + the SponsoredFPC's
 *    sponsor_unconditionally so the embedded sponsor call passes scope
 *    enforcement.
 *
 * No wildcard scopes.
 */

export interface DripManifestInput {
	readonly dripperAddress: AztecAddress
	readonly usdcAddress: AztecAddress
	readonly ethAddress: AztecAddress
	readonly sponsoredFpcAddress: AztecAddress
	readonly appUrl?: string
}

interface ScopedFunction {
	contract: AztecAddress
	function: string
}

interface AccountsCapability {
	type: "accounts"
	canGet: true
	canCreateAuthWit: boolean
}

interface ContractsCapability {
	type: "contracts"
	contracts: ReadonlyArray<AztecAddress>
	canRegister: true
	canGetMetadata: true
}

interface SimulationCapability {
	type: "simulation"
	utilities: { scope: ReadonlyArray<ScopedFunction> }
	transactions: { scope: ReadonlyArray<ScopedFunction> }
}

interface TransactionCapability {
	type: "transaction"
	scope: ReadonlyArray<ScopedFunction>
}

export interface AppManifest {
	version: "1.0"
	metadata: { name: string; version: string; description: string; url: string }
	capabilities: ReadonlyArray<AccountsCapability | ContractsCapability | SimulationCapability | TransactionCapability>
}

export function buildDripManifest(input: DripManifestInput): AppManifest {
	const { dripperAddress, usdcAddress, ethAddress, sponsoredFpcAddress } = input
	return {
		version: "1.0",
		metadata: {
			name: "unleashed",
			version: "0.1.0",
			description: "Test SIGNAL + NOISE on Aztec alpha-testnet - Unleashed",
			url: input.appUrl ?? defaultUrl(),
		},
		capabilities: [
			{ type: "accounts", canGet: true, canCreateAuthWit: false },
			{
				type: "contracts",
				contracts: [dripperAddress, usdcAddress, ethAddress],
				canRegister: true,
				canGetMetadata: true,
			},
			{
				type: "simulation",
				utilities: {
					scope: [
						{ contract: usdcAddress, function: "balance_of_private" },
						{ contract: ethAddress, function: "balance_of_private" },
					],
				},
				transactions: {
					scope: [
						{ contract: usdcAddress, function: "balance_of_public" },
						{ contract: ethAddress, function: "balance_of_public" },
					],
				},
			},
			{
				type: "transaction",
				scope: [
					{ contract: dripperAddress, function: "drip_to_public" },
					{ contract: dripperAddress, function: "drip_to_private" },
					{ contract: sponsoredFpcAddress, function: "sponsor_unconditionally" },
				],
			},
		],
	}
}

/** Hub entrypoints the wizard SENDS. `register_*` is send-only: an instance the PXE has not seen
 *  cannot be simulated, so there is no dry-run gate for a first-time token's registration. */
const HUB_SEND_FUNCTIONS = [
	"register_token",
	"register_and_claim_public",
	"claim_public",
	"claim_private",
	"exit_to_l1_public",
	"exit_to_l1_private",
] as const

/** Hub sends the deposit dry-runs before it raises the claim prompt. */
const HUB_SIMULATED_SENDS = ["claim_public", "claim_private", "exit_to_l1_public", "exit_to_l1_private"] as const

/** `#[view]` reads on the hub: the token binding, its portal, and the guardian's exit switch. They
 *  are `#[external("public")]`, so they route through public_dispatch as tx-shaped simulations —
 *  `simulation.utilities` is for `#[external("utility")]` only, and mis-scoping surfaces as
 *  "Function artifact not found". */
const HUB_VIEW_FUNCTIONS = ["token_for", "portal_for", "exits_paused"] as const

/** The exit authwit's targets on each hub Token. */
const TOKEN_BURN_FUNCTIONS = ["burn_public", "burn_private"] as const

function at(contract: AztecAddress, functions: readonly string[]): ScopedFunction[] {
	return functions.map((fn) => ({ contract, function: fn }))
}

function each(contracts: readonly AztecAddress[], functions: readonly string[]): ScopedFunction[] {
	return contracts.flatMap((contract) => at(contract, functions))
}

interface ManifestScopes {
	readonly contracts: AztecAddress[]
	readonly utilities: ScopedFunction[]
	readonly simulatedTransactions: ScopedFunction[]
	readonly transactions: ScopedFunction[]
}

/**
 * The send half of a grant: the hub, the hub Tokens this grant covers, and the fee machinery every
 * L2 send leans on. A grant with no hub carries no token scopes either — a Token the hub cannot
 * mint to is not something the app ever calls.
 */
function sendScopes(hub: AztecAddress | undefined, tokens: readonly AztecAddress[]): ManifestScopes {
	const hubTokens = hub ? tokens : []
	const onHub = (functions: readonly string[]): ScopedFunction[] => (hub ? at(hub, functions) : [])
	return {
		contracts: [...(hub ? [hub] : []), ...hubTokens, PRIVATE_FPC_L2],
		utilities: [
			...each(hubTokens, ["balance_of_private"]),
			// No-fuel claim fee source: read the user's PRIVATE Fee Juice held at the PrivateFPC
			// (abi_utility) to decide whether a no-fuel claim can self-pay from it.
			{ contract: PRIVATE_FPC_L2, function: "balance_of" },
		],
		// The hub's sends are simulatable too (a prompt-free PXE dry-run). The deposit gates its claim
		// PROMPT on a successful claim SIMULATION - PXE-aware, since the simulate reverts
		// (l1_to_l2_msg_exists) until the wallet's own PXE can consume the message, which lags the
		// node's checkpoint. Simulations are read-only; the actual send is still gated by the
		// (separate) transaction scope.
		simulatedTransactions: [
			...each(hubTokens, ["balance_of_public"]),
			...onHub(HUB_VIEW_FUNCTIONS),
			...onHub(HUB_SIMULATED_SENDS),
			...each(hubTokens, TOKEN_BURN_FUNCTIONS),
			{ contract: STANDARD_AUTH_REGISTRY_ADDRESS, function: "set_authorized" },
			// The fuel claim (canonical FeeJuice, a protocol contract) must be simulatable: the engine's
			// claim gate dry-runs the token claim WITH the embedded fjwc fee payment.
			...at(FEE_JUICE_L2, ["claim_and_end_setup", "claim"]),
			...at(PRIVATE_FPC_L2, ["mint_and_pay_fee", "pay_fee"]),
			// No-fuel cold-check: read the account's public Fee Juice balance (private FJ is read via
			// PrivateFPC.balance_of in the utilities scope above).
			{ contract: FEE_JUICE_L2, function: "balance_of_public" },
		],
		transactions: [
			// The gas claim riding inside a fueled deposit's claim tx (fjwc embedded payment), then the
			// standalone/sponsored one — an app-phase `claim` may not end setup, the fee payment does.
			...at(FEE_JUICE_L2, ["claim_and_end_setup", "claim"]),
			// Private fuel (gas-follows-token): the 2-call cold-start payment run verbatim by the
			// wallet's EXTERNAL path, plus the self-pay from an existing private FJ balance.
			...at(PRIVATE_FPC_L2, ["mint_and_pay_fee", "pay_fee"]),
			...onHub(HUB_SEND_FUNCTIONS),
			...each(hubTokens, TOKEN_BURN_FUNCTIONS),
			// exit_to_l1 needs a PUBLIC burn auth-wit, which lands on-chain as set_authorized on the
			// standard auth registry (STANDARD_AUTH_REGISTRY_ADDRESS — derived from the artifact in 5.0,
			// no longer protocol slot 0x..01). Without this the exit's auth-wit sendTx hits a
			// transaction-scope violation.
			{ contract: STANDARD_AUTH_REGISTRY_ADDRESS, function: "set_authorized" },
		],
	}
}

interface DripTokens {
	readonly dripper: AztecAddress
	readonly usdc: AztecAddress
	readonly eth: AztecAddress
}

function dripScopes(drip: DripTokens | null, sponsoredFpc: AztecAddress): ManifestScopes {
	if (!drip) return { contracts: [], utilities: [], simulatedTransactions: [], transactions: [] }
	const tokens = [drip.usdc, drip.eth]
	// The faucet is the one surface the sponsor pays for (testnet only): its grant travels with the
	// drip scopes, so a network without a faucet carries no sponsor at all.
	const sponsor = { contract: sponsoredFpc, function: "sponsor_unconditionally" }
	return {
		contracts: [drip.dripper, drip.usdc, drip.eth],
		utilities: each(tokens, ["balance_of_private"]),
		simulatedTransactions: [...each(tokens, ["balance_of_public"]), sponsor],
		transactions: [...at(drip.dripper, ["drip_to_public", "drip_to_private"]), sponsor],
	}
}

function manifestOf(name: string, description: string, url: string, scopes: ManifestScopes): AppManifest {
	return {
		version: "1.0",
		metadata: { name, version: "0.1.0", description, url },
		capabilities: [
			{ type: "accounts", canGet: true, canCreateAuthWit: true },
			{ type: "contracts", contracts: scopes.contracts, canRegister: true, canGetMetadata: true },
			{
				type: "simulation",
				utilities: { scope: scopes.utilities },
				transactions: { scope: scopes.simulatedTransactions },
			},
			{ type: "transaction", scope: scopes.transactions },
		],
	}
}

export interface SendManifestInput {
	/** Absent on a placeholder network — the grant then carries no hub and no token scopes. */
	readonly hub?: AztecAddress
	/** The hub Tokens this grant covers: the manifest's set plus every token the wizard has asked
	 *  for. Exact addresses only — a wildcard Token scope would route burn authwits to silent
	 *  execution. */
	readonly tokens: ReadonlyArray<AztecAddress>
	readonly appUrl?: string
}

/**
 * Build the wallet-sdk capability manifest for the Send wizard. Wider than the Drip tab's:
 *  - `accounts.canCreateAuthWit: true` — an exit needs a burn auth-wit.
 *  - `contracts` = [hub, ...tokens, PrivateFPC]; the wallet registers each of them.
 *  - `transaction.scope` covers registration, claim and exit on the hub, the Token burns the exit
 *    auth-wit drives, and the fee-payment calls (Nulo enforces every `exec.calls` entry against
 *    the granted tx scope). No sponsor: every bridge transaction pays from Fee Juice the user
 *    bridged or already holds, on every network.
 *
 * Growing `tokens` is what makes the wallet re-prompt: the approval replaces the stored grant, so a
 * request must always carry the WHOLE set, never just the newcomer.
 */
export function buildSendManifest(input: SendManifestInput): AppManifest {
	const scopes = sendScopes(input.hub, input.tokens)
	return manifestOf(
		"unleashed-bridge",
		"Bridge assets between Ethereum (L1) and Aztec (L2) - Unleashed",
		input.appUrl ?? defaultUrl(),
		scopes,
	)
}

export interface CombinedManifestInput {
	/** The drip tokens (Dripper/SIGNAL/NOISE) — testnet-only. Omit ALL three on mainnet: the grant then
	 *  covers the Bridge + fuel (public + private) but NOT the Drip tab, matching the mainnet UI (no
	 *  Drip tab). The PrivateFPC + FEE_JUICE + auth-registry grants are always present, so
	 *  private-fuel-paid claims work on both networks. */
	readonly dripperAddress?: AztecAddress
	readonly usdcAddress?: AztecAddress
	readonly ethAddress?: AztecAddress
	/** Absent on a placeholder network — no hub, so no hub or token scopes. */
	readonly hub?: AztecAddress
	readonly hubTokens?: ReadonlyArray<AztecAddress>
	readonly sponsoredFpcAddress: AztecAddress
	readonly appUrl?: string
}

/**
 * Build ONE manifest covering the Send wizard + fuel, and — when the drip tokens are supplied
 * (testnet) — the Drip tab too. The tabs are the same origin = the same app to the wallet, which keys
 * the grant per-app, so two separate manifests collide (the second connect's grant shadows the
 * first, and registerContract for the missing contracts hits a scope violation). One complete
 * manifest, requested once, fixes that.
 */
export function buildCombinedManifest(input: CombinedManifestInput): AppManifest {
	const { dripperAddress, usdcAddress, ethAddress, sponsoredFpcAddress } = input
	// All three drip tokens present ⇒ include the drip grants; none ⇒ send+fuel only (mainnet).
	const drip = dripperAddress && usdcAddress && ethAddress ? { dripper: dripperAddress, usdc: usdcAddress, eth: ethAddress } : null
	const send = sendScopes(input.hub, input.hubTokens ?? [])
	const drips = dripScopes(drip, sponsoredFpcAddress)
	return manifestOf(
		"unleashed",
		drip ? "Drip + Bridge on Aztec - Unleashed" : "Bridge on Aztec - Unleashed",
		input.appUrl ?? defaultUrl(),
		{
			contracts: [...send.contracts, ...drips.contracts],
			utilities: [...drips.utilities, ...send.utilities],
			simulatedTransactions: [...drips.simulatedTransactions, ...send.simulatedTransactions],
			transactions: [...drips.transactions, ...send.transactions],
		},
	)
}

function defaultUrl(): string {
	if (typeof window === "undefined") return "https://localhost"
	return window.location.origin
}
