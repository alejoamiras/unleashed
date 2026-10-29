/**
 * Gas and venue constants for LI.FI deliveries into `DepositRouter`, each pinned by a mainnet fork assertion
 * (`contracts/bridge/evm/test/LifiDestinationFork.t.sol`, `LifiStargateComposeFork.t.sol`) at the blocks
 * `scripts/lifi-fixtures.ts mainnet` records. Re-measure after any router, venue or LI.FI contract change.
 */

/** `BridgeData.integrator` on every route we build or request. Keyless and fee-free: it names us, it collects
 *  nothing. */
export const LIFI_INTEGRATOR = "unleashed"

/**
 * `toContractGasLimit` for the router call in a contract-call quote. The worst shape (private token leg, fuel to
 * the PrivateFPC, a deadline-free venue, known portal) measured 717,544 with every slot cold (LI.FI Diamond via
 * sushiswap, Ethereum block 26,128,931; via nordstern it was 673,561); the fork asserts that figure × 1.3 ≤ this.
 * Through Stargate the whole compose completes from 947,690 gas, under `LIFI_MIN_COMPOSE_GAS`.
 */
export const LIFI_TO_CONTRACT_GAS_LIMIT = 1_000_000n

/**
 * What a Stargate compose needs on top of `LIFI_TO_CONTRACT_GAS_LIMIT`: ReceiverStargateV2 reserves
 * `recoverGas` (100,000 on mainnet) and the Executor wraps the call. LI.FI's own quote adds the same 300,000; the
 * compose fork proves the worst shape completes with exactly the sum.
 */
export const LIFI_STARGATE_COMPOSE_OVERHEAD = 300_000n

/** The lowest lzCompose gas the decoder accepts in a Stargate route's `extraOptions`. */
export const LIFI_MIN_COMPOSE_GAS = LIFI_TO_CONTRACT_GAS_LIMIT + LIFI_STARGATE_COMPOSE_OVERHEAD

/**
 * Signed RFQ venues whose orders expire within minutes (bitget's ~10), which a cross-chain fill can outlive. The
 * recorder asks with this list, so each recording shows which venue LI.FI picks without them.
 */
export const LIFI_DENY_EXCHANGES = ["bitget"] as const

/** Fuel venues: the warp fork proved nordstern (Ethereum block 26,128,734) and sushiswap (26,128,931) survive ETA × 3. */
export const LIFI_ALLOW_EXCHANGES = ["nordstern", "sushiswap"] as const
