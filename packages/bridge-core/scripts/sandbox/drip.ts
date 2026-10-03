/** The faucet on the sandbox: Wonderland's Dripper and the two drip tokens, universally deployed
 *  at the salts the tools app records — deployer ZERO + fixed salt + the same constructor args land
 *  the SAME addresses on every chain, so the app's committed `deployments.json` already names them. */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase } from "@aztec-labs/aztec.js/contracts"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { FAUCET_DRIPPER_SALT, FAUCET_TOKENS } from "../../src/faucet-catalog"
import type { L2Ctx } from "../generation"
import type { L2Base } from "./l2"

export const DRIPPER_SALT = FAUCET_DRIPPER_SALT
export const DRIP_TOKENS = FAUCET_TOKENS

export interface DripTokenRecord {
	address: string
	salt: number
	deployer: string
	constructorArtifact: "constructor_with_minter"
	constructorArgs: { name: string; symbol: string; decimals: number; minter: string; authContract: string }
}

/** The shape `apps/tools/src/contracts/deployments.json` carries, so the app can read a sandbox run's copy verbatim. */
export interface DripDeploymentRecord {
	tokens: DripTokenRecord[]
	dripper: { address: string; salt: number; deployer: string; constructorArtifact: "constructor" }
}

type Artifact = typeof TokenContractArtifact

async function universalInstance(artifact: Artifact, constructorArgs: unknown[], constructorArtifact: string, salt: number) {
	return getContractInstanceFromInstantiationParams(artifact, {
		constructorArgs,
		salt: new Fr(salt),
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.ZERO,
		constructorArtifact,
	})
}

async function deployUniversal(
	l2: L2Ctx,
	artifact: Artifact,
	constructorArgs: unknown[],
	constructorArtifact: string,
	salt: number,
): Promise<AztecAddress> {
	const instance = await universalInstance(artifact, constructorArgs, constructorArtifact, salt)
	if (await l2.node.getContract(instance.address)) {
		await l2.wallet.registerContract(instance, artifact).catch(() => {})
		return instance.address
	}
	const method = Contract.deploy(l2.wallet, artifact, constructorArgs, constructorArtifact, { salt: new Fr(salt), universalDeploy: true })
	await method.send({ ...l2.deployOpts, wait: { waitForStatus: TxStatus.PROPOSED } } as never)
	if (!(await l2.node.getContract(instance.address))) throw new Error(`universal deploy did not land at ${instance.address}`)
	return instance.address
}

export async function deployDripFixture(l2: L2Ctx): Promise<DripDeploymentRecord> {
	const dripper = await deployUniversal(l2, DripperContractArtifact as unknown as Artifact, [], "constructor", DRIPPER_SALT)
	const tokens: DripTokenRecord[] = []
	for (const t of DRIP_TOKENS) {
		const args = [t.name, t.symbol, t.decimals, dripper, AztecAddress.ZERO]
		const address = await deployUniversal(l2, TokenContractArtifact, args, "constructor_with_minter", t.salt)
		tokens.push({
			address: address.toString(),
			salt: t.salt,
			deployer: AztecAddress.ZERO.toString(),
			constructorArtifact: "constructor_with_minter",
			constructorArgs: {
				name: t.name,
				symbol: t.symbol,
				decimals: t.decimals,
				minter: dripper.toString(),
				authContract: AztecAddress.ZERO.toString(),
			},
		})
		console.log(`  ${t.symbol}: ${address.toString()}`)
	}
	console.log(`  Dripper: ${dripper.toString()}`)
	return {
		tokens,
		dripper: {
			address: dripper.toString(),
			salt: DRIPPER_SALT,
			deployer: AztecAddress.ZERO.toString(),
			constructorArtifact: "constructor",
		},
	}
}

/** Registers the faucet contracts with a wallet that did not deploy them (a fresh actor's view). */
export async function registerDripFixture(
	wallet: Wallet,
	record: DripDeploymentRecord,
): Promise<{ dripper: ContractBase; tokens: Map<string, ContractBase> }> {
	const dripperInstance = await universalInstance(DripperContractArtifact as unknown as Artifact, [], "constructor", record.dripper.salt)
	await wallet.registerContract(dripperInstance, DripperContractArtifact as never).catch(() => {})
	const tokens = new Map<string, ContractBase>()
	for (const t of record.tokens) {
		const args = [
			t.constructorArgs.name,
			t.constructorArgs.symbol,
			t.constructorArgs.decimals,
			AztecAddress.fromStringUnsafe(t.constructorArgs.minter),
			AztecAddress.fromStringUnsafe(t.constructorArgs.authContract),
		]
		const instance = await universalInstance(TokenContractArtifact, args, "constructor_with_minter", t.salt)
		await wallet.registerContract(instance, TokenContractArtifact).catch(() => {})
		tokens.set(t.constructorArgs.symbol, Contract.at(instance.address, TokenContractArtifact, wallet))
	}
	return { dripper: Contract.at(dripperInstance.address, DripperContractArtifact as never, wallet), tokens }
}

export async function dripTo(
	l2: L2Ctx,
	dripper: ContractBase,
	token: ContractBase,
	amount: bigint,
	kind: "public" | "private",
): Promise<void> {
	const call =
		kind === "public" ? dripper.methods.drip_to_public(token.address, amount) : dripper.methods.drip_to_private(token.address, amount)
	await call.send(l2.sendOpts as never)
}

export type { L2Base }
