// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Vm} from "forge-std/Test.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";

import {DepositRouter} from "../src/DepositRouter.sol";
import {FuelOnlyGate} from "../src/FuelOnlyGate.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {MainnetLifiFork, SameChainQuote} from "./lifi/MainnetLifiFork.sol";
import {DepositPermit} from "./mocks/DepositPermit.sol";

/// The mainnet fuel route on Ethereum's real contracts: a `DepositRouter` bound to a `FuelOnlyGate`, a user's
/// signature to the real Permit2, the recorded USDC → AZTEC quote through LI.FI's Diamond, and the FeeJuicePortal, at
/// the block `lifi-fixtures.ts mainnet` recorded. That block predates the canonical rollup's portal, so the fixture's
/// portal stands in for it; `verify-l1 --strict` proves the deployed router's own binding. Needs an archive
/// `ETH_RPC_URL`; skips without one.
contract FuelRouteMainnetFork is MainnetLifiFork {
    /// Not a well-known test key: famous ones carry EIP-7702 delegations on live chains.
    uint256 internal constant SIGNER_PK = 0x5EC12E7_F0E1_6A7E;
    /// The installed line's canonical PrivateFPC, where private Fee Juice lands.
    bytes32 internal constant PRIVATE_FPC = 0x0516ebb4f9c7988eb3cf6dd9459a47556f7a92db06b17cfa47ffb37fd35c6915;
    bytes32 internal constant PUBLIC_RECIPIENT = bytes32(uint256(0xa2ec1));

    FuelOnlyGate internal gate;
    address internal signer;
    address internal permit2;
    uint256 internal nonce;

    function setUp() public {
        _forkEthereum();
        if (bytes(json).length == 0) return;
        permit2 = vm.parseJsonAddress(json, ".ethereum.permit2");
        gate = new FuelOnlyGate(guardian);
        assertEq(router.code.length, 0, "the fixture router address is taken on mainnet");
        // The recorded quote pays its output to the fixture address, so the router must sit there.
        deployCodeTo(
            "DepositRouter.sol:DepositRouter",
            abi.encode(permit2, feeJuicePortal, address(gate), diamond, routerOwner),
            router
        );
        depositRouter = DepositRouter(router);
        assertEq(depositRouter.FEE_ASSET(), aztec, "the FeeJuicePortal's underlying is not AZTEC");
        signer = vm.addr(SIGNER_PK);
        assertEq(signer.code.length, 0, "the signer is not a plain EOA at the fixture block");
        vm.startPrank(signer);
        IERC20(usdc).approve(permit2, type(uint256).max);
        IERC20(aztec).approve(permit2, type(uint256).max);
        vm.stopPrank();
    }

    function test_usdcFuel_toAPublicRecipient() public {
        _swappedFuel(PUBLIC_RECIPIENT);
    }

    function test_usdcFuel_toThePrivateFpc() public {
        _swappedFuel(PRIVATE_FPC);
    }

    /// The fee asset itself needs no venue: what the signer signs is what the portal receives.
    function test_aztecIdentity_settlesOneToOne() public {
        uint256 amount = 50e18;
        DepositRouter.DepositIntent memory intent = _fuelOnly(aztec, amount, PUBLIC_RECIPIENT, amount);
        uint256 portalBefore = IERC20(aztec).balanceOf(feeJuicePortal);
        deal(aztec, signer, amount);
        (Vm.Log[] memory logs, uint256 tokenAmount, uint256 fuelOut) = _send(intent, "", amount);
        assertEq(tokenAmount, 0, "a fuel-only send has a token leg");
        assertEq(fuelOut, amount, "identity is not 1:1");
        _assertFuelLanded(logs, intent, fuelOut, portalBefore);
        assertEq(IERC20(aztec).balanceOf(signer), 0, "Permit2 did not pull exactly the signed amount");
    }

    /// Every token leg reaches the gate's `createPortal`, which reverts before anything is pulled.
    function test_tokenLeg_revertsWithTheSignersBalanceUnchanged() public {
        uint256 amount = 20e6;
        deal(usdc, signer, amount);
        DepositRouter.DepositIntent memory intent = DepositRouter.DepositIntent({
            token: usdc,
            aztecRecipient: PUBLIC_RECIPIENT,
            tokenSecretHash: bytes32(uint256(0x70ce)),
            isPrivate: false,
            fuelSlice: 0,
            fuelRecipient: bytes32(0),
            fuelSecretHash: bytes32(0),
            minFuelOutput: 0
        });
        DepositRouter.PermitParams memory permit = _permit(intent, "", amount);
        vm.prank(signer);
        vm.expectRevert(FuelOnlyGate.TokenLegsDisabled.selector);
        depositRouter.bridgeWithPermit(intent, "", amount, permit);
        assertEq(IERC20(usdc).balanceOf(signer), amount, "a refused token leg moved the signer's USDC");
        assertEq(IERC20(usdc).balanceOf(router), 0, "a refused token leg left USDC in the router");
    }

    /// The gate's owner stops fuel-only sends before Permit2 pulls anything, and reopens them.
    function test_pausedGate_refusesFuel_andReopens() public {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _fuelOnly(usdc, q.fromAmount, PUBLIC_RECIPIENT, q.toAmountMin);
        deal(usdc, signer, q.fromAmount);
        vm.prank(guardian);
        gate.setDepositsPaused(true);
        DepositRouter.PermitParams memory permit = _permit(intent, q.data, q.fromAmount);
        vm.prank(signer);
        vm.expectRevert(DepositRouter.DepositsPaused.selector);
        depositRouter.bridgeWithPermit(intent, q.data, q.fromAmount, permit);
        assertEq(IERC20(usdc).balanceOf(signer), q.fromAmount, "a paused route moved the signer's USDC");

        vm.prank(guardian);
        gate.setDepositsPaused(false);
        uint256 portalBefore = IERC20(aztec).balanceOf(feeJuicePortal);
        (Vm.Log[] memory logs,, uint256 fuelOut) = _send(intent, q.data, q.fromAmount);
        _assertFuelLanded(logs, intent, fuelOut, portalBefore);
    }

    /// The recorded quote's slice, signed by the user and swapped through the Diamond into the portal for `recipient`.
    function _swappedFuel(bytes32 recipient) internal {
        SameChainQuote memory q = _sameChain("deadlineFree");
        DepositRouter.DepositIntent memory intent = _fuelOnly(usdc, q.fromAmount, recipient, q.toAmountMin);
        uint256[5] memory usdcResidue = _residue(usdc);
        uint256[5] memory aztecResidue = _residue(aztec);
        uint256 portalBefore = IERC20(aztec).balanceOf(feeJuicePortal);
        deal(usdc, signer, q.fromAmount);
        (Vm.Log[] memory logs, uint256 tokenAmount, uint256 fuelOut) = _send(intent, q.data, q.fromAmount);
        assertEq(tokenAmount, 0, "a fuel-only send has a token leg");
        _assertFuelLanded(logs, intent, fuelOut, portalBefore);
        assertEq(IERC20(usdc).balanceOf(signer), 0, "Permit2 did not pull exactly the signed amount");
        _assertNoResidue(usdc, usdcResidue);
        _assertNoResidue(aztec, aztecResidue);
    }

    function _fuelOnly(address token, uint256 slice, bytes32 recipient, uint256 floor)
        internal
        pure
        returns (DepositRouter.DepositIntent memory)
    {
        return DepositRouter.DepositIntent({
            token: token,
            aztecRecipient: bytes32(0),
            tokenSecretHash: bytes32(0),
            isPrivate: false,
            fuelSlice: slice,
            fuelRecipient: recipient,
            fuelSecretHash: bytes32(uint256(0xf0e1)),
            minFuelOutput: floor
        });
    }

    function _permit(DepositRouter.DepositIntent memory intent, bytes memory swapData, uint256 amount)
        internal
        returns (DepositRouter.PermitParams memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        uint256 n = nonce++;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_PK, DepositPermit.digest(depositRouter, permit2, intent, swapData, amount, n, deadline));
        return DepositRouter.PermitParams({nonce: n, deadline: deadline, signature: abi.encodePacked(r, s, v)});
    }

    function _send(DepositRouter.DepositIntent memory intent, bytes memory swapData, uint256 amount)
        internal
        returns (Vm.Log[] memory logs, uint256 tokenAmount, uint256 fuelOut)
    {
        DepositRouter.PermitParams memory permit = _permit(intent, swapData, amount);
        vm.recordLogs();
        vm.prank(signer);
        (tokenAmount, fuelOut) = depositRouter.bridgeWithPermit(intent, swapData, amount, permit);
        logs = vm.getRecordedLogs();
    }

    /// The portal holds exactly `fuelOut` more AZTEC and emitted it for the intent's recipient and secret hash.
    function _assertFuelLanded(
        Vm.Log[] memory logs,
        DepositRouter.DepositIntent memory intent,
        uint256 fuelOut,
        uint256 portalBefore
    ) internal view {
        assertGe(fuelOut, intent.minFuelOutput, "fuel under the floor");
        assertEq(IERC20(aztec).balanceOf(feeJuicePortal) - portalBefore, fuelOut, "FeeJuicePortal delta");
        uint256 at = _find(logs, feeJuicePortal, TokenPortalImpl.DepositToAztecPublic.selector, intent.fuelRecipient);
        assertTrue(at != NOT_FOUND, "no FeeJuicePortal deposit for the fuel recipient");
        (uint256 amount, bytes32 secretHash,,) = abi.decode(logs[at].data, (uint256, bytes32, bytes32, uint256));
        assertEq(amount, fuelOut, "fuel amount");
        assertEq(secretHash, intent.fuelSecretHash, "fuel secret hash");
        assertTrue(_find(logs, router, DepositRouter.Deposited.selector, NONE) != NOT_FOUND, "no Deposited");
    }
}
