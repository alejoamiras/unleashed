import { type Ref, ref, watch } from "vue"
import { formatCompact } from "@/lib/format"
import { readClientFor } from "./useEthereumReader"

const TX_HASH = /^0x[0-9a-f]{64}$/i

/**
 * The network fee a reverted transaction paid, in ETH ("0.000041"): its execution gas plus the L1 data fee an
 * OP-stack receipt carries. Undefined until read, where the build reads no such chain, or when the read fails; a
 * surface drops the clause rather than guess.
 */
export function useAttemptFee(tx: () => { chainId: number; hash: string } | undefined): Ref<string | undefined> {
	const fee = ref<string | undefined>()
	watch(
		() => tx()?.hash,
		async (hash) => {
			fee.value = undefined
			const t = tx()
			const reader = t && readClientFor(t.chainId)
			if (!hash || !t || !TX_HASH.test(hash) || !reader) return
			try {
				const receipt = await reader.getTransactionReceipt({ hash: hash as `0x${string}` })
				const l1Fee = (receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n
				if (tx()?.hash === hash) fee.value = formatCompact(receipt.gasUsed * receipt.effectiveGasPrice + l1Fee, 18)
			} catch {
				// An unread receipt only drops the clause that would state the fee.
			}
		},
		{ immediate: true },
	)
	return fee
}
