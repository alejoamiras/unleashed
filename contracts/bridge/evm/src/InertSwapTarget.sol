// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

/**
 * @notice The mainnet swapTarget: PROVABLY INERT. SwapBridgeRouter's constructor rejects
 *         address(0) and binds the swapTarget into every Permit2 witness, so a bridge-only
 *         deployment (swap-fuel disabled) still needs a non-zero target — this contract
 *         exists solely to fill that slot while making the dormant `bridgeWithFuel` path
 *         atomically unusable: EVERY call (any selector, any value) reverts, so a fueled
 *         bridge attempt reverts before any token movement, and the contract can never
 *         hold or route funds. No state, no owner, no selectors.
 */
contract InertSwapTarget {
    error Inert();

    fallback() external payable {
        revert Inert();
    }

    receive() external payable {
        revert Inert();
    }
}
