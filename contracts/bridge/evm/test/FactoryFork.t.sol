// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";
import {IRollup} from "@aztec/core/interfaces/IRollup.sol";
import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {IERC20Metadata} from "@oz/token/ERC20/extensions/IERC20Metadata.sol";

import {PortalFactory} from "../src/PortalFactory.sol";
import {TokenPortalImpl} from "../src/TokenPortalImpl.sol";
import {TestUsdc} from "../src/TestUsdc.sol";

/// Forks Sepolia so the factory wires into the REAL registry → rollup → Inbox/Outbox, reads the
/// metadata of live tokens (Test USDC, canonical WETH9), sends real `register` messages, and a
/// real clone deposits through the real Inbox. Opt-in: skips unless SEPOLIA_RPC_URL and
/// AZTEC_REGISTRY (the network's canonical registry) are both set.
contract FactoryForkTest is Test {
    TestUsdc internal constant USDC = TestUsdc(0x032E4F5f21d74AE177b96BeD98E472FFA9D62448);
    IERC20Metadata internal constant WETH = IERC20Metadata(0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14);
    bytes32 internal constant HUB = bytes32(uint256(0x4B));

    PortalFactory internal factory;
    IRegistry internal registry;
    IInbox internal inbox;

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string(""));
        address registryAddr = vm.envOr("AZTEC_REGISTRY", address(0));
        if (bytes(rpc).length == 0 || registryAddr == address(0)) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        registry = IRegistry(registryAddr);
        factory = new PortalFactory(registry, HUB, address(this));
        inbox = IRollup(address(registry.getCanonicalRollup())).getInbox();
    }

    function test_wiresIntoTheCanonicalRollup() public view {
        IRollup rollup = IRollup(address(registry.getCanonicalRollup()));
        assertEq(address(factory.INBOX()), address(rollup.getInbox()), "factory inbox");
        assertEq(factory.ROLLUP_VERSION(), rollup.getVersion(), "factory version");
        TokenPortalImpl impl = TokenPortalImpl(factory.IMPLEMENTATION());
        assertEq(address(impl.INBOX()), address(rollup.getInbox()), "impl inbox");
        assertEq(address(impl.OUTBOX()), address(rollup.getOutbox()), "impl outbox");
        assertEq(address(impl.FACTORY()), address(factory), "impl factory");
    }

    /// Live metadata is read through the bounded reader and committed verbatim; the register
    /// message lands in the real Inbox with the factory as sender.
    function test_createPortal_liveUsdcAndWeth() public {
        address pu = factory.createPortal(address(USDC));
        assertEq(pu, factory.predictPortal(address(USDC)));
        assertEq(address(TokenPortalImpl(pu).underlying()), address(USDC));
        _assertRegistration(address(USDC), USDC.name(), USDC.symbol(), USDC.decimals());

        address pw = factory.createPortal(address(WETH));
        assertEq(pw, factory.predictPortal(address(WETH)));
        _assertRegistration(address(WETH), WETH.name(), WETH.symbol(), WETH.decimals());
        assertEq(factory.registrationOf(address(WETH)).decimals, 18);

        assertGt(factory.registrationOf(address(WETH)).registerIndex, factory.registrationOf(address(USDC)).registerIndex);
        assertEq(factory.createPortal(address(USDC)), pu, "not idempotent on a live token");
    }

    /// A real clone pulls real Test USDC and enqueues the canonical mint message in the real Inbox.
    function test_cloneDeposit_throughTheRealInbox() public {
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(USDC)));
        uint256 amount = 250 * 10 ** USDC.decimals();
        USDC.mint(address(this), amount);
        USDC.approve(address(portal), amount);

        bytes32 to = bytes32(uint256(0xA11CE));
        vm.expectEmit(true, true, true, false, address(portal));
        emit TokenPortalImpl.DepositToAztecPublic(to, amount, bytes32(0), bytes32(0), 0);
        (bytes32 key,) = portal.depositToAztecPublic(to, amount, bytes32(0));

        assertNotEq(key, bytes32(0));
        assertEq(USDC.balanceOf(address(portal)), amount, "reserve");
    }

    /// The real cost of a first-time registration (clone + metadata reads + real Inbox leaf +
    /// registration record) — the price of "no pre-deploy step", paid once per token.
    function test_gas_createPortal_live() public {
        uint256 g = gasleft();
        factory.createPortal(address(USDC));
        uint256 used = g - gasleft();
        emit log_named_uint("createPortal gas (live Inbox)", used);
        assertLt(used, 450_000, "first-time registration cost regressed");
    }

    /// Withdraws are fenced by the guardian before the real Outbox is ever consulted.
    function test_withdrawPaused_precedesOutbox() public {
        TokenPortalImpl portal = TokenPortalImpl(factory.createPortal(address(USDC)));
        factory.setPaused(false, true);
        bytes32[] memory path;
        vm.expectRevert(TokenPortalImpl.WithdrawsPaused.selector);
        portal.withdraw(address(this), 1, false, Epoch.wrap(0), 0, 0, path);
    }

    function _assertRegistration(address token, string memory name, string memory symbol, uint8 decimals) private view {
        (bytes32 nameWord, bytes32 symbolWord) = (factory.registrationOf(token).nameWord, factory.registrationOf(token).symbolWord);
        assertEq(nameWord, _word(name), "name word");
        assertEq(symbolWord, _word(symbol), "symbol word");
        assertEq(factory.registrationOf(token).decimals, decimals, "decimals");
        assertEq(factory.tokenOf(factory.portalOf(token)), token, "tokenOf");
    }

    /// `0x00 ‖ first 31 bytes` — live tokens are plain ASCII, so no sanitization applies.
    function _word(string memory s) private pure returns (bytes32 out) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < 31 && i < b.length; i++) {
            out |= bytes32(bytes1(b[i])) >> (8 * (i + 1));
        }
    }
}
