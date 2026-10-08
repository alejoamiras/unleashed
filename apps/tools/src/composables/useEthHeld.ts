import { type Ref, ref, watch } from "vue"
import { formatAmount } from "@/lib/format"
import { NETWORK } from "@/lib/network"
import { readClientFor } from "./useEthereumReader"

const ADDRESS = /^0x[0-9a-f]{40}$/i

/**
 * The ETH `address` holds on Ethereum, formatted ("0.40"): what continuing a delivered deposit from
 * Ethereum pays its gas with. Undefined until read, where the build reads no Ethereum, or when the
 * read fails; a surface drops the clause rather than guess.
 */
export function useEthHeld(address: () => string | undefined): Ref<string | undefined> {
	const held = ref<string | undefined>()
	watch(
		address,
		async (owner) => {
			held.value = undefined
			const reader = readClientFor(NETWORK.l1ChainId)
			if (!owner || !ADDRESS.test(owner) || !reader) return
			try {
				const wei = await reader.getBalance({ address: owner as `0x${string}` })
				if (address() === owner) held.value = formatAmount(wei, 18)
			} catch {
				// An unread balance only drops the clause that would state it.
			}
		},
		{ immediate: true },
	)
	return held
}
