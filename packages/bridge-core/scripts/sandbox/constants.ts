/** Fixed values of the sandbox network the harness deploys onto. None is a credential. */
import { GasFees } from "@aztec-labs/stdlib/gas"
import { type Address, defineChain, type Hex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import type { L1Ctx } from "../../src/flows"

export const CHAIN_ID = 31337
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address
export const ZERO_L1 = "0x0000000000000000000000000000000000000000" as Address
/** 1 FJ — the floor the app refuses to bridge below. */
export const MIN_FJ = 10n ** 18n
/** The fuel swapper's rate for every fixture token: one whole Fee Juice per whole token. */
export const SWAPPER_FJ_PER_WHOLE_TOKEN = 10n ** 18n
/** The local sequencer prices L2 gas orders of magnitude above the old default; a lower ceiling
 *  rejects every setup tx with "maxFeesPerGas.feePerL2Gas must be >= gasFees". */
export const FEE_CEILING = { maxFeesPerGas: new GasFees(10n ** 13n, 10n ** 13n) }

/** Anvil's default mnemonic — the local network's too: its block publisher and validator both sign
 *  from index 0, so that index belongs to the node. The harness signs from the LAST funded index,
 *  the relayer and the cross-chain depositor from the two below it, the actors from the ones
 *  between; a key shared with the node's publisher races every L1 write on one nonce, and the
 *  generation deploy binds the deployer's next CREATE address. Both anvils fund the same keys. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
/** How many keys anvil is started with; every index the harness or an actor uses must be below it. */
export const ANVIL_ACCOUNTS = 16
export const HARNESS_INDEX = ANVIL_ACCOUNTS - 1
/** Sends the relay loop's L1 fills, so a fill never races the harness's nonce. */
export const RELAYER_INDEX = HARNESS_INDEX - 1
/** Signs the cross-chain sends on the source chain; the same address receives a recovered delivery on L1. */
export const CROSSCHAIN_USER_INDEX = HARNESS_INDEX - 2
export function anvilKey(index: number): Hex {
	const hd = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey()
	const key = hd.privateKey
	if (!key) throw new Error(`anvil account ${index} has no private key`)
	return `0x${Buffer.from(key).toString("hex")}` as Hex
}
/** Deploys, relays, and is `l1` in every flow. */
export const HARNESS_KEY = anvilKey(HARNESS_INDEX)

export interface TokenSpec {
	name: string
	symbol: string
	decimals: number
}

export const SPECS = {
	usdc: { name: "Test USDC", symbol: "USDC", decimals: 6 },
	usdt: { name: "Test USDT", symbol: "USDT", decimals: 6 },
	nort: { name: "No Route Token", symbol: "NORT", decimals: 18 },
	pxo: { name: "Portal Only", symbol: "PXO", decimals: 18 },
	/** An 18-decimal token outside the manifest, which a test rates at the swapper on demand. */
	weth: { name: "Wrapped Ether", symbol: "WETH", decimals: 18 },
} satisfies Record<string, TokenSpec>
export type SpecKey = keyof typeof SPECS

export const sandboxChain = (rpcUrl: string) =>
	defineChain({
		id: CHAIN_ID,
		name: "sandbox",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
		contracts: { multicall3: { address: MULTICALL3 } },
	})

/** The second anvil a LI.FI-routed deposit starts on. It is never in the production source catalogue. */
export const SOURCE_CHAIN_ID = 31338

export const sandboxSourceChain = (rpcUrl: string) =>
	defineChain({
		id: SOURCE_CHAIN_ID,
		name: "sandbox-source",
		nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
		rpcUrls: { default: { http: [rpcUrl] } },
	})

export const lc = (v: string) => v.toLowerCase() as Address
export const rndNonce = () => BigInt(`0x${crypto.randomUUID().replaceAll("-", "")}`)
/** Read from the CHAIN, never the wall clock: anvil's timestamp runs far ahead of real time here
 *  (every forced block and every sequencer publication advances it), and a wall-clock deadline is
 *  already in this chain's past — Permit2 answers `SignatureExpired`. */
export const deadline = async (l1: L1Ctx): Promise<bigint> => (await l1.pub.getBlock()).timestamp + 3600n
