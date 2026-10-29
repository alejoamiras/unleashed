// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Ownable2Step, Ownable} from "@oz/access/Ownable2Step.sol";

/// @notice Stands in `DepositRouter`'s factory slot on a network with no token portals: the router asks it only
/// `depositsPaused()` (every entry) and `createPortal` (token legs only), so a router bound here can make fuel-only
/// deposits and nothing else. A token leg reverts inside the router's call, atomically, before any funds move.
///
/// The owner is the guardian: one pause bit (a delay, never a transfer of funds) behind `Ownable2Step`, renounce
/// disabled so the pause can never become unownable. No storage beyond the bit and the owner, no upgrade path.
contract FuelOnlyGate is Ownable2Step {
    bool public depositsPaused;

    event DepositsPauseChanged(bool paused);

    error TokenLegsDisabled();
    error RenounceDisabled();

    constructor(address guardian) Ownable(guardian) {}

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    function setDepositsPaused(bool paused) external onlyOwner {
        depositsPaused = paused;
        emit DepositsPauseChanged(paused);
    }

    function createPortal(address) external pure returns (address) {
        revert TokenLegsDisabled();
    }
}
