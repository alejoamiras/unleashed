/**
 * LIVE-testnet fueled-send validation: drives the router's fueled entrypoint against the live pools,
 * then proves the headline claim on Aztec — a fresh account's hub claim PAYS FOR ITSELF out of the
 * Fee Juice the same send bridged, for both the public and the private-FPC fuel lanes. The fees it
 * observes are the manifest's `bridge.l1.swap.minFuelFj` and `fjPerTx` calibration.
 *
 * Nothing is deployed: the portal is the factory's clone for the token, the L2 side is the
 * manifest's hub and the token that hub derives, and only the throwaway L2 account is created
 * (the sponsored FPC pays its deploy; fuel pays every claim).
 *
 * Real proofs: expect ~30-60 min end to end.
 * Run: bun run scripts/fuel-testnet.ts --config <manifest> [--token <erc20>]
 *      (PRIVATE_KEY + SEPOLIA_RPC_URL in packages/bridge-core/.env)
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract, type ContractBase, getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { TxHash, TxStatus } from "@aztec-labs/aztec.js/tx"
import { Gas, type GasFees } from "@aztec-labs/stdlib/gas"
import { resolvePackageAsset } from "@alejoamiras/nulo-resolve-asset"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { predictedWorstMinFees, publicFeeJuicePayment } from "../src/fee-juice"
import type { L1Ctx } from "../src/flows"
import { claimViaHub, type HubClaimOutcome, hubTokenFor } from "../src/hub-l2"
import {
	PRIVATE_FPC_ADDRESS,
	PRIVATE_FPC_SALT,
	PRIVATE_HUB_CLAIM_GAS,
	PRIVATE_HUB_REGISTER_GAS,
	deriveBridgeSecret,
	privateFeeJuicePayment,
	privateFpcFeeLimit,
	privateMintAndPayFee,
} from "../src/private-fuel"
import type { SendResult } from "../src/send-flow"
import { runSend } from "../src/send-flow"
import { runFpcGate } from "./check-fpc-version"
import { requirePinnedSigner } from "./live-intent"
import { evmAbi } from "./script-artifacts"
import { ensureRouterPermit2 } from "./script-l1"
import { feeJuiceFor } from "./fee-juice-l2"
import { deployAccountIfAbsent, freshSchnorrAccount, registerHub, registerHubToken, sponsoredFpcFee } from "./script-l2"
import { claimTokenBlock, planFuelLeg, requireSwap, selectToken, sendGenerationOf } from "./script-send"
import {
	createL1Clients,
	createL2Wallet,
	createNode,
	loadManifestV2FromConfigArg,
	requireBridge,
	sepoliaChain,
	stopwatch,
} from "./script-bootstrap"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com"
const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined
if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY required (packages/bridge-core/.env)")

const here = dirname(fileURLToPath(import.meta.url))
const CONFIG = loadManifestV2FromConfigArg(process.argv, {
	mode: "fallback",
	fallbackPath: join(here, "..", "..", "..", "apps", "tools", "public", "testnet-bridge.json"),
})
const BRIDGE = requireBridge(CONFIG)
const SWAP = requireSwap(BRIDGE)
const TOKEN = selectToken(BRIDGE, process.argv)
const GENERATION = sendGenerationOf(CONFIG, BRIDGE)

const sepolia = sepoliaChain(SEPOLIA_RPC)

const UNIT = 10n ** BigInt(TOKEN.decimals)
const TOTAL = 10n * UNIT
const FUEL_SLICE = BigInt(process.env.FUEL_SLICE_UNITS ?? (UNIT / 4n).toString())
const BRIDGED = TOTAL - FUEL_SLICE
// The committed maxFeesPerGas is predicted-worst with NO padding by default — the app's policy: the
// FPC credits `amount − max_gas_cost` and refunds nothing, so any pad is Fee Juice the claimer
// forfeits, and a cap that still falls under the live fee is re-priced on the next attempt.
const RELIABILITY_PAD = Number(process.env.RELIABILITY_PAD ?? 1)
const PUBLIC_RUNS = Number(process.env.PUBLIC_RUNS ?? 1)
const PRIVATE_RUNS = Number(process.env.PRIVATE_RUNS ?? 3)
const NOFUEL_SPEND_RUNS = Number(process.env.NOFUEL_SPEND_RUNS ?? 0)

const rndNonce = () => BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface VariantCtx {
	l1: L1Ctx
	node: ReturnType<typeof createNode>
	hub: ContractBase
	l2Token: ContractBase
	from: AztecAddress
	fjBalance: () => Promise<bigint>
	tokenBalance: (kind: "public" | "private") => Promise<bigint>
	mins: () => string
}

interface VariantRun {
	actualFee: bigint
	ceiling?: bigint
	path: HubClaimOutcome["path"]
	/** A private first claim's own registration, when this run made one: what it paid and roughly
	 *  the L2 gas that fee bought — the measurement PRIVATE_HUB_REGISTER_GAS is sized from. */
	registerFee?: bigint
	registerL2Gas?: bigint
}

