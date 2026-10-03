/**
 * The chain id a wallet matches a network by: the L1 chain id XOR the rollup version, as an
 * unsigned 32-bit integer. It is the node-handshake identity the manifest's `walletChainId` must
 * carry — a manifest written with the bare rollup version is unusable by every wallet.
 */
export function walletChainIdOf(l1ChainId: number, rollupVersion: number): number {
	return (l1ChainId ^ rollupVersion) >>> 0
}
