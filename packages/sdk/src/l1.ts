/** The viem-only slice of the protocol a Worker can bundle: esbuild resolves every module the `./protocol` barrel
 *  names, Aztec's included, before it drops the unused ones. Workspace-only. */
export * from "./protocol/deposit-router-abi.ts"
export * from "./protocol/fuel-swap.ts"
export * from "./protocol/lifi-abi.ts"
export * from "./protocol/lifi-addresses.ts"
export * from "./protocol/lifi-gas.ts"
