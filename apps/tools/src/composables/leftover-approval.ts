/**
 * The approval a failed cross-chain send can leave behind: the LI.FI Diamond may still pull the source
 * token from the sender's wallet on the source chain. Read without a wallet; revoked only from the
 * sender's own wallet, on that chain, by an exact `approve(diamond, 0)`.
 */
import { type CrossChainDepositRecord, lifiBook } from "@unleashed/bridge-core"
import { type Address, encodeFunctionData, erc20Abi } from "viem"
import { chainLabel } from "@/lib/chains"
import { shortAddress } from "@/lib/crosschain-activity"
import { readChainOf } from "@/lib/network"
import { runOnLane } from "./useBridgeJournal"
import { readClientFor } from "./useEthereumReader"
import { useL1Wallet } from "./useL1Wallet"

function diamondOf(chainId: number): Address | undefined {
	try {
		return lifiBook(chainId).diamond
	} catch {
		return undefined
	}
}

/** What the Diamond may still spend; 0n where this build cannot read the source chain. */
export async function leftoverAllowance(rec: CrossChainDepositRecord): Promise<bigint> {
	const { srcChainId, srcToken, srcSender } = rec.route
	const spender = diamondOf(srcChainId)
	const reader = readClientFor(srcChainId)
	if (!spender || !reader) return 0n
	return reader.readContract({ address: srcToken, abi: erc20Abi, functionName: "allowance", args: [srcSender, spender] })
}

/**
 * Sends `approve(diamond, 0)` on the source chain from the record's sender and waits for it.
 *
 * @throws with user-facing copy when the wallet is another account, cannot reach the chain, or the
 * transaction reverts; a declined prompt throws the wallet's own rejection.
 */
export async function revokeLeftover(rec: CrossChainDepositRecord): Promise<void> {
	const { srcChainId, srcToken, srcSender } = rec.route
	const source = chainLabel(srcChainId)
	const spender = diamondOf(srcChainId)
	const reader = readClientFor(srcChainId)
	const chain = readChainOf(srcChainId)?.chain
	if (!spender || !reader || !chain) throw new Error(`${source} can't be reached from this build.`)
	const l1 = useL1Wallet()
	const account = l1.address.value
	const client = l1.ensureWalletClient()
	if (!account || !client) throw new Error("Connect your Ethereum wallet first.")
	if (account.toLowerCase() !== srcSender.toLowerCase()) throw new Error(`Switch your wallet to ${shortAddress(srcSender)} to revoke.`)
	if (l1.chainId.value !== srcChainId && !(await l1.switchChain(srcChainId))) {
		throw new Error(`Switch your wallet to ${source} to revoke.`)
	}
	const data = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, 0n] })
	const hash = await runOnLane("l1", () => client.sendTransaction({ account, chain, to: srcToken, data, value: 0n }))
	const receipt = await reader.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success") throw new Error(`The revoke reverted on ${source}. Nothing changed; try again.`)
}
