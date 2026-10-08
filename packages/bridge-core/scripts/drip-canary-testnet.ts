/**
 * LIVE-testnet tools drip canary: proves the deployed Dripper actually drips EVERY token in the
 * file through the SAME call the tools app UI makes (`drip_to_public(token, amount)` paid by the
 * Sponsored FPC) from a fresh L2 account. The file must match the faucet catalog, and every instance
 * is REBUILT from its params with the address and minter asserted, all before any account exists:
 * a drifted record fails here, not in a user's browser.
 *
 * Run: bun scripts/drip-canary-testnet.ts [--config <path>]   (no L1 env needed; the drip is L2-only)
 */
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { TokenContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Token.js"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { catalogMismatches } from "../src/faucet-catalog"
import { stopwatch } from "./script-bootstrap"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL

const here = dirname(fileURLToPath(import.meta.url))
// `--config <path>` targets a CANDIDATE manifest (candidate-first: the canary must
// prove the candidate BEFORE promote touches the live file); default = live.
const configArgIndex = process.argv.indexOf("--config")
const deploymentsPath =
	configArgIndex >= 0 && process.argv[configArgIndex + 1]
		? process.argv[configArgIndex + 1]
		: join(here, "..", "..", "..", "apps", "tools", "src", "contracts", "deployments.json")
type TokenRecord = {
	address: string
	salt: number
	constructorArtifact: string
	constructorArgs: { name: string; symbol: string; decimals: number; minter: string; authContract?: string }
}
const deployments = JSON.parse(readFileSync(deploymentsPath, "utf8")) as {
	dripper: { address: string; salt: number; deployer: string; constructorArtifact: string }
	tokens: (TokenRecord & { deployer: string })[]
}

/** Rebuilds a token from its record and asserts the address and that this file's Dripper mints it. */
async function rebuildToken(record: TokenRecord) {
	const a = record.constructorArgs
	// 5.0.1 standards Token: constructor_with_minter takes 5 args; a record without
	// authContract predates the fence and cannot re-derive under the installed artifact.
	if (!a.authContract) throw new Error(`${a.symbol} record lacks constructorArgs.authContract (pre-5.0.1 shape) — redeploy first`)
	if (a.minter.toLowerCase() !== deployments.dripper.address.toLowerCase()) {
		throw new Error(`${a.symbol} minter ${a.minter} is not this file's Dripper ${deployments.dripper.address}`)
	}
	const instance = await getContractInstanceFromInstantiationParams(
		TokenContractArtifact as never,
		{
			salt: new Fr(record.salt),
			publicKeys: PublicKeys.default(),
			deployer: AztecAddress.ZERO,
			constructorArtifact: record.constructorArtifact,
			constructorArgs: [
				a.name,
				a.symbol,
				a.decimals,
				AztecAddress.fromStringUnsafe(a.minter),
				AztecAddress.fromStringUnsafe(a.authContract),
			],
		} as never,
	)
	if (instance.address.toString() !== record.address) {
		throw new Error(`${a.symbol} rebuilt ${instance.address} != committed ${record.address}`)
	}
	return instance
}

/** The Dripper and every token, rebuilt from the file and asserted against it and the catalog. */
async function rebuildAll() {
	const mismatches = catalogMismatches(deployments)
	if (mismatches.length > 0) throw new Error(`the deployments file is not the faucet catalog's: ${mismatches.join("; ")}`)
	const dripper = await getContractInstanceFromInstantiationParams(
		DripperContractArtifact as never,
		{
			salt: new Fr(deployments.dripper.salt),
			publicKeys: PublicKeys.default(),
			deployer: AztecAddress.ZERO,
			constructorArtifact: deployments.dripper.constructorArtifact,
			constructorArgs: [],
		} as never,
	)
	if (dripper.address.toString() !== deployments.dripper.address) {
		throw new Error(`dripper rebuilt ${dripper.address} != committed ${deployments.dripper.address}`)
	}
	const tokens = await Promise.all(deployments.tokens.map(async (record) => ({ record, instance: await rebuildToken(record) })))
	return { dripper, tokens }
}

type Rebuilt = Awaited<ReturnType<typeof rebuildAll>>

async function dripEach(ewallet: EmbeddedWallet, { dripper: dripperInstance, tokens }: Rebuilt, mins: () => string) {
	const { signingKey, secretKey } = await deriveNuloAccountKeys(Fr.random())
	const manager = await ewallet.createSchnorrAccount(secretKey, Fr.random(), signingKey)
	const from = (await manager.getAccount()).getAddress()
	console.log(`L2 drip recipient ${from.toString()}`)

	const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
	try {
		await ewallet.registerContract(fpc, SponsoredFPCContract.artifact)
	} catch {}
	const sponsoredFee = { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) }
	if (!(await createAztecNodeClient(NODE_URL).getContract(from))) {
		console.log(`deploying L2 account via sponsored FPC (real proof)… (${mins()})`)
		const deployMethod = await manager.getDeployMethod()
		await deployMethod.send({ fee: sponsoredFee, from: "NO_FROM" as never } as never)
		console.log(`L2 account deployed (${mins()})`)
	}
	try {
		await ewallet.registerContract(dripperInstance, DripperContractArtifact as never)
	} catch {}
	for (const { instance } of tokens) {
		try {
			await ewallet.registerContract(instance, TokenContractArtifact as never)
		} catch {}
	}

	const dripper = await Contract.at(dripperInstance.address, DripperContractArtifact as never, ewallet as never)
	for (const { record, instance } of tokens) {
		const { symbol, decimals } = record.constructorArgs
		// One whole token: enough to prove the mint, whatever the decimals.
		const amount = 10n ** BigInt(decimals)
		const token = await Contract.at(instance.address, TokenContractArtifact as never, ewallet as never)
		const balanceOf = async (): Promise<bigint> => {
			const r = (await token.methods.balance_of_public(from).simulate({ from })) as { result?: bigint } | bigint
			return typeof r === "bigint" ? r : (r.result ?? 0n)
		}
		const before = await balanceOf()
		console.log(`dripping ${amount} ${symbol}-units (sponsored)… (${mins()})`)
		await dripper.methods.drip_to_public(instance.address, amount).send({
			from,
			fee: sponsoredFee,
			wait: { waitForStatus: TxStatus.PROPOSED },
		} as never)
		const after = await balanceOf()
		if (after - before !== amount) throw new Error(`${symbol} drip landed ${after - before}, expected ${amount}`)
		console.log(`[OK] ${symbol}: ${amount} units landed (${mins()})`)
	}
}

