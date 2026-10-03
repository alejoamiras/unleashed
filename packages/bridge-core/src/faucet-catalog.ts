/** A token the testnet faucet deploys, with the Dripper as its minter. */
export interface FaucetToken {
	readonly name: string
	readonly symbol: string
	readonly decimals: number
	readonly salt: number
}

/**
 * The faucet's tokens: the one list the deploy config, the app's lookups and the sandbox read.
 * Salts 4242–4245 belong to retired faucet generations and are never reused.
 */
export const FAUCET_TOKENS = [
	{ name: "SIGNAL", symbol: "SIGNAL", decimals: 6, salt: 4246 },
	{ name: "NOISE", symbol: "NOISE", decimals: 18, salt: 4247 },
] as const satisfies readonly FaucetToken[]

export type FaucetSymbol = (typeof FAUCET_TOKENS)[number]["symbol"]

/** Wonderland's default: a Dripper already deployed universally at this salt is the same contract,
 *  and shared. */
export const FAUCET_DRIPPER_SALT = 1337

/** The fields of a faucet deployment file that the catalog fixes. Address derivation and the
 *  minter are checked where the instances are rebuilt. */
export interface FaucetRecords {
	readonly dripper: { readonly salt: number; readonly deployer: string; readonly constructorArtifact: string }
	readonly tokens: readonly FaucetTokenRecord[]
}

interface FaucetTokenRecord {
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: string
	readonly constructorArgs: { readonly name: string; readonly symbol: string; readonly decimals: number; readonly authContract?: string }
}

const ZERO_ADDRESS = /^0x0{64}$/i

function tokenMismatches(want: FaucetToken, records: readonly FaucetTokenRecord[]): string[] {
	const found = records.filter((r) => r.constructorArgs.symbol === want.symbol)
	if (found.length !== 1) return [`${want.symbol}: ${found.length} records, expected 1`]
	const [r] = found
	const out: string[] = []
	if (r.constructorArgs.name !== want.name || r.constructorArgs.decimals !== want.decimals || r.salt !== want.salt) {
		out.push(`${want.symbol}: expected name ${want.name}, decimals ${want.decimals}, salt ${want.salt}`)
	}
	if (
		!ZERO_ADDRESS.test(r.deployer) ||
		r.constructorArtifact !== "constructor_with_minter" ||
		!ZERO_ADDRESS.test(r.constructorArgs.authContract ?? "")
	) {
		out.push(`${want.symbol}: expected deployer zero, constructor_with_minter and no auth contract`)
	}
	return out
}

/**
 * Where a deployment file departs from the catalog: empty only when it holds exactly one record per
 * catalog token, with the catalog's name, decimals and salt, deployed universally with no auth
 * contract, beside a universal Dripper at FAUCET_DRIPPER_SALT. A file that is self-consistent for
 * other parameters still derives valid addresses, so address checks alone cannot catch it.
 */
export function catalogMismatches(data: FaucetRecords): string[] {
	const out: string[] = []
	const d = data.dripper
	if (d.salt !== FAUCET_DRIPPER_SALT || !ZERO_ADDRESS.test(d.deployer) || d.constructorArtifact !== "constructor") {
		out.push(`dripper: expected salt ${FAUCET_DRIPPER_SALT}, deployer zero and constructor`)
	}
	for (const want of FAUCET_TOKENS) out.push(...tokenMismatches(want, data.tokens))
	for (const r of data.tokens) {
		if (!FAUCET_TOKENS.some((t) => t.symbol === r.constructorArgs.symbol))
			out.push(`${r.constructorArgs.symbol}: not in the faucet catalog`)
	}
	return out
}
