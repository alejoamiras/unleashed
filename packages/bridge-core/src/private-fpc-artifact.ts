/**
 * Lazy, dynamic-import-ONLY entry for the 2.2 MB Wonderland PrivateFPC `ContractArtifact`. It is kept
 * out of BOTH the main `@unleashed/bridge-core` barrel and the eager `./artifacts` barrel (which the tools app
 * statically imports for the bridge/proxy artifacts) so this JSON never lands in the main bundle.
 *
 * Consume it ONLY via `await import("@unleashed/bridge-core/private-fpc-artifact")` — mirroring the tools app's
 * lazy `import("@aztec-labs/noir-contracts.js/FeeJuice")` for the public-FJ read. The sole use is building a
 * `Contract.at(PRIVATE_FPC_ADDRESS, …)` to read `PrivateFPC.balance_of` (the user's private Fee Juice).
 * This is the only place the tools app reaches the Wonderland artifact; the address + payment-method
 * coupling stays in `private-fuel.ts`.
 */
export { PrivateFPCContractArtifact } from "@alejoamiras/private-fee-juice/artifacts/private"
