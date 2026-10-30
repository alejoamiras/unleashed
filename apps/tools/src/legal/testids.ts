/** The gate's testids. Not in the global `TESTIDS`, which ships whole to every build: these stay in the mainnet chunk. */
export const GATE_TESTIDS = {
	gate: "tl-terms-gate",
	docLink: "tl-terms-gate-doc-link",
	sign: "tl-terms-gate-sign",
	status: "tl-terms-gate-status",
} as const