/** What a landed transaction paid, and the L2 gas that fee corresponds to at its block's price
 *  (the testnet bills no DA gas, so the whole fee is L2 gas × the block's L2 price). */
async function landedTx(ctx: VariantCtx, txHash: string): Promise<{ fee: bigint; l2GasApprox?: bigint }> {
	const receipt = (await ctx.node.getTxReceipt(TxHash.fromString(txHash))) as { transactionFee?: bigint; blockNumber?: number | bigint }
	const fee = receipt.transactionFee ?? 0n
	const block = receipt.blockNumber === undefined ? undefined : await ctx.node.getBlock(Number(receipt.blockNumber) as never)
	const feePerL2Gas = block?.header.globalVariables.gasFees.feePerL2Gas
	return { fee, l2GasApprox: feePerL2Gas && feePerL2Gas > 0n ? fee / feePerL2Gas : undefined }
}

const gasNote = (tx: { l2GasApprox?: bigint }): string => (tx.l2GasApprox === undefined ? "" : ` (≈${tx.l2GasApprox} L2 gas)`)

/** The PrivateFPC has no public functions and no initializer, so it needs no on-chain deploy — but
 *  the private kernel oracle needs both preimages locally, and the canonical salt must reproduce the
 *  pinned address or the artifact has drifted. */
async function registerPrivateFpc(ewallet: unknown, mins: () => string) {
	const artifact = loadContractArtifact(
		JSON.parse(
			readFileSync(
				resolvePackageAsset("@alejoamiras/private-fee-juice", "target/private_contract-PrivateFPC.json", { from: import.meta.url }),
				"utf8",
			),
		),
	)
	const instance = await getContractInstanceFromInstantiationParams(artifact, {
		salt: Fr.fromHexString(PRIVATE_FPC_SALT),
		publicKeys: PublicKeys.default(),
		deployer: AztecAddress.ZERO,
	})
	if (instance.address.toString() !== PRIVATE_FPC_ADDRESS) {
		throw new Error(`PrivateFPC rebuilt ${instance.address} != pinned ${PRIVATE_FPC_ADDRESS} (artifact/version drift)`)
	}
	try {
		await (ewallet as { registerContract: (i: unknown, a: unknown) => Promise<unknown> }).registerContract(instance, artifact)
	} catch {}
	console.log(`PrivateFPC ${PRIVATE_FPC_ADDRESS.slice(0, 12)}… registered (${mins()})`)
	return { instance, artifact }
}

/** PUBLIC fuel pays the ACTUAL fee, so its payment is static. PRIVATE-FPC fuel asserts
 *  `amount >= getFeeLimit` against the COMMITTED maxFeesPerGas, and the protocol rejects a tx whose
 *  committed cap fell below the live base fee by inclusion time — a claim proves for minutes, so the
 *  cap is re-priced on every attempt rather than reused. */
