/**
 * Whether the connected wallet build advertises a feature, through the wallet-specific
 * `getWalletFeatures` RPC. FAIL CLOSED: a build that predates the method, a transport error or a
 * malformed answer all read as "not supported" — the features gated here (a dApp-named payer for
 * the account's own Fee Juice) build an INVALID transaction on a wallet that lacks them, so a
 * doubt is a no.
 */
export const DAPP_SELF_PAY_FEATURE = "dapp-self-pay"

type WalletWithFeatures = { getWalletFeatures?: () => Promise<unknown> }

export async function walletSupports(wallet: unknown, feature: string): Promise<boolean> {
	try {
		const w = wallet as WalletWithFeatures | null | undefined
		if (typeof w?.getWalletFeatures !== "function") return false
		const features = await w.getWalletFeatures()
		return Array.isArray(features) && features.includes(feature)
	} catch {
		return false
	}
}
