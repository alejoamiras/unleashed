// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {DepositRouter} from "../../src/DepositRouter.sol";
import {PortalFactory} from "../../src/PortalFactory.sol";
import {LifiForkBase} from "./LifiForkBase.sol";

/// One same-chain AZTEC buy recorded at the fixture router (`fromAddress = toAddress = router`).
struct SameChainQuote {
    string tool;
    address fromToken;
    uint256 fromAmount;
    uint256 toAmount;
    uint256 toAmountMin;
    address to;
    bytes data;
}

/// Ethereum mainnet as `lifi-fixtures.ts mainnet` recorded it: our factory over Aztec's real registry, USDC's clone
/// pre-created (cross-chain sends only target tokens whose portal exists), and `DepositRouter` placed at the
/// fixture address the recorded quotes pay, swapping through LI.FI's real Diamond into the real FeeJuicePortal.
/// Public full nodes prune the pinned blocks within minutes; an archive RPC (e.g. drpc) replays a committed fixture.
abstract contract MainnetLifiFork is LifiForkBase {
    string internal constant FIXTURE = "test/fixtures/lifi/mainnet.json";
    bytes32 internal constant HUB = bytes32(uint256(0xA2B1));

    string internal json;
    address internal router;
    address internal user;
    address internal diamond;
    address internal executor;
    address internal receiverAcrossV4;
    address internal receiverStargateV2;
    address internal spokePool;
    address internal feeJuicePortal;
    address internal aztec;
    address internal usdc;
    address internal weth;

    PortalFactory internal factory;
    address internal usdcPortal;
    DepositRouter internal depositRouter;
    address internal guardian = makeAddr("guardian");
    address internal routerOwner = makeAddr("routerOwner");

    /// Skips unless `ETH_RPC_URL` is set; otherwise forks Ethereum at the fixture block with the stack in place.
    function _setUpEthereum() internal returns (uint256 fork) {
        string memory rpc = vm.envOr("ETH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return 0;
        }
        _loadFixture();
        fork = vm.createSelectFork(rpc, vm.parseJsonUint(json, ".ethereum.block"));
        _deployStack();
    }

    function _loadFixture() internal {
        json = vm.readFile(FIXTURE);
        router = vm.parseJsonAddress(json, ".router");
        user = vm.parseJsonAddress(json, ".user");
        diamond = vm.parseJsonAddress(json, ".ethereum.diamond");
        executor = vm.parseJsonAddress(json, ".ethereum.executor");
        receiverAcrossV4 = vm.parseJsonAddress(json, ".ethereum.receiverAcrossV4");
        receiverStargateV2 = vm.parseJsonAddress(json, ".ethereum.receiverStargateV2");
        spokePool = vm.parseJsonAddress(json, ".ethereum.spokePool");
        feeJuicePortal = vm.parseJsonAddress(json, ".ethereum.feeJuicePortal");
        aztec = vm.parseJsonAddress(json, ".ethereum.aztec");
        usdc = vm.parseJsonAddress(json, ".ethereum.usdc");
        weth = vm.parseJsonAddress(json, ".ethereum.weth");
    }

    /// Deploys on the currently selected Ethereum fork; the router lands at the fixture address with LI.FI's Diamond
    /// as its immutable swap target.
    function _deployStack() internal {
        assertEq(block.chainid, 1, "not an Ethereum fork");
        for (uint256 i; i < 5; i++) {
            address c = [diamond, executor, receiverAcrossV4, receiverStargateV2, spokePool][i];
            assertGt(c.code.length, 0, "a recorded LI.FI or Across address has no code at the fixture block");
        }
        factory = new PortalFactory(IRegistry(vm.parseJsonAddress(json, ".ethereum.registry")), HUB, guardian);
        usdcPortal = factory.createPortal(usdc);
        assertEq(router.code.length, 0, "the fixture router address is taken on mainnet");
        deployCodeTo(
            "DepositRouter.sol:DepositRouter",
            abi.encode(
                vm.parseJsonAddress(json, ".ethereum.permit2"), feeJuicePortal, address(factory), diamond, routerOwner
            ),
            router
        );
        depositRouter = DepositRouter(router);
        assertEq(depositRouter.FEE_ASSET(), aztec, "the FeeJuicePortal's underlying is not AZTEC");
    }

    function _sameChain(string memory name) internal view returns (SameChainQuote memory q) {
        string memory k = string.concat(".sameChain.", name);
        q.tool = vm.parseJsonString(json, string.concat(k, ".tool"));
        q.fromToken = vm.parseJsonAddress(json, string.concat(k, ".fromToken"));
        q.fromAmount = vm.parseJsonUint(json, string.concat(k, ".fromAmount"));
        q.toAmount = vm.parseJsonUint(json, string.concat(k, ".toAmount"));
        q.toAmountMin = vm.parseJsonUint(json, string.concat(k, ".toAmountMin"));
        q.to = vm.parseJsonAddress(json, string.concat(k, ".to"));
        q.data = vm.parseJsonBytes(json, string.concat(k, ".data"));
        assertEq(q.to, diamond, "a same-chain quote does not target the Diamond");
    }

    /// The intent the recorded cross-chain quote embeds (private token leg, fuel to the PrivateFPC).
    function _crossChainIntent(string memory name) internal view returns (DepositRouter.DepositIntent memory i) {
        string memory k = string.concat(".crossChain.", name, ".intent");
        i.token = vm.parseJsonAddress(json, string.concat(k, ".token"));
        i.aztecRecipient = vm.parseJsonBytes32(json, string.concat(k, ".aztecRecipient"));
        i.tokenSecretHash = vm.parseJsonBytes32(json, string.concat(k, ".tokenSecretHash"));
        i.isPrivate = vm.parseJsonBool(json, string.concat(k, ".isPrivate"));
        i.fuelSlice = vm.parseJsonUint(json, string.concat(k, ".fuelSlice"));
        i.fuelRecipient = vm.parseJsonBytes32(json, string.concat(k, ".fuelRecipient"));
        i.fuelSecretHash = vm.parseJsonBytes32(json, string.concat(k, ".fuelSecretHash"));
        i.minFuelOutput = vm.parseJsonUint(json, string.concat(k, ".minFuelOutput"));
    }

    /// `bridgeFromCaller` calldata for `intent` and `swapData` under the given bounds.
    function _routerCall(
        DepositRouter.DepositIntent memory intent,
        bytes memory swapData,
        uint256 minReceived,
        uint256 maxPull
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(DepositRouter.bridgeFromCaller, (intent, swapData, minReceived, maxPull));
    }

    /// Balances of `token` at every contract a deposit passes through; compare before and after for residue.
    function _residue(address token) internal view returns (uint256[5] memory b) {
        address[5] memory at = [router, executor, receiverAcrossV4, receiverStargateV2, diamond];
        for (uint256 i; i < 5; i++) {
            b[i] = IERC20(token).balanceOf(at[i]);
        }
    }

    function _assertNoResidue(address token, uint256[5] memory before) internal view {
        uint256[5] memory afterwards = _residue(token);
        string[5] memory names = ["router", "executor", "receiverAcrossV4", "receiverStargateV2", "diamond"];
        for (uint256 i; i < 5; i++) {
            assertEq(afterwards[i], before[i], string.concat(names[i], " residue"));
        }
    }
}