async function buildVariantClaimFee(
	ctx: VariantCtx,
	result: SendResult,
	viaFpc: boolean,
	bridgeSalt: Fr | undefined,
	registers: boolean,
): Promise<{ fee: unknown; registerFee?: unknown; registeredClaimFee?: unknown; maxFees?: GasFees }> {
	const fuelReceived = result.fuelReceived ?? 0n
	if (!viaFpc) {
		return {
			fee: {
				paymentMethod: publicFeeJuicePayment(ctx.from, {
					claimAmount: fuelReceived,
					claimSecret: Fr.fromHexString(result.fuelSecretHex as string),
					messageLeafIndex: result.fuelLeafIndex as bigint,
				}),
			},
		}
	}
	const maxFees = (await predictedWorstMinFees(ctx.node)).mul(RELIABILITY_PAD)
	const fpc = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)
	const fuelPayment = privateMintAndPayFee(
		fpc,
		fuelReceived,
		deriveBridgeSecret(bridgeSalt as Fr, ctx.from),
		bridgeSalt as Fr,
		new Fr(result.fuelLeafIndex as bigint),
	)
	const gasSettings = (gas: { daGas: number; l2Gas: number }) => ({
		gasLimits: Gas.from(gas),
		teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }),
		maxFeesPerGas: maxFees,
	})
	// The fuel message is spent by whichever transaction goes first — a first-time token's own
	// registration, sized for one, else the claim — and a claim after such a registration draws on
	// the credit the FPC kept, exactly as the app's ladder does it.
	return {
		fee: { paymentMethod: fuelPayment, gasSettings: gasSettings(PRIVATE_HUB_CLAIM_GAS) },
		...(registers
			? {
					registerFee: { paymentMethod: fuelPayment, gasSettings: gasSettings(PRIVATE_HUB_REGISTER_GAS) },
					registeredClaimFee: { paymentMethod: privateFeeJuicePayment(fpc), gasSettings: gasSettings(PRIVATE_HUB_CLAIM_GAS) },
				}
			: {}),
		maxFees,
	}
}

/** An FPC budget assert means the bridged FJ is below the committed getFeeLimit — a real failure,
 *  never a sync/fee-drift wait to retry through. */
function throwIfFpcBudgetAssert(label: string, fuelReceived: bigint, msg: string): void {
	if (/Amount too low to cover gas cost|max_gas_cost/.test(msg)) {
		throw new Error(`${label}: FPC budget assert — bridged FJ ${fuelReceived} < committed getFeeLimit. ${msg}`)
	}
}

/** The self-paying claim, retried on the message-sync cadence. It cannot use the shared fixed-options
 *  claim loop: the FPC fee has to be rebuilt per attempt (see buildVariantClaimFee). */
async function settleVariantClaim(
	ctx: VariantCtx,
	p: { label: string; isPrivate: boolean; result: SendResult; viaFpc: boolean; bridgeSalt?: Fr },
): Promise<{ outcome: HubClaimOutcome; committedMaxFees?: GasFees; registered: boolean }> {
	const claim = {
		token: claimTokenBlock(TOKEN, p.result.token as NonNullable<SendResult["token"]>),
		recipient: ctx.from.toString(),
		amount: BRIDGED,
		claimValue: Fr.fromHexString(p.result.tokenClaimValueHex as string),
		leafIndex: p.result.tokenLeafIndex as bigint,
		isPrivate: p.isPrivate,
		from: ctx.from.toString(),
	}
	for (let i = 0; i < 300; i++) {
		try {
			// Whether this claim registers the token is a live fact, re-read per attempt like the app does.
			const registers = p.viaFpc && (await hubTokenFor(ctx.hub, TOKEN.erc20, ctx.from.toString())) === undefined
			const built = await buildVariantClaimFee(ctx, p.result, p.viaFpc, p.bridgeSalt, registers)
			const sendOpts = {
				from: ctx.from,
				fee: built.fee,
				...(built.registerFee ? { registerFee: built.registerFee, registeredClaimFee: built.registeredClaimFee } : {}),
				onRegistered: (hash: string) =>
					console.log(
						`${p.label}: register_token ${hash} landed — waiting for the claim to pass in this wallet's view (${ctx.mins()})`,
					),
				wait: { waitForStatus: TxStatus.PROPOSED },
			}
			return { outcome: await claimViaHub(ctx.hub, claim, sendOpts), committedMaxFees: built.maxFees, registered: registers }
		} catch (e) {
			throwIfFpcBudgetAssert(p.label, p.result.fuelReceived ?? 0n, e instanceof Error ? e.message : String(e))
			if (i % 10 === 0) console.log(`${p.label}: claim not ready / re-pricing… (${ctx.mins()})`)
			await sleep(6000)
		}
	}
	throw new Error(`${p.label}: self-paying claim never SETTLED within budget`)
}

