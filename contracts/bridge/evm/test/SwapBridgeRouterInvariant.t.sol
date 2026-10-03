// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@oz/token/ERC20/IERC20.sol";
import {IRegistry} from "@aztec/governance/interfaces/IRegistry.sol";

import {SwapBridgeRouter, IUniswapFuelSwap} from "../src/SwapBridgeRouter.sol";
import {PortalFactory} from "../src/PortalFactory.sol";
import {MintableERC20} from "../src/MintableERC20.sol";
import {CapturingInbox, CapturingOutbox, FakeRegistry, FakeRollup} from "./mocks/AztecFakes.sol";
import {MockPermit2, MockSwap, MockFeeJuicePortal} from "./mocks/RouterMocks.sol";

/// Cross-call INVARIANT suite for SwapBridgeRouter over the REAL factory: a handler drives
/// randomized bridge/bridgeWithFuel/fuel-only/identity/create/pause/donate/sweep/rotate sequences
/// and the suite asserts state that must hold after EVERY sequence:
///
///   I1  The router holds NOTHING beyond attacker donations (per token).
///   I2  Conservation: every wei Permit2-pulled sits at a real sink — the token's portal clone,
///       the swap targets, or (for the fee asset) the fee portal — no third destination exists.
///   I3  The fee portal received exactly what the swaps reported plus every identity pass-through.
///   I4  A swap target that under-delivers against its report is never accepted.
///   I5  No deposit lands while the guardian has deposits paused; the USDC clone is created
///       exactly once and always at the prediction.
contract SwapBridgeRouterInvariantTest is Test {
    RouterHandler internal handler;

    function setUp() public {
        handler = new RouterHandler();
        targetContract(address(handler));
    }

    function invariant_routerHoldsNothingBeyondDonations() public view {
        assertEq(handler.routerUsdc(), handler.ghostDonatedUsdc() - handler.ghostSweptUsdc(), "usdc residue != donations");
        assertEq(handler.routerFj(), handler.ghostDonatedFj() - handler.ghostSweptFj(), "fj residue != donations");
    }

    /// Measured against OBSERVED sinks, never ghost against ghost.
    function invariant_pulledIsFullyAccounted() public view {
        assertEq(handler.usdcPortalBalance(), handler.ghostTokenDeposited(), "usdc clone != cumulative deposits");
        assertEq(handler.fjPortalBalance(), handler.ghostFjTokenDeposited(), "fj clone != cumulative fj remainders");
        assertEq(handler.swapTargetBalance(), handler.ghostFuelSwapped(), "swap targets != cumulative fuel slices");
    }

    function invariant_feePortalReceivedExactlyReportedOutput() public view {
        assertEq(handler.feePortalBalance(), handler.ghostFjOut(), "fee portal balance != cumulative reported output");
    }

    function invariant_lyingSwapTargetNeverAccepted() public view {
        assertFalse(handler.hostileAccepted(), "router accepted a swap target that under-delivered");
    }

    function invariant_pauseHoldsAndPortalIsStable() public view {
        assertFalse(handler.pausedDepositAccepted(), "a deposit landed while paused");
        assertFalse(handler.unexpectedRevert(), "an honest action reverted while deposits were open");
        address p = handler.factory().portalOf(handler.usdcAddress());
        if (p != address(0)) {
            assertEq(p, handler.factory().predictPortal(handler.usdcAddress()), "clone drifted from prediction");
        }
        assertLe(handler.inbox().sent(), handler.ghostDeposits() + 2, "more Inbox messages than deposits + registers");
    }
}

