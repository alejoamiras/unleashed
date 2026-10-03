// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Script} from "forge-std/Script.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {SwapBridgeRouter} from "../src/SwapBridgeRouter.sol";
import {UniswapFuelSwap} from "../src/UniswapFuelSwap.sol";

/// One L1 generation: factory → swap target → router, in that order (the router binds the factory
/// as an immutable). Fork-test fixture only — the TS conductor is the operator surface — and the one
/// place the three constructor argument lists are spelled out.
abstract contract GenerationDeployer is Script {
    struct Generation {
        PortalFactory factory;
        UniswapFuelSwap swap;
        SwapBridgeRouter router;
    }

    function _deployGeneration(
        IRegistry registry,
        bytes32 l2Hub,
        address guardian,
        address permit2,
        address feeJuicePortal,
        address poolManager,
        address feeJuice,
        address weth
    ) internal returns (Generation memory g) {
        g.factory = new PortalFactory(registry, l2Hub, guardian);
        g.swap = new UniswapFuelSwap(poolManager, feeJuice, weth);
        g.router = new SwapBridgeRouter(permit2, feeJuicePortal, address(g.swap), address(g.factory));
    }

    /// The scripts that inherit this run only against an existing factory: a generation's factory is deployed
    /// by the conductor, which predicts its address for the hub's salt first.
    function _resolveFactory() internal view returns (address) {
        return vm.envAddress("PORTAL_FACTORY");
    }
}