/** The FPC ceiling (`getFeeLimit`) the claim committed to: the explicit limits × the committed
 *  max fees — exact, since the limits are declared rather than left to the network maximum. */
const feeCeiling = (committedMaxFees?: GasFees, registered = false): bigint | undefined =>
	committedMaxFees
		? privateFpcFeeLimit(PRIVATE_HUB_CLAIM_GAS, committedMaxFees) +
			(registered ? privateFpcFeeLimit(PRIVATE_HUB_REGISTER_GAS, committedMaxFees) : 0n)
		: undefined

async function sendVariant(ctx: VariantCtx, isPrivate: boolean, viaFpc: boolean, bridgeSalt?: Fr): Promise<SendResult> {
	const fuel = await planFuelLeg(ctx.l1.pub, SWAP, GENERATION.feeAsset, TOKEN.erc20 as Address, FUEL_SLICE)
	console.log(`quote: ${FUEL_SLICE} ${TOKEN.displaySymbol}-units → ${fuel.quote} FJ-wei (floor ${fuel.minFuelOutput}) (${ctx.mins()})`)
	return runSend(
		ctx.l1,
		GENERATION,
		{
			intent: "token+gas",
			erc20: TOKEN.erc20 as Address,
			amount: TOTAL,
			aztecRecipient: ctx.from.toString() as `0x${string}`,
			isPrivate,
			claimSalt: isPrivate ? Fr.random() : undefined,
			gas: {
				fuelAmount: FUEL_SLICE,
				fuelRecipient: (viaFpc ? PRIVATE_FPC_ADDRESS : ctx.from.toString()) as `0x${string}`,
				minFuelOutput: fuel.minFuelOutput,
				path: fuel.path,
				zeroForOnes: fuel.zeroForOnes,
				fuelSecret: bridgeSalt ? deriveBridgeSecret(bridgeSalt, ctx.from) : undefined,
			},
			nonce: rndNonce(),
			deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
		},
		(s) => console.log(`l1: ${s} (${ctx.mins()})`),
	)
}