contract RouterHandler is StdUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    MintableERC20 public usdc;
    MintableERC20 public fj;
    MockPermit2 public permit2;
    MockSwap public swap;
    MockFeeJuicePortal public feePortal;
    CapturingInbox public inbox;
    PortalFactory public factory;
    SwapBridgeRouter public router;

    address public immutable user;

    uint256 public ghostDonatedUsdc;
    uint256 public ghostDonatedFj;
    uint256 public ghostSweptUsdc;
    uint256 public ghostSweptFj;
    uint256 public ghostTokenDeposited;
    uint256 public ghostFjTokenDeposited;
    uint256 public ghostFuelSwapped;
    uint256 public ghostFjOut;
    uint256 public ghostDeposits;
    bool public hostileAccepted;
    bool public pausedDepositAccepted;
    /// An honest action reverted while deposits were open — the campaign's fail_on_revert=false
    /// would otherwise swallow it.
    bool public unexpectedRevert;
    bool public depositsPaused;
    uint256 private nonce;
    address[] public swapTargets;

    bytes32 constant RECIPIENT = bytes32(uint256(0x1234));
    bytes32 constant FUEL_RECIPIENT = bytes32(uint256(0x5678));
    bytes32 constant SECRET = bytes32(uint256(0x5EC7E7));

    constructor() {
        usdc = new MintableERC20("USDC", "USDC", 6, 1_000_000_000);
        fj = new MintableERC20("FeeJuice", "FJ", 18, 1_000_000_000);
        permit2 = new MockPermit2();
        swap = new MockSwap(IERC20(address(fj)));
        swapTargets.push(address(swap));
        feePortal = new MockFeeJuicePortal(IERC20(address(fj)));
        inbox = new CapturingInbox();
        FakeRegistry registry = new FakeRegistry(address(new FakeRollup(address(inbox), address(new CapturingOutbox()))));
        // Handler deploys → handler is the guardian AND the router owner.
        factory = new PortalFactory(IRegistry(address(registry)), bytes32(uint256(0x4B)), address(this));
        router = new SwapBridgeRouter(address(permit2), address(feePortal), address(swap), address(factory));

        user = address(0xDA0);
        usdc.mint(address(this), 1_000_000_000 * 1e6);
        usdc.mint(user, 1_000_000_000 * 1e6);
        fj.mint(address(swap), 100_000_000 ether);
        fj.mint(address(this), 100_000_000 ether);
        fj.mint(user, 100_000_000 ether);
        usdc.approve(address(permit2), type(uint256).max);
        vm.startPrank(user);
        usdc.approve(address(permit2), type(uint256).max);
        fj.approve(address(permit2), type(uint256).max);
        vm.stopPrank();
        swap.setOutput(1 ether, 0); // honest default: report == transfer
    }

    // ─── Actions (foundry feeds random seeds) ────────────────────────

    function bridgeWithFuel(uint256 seed) external {
        uint256 total = bound(seed % 1000, 2, 1000) * 1e6;
        uint256 fuel = bound(seed >> 8, 1, total - 1);
        bool isPrivate = (seed >> 4) % 2 == 0;
        // Vary the honest output so I3 compares a moving sum rather than a constant multiple.
        uint256 out = bound((seed >> 20) % 4096, 1 ether, 5 ether);
        swap.setOutput(out, 0);
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        vm.prank(user);
        try router.bridgeWithFuel(_fuelParams(address(usdc), total, fuel, path, dirs, 1 ether, isPrivate), _permit()) {
            if (depositsPaused) pausedDepositAccepted = true;
            ghostTokenDeposited += total - fuel;
            ghostFuelSwapped += fuel;
            ghostFjOut += out;
            ghostDeposits++;
        } catch {
            if (!depositsPaused) unexpectedRevert = true;
        }
    }

    function fuelOnly(uint256 seed) external {
        uint256 total = bound(seed % 1000, 1, 1000) * 1e6;
        uint256 out = bound((seed >> 20) % 4096, 1 ether, 5 ether);
        swap.setOutput(out, 0);
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(usdc), total, total, path, dirs, 1 ether, false);
        p.tokenPortal = address(0);
        p.aztecRecipient = bytes32(0);
        p.tokenSecretHash = bytes32(0);
        vm.prank(user);
        try router.bridgeWithFuel(p, _permit()) {
            ghostFuelSwapped += total;
            ghostFjOut += out;
        } catch {
            unexpectedRevert = true; // no token leg → the pause cannot bite
        }
    }

    /// The fee asset splits 1:1: `fuel` straight into the fee portal, the rest into FJ's own clone.
    function identity(uint256 seed) external {
        uint256 total = bound(seed % 1000, 1, 1000) * 1 ether;
        uint256 fuel = bound(seed >> 8, 1, total);
        bool isPrivate = (seed >> 4) % 2 == 0;
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _noRoute();
        SwapBridgeRouter.BridgeParams memory p = _fuelParams(address(fj), total, fuel, path, dirs, fuel, isPrivate);
        if (fuel == total) {
            p.tokenPortal = address(0);
            p.aztecRecipient = bytes32(0);
            p.tokenSecretHash = bytes32(0);
        }
        vm.prank(user);
        try router.bridgeWithFuel(p, _permit()) {
            if (depositsPaused && fuel != total) pausedDepositAccepted = true;
            ghostFjOut += fuel;
            ghostFjTokenDeposited += total - fuel;
            if (fuel != total) ghostDeposits++;
        } catch {
            if (!(depositsPaused && fuel != total)) unexpectedRevert = true;
        }
    }

    /// A swap target that reports more fuel than it hands over must be caught whole: nothing
    /// pulled, nothing credited, no ghost advances. I4 reads the flag.
    function bridgeWithLyingTarget(uint256 seed) external {
        uint256 total = bound(seed % 1000, 2, 1000) * 1e6;
        uint256 fuel = bound((seed >> 10) % 997, 1, total - 1);
        uint256 reported = bound((seed >> 20) % 4096, 2 ether, 5 ether);
        uint256 delivered = bound((seed >> 32) % 997, 1, reported - 1 ether);
        (IUniswapFuelSwap.PoolKey[] memory path, bool[] memory dirs) = _route();

        swap.setOutput(reported, delivered);
        vm.prank(user);
        try router.bridgeWithFuel(_fuelParams(address(usdc), total, fuel, path, dirs, 1 ether, false), _permit()) {
            hostileAccepted = true;
        } catch {}
        swap.setOutput(1 ether, 0);
    }

    function bridge(uint256 seed) external {
        uint256 amount = bound(seed % 997, 1, 1000) * 1e6;
        bool isPrivate = (seed >> 3) % 2 == 0;
        vm.prank(user);
        try router.bridge(
            SwapBridgeRouter.SimpleBridgeParams({
                tokenPortal: factory.predictPortal(address(usdc)),
                bridgeToken: address(usdc),
                amount: amount,
                aztecRecipient: RECIPIENT,
                secretHash: SECRET,
                isPrivate: isPrivate
            }),
            _permit()
        ) {
            if (depositsPaused) pausedDepositAccepted = true;
            ghostTokenDeposited += amount;
            ghostDeposits++;
        } catch {
            if (!depositsPaused) unexpectedRevert = true;
        }
    }

    /// Anyone may pre-create the clone; the router must then simply reuse it.
    function createPortal(uint256 seed) external {
        address t = (seed >> 2) % 2 == 0 ? address(usdc) : address(fj);
        try factory.createPortal(t) {} catch {
            unexpectedRevert = true;
        }
    }

    function guardianPause(bool d) external {
        factory.setPaused(d, false);
        depositsPaused = d;
    }

    /// Attacker dust/value donation — must NEVER distort user accounting (delta checks).
    function donate(uint256 seed) external {
        uint256 units = bound(seed % 991, 1, 500);
        if ((seed >> 5) % 2 == 0) {
            uint256 amt = units * 1e6;
            usdc.transfer(address(router), amt);
            ghostDonatedUsdc += amt;
        } else {
            uint256 amt = units * 1 ether;
            fj.transfer(address(router), amt);
            ghostDonatedFj += amt;
        }
    }

    function sweep(uint256 seed) external {
        if ((seed >> 6) % 2 == 0) {
            uint256 bal = usdc.balanceOf(address(router));
            router.sweep(address(usdc), address(this));
            ghostSweptUsdc += bal;
        } else {
            uint256 bal = fj.balanceOf(address(router));
            router.sweep(address(fj), address(this));
            ghostSweptFj += bal;
        }
    }

    /// Pool-migration rotation: a fresh honest target; pending sigs die (witness drift) but the
    /// mock permit2 accepts regardless, so sequences keep flowing.
    function rotateSwap(uint256 seed) external {
        seed;
        MockSwap next = new MockSwap(IERC20(address(fj)));
        fj.mint(address(next), 100_000_000 ether);
        next.setOutput(1 ether, 0);
        router.setSwapTarget(address(next));
        swapTargets.push(address(next));
        swap = next;
    }

    // ─── Invariant read-backs ────────────────────────────────────────

    function usdcAddress() external view returns (address) {
        return address(usdc);
    }

    function routerUsdc() external view returns (uint256) {
        return usdc.balanceOf(address(router));
    }

    function routerFj() external view returns (uint256) {
        return fj.balanceOf(address(router));
    }

    function usdcPortalBalance() external view returns (uint256) {
        return usdc.balanceOf(factory.predictPortal(address(usdc)));
    }

    function fjPortalBalance() external view returns (uint256) {
        return fj.balanceOf(factory.predictPortal(address(fj)));
    }

    /// Slices land on whichever target was live at swap time; rotations strand nothing.
    function swapTargetBalance() external view returns (uint256) {
        uint256 total;
        for (uint256 i = 0; i < swapTargets.length; i++) total += usdc.balanceOf(swapTargets[i]);
        return total;
    }

    function feePortalBalance() external view returns (uint256) {
        return fj.balanceOf(address(feePortal));
    }

    // ─── Internals ───────────────────────────────────────────────────

    function _fuelParams(
        address token,
        uint256 total,
        uint256 fuel,
        IUniswapFuelSwap.PoolKey[] memory path,
        bool[] memory dirs,
        uint256 minOut,
        bool isPrivate
    ) internal view returns (SwapBridgeRouter.BridgeParams memory) {
        return SwapBridgeRouter.BridgeParams({
            tokenPortal: factory.predictPortal(token),
            bridgeToken: token,
            totalAmount: total,
            fuelAmount: fuel,
            aztecRecipient: RECIPIENT,
            fuelRecipient: FUEL_RECIPIENT,
            tokenSecretHash: SECRET,
            fuelSecretHash: SECRET,
            minFuelOutput: minOut,
            path: path,
            zeroForOnes: dirs,
            isPrivate: isPrivate
        });
    }

    function _route() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](1);
        p[0] = IUniswapFuelSwap.PoolKey(address(0), address(0), 3000, 60, address(0));
        d = new bool[](1);
        d[0] = true;
    }

    function _noRoute() internal pure returns (IUniswapFuelSwap.PoolKey[] memory p, bool[] memory d) {
        p = new IUniswapFuelSwap.PoolKey[](0);
        d = new bool[](0);
    }

    function _permit() internal returns (SwapBridgeRouter.PermitParams memory) {
        nonce += 1;
        return SwapBridgeRouter.PermitParams({nonce: nonce, deadline: type(uint256).max, signature: hex"00"});
    }
}
