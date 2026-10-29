/**
 * The relayer on two local chains: Across's pool and USDC are placed at their real Base Sepolia and Sepolia
 * addresses, so `relayOnce`, the run the Worker's cron makes, fills on the production route unchanged. LI.FI's receiver
 * has no code here, so the pool pays it without running the message; the bridge-core sandbox suite runs that leg.
 */
import { depositsIn, type FillWallet, relayHashOf, SPOKE_POOL_ABI, type SourceDeposit } from "@unleashed/bridge-core/across-fill"
import { lifiBook } from "@unleashed/sdk/l1"
import {
	type Address,
	createPublicClient,
	createTestClient,
	createWalletClient,
	custom,
	defineChain,
	erc20Abi,
	type Hex,
	http,
	maxUint256,
	type PublicClient,
	pad,
	type Transport,
	toHex,
	type WalletClient,
	zeroHash,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import manifest from "../../../../apps/tools/public/testnet-bridge.json"
import type { RelayLine } from "../../src/log"
import { testnetRoute } from "../../src/route"
import { type RelayConfig, relayOnce } from "../../src/run"
import { appDeposit, SEPOLIA_USDC, SOURCE_USDC } from "../app-deposit"
import { type AnvilPair, artifact, startAnvilPair } from "./anvil-pair"

const INTEGRATION = process.env.RELAYER_INTEGRATION === "1"

// Anvil's well-known development keys.
const KEYS = {
	deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	filler: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
	depositor: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
	stranger: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const
const FILLER = privateKeyToAccount(KEYS.filler).address
const STRANGER = privateKeyToAccount(KEYS.stranger).address
const SOURCE_POOL = lifiBook(84532).acrossSpokePool
const DEST_POOL = lifiBook(11155111).acrossSpokePool
const RECEIVER = lifiBook(11155111).receiverAcrossV4
const USDC = 1_000_000n
const route = testnetRoute(manifest, FILLER)

/** `url` answering Sepolia's 2 wei priority fee where anvil hard-codes 1 gwei. */
function sepoliaTransport(url: string): Transport {
	const base = http(url)({})
	return custom({
		async request({ method, params }) {
			if (method === "eth_maxPriorityFeePerGas") return "0x2"
			return base.request({ method, params })
		},
	})
}

/** `url` with its head pinned at `head`: a node lagging behind the chain. */
const laggingTransport = (url: string, head: bigint): Transport =>
	custom({
		async request({ method, params }) {
			if (method === "eth_blockNumber") return toHex(head)
			return http(url)({}).request({ method, params })
		},
	})

function side(url: string, chainId: number) {
	const chain = defineChain({
		id: chainId,
		name: `anvil-${chainId}`,
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [url] } },
	})
	return {
		pub: createPublicClient({ chain, transport: sepoliaTransport(url) }),
		test: createTestClient({ chain, mode: "anvil", transport: http(url) }),
		wallet: (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: sepoliaTransport(url) }),
	}
}
type Side = ReturnType<typeof side>

/** Deploys `name` and copies its runtime code, immutables included, to `target`. */
async function place(s: Side, name: string, args: unknown[], target: Address): Promise<void> {
	const { abi, bytecode } = artifact(name)
	const hash = await s.wallet(KEYS.deployer).deployContract({ abi, bytecode, args } as never)
	const { contractAddress } = await s.pub.waitForTransactionReceipt({ hash })
	const code = contractAddress && (await s.pub.getCode({ address: contractAddress }))
	if (!code) throw new Error(`${name} deployed no code`)
	await s.test.setCode({ address: target, bytecode: code })
}

async function write(s: Side, key: Hex, call: { address: Address; abi: unknown; functionName: string; args: unknown[] }) {
	const hash = await s.wallet(key).writeContract(call as never)
	const receipt = await s.pub.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`${call.functionName} reverted`)
	return receipt
}

