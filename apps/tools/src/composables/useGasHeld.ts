/**
 * The gas the connected Aztec account already holds that a token-only claim can pay with: its
 * private Fee Juice at the PrivateFPC, and — on a wallet that routes a dApp-named payer — its
 * public Fee Juice. A token-only claim has no bridged Fee Juice to pay itself with, so it spends
 * these; a claim sent without a payer would be left to the wallet's picker, whose default is the
 * sponsored FPC no bridge path may lean on. Read ahead of the review so the user is steered to a
 * fueled send before signing anything on Ethereum.
 *
 * `null` means unknown: no Aztec account yet, or a read that failed. The amount step blocks nothing
 * on an unknown; the confirm requires known balances, and the claim's own gate reads again. The
 * public balance reads 0 on a wallet that cannot route it — it can pay nothing there.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { type Ref, ref, watch } from "vue"
import { DAPP_SELF_PAY_FEATURE, walletSupports } from "@/lib/wallet-features"
import { readFeeJuiceOrNull, readPrivateFeeJuiceBalance, readPublicFeeJuiceBalance } from "./deposit-flow"

export interface GasHeldDeps {
	aztec: () => unknown
	account: () => string | undefined
}

export interface UseGasHeldHandle {
	readonly credit: Ref<bigint | null>
	readonly publicFeeJuice: Ref<bigint | null>
	/** Whether the connected wallet routes the account's public Fee Juice as a dApp-named payer. */
	readonly selfPay: Ref<boolean>
	refresh: () => Promise<void>
	dispose: () => void
}

export function useGasHeld(deps: GasHeldDeps): UseGasHeldHandle {
	const credit = ref<bigint | null>(null)
	const publicFeeJuice = ref<bigint | null>(null)
	const selfPay = ref(false)
	let epoch = 0
	let disposed = false

	async function refresh(): Promise<void> {
		const mine = ++epoch
		const aztec = deps.aztec()
		const account = deps.account()
		if (!aztec || !account) {
			credit.value = null
			publicFeeJuice.value = null
			return
		}
		const recipient = AztecAddress.fromStringUnsafe(account)
		const routesSelfPay = await walletSupports(aztec, DAPP_SELF_PAY_FEATURE)
		const [priv, pub] = await Promise.all([
			readFeeJuiceOrNull("private FJ", () => readPrivateFeeJuiceBalance(aztec, recipient)),
			routesSelfPay ? readFeeJuiceOrNull("public FJ", () => readPublicFeeJuiceBalance(aztec, recipient)) : Promise.resolve(0n),
		])
		if (disposed || mine !== epoch) return
		selfPay.value = routesSelfPay
		credit.value = priv
		publicFeeJuice.value = pub
	}

	const stop = watch(
		() => `${deps.aztec() ? "w" : ""}|${deps.account() ?? ""}`,
		() => void refresh(),
		{ immediate: true },
	)

	function dispose(): void {
		disposed = true
		epoch++
		stop()
	}

	return { credit, publicFeeJuice, selfPay, refresh, dispose }
}
