/** Ethereum addresses the SDK trusts without asking the integrator's RPC or the manifest. */

/** Uniswap's Permit2, at this one address on every chain the bridge reaches (the sandbox installs it there). */
export const CANONICAL_PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"

/** Ethereum mainnet's Aztec registry, and the Fee Juice portal and asset of its canonical rollup on this Aztec line. */
export const MAINNET_L1 = {
	registry: "0x35b22e09ee0390539439e24f06da43d83f90e298",
	feeJuicePortal: "0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3",
	feeAsset: "0xa27ec0006e59f245217ff08cd52a7e8b169e62d2",
} as const

/** The widest swap slippage a network may sign gas legs with. A manifest above it is refused: its floor would let a
 *  venue fill a deposit far under its quote. */
export const MAX_FUEL_SLIPPAGE_BPS = 300
