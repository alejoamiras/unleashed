import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { catalogMismatches } from "@unleashed/bridge-core"

/*
 * The faucet's deployment records and their re-derivation. No JSON import: a script that verifies
 * a candidate file must never load the live one on the side.
 */

export interface TokenDeployment {
	readonly address: string
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: "constructor_with_minter"
	readonly constructorArgs: {
		readonly name: string
		readonly symbol: string
		readonly decimals: number
		readonly minter: string
		/** 5.0.1 standards Token: the 5th constructor parameter. Absent only on
		 *  pre-5.0.1 records, which can no longer derive under the installed
		 *  artifact — the rebuild fails with a targeted error instead of an
		 *  arity crash. */
		readonly authContract?: string
	}
}

export interface DripperDeployment {
	readonly address: string
	readonly salt: number
	readonly deployer: string
	readonly constructorArtifact: "constructor"
}

export interface DeploymentsJson {
	readonly tokens: readonly TokenDeployment[]
	readonly dripper: DripperDeployment
}

type ReconstructedInstance = Awaited<ReturnType<typeof getContractInstanceFromInstantiationParams>>

/** Record-parameterized rebuilds: the committed live json and a candidate json
 *  (`verify-deployments --config`) go through the SAME derivation, so candidate
 *  verification proves exactly what the app will later trust. */
export async function rebuildDripperInstanceFrom(record: DripperDeployment): Promise<ReconstructedInstance> {
	return getContractInstanceFromInstantiationParams(DripperContractArtifact, {
		constructorArgs: [],
		salt: new Fr(record.salt),
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.fromStringUnsafe(record.deployer),
		constructorArtifact: record.constructorArtifact,
	})
}

export async function rebuildTokenInstanceFrom(record: TokenDeployment): Promise<ReconstructedInstance> {
	const { name, symbol, decimals, minter, authContract } = record.constructorArgs
	if (authContract === undefined) {
		throw new Error(
			`token ${symbol}: pre-5.0.1 record lacks constructorArgs.authContract — the installed 5.0.1 Token ` +
				"artifact takes 5 constructor args; this record cannot re-derive. Redeploy the faucet tokens.",
		)
	}
	return getContractInstanceFromInstantiationParams(TokenContractArtifact, {
		constructorArgs: [name, symbol, decimals, AztecAddress.fromStringUnsafe(minter), AztecAddress.fromStringUnsafe(authContract)],
		salt: new Fr(record.salt),
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.fromStringUnsafe(record.deployer),
		constructorArtifact: record.constructorArtifact,
	})
}

export interface RecordCheck {
	readonly name: string
	readonly ok: boolean
	readonly detail: string
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Checks that `data` is the faucet catalog's deployment (`catalogMismatches`), that the Dripper and
 * each token re-derive to their committed addresses, that each token's minter is this file's
 * Dripper, and that symbols are unique (the app looks tokens up by symbol).
 */
export async function checkDeploymentRecords(data: DeploymentsJson): Promise<RecordCheck[]> {
	const mismatches = catalogMismatches(data)
	const dripper = await rebuildDripperInstanceFrom(data.dripper)
	const checks: RecordCheck[] = [
		{ name: "catalog", ok: mismatches.length === 0, detail: mismatches.join("; ") || "matches FAUCET_TOKENS" },
		{
			name: "dripper",
			ok: same(dripper.address.toString(), data.dripper.address),
			detail: `computed=${dripper.address.toString()} committed=${data.dripper.address}`,
		},
	]
	const seen = new Set<string>()
	for (const record of data.tokens) {
		const { symbol, minter } = record.constructorArgs
		if (seen.has(symbol)) checks.push({ name: symbol, ok: false, detail: "duplicate symbol" })
		seen.add(symbol)
		const token = await rebuildTokenInstanceFrom(record)
		checks.push({
			name: symbol,
			ok: same(token.address.toString(), record.address),
			detail: `computed=${token.address.toString()} committed=${record.address}`,
		})
		checks.push({ name: `${symbol} minter`, ok: same(minter, data.dripper.address), detail: `minter=${minter}` })
	}
	return checks
}