async function main() {
	console.log(`drip canary config: ${deploymentsPath}`)
	const mins = stopwatch()
	const rebuilt = await rebuildAll()
	console.log(`dripper + ${rebuilt.tokens.length} token instances rebuilt and match the file (${mins()})`)

	// The SDK's `ephemeral` stores are temp directories it never removes, and its default store is
	// ./aztec-wallet-data. This run's account key lives in a directory it owns, on real disk, and
	// removes on every exit path, an interrupt included.
	const base = join(homedir(), ".cache", "unleashed")
	await mkdir(base, { recursive: true })
	const dataDirectory = await mkdtemp(join(base, "drip-canary-"))
	let walletReady: Promise<EmbeddedWallet> | undefined
	let released: Promise<void> | undefined
	// Waits for a wallet still being created, so an interrupt during creation cannot skip its stop.
	const release = (): Promise<void> =>
		(released ??= (async () => {
			const ewallet = await walletReady?.catch(() => undefined)
			await ewallet?.stop().catch(() => {})
			await rm(dataDirectory, { recursive: true, force: true })
		})())
	const onSignal = (): void => void release().finally(() => process.exit(130))
	process.once("SIGINT", onSignal).once("SIGTERM", onSignal)
	try {
		walletReady = EmbeddedWallet.create(NODE_URL, { pxeConfig: { proverEnabled: true, dataDirectory } })
		const ewallet = await walletReady
		if (released) throw new Error("interrupted")
		await dripEach(ewallet, rebuilt, mins)
	} finally {
		await release()
	}
	console.log(
		`\n✅ DRIP canary PASSED — ${rebuilt.tokens.map((t) => t.record.constructorArgs.symbol).join(" + ")} dripped to a fresh account in ${mins()}.`,
	)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