/** One variant = an L1 fueled send → a self-paying L2 hub claim. */
async function runVariant(ctx: VariantCtx, isPrivate: boolean, viaFpc = false): Promise<VariantRun> {
	const label = `${isPrivate ? "PRIVATE" : "PUBLIC"}${viaFpc ? "+FPC-fuel" : ""}`
	console.log(`\n=== ${label} fueled send ===`)

	// Private-FPC fuel binds the Fee Juice to the FPC through a claimer-derived secret, so the FPC can
	// reconstruct it inside mint_and_pay_fee; public fuel lands at the user with a random secret.
	const bridgeSalt = viaFpc ? Fr.random() : undefined
	const result = await sendVariant(ctx, isPrivate, viaFpc, bridgeSalt)
	console.log(`sent: tokenLeaf ${result.tokenLeafIndex}, fuelLeaf ${result.fuelLeafIndex}, fuelReceived ${result.fuelReceived}`)

	const fjBefore = await ctx.fjBalance()
	const { outcome, committedMaxFees, registered } = await settleVariantClaim(ctx, { label, isPrivate, result, viaFpc, bridgeSalt })
	const claimTx = await landedTx(ctx, outcome.claimTxHash)
	const registerTx = outcome.registerTxHash === undefined ? undefined : await landedTx(ctx, outcome.registerTxHash)
	const actualFee = claimTx.fee
	const ceiling = feeCeiling(committedMaxFees, registered)
	const registerNote = registerTx === undefined ? "" : ` | register fee ${registerTx.fee}${gasNote(registerTx)}`
	console.log(
		`${label}: ${outcome.path} settled, claim fee ${actualFee}${gasNote(claimTx)}${registerNote}${ceiling === undefined ? "" : ` | getFeeLimit ≈ ${ceiling}`}`,
	)

	const tokenBal = await ctx.tokenBalance(isPrivate ? "private" : "public")
	if (tokenBal < BRIDGED) throw new Error(`${label}: token balance ${tokenBal} < ${BRIDGED}`)
	if (!viaFpc) {
		// FPC fuel credits the remainder as a private note, not the public FJ balance — only the public
		// lane can assert on the balance.
		const fjAfter = await ctx.fjBalance()
		if (fjAfter <= fjBefore) throw new Error(`${label}: no FJ landed as balance (fee ate everything?)`)
		console.log(`${label}: token balance ${tokenBal}, FJ gained ${fjAfter - fjBefore}`)
	}
	return { actualFee, ceiling, path: outcome.path, registerFee: registerTx?.fee, registerL2Gas: registerTx?.l2GasApprox }
}

const worstOf = (values: bigint[]): bigint | undefined => (values.length ? values.reduce((a, b) => (a > b ? a : b)) : undefined)

/**
 * `minFuelFj` is 4× the worst FPC CEILING, never the actual fee: the FPC asserts
 * `amount >= getFeeLimit`, and the ceiling already bakes in the fee pad, so 4× tolerates a further
 * ~4× base-fee surge. `fjPerTx` is the worst PLAIN claim observed (a registering first claim costs
 * more, and that difference is what `fjRegister` exists for).
 */
function printCalibration(runs: VariantRun[], mins: () => string): void {
	const ceilings = runs.map((r) => r.ceiling).filter((c): c is bigint => c !== undefined)
	const worstCeiling = worstOf(ceilings)
	const worstActual = worstOf(runs.map((r) => r.actualFee)) ?? 0n
	const minFuelFj = (worstCeiling ?? worstActual * 4n) * 4n
	console.log(`\n✅ ${runs.length} fueled runs SETTLED in ${mins()}`)
	console.log(`claim paths          : ${runs.map((r) => r.path).join(", ")}`)
	console.log(`claim fees (FJ-wei)  : ${runs.map((r) => r.actualFee).join(", ")}`)
	console.log(`minFuelFj calibration: ${minFuelFj} (4× worst ${worstCeiling === undefined ? "actual×4 proxy" : "getFeeLimit"})`)

	const plain = worstOf(runs.filter((r) => r.path === "claim").map((r) => r.actualFee))
	const registering = worstOf(runs.filter((r) => r.path !== "claim").map((r) => r.actualFee))
	const fjPerTx = plain ?? worstActual
	console.log(`fjPerTx calibration  : ${fjPerTx} — set bridge.l1.swap.fjPerTx${plain === undefined ? " (no plain claim ran)" : ""}`)
	if (plain !== undefined && registering !== undefined && registering > plain) {
		console.log(`fjRegister hint      : ${registering - plain} (the first claim's registration surcharge)`)
	}
	const registrations = runs.filter((r) => r.registerFee !== undefined)
	if (registrations.length > 0) {
		const line = registrations.map((r) => `${r.registerFee}${gasNote({ l2GasApprox: r.registerL2Gas })}`).join(", ")
		console.log(`register_token fees  : ${line} — PRIVATE_HUB_REGISTER_GAS is sized from that gas with headroom`)
	}
}

