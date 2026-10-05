// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {MintableERC20} from "../src/MintableERC20.sol";
import {DepositRouter} from "../src/DepositRouter.sol";
import {DepositRouterFixture} from "./mocks/DepositRouterFixture.sol";

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// The Permit2 reverts these tests expect, declared for their selectors.
interface IPermit2Errors {
    error InvalidNonce();
    error SignatureExpired(uint256 signatureDeadline);
    error InvalidSigner();
}

/// The REAL Permit2 on a mainnet fork against a router deployed over the shared fixture's stack (a fresh real
/// factory on Aztec fakes, the mock FeeJuicePortal and LI.FI swap). Signatures are built from the router's own type
/// string and typehash, never from `hashWitness`, so an accepted signature also proves the two agree. Permit2 is
/// immutable and nothing else is read from chain, so the fork runs at the latest block. Opt-in: skips unless
/// ETH_RPC_URL is set.
contract DepositRouterPermit2ForkTest is DepositRouterFixture {
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    string constant PERMIT2_STUB =
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,";

    // Not a well-known test key: famous ones carry EIP-7702 delegations on live chains, which turns Permit2's EOA
    // signature check into an `isValidSignature` call.
    uint256 constant USER_PK = 0x5EC12E7_A11CE_0BEEF;

    MintableERC20 other;

    function setUp() public {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        user = vm.addr(USER_PK);
        require(user.code.length == 0, "signer must be a plain EOA on this fork");

        _deployStack();
        router = new DepositRouter(PERMIT2, address(feePortal), address(factory), address(swap), owner);
        other = new MintableERC20("Other", "OTH", 6, 1_000_000_000);
        swap.set(type(uint256).max, 5 ether);
    }

    // ─── Signing: the digest real Permit2 re-derives ───

    function _witness(DepositRouter.DepositIntent memory i, bytes memory swapData) internal view returns (bytes32) {
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

    function _sign(
        DepositRouter.DepositIntent memory i,
        bytes memory swapData,
        uint256 amount,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (DepositRouter.PermitParams memory) {
        bytes32 typehash = keccak256(abi.encodePacked(PERMIT2_STUB, router.DEPOSIT_WITNESS_TYPE_STRING()));
        bytes32 permitted = keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, i.token, amount));
        bytes32 structHash =
            keccak256(abi.encode(typehash, permitted, address(router), nonce, deadline, _witness(i, swapData)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IPermit2Domain(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_PK, digest);
        return DepositRouter.PermitParams({nonce: nonce, deadline: deadline, signature: abi.encodePacked(r, s, v)});
    }

    function _usdcWithFuel(bool isPrivate)
        internal
        view
        returns (DepositRouter.DepositIntent memory i, bytes memory swapData)
    {
        i = _fuelIntent(address(usdc), 2e6, 1 ether, isPrivate);
        swapData = _swapData(address(usdc), 2e6, 1 ether);
    }

    // ─── Token leg plus a swapped fuel slice ───

    function test_permit_depositWithFuel() public {
        usdc.mint(user, 10e6);
        (DepositRouter.DepositIntent memory i, bytes memory swapData) = _usdcWithFuel(false);
        DepositRouter.PermitParams memory permit = _sign(i, swapData, 10e6, 0, block.timestamp + 1 hours);
        assertEq(factory.portalOf(address(usdc)), address(0));

        vm.prank(user);
        (uint256 tokenAmount, uint256 fuelOut) = router.bridgeWithPermit(i, swapData, 10e6, permit);

        assertEq(usdc.balanceOf(user), 0, "Permit2 pulled exactly the signed amount");
        assertEq(factory.portalOf(address(usdc)), portalFor(address(usdc)), "clone created on first use");
        assertEq(tokenAmount, 8e6);
        assertEq(portalBalance(address(usdc)), 8e6, "amount - slice into the clone");
        assertTrue(lastMintWasPublic(RECIPIENT, 8e6));
        assertEq(fuelOut, 5 ether);
        assertEq(feePortal.lastAmount(), 5 ether, "swapped fuel into the FeeJuicePortal");
        assertEq(feePortal.lastTo(), FUEL_RECIPIENT);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(fj.balanceOf(address(router)), 0);
    }

    function test_permit_nonceReplayReverts() public {
        usdc.mint(user, 20e6);
        (DepositRouter.DepositIntent memory i, bytes memory swapData) = _usdcWithFuel(false);
        DepositRouter.PermitParams memory permit = _sign(i, swapData, 10e6, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridgeWithPermit(i, swapData, 10e6, permit);

        vm.prank(user);
        vm.expectRevert(IPermit2Errors.InvalidNonce.selector);
        router.bridgeWithPermit(i, swapData, 10e6, permit);
    }

    function test_permit_expiredDeadlineReverts() public {
        usdc.mint(user, 10e6);
        (DepositRouter.DepositIntent memory i, bytes memory swapData) = _usdcWithFuel(false);
        uint256 deadline = block.timestamp - 1;
        DepositRouter.PermitParams memory permit = _sign(i, swapData, 10e6, 0, deadline);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IPermit2Errors.SignatureExpired.selector, deadline));
        router.bridgeWithPermit(i, swapData, 10e6, permit);
    }

    /// Every intent field and the amount, re-aimed after signing, fails Permit2's signature check (each tamper keeps
    /// the router's shape rules satisfied, so only the signature can catch it); the nonce survives for the honest call.
    function test_permit_tamperedIntentOrAmountReverts() public {
        usdc.mint(user, 10e6);
        other.mint(user, 10e6);
        for (uint256 field = 0; field < 9; field++) {
            (DepositRouter.DepositIntent memory i, bytes memory swapData) = _usdcWithFuel(field == 3);
            DepositRouter.PermitParams memory permit = _sign(i, swapData, 10e6, 0, block.timestamp + 1 hours);
            uint256 amount = 10e6;
            if (field == 0) i.token = address(other);
            if (field == 1) i.aztecRecipient = bytes32(uint256(0xDEAD));
            if (field == 2) i.tokenSecretHash = bytes32(uint256(0x5EC2));
            if (field == 3) i.isPrivate = false;
            if (field == 4) i.fuelSlice = 3e6;
            if (field == 5) i.fuelRecipient = bytes32(uint256(0xF00D));
            if (field == 6) i.fuelSecretHash = bytes32(uint256(0xF5EC2));
            if (field == 7) i.minFuelOutput = 2 ether;
            if (field == 8) amount = 9e6;
            vm.prank(user);
            vm.expectRevert(IPermit2Errors.InvalidSigner.selector);
            router.bridgeWithPermit(i, swapData, amount, permit);
        }

        (DepositRouter.DepositIntent memory honest, bytes memory honestData) = _usdcWithFuel(false);
        DepositRouter.PermitParams memory honestPermit = _sign(honest, honestData, 10e6, 0, block.timestamp + 1 hours);
        vm.prank(user);
        router.bridgeWithPermit(honest, honestData, 10e6, honestPermit);
        assertEq(portalBalance(address(usdc)), 8e6);
    }

    /// Mutations the router's own pin accepts (pinned selector, `_receiver` = router), so only the witness's
    /// `swapDataHash` catches them.
    function test_permit_mutatedSwapDataReverts() public {
        usdc.mint(user, 10e6);
        (DepositRouter.DepositIntent memory i, bytes memory swapData) = _usdcWithFuel(false);
        DepositRouter.PermitParams memory permit = _sign(i, swapData, 10e6, 0, block.timestamp + 1 hours);
        bytes[] memory mutated = new bytes[](2);
        mutated[0] = _swapData(address(usdc), 2e6, 1 ether + 1);
        mutated[1] = _swapDataMultiple(address(usdc), 2e6, 1 ether, true);
        for (uint256 k = 0; k < mutated.length; k++) {
            vm.prank(user);
            vm.expectRevert(IPermit2Errors.InvalidSigner.selector);
            router.bridgeWithPermit(i, mutated[k], 10e6, permit);
        }
    }

    // ─── Identity legs: the fee asset needs no swap ───

    function test_identity_partialIntoFeePortalAndOwnClone() public {
        fj.mint(user, 20 ether);
        DepositRouter.DepositIntent memory i = _fuelIntent(address(fj), 16 ether, 16 ether, true);
        DepositRouter.PermitParams memory permit = _sign(i, "", 20 ether, 0, block.timestamp + 1 hours);

        vm.prank(user);
        router.bridgeWithPermit(i, "", 20 ether, permit);

        assertEq(fj.balanceOf(address(feePortal)), 16 ether, "slice straight into the FeeJuicePortal");
        assertEq(portalBalance(address(fj)), 4 ether, "remainder into the fee asset's own clone");
        assertTrue(lastMintWasPrivate(4 ether));
        assertEq(fj.balanceOf(address(router)), 0);
        assertEq(swap.calls(), 0, "no swap");
    }

    function test_identity_fuelOnly() public {
        fj.mint(user, 16 ether);
        DepositRouter.DepositIntent memory i = _fuelOnlyIntent(address(fj), 16 ether, 16 ether);
        DepositRouter.PermitParams memory permit = _sign(i, "", 16 ether, 0, block.timestamp + 1 hours);

        vm.prank(user);
        router.bridgeWithPermit(i, "", 16 ether, permit);

        assertEq(fj.balanceOf(address(feePortal)), 16 ether);
        assertEq(factory.portalOf(address(fj)), address(0), "fuel-only creates no clone");
        assertEq(fj.balanceOf(address(router)), 0);
    }
}
