/**
 * What the journal's claims run with: the build's own Ethereum reader where it pins one (a cross-chain send leaves the
 * wallet on its source chain), the app's Aztec node, the session wallet behind the app's two wallet rules, and the
 * SDK's checked network.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { Network } from "@unleashed/sdk"
import { bridgeNetwork } from "@/contracts/bridge-generation"
import { appReads } from "./app-reads"
import { type ClaimContext, runOnLane } from "./useBridgeJournal"
import { retryOnUnregistered } from "./useWalletConnection"

type Session = Parameters<typeof retryOnUnregistered>[0]

const NO_WALLET = "Connect your Aztec wallet first."

/** The session wallet as a claim sees it: a simulate re-registers the app's contracts once, quietly, when the wallet
 *  forgot them, and a send waits its turn on the Aztec prompt lane. Everything else is the wallet's own, bound to it
 *  (a wallet object may keep private fields a proxy receiver cannot read). */
export function claimWallet(session: Session, wallet: Wallet): Wallet {
	return new Proxy(wallet, {
		get(target, prop) {
			if (prop === "simulateTx")
				return (...args: Parameters<Wallet["simulateTx"]>) => retryOnUnregistered(session, target, () => target.simulateTx(...args))
			if (prop === "sendTx") return (...args: Parameters<Wallet["sendTx"]>) => runOnLane("aztec", () => target.sendTx(...args))
			const value: unknown = Reflect.get(target, prop, target)
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

/** A watching claim with no wallet connected asks the wallet only which network it is on, which the checked network
 *  answers; it never signs or sends, and any other wallet read fails as an absent wallet. */
function watchOnlyWallet(network: () => Promise<Network>): Wallet {
	const absent = () => Promise.reject(new Error(NO_WALLET))
	return new Proxy({} as Wallet, {
		get(_, prop) {
			if (prop === "then") return undefined
			if (prop !== "getChainInfo") return absent
			return async () => {
				const net = await network()
				return { chainId: new Fr(BigInt(net.l1ChainId)), version: new Fr(BigInt(net.rollupVersion)) }
			}
		},
	})
}

/** The claim's context. Throws without a connected Aztec wallet unless the claim only watches. */
export async function claimContextOf(
	session: Session,
	l1: { publicClient: unknown },
	recipient: string,
	watchOnly: boolean,
): Promise<ClaimContext> {
	const reads = appReads(l1)
	const network = () => bridgeNetwork(reads)
	const wallet = session.wallet.value
	if (!wallet && !watchOnly) throw new Error(NO_WALLET)
	return {
		reads,
		network,
		aztec: {
			wallet: wallet ? claimWallet(session, wallet) : watchOnlyWallet(network),
			account: AztecAddress.fromStringUnsafe(recipient),
		},
	}
}