describe.skipIf(!INTEGRATION)("the relayer on two anvils", () => {
	let pair: AnvilPair
	let src: Side
	let dst: Side
	const token = artifact("MintableERC20").abi
	const pool = artifact("TestSpokePool").abi
	const mint = (s: Side, tokenAddress: Address, to: Address, amount: bigint) =>
		write(s, KEYS.deployer, { address: tokenAddress, abi: token, functionName: "mint", args: [to, amount] })
	const usdc = (who: Address) => dst.pub.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [who] })
	const status = (relayHash: Hex) =>
		dst.pub.readContract({ address: DEST_POOL, abi: SPOKE_POOL_ABI, functionName: "fillStatuses", args: [relayHash] })
	const nonce = () => dst.pub.getTransactionCount({ address: FILLER })

	/** A run of the relayer, its log lines collected; `o` stands in for its source client or its signing client. */
	const run = (lines: RelayLine[] = [], o: { source?: PublicClient; wallet?: WalletClient } = {}) => {
		const c: RelayConfig = {
			source: o.source ?? src.pub,
			destination: { public: dst.pub, wallet: (o.wallet ?? dst.wallet(KEYS.filler)) as FillWallet },
			route,
			log: (l) => lines.push(l),
		}
		return relayOnce(c)
	}

	/** Sends `d`, built from the source head's time, from the depositor and confirms it past the relayer's lag. */
	async function send(
		build: (head: number) => SourceDeposit,
	): Promise<{ txHash: Hex; block: bigint; deposit: SourceDeposit; relayHash: Hex }> {
		await src.test.mine({ blocks: 1 })
		const d = build(Number((await src.pub.getBlock()).timestamp))
		const r = d.relay
		const args = [r.depositor, r.recipient, r.inputToken, r.outputToken, r.inputAmount, r.outputAmount, d.destinationChainId]
		const tail = [r.exclusiveRelayer, d.quoteTimestamp, r.fillDeadline, r.exclusivityDeadline, r.message]
		const receipt = await write(src, KEYS.depositor, {
			address: SOURCE_POOL,
			abi: pool,
			functionName: "deposit",
			args: [...args, ...tail],
		})
		await src.test.mine({ blocks: 2 })
		const [deposit] = depositsIn(receipt.logs, SOURCE_POOL, 84532n)
		if (!deposit) throw new Error("the deposit logged no FundsDeposited")
		return { txHash: receipt.transactionHash, block: receipt.blockNumber, deposit, relayHash: relayHashOf(deposit) }
	}
	const app = (input: bigint, o: { filler?: Address; router?: Address; ago?: number } = {}) =>
		send((head) => appDeposit({ input, filler: o.filler ?? FILLER, router: o.router, head: head - (o.ago ?? 0) }))

	beforeAll(async () => {
		pair = await startAnvilPair()
		src = side(pair.sourceUrl, 84532)
		dst = side(pair.destinationUrl, 11155111)
		const usdcArgs = ["USD Coin", "USDC", 6, 1_000_000n]
		await Promise.all([
			place(src, "TestSpokePool", [], SOURCE_POOL).then(() => place(src, "MintableERC20", usdcArgs, SOURCE_USDC)),
			place(dst, "TestSpokePool", [], DEST_POOL).then(() => place(dst, "MintableERC20", usdcArgs, SEPOLIA_USDC)),
		])
		await mint(src, SOURCE_USDC, privateKeyToAccount(KEYS.depositor).address, 1_000n * USDC)
		await write(src, KEYS.depositor, { address: SOURCE_USDC, abi: erc20Abi, functionName: "approve", args: [SOURCE_POOL, maxUint256] })
		await mint(dst, SEPOLIA_USDC, FILLER, 20n * USDC)
	})
	afterAll(async () => {
		await pair?.stop()
	})

	it("fills an app deposit in one run, and the next run sends nothing", async () => {
		const received = await usdc(RECEIVER)
		const { relayHash, deposit } = await app(5n * USDC)
		expect(await run()).toMatchObject({ outcome: "filled" })
		expect(await status(relayHash)).toBe(2n)
		expect((await usdc(RECEIVER)) - received).toBe(deposit.relay.outputAmount)
		const sent = await nonce()
		expect(await run()).toEqual({ outcome: "idle" })
		expect(await nonce()).toBe(sent)
	})

	it("ignores deposits naming another relayer, another router or more output than the terms, sending nothing", async () => {
		const ours = [
			await app(4n * USDC, { filler: STRANGER }),
			await app(4n * USDC, { router: STRANGER }),
			await send((head) => {
				const d = appDeposit({ input: 4n * USDC, filler: FILLER, head })
				return { ...d, relay: { ...d.relay, outputAmount: d.relay.outputAmount + 1n } }
			}),
		]
		const sent = await nonce()
		const lines: RelayLine[] = []
		expect(await run(lines)).toEqual({ outcome: "idle" })
		const txs = new Set(ours.map((o) => o.txHash))
		expect(lines.filter((l) => l.event === "ignored" && l.srcTx && txs.has(l.srcTx)).map((l) => l.reason)).toEqual([
			"relayer",
			"router",
			"output",
		])
		expect(await nonce()).toBe(sent)
	})

	it("passes over a deposit above the float to fill a smaller one, and fills the first once restocked", async () => {
		const float = await usdc(FILLER)
		await write(dst, KEYS.filler, {
			address: SEPOLIA_USDC,
			abi: erc20Abi,
			functionName: "transfer",
			args: [STRANGER, float - 5n * USDC],
		})
		const large = await app(8n * USDC)
		const small = await app(2n * USDC)
		const lines: RelayLine[] = []
		expect(await run(lines)).toMatchObject({ outcome: "filled" })
		expect([await status(small.relayHash), await status(large.relayHash)]).toEqual([2n, 0n])
		expect(lines).toContainEqual(expect.objectContaining({ event: "skipped", reason: "balance", relayHash: large.relayHash }))
		expect(lines).toContainEqual(expect.objectContaining({ event: "low-inventory" }))
		await mint(dst, SEPOLIA_USDC, FILLER, 10n * USDC)
		expect(await run()).toMatchObject({ outcome: "filled" })
		expect(await status(large.relayHash)).toBe(2n)
	})

	it("still fills a deposit after a stranger fills another relay reusing its origin and id", async () => {
		const ours = await app(5n * USDC)
		const forged = {
			...ours.deposit.relay,
			recipient: pad(STRANGER, { size: 32 }),
			exclusiveRelayer: zeroHash,
			exclusivityDeadline: 0,
			outputAmount: 1n,
			message: "0x" as Hex,
		}
		await mint(dst, SEPOLIA_USDC, STRANGER, 1n)
		await write(dst, KEYS.stranger, { address: SEPOLIA_USDC, abi: erc20Abi, functionName: "approve", args: [DEST_POOL, 1n] })
		await write(dst, KEYS.stranger, {
			address: DEST_POOL,
			abi: pool,
			functionName: "fillRelay",
			args: [forged, 84532n, pad(STRANGER, { size: 32 })],
		})
		expect(await run()).toMatchObject({ outcome: "filled" })
		expect(await status(ours.relayHash)).toBe(2n)
	})

	it("loses no token when another run's approval and fill land between a run's approval and its fill", async () => {
		await mint(dst, SEPOLIA_USDC, FILLER, 20n * USDC)
		const older = await app(3n * USDC)
		const newer = await app(4n * USDC)
		const float = await usdc(FILLER)
		let reached = () => {}
		let resume = () => {}
		const atFill = new Promise<void>((r) => {
			reached = r
		})
		const resumed = new Promise<void>((r) => {
			resume = r
		})
		// Held before its fill is signed: the first run's approval has landed, its fill was simulated and priced at the
		// nonce it read, which the other run's approval and fill then spend.
		const wallet = dst.wallet(KEYS.filler)
		const held = {
			...wallet,
			writeContract: async (w: Parameters<typeof wallet.writeContract>[0]) => {
				if (w.functionName === "fillRelay") {
					reached()
					await resumed
				}
				return wallet.writeContract(w)
			},
		} as WalletClient
		const lines: RelayLine[] = []
		const first = run(lines, { wallet: held })
		await Promise.race([
			atFill,
			new Promise((_, no) => setTimeout(() => no(new Error("the first run never reached its fill")), 30_000)),
		])
		const lagging = createPublicClient({ chain: src.pub.chain, transport: laggingTransport(pair.sourceUrl, older.block + 2n) })
		expect(await run([], { source: lagging })).toMatchObject({ outcome: "filled" })
		expect(await status(older.relayHash)).toBe(2n)
		resume()
		expect(await first).toEqual({ outcome: "failed" })
		expect(lines).toContainEqual(
			expect.objectContaining({
				event: "failed",
				reason: expect.stringMatching(/lower than the current nonce/),
				relayHash: newer.relayHash,
			}),
		)
		expect(await run()).toMatchObject({ outcome: "filled" })
		expect(await status(newer.relayHash)).toBe(2n)
		expect(float - (await usdc(FILLER))).toBe(older.deposit.relay.outputAmount + newer.deposit.relay.outputAmount)
		expect(
			await dst.pub.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "allowance", args: [FILLER, DEST_POOL] }),
		).toBe(0n)
	})

	it("skips a deposit inside the deadline margin by the destination's clock, sending nothing", async () => {
		const late = await app(5n * USDC, { ago: 3_500 })
		await dst.test.increaseTime({ seconds: 3_650 })
		await dst.test.mine({ blocks: 1 })
		const sent = await nonce()
		const lines: RelayLine[] = []
		expect(await run(lines)).toEqual({ outcome: "idle" })
		expect(lines).toContainEqual(expect.objectContaining({ event: "skipped", reason: "deadline", relayHash: late.relayHash }))
		expect(await nonce()).toBe(sent)
	})
})