/** Spend EXISTING private Fee Juice: a 1-unit public self-transfer paid via PrivateFPC.pay_fee,
 *  re-priced per attempt. A pay_fee insufficiency is a real failure; sync/fee drift retries. */
async function spendFpcBalanceOnce(ctx: VariantCtx, before: bigint): Promise<void> {
	for (let a = 0; a < 100; a++) {
		try {
			const maxFees = (await predictedWorstMinFees(ctx.node)).mul(RELIABILITY_PAD)
			await ctx.l2Token.methods.transfer_public_to_public(ctx.from, ctx.from, 1n, 0).send({
				from: ctx.from,
				fee: {
					paymentMethod: privateFeeJuicePayment(AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)),
					gasSettings: { teardownGasLimits: Gas.from({ daGas: 0, l2Gas: 0 }), maxFeesPerGas: maxFees },
				},
				wait: { waitForStatus: TxStatus.PROPOSED },
			} as never)
			return
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			if (/Amount too low to cover gas cost|max_gas_cost|insufficient/i.test(msg)) {
				throw new Error(`NO-FUEL-SPEND: pay_fee insufficiency — FPC balance ${before} < reserved cost. ${msg}`)
			}
			if (a % 10 === 0) console.log(`no-fuel-spend re-pricing… (${ctx.mins()})`)
			await sleep(6000)
		}
	}
	throw new Error("NO-FUEL-SPEND: pay_fee tx never SETTLED within budget")
}

/** A tx self-pays from Fee Juice ALREADY held at the FPC — the lane a user hits after their first send. */
async function runNoFuelSpendProof(ctx: VariantCtx, fpc: ContractBase, runs: number): Promise<void> {
	const fpcBalance = async (): Promise<bigint> => {
		const r = (await fpc.methods.balance_of(ctx.from).simulate({ from: ctx.from } as never)) as { result?: bigint } | bigint
		return typeof r === "bigint" ? r : (r.result ?? 0n)
	}
	for (let i = 0; i < runs; i++) {
		console.log(`\n--- no-fuel-spend run ${i + 1}/${runs} ---`)
		// A public-token + private-FPC-fuel send credits the FPC with private FJ AND leaves public
		// tokens to move; what mint_and_pay_fee credits is exactly what pay_fee then spends.
		await runVariant(ctx, false, true)
		const before = await fpcBalance()
		if (before <= 0n) throw new Error("NO-FUEL-SPEND: FPC balance 0 after a private fuel run — nothing to spend")
		await spendFpcBalanceOnce(ctx, before)
		const after = await fpcBalance()
		if (after >= before) throw new Error(`NO-FUEL-SPEND: FPC balance did not drop (${before} → ${after}) — pay_fee did not charge`)
		console.log(`OK run ${i + 1}: self-paid from existing private FJ (FPC ${before} → ${after}) (${ctx.mins()})`)
	}
}

async function mintForRuns(l1: L1Ctx, amount: bigint, mins: () => string): Promise<void> {
	if (TOKEN.source !== "permissionless-mint") {
		console.log(`${TOKEN.displaySymbol} is canonical — fund the sender yourself (needs ${amount} base units)`)
		return
	}
	const hash = await l1.wallet.writeContract({
		address: TOKEN.erc20 as Address,
		abi: evmAbi(TOKEN.sourceContract ?? "MintableERC20"),
		functionName: "mint",
		args: [l1.account.address, amount],
		account: l1.account,
		chain: l1.wallet.chain,
	} as never)
	await l1.pub.waitForTransactionReceipt({ hash })
	console.log(`minted ${amount} ${TOKEN.displaySymbol} base units (${mins()})`)
}

