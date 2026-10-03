/**
 * What an Ethereum address typed into the token search resolves to. A well-formed address the
 * catalog does not hold yet is read from the chain — symbol, name, decimals — so the user adds a
 * token they can recognise rather than a bare hex string. A partial address, or one the list
 * already carries, looks up nothing: the search filter is what finds those.
 *
 * Every read runs under an EPOCH, so a result for an address the user has already typed past can
 * never land on top of the current one.
 */
import { readErc20Metadata } from "@unleashed/bridge-core"
import type { Address, PublicClient } from "viem"
import { type Ref, shallowRef, watch } from "vue"
import { logoKeyOf, type SelectableToken, type TokenIdentity } from "@/lib/send-model"

const HEX20 = /^0x[0-9a-fA-F]{40}$/
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type LookupState = { address: Address; logoKey: string } & (
	| { status: "reading" }
	| { status: "found"; identity: TokenIdentity }
	| { status: "error"; message: string }
)

export interface AddressLookupDeps {
	pub: () => PublicClient | undefined
	query: Ref<string>
	/** Everything the catalog already lists; a known address is found by the search filter instead. */
	known: () => readonly SelectableToken[]
	chainId: () => number
}

export interface UseAddressLookupHandle {
	readonly state: Ref<LookupState | null>
	dispose: () => void
}

/** Exactly a 20-byte hex address, whatever its casing. */
export function isTokenAddress(text: string): boolean {
	return HEX20.test(text.trim())
}

export function useAddressLookup(deps: AddressLookupDeps): UseAddressLookupHandle {
	const state = shallowRef<LookupState | null>(null)
	let epoch = 0
	let disposed = false

	async function read(address: Address, mine: number): Promise<void> {
		const logoKey = logoKeyOf(deps.chainId(), address)
		const pub = deps.pub()
		if (!pub) {
			state.value = { status: "error", address, logoKey, message: "Connect your Ethereum wallet to read this token." }
			return
		}
		state.value = { status: "reading", address, logoKey }
		try {
			const meta = await readErc20Metadata(pub, address)
			if (disposed || mine !== epoch) return
			state.value = { status: "found", address, logoKey, identity: { symbol: meta.symbol, name: meta.name, decimals: meta.decimals } }
		} catch (e) {
			if (disposed || mine !== epoch) return
			state.value = {
				status: "error",
				address,
				logoKey,
				message: e instanceof Error ? e.message : "This address is not an ERC-20 token.",
			}
		}
	}

	function onQuery(query: string): void {
		const mine = ++epoch
		const trimmed = query.trim()
		if (!HEX20.test(trimmed)) {
			state.value = null
			return
		}
		const address = trimmed.toLowerCase() as Address
		if (address === ZERO_ADDRESS) {
			state.value = {
				status: "error",
				address,
				logoKey: logoKeyOf(deps.chainId(), address),
				message: "The zero address is not a token.",
			}
			return
		}
		if (deps.known().some((t) => t.address === address)) {
			state.value = null
			return
		}
		void read(address, mine)
	}

	const stop = watch(deps.query, onQuery, { immediate: true })

	function dispose(): void {
		disposed = true
		epoch++
		stop()
		state.value = null
	}

	return { state, dispose }
}
