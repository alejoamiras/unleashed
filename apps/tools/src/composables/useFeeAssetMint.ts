/**
 * Aztec's testnet FeeAssetHandler gives anyone a fixed amount of the fee asset per call. The Send
 * strip and the Drip card share this module's state: one in-flight lock, the per-call amount, and
 * `feeAssetMinted`, which the Send wizard watches to refresh its balances after a mint on either tab.
 */
import { awaitL1Receipt } from "@unleashed/bridge-core"
import { type Address, erc20Abi, type Log, parseEventLogs, type WalletClient, zeroAddress } from "viem"
import { computed, type ComputedRef, type Ref, readonly, ref, shallowRef, watch } from "vue"
import { FUEL_ASSET, FUEL_ASSET_HANDLER } from "@/contracts/bridge-generation"
import { FEE_ASSET_HANDLER_ABI } from "@/lib/fee-asset-handler-abi"
import { toDecimalString } from "@/lib/format"
import { NETWORK } from "@/lib/network"
import { safeSentence } from "@/lib/token-display"
import { useL1Wallet } from "./useL1Wallet"
import { assertL1Chain } from "./useSend"

/** Fee Juice and its L1 asset share the protocol's 18 decimals. */
const DECIMALS = 18

export interface FeeAssetMint {
	/** What the receipt's `Transfer` log credited the minter; null when it carries no such log. */
	amount: bigint | null
	txHash: `0x${string}`
}

export interface UseFeeAssetMintHandle {
	/** False on a network whose manifest names no handler, mainnet among them. */
	readonly available: boolean
	/** The handler's per-call amount in whole units; null until read on the right chain. */
	readonly amountText: ComputedRef<string | null>
	readonly minting: Readonly<Ref<boolean>>
	/** When the running mint started, on either surface; null while none runs. */
	readonly startedAt: Readonly<Ref<number | null>>
	/** This surface's last failure; another surface's mint never writes it. */
	readonly error: Readonly<Ref<string | null>>
	mint: () => Promise<FeeAssetMint | null>
}

const amount = ref<bigint | null>(null)
const startedAt = ref<number | null>(null)
const minting = computed(() => startedAt.value !== null)
const lastMinted = shallowRef<FeeAssetMint | null>(null)
let amountRead: Promise<void> | null = null
/** Bumped on every disconnect: a read started under an earlier connection never writes `amount`. */
let connection = 0

/** The latest confirmed mint from any surface. */
export const feeAssetMinted = readonly(lastMinted)

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

type L1 = ReturnType<typeof useL1Wallet>

/** The handler's owner can change the amount, so it is re-read on every connect; a read that ends on
 *  another chain is dropped rather than shown. */
function refreshAmount(l1: L1, handler: Address): Promise<void> {
	if (amountRead) return amountRead
	const mine = connection
	// While `mine` is current no disconnect has run, so `amountRead` is still this read.
	amountRead = (async () => {
		try {
			await assertL1Chain(l1)
			const next = await l1.publicClient.readContract({ address: handler, abi: FEE_ASSET_HANDLER_ABI, functionName: "mintAmount" })
			await assertL1Chain(l1)
			if (mine === connection) amount.value = next
		} catch {
			if (mine === connection) amount.value = null
		} finally {
			if (mine === connection) amountRead = null
		}
	})()
	return amountRead
}

function dropAmountRead(): void {
	connection++
	amountRead = null
}

function mintedTo(logs: Log[], owner: Address): bigint | null {
	const credit = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs }).find(
		(l) => same(l.address, FUEL_ASSET) && same(l.args.from, zeroAddress) && same(l.args.to, owner),
	)
	return credit ? credit.args.value : null
}

/** One checked mint: the right chain, a handler minting this network's asset, a successful receipt. */
async function submitMint(l1: L1, wallet: WalletClient, handler: Address, owner: Address): Promise<FeeAssetMint> {
	await assertL1Chain(l1)
	// A consistency guard, not authentication: the manifest pins the handler, and this catches one
	// that mints some other asset before anything is signed.
	const asset = await l1.publicClient.readContract({ address: handler, abi: FEE_ASSET_HANDLER_ABI, functionName: "FEE_ASSET" })
	if (!same(asset, FUEL_ASSET)) throw new Error("This mint contract does not mint this network's AZTEC. Nothing was sent.")
	const txHash = await wallet.writeContract({
		address: handler,
		abi: FEE_ASSET_HANDLER_ABI,
		functionName: "mint",
		args: [owner],
		chain: NETWORK.viemChain,
		account: owner,
	})
	// The receipt is read through the wallet's provider, so a chain switch after signing hides it: the
	// wait is short, and its failure names the hash rather than the bridge journal's retry advice.
	const receipt = await awaitL1Receipt(l1.publicClient, txHash, { attempts: 2 }).catch((e: unknown) => {
		if (e instanceof Error && /reverted on-chain/.test(e.message)) throw e
		throw new Error(`The mint ${txHash} was sent but not confirmed yet. Check it in your Ethereum wallet's activity.`)
	})
	return { amount: mintedTo(receipt.logs, owner), txHash }
}

/** Call from a component's setup: the watch that re-reads the amount on each connect stops when the
 *  caller unmounts. */
export function useFeeAssetMint(): UseFeeAssetMintHandle {
	const l1 = useL1Wallet()
	const handler = FUEL_ASSET_HANDLER
	const error = ref<string | null>(null)

	if (handler) {
		const ready = computed(() => l1.isConnected.value && !l1.wrongChain.value)
		watch(ready, (r) => (r ? void refreshAmount(l1, handler) : dropAmountRead()), { immediate: true })
	}

	async function mint(): Promise<FeeAssetMint | null> {
		if (!handler || minting.value) return null
		const wallet = l1.ensureWalletClient()
		const owner = l1.address.value
		if (!wallet || !owner) {
			error.value = "Connect your Ethereum wallet first."
			return null
		}
		startedAt.value = Date.now()
		error.value = null
		try {
			const minted = await submitMint(l1, wallet, handler, owner)
			lastMinted.value = minted
			return minted
		} catch (e) {
			error.value = e instanceof Error ? safeSentence(e.message) : "Mint failed"
			return null
		} finally {
			startedAt.value = null
		}
	}

	return {
		available: handler !== undefined,
		amountText: computed(() => (amount.value === null ? null : formatWhole(amount.value))),
		minting,
		startedAt: readonly(startedAt),
		error: readonly(error),
		mint,
	}
}

/** AZTEC for button and status copy, every digit kept and thousands grouped like the Drip cards':
 *  `1,000`, or `0.5` for a fractional amount. */
export function formatWhole(value: bigint): string {
	const [whole, fraction] = toDecimalString(value, DECIMALS).split(".")
	const grouped = BigInt(whole ?? "0").toLocaleString("en-US")
	return fraction ? `${grouped}.${fraction}` : grouped
}

/** Test-only: module state outlives a test's mounts. */
export function __resetFeeAssetMintForTests(): void {
	amount.value = null
	startedAt.value = null
	lastMinted.value = null
	amountRead = null
	connection = 0
}