async function buildL1(mins: () => string): Promise<L1Ctx> {
	const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`)
	const pinned = requirePinnedSigner("testnet")
	if (account.address.toLowerCase() !== pinned.toLowerCase()) {
		throw new Error(`L1 sender ${account.address} != pinned signer ${pinned} — wrong key; STOP`)
	}
	const { wallet, pub } = createL1Clients({ chain: sepolia, rpcUrl: SEPOLIA_RPC, account })
	const l1: L1Ctx = { pub, wallet, account }
	console.log(`L1 sender ${account.address} | ${TOKEN.displaySymbol} ${TOKEN.erc20} | router ${GENERATION.router}`)

	// 1 public sanity + the private calibration runs + one seed per no-fuel-spend run + one TOTAL spare.
	const mintAmount = BigInt(2 + PRIVATE_RUNS + NOFUEL_SPEND_RUNS) * TOTAL
	await mintForRuns(l1, mintAmount, mins)
	await ensureRouterPermit2(l1, {
		usdc: TOKEN.erc20 as `0x${string}`,
		usdcAbi: evmAbi(TOKEN.sourceContract ?? "MintableERC20"),
		permit2: GENERATION.permit2,
		needed: mintAmount,
		mins,
	})
	return l1
}

async function buildL2(l1: L1Ctx, mins: () => string): Promise<{ ctx: VariantCtx; fpc: ContractBase }> {
	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	console.log("L2 recipient", from.toString())

	const { fee: sponsoredFee } = await sponsoredFpcFee(ewallet)
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee: sponsoredFee,
		log: (stage) =>
			console.log(stage === "deploying" ? `deploying L2 account (real proof)… (${mins()})` : `L2 account deployed (${mins()})`),
	})

	const hub = await registerHub(ewallet as never, BRIDGE.l2.hub)
	const hubAddress = AztecAddress.fromStringUnsafe(BRIDGE.l2.hub.address)
	const l2Token = await registerHubToken(ewallet as never, hubAddress, TOKEN, BRIDGE.l2.tokenClassId)
	const privateFpc = await registerPrivateFpc(ewallet, mins)
	const feeJuice = await feeJuiceFor(ewallet as never, node)

	const read = async (call: { simulate: (o: never) => Promise<unknown> }): Promise<bigint> => {
		const r = (await call.simulate({ from } as never)) as { result?: bigint } | bigint
		return typeof r === "bigint" ? r : (r.result ?? 0n)
	}
	const ctx: VariantCtx = {
		l1,
		node,
		hub,
		l2Token,
		from,
		fjBalance: () => read(feeJuice.methods.balance_of_public(from)),
		tokenBalance: (kind) =>
			read(kind === "public" ? l2Token.methods.balance_of_public(from) : l2Token.methods.balance_of_private(from)),
		mins,
	}
	return { ctx, fpc: Contract.at(privateFpc.instance.address, privateFpc.artifact, ewallet as never) }
}

async function main() {
	const mins = stopwatch()

	// This canary deposits Fee Juice and pays fees THROUGH the pinned PrivateFPC — an unrecoverable
	// loss if that address is not the deployed, class-correct contract. The gate runs inline so it
	// cannot be skipped before the first broadcast.
	await runFpcGate("require-deployed")

	const l1 = await buildL1(mins)
	const { ctx, fpc } = await buildL2(l1, mins)

	// The public lane is the sanity check; the private-FPC lane is what the calibration needs, so run
	// it repeatedly for a stable getFeeLimit across fee conditions. `PUBLIC_RUNS=0` skips the sanity
	// lane so a token the hub does not know yet meets the PRIVATE first claim (its own registration).
	const runs: VariantRun[] = PUBLIC_RUNS > 0 ? [await runVariant(ctx, false)] : []
	for (let i = 0; i < PRIVATE_RUNS; i++) {
		console.log(`\n--- private-FPC run ${i + 1}/${PRIVATE_RUNS} ---`)
		runs.push(await runVariant(ctx, true, true))
	}
	printCalibration(runs, mins)

	if (NOFUEL_SPEND_RUNS > 0) await runNoFuelSpendProof(ctx, fpc, NOFUEL_SPEND_RUNS)
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
