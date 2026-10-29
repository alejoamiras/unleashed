/**
 * The 2.2 MB Wonderland PrivateFPC `ContractArtifact`, outside every barrel and `./artifacts` so no eager bundle carries
 * it: reach it only with a dynamic `import()`, as the private Fee Juice balance read and the tools app do.
 */
export { PrivateFPCContractArtifact } from "@alejoamiras/private-fee-juice/artifacts/private"
