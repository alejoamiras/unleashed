// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {MockFeeJuicePortal} from "./mocks/RouterMocks.sol";

/// Exposes the internal witness/route hashing so the TS side (bridge-core/l1.ts)
/// can be pinned byte-for-byte against it (the L1 analogue of the content-hash
/// keystone — a Permit2 witness mismatch invalidates the signature).
contract WitnessHarness is SwapBridgeRouter {
    constructor()
        SwapBridgeRouter(
            address(uint160(1)),
            address(new MockFeeJuicePortal(IERC20(address(uint160(2))))),
            address(uint160(3)),
            address(uint160(4))
        )
    {}

    function hRoute(IUniswapFuelSwap.PoolKey[] calldata p, bool[] calldata d) external pure returns (bytes32) {
        return _hashRoute(p, d);
    }

    function hWitness(BridgeWitness calldata w) external pure returns (bytes32) {
        return _hashBridgeWitness(w);
    }
}

contract WitnessHashTest is Test {
    function test_witnessHashPinned() public {
        WitnessHarness h = new WitnessHarness();

        IUniswapFuelSwap.PoolKey[] memory path = new IUniswapFuelSwap.PoolKey[](1);
        path[0] = IUniswapFuelSwap.PoolKey({
            currency0: address(uint160(0x05DC)),
            currency1: address(uint160(0x4E14)),
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
        bool[] memory dirs = new bool[](1);
        dirs[0] = true;
        bytes32 routeHash = h.hRoute(path, dirs);

        SwapBridgeRouter.BridgeWitness memory w = SwapBridgeRouter.BridgeWitness({
            tokenPortal: address(uint160(0x1111)),
            bridgeToken: address(uint160(0x2222)),
            totalAmount: 1_000_000,
            fuelAmount: 100_000,
            aztecRecipient: bytes32(uint256(0x1234)),
            fuelRecipient: bytes32(uint256(0x5678)),
            tokenSecretHash: bytes32(uint256(0x5EC7)),
            fuelSecretHash: bytes32(uint256(0xFEE)),
            minFuelOutput: 1 ether,
            routeHash: routeHash,
            isPrivate: false,
            swapTarget: address(uint160(0x9ABC))
        });
        bytes32 witnessHash = h.hWitness(w);

        // Pinned, cross-checked against bridge-core/l1.test.ts for the SAME fixed witness — a drift on
        // either side means the JS-signed Permit2 witness won't match what the router hashes (12 fields).
        assertEq(routeHash, 0x01441be25b5060664969cc7926ae553da9e9393d5f4f83ce732e294df7578340, "ROUTE_HASH drift");
        assertEq(witnessHash, 0xf910b94139aa6f65c9a6ffe6a9b4a03f07a28928fe9b82a15834c3056160313b, "WITNESS_HASH drift");
    }
}
