// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {DepositRouter} from "../../src/DepositRouter.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The digest real Permit2 re-derives for a `bridgeWithPermit` signature, built from the router's own type string and
/// typehash, never from `hashWitness`, so an accepted signature also proves the two agree.
library DepositPermit {
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string internal constant PERMIT2_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    function digest(
        DepositRouter router,
        address permit2,
        DepositRouter.DepositIntent memory i,
        bytes memory swapData,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 typehash = keccak256(abi.encodePacked(PERMIT2_STUB, router.DEPOSIT_WITNESS_TYPE_STRING()));
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, i.token, amount));
        bytes32 structHash =
            keccak256(abi.encode(typehash, permitted, address(router), nonce, deadline, witness(router, i, swapData)));
        return keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(permit2).DOMAIN_SEPARATOR(), structHash));
    }

    function witness(DepositRouter router, DepositRouter.DepositIntent memory i, bytes memory swapData)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                router.DEPOSIT_WITNESS_TYPEHASH(),
                i.aztecRecipient,
                i.tokenSecretHash,
                i.isPrivate,
                i.fuelSlice,
                i.fuelRecipient,
                i.fuelSecretHash,
                i.minFuelOutput,
                keccak256(swapData)
            )
        );
    }
}
