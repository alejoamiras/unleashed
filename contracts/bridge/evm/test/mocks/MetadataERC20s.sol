// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {ERC20} from "@oz/token/ERC20/ERC20.sol";
import {IPortalFactory} from "../../src/interfaces/IPortalFactory.sol";

/// Hostile and odd ERC-20 shapes the factory must classify correctly at `createPortal`.

/// MKR-style: `name()`/`symbol()` return a left-aligned bytes32, not a string.
contract Bytes32MetadataERC20 {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    // Selectors 0x06fdde03 / 0x95d89b41 answer with a raw word, as MKR does.
    fallback(bytes calldata data) external returns (bytes memory) {
        bytes4 sel = bytes4(data);
        if (sel == 0x06fdde03) return abi.encode(bytes32("Maker"));
        if (sel == 0x95d89b41) return abi.encode(bytes32("MKR"));
        revert("unknown");
    }
}

/// `name()` returns a dynamic-string HEAD (offset ‖ length) with no data word — 64 bytes claiming
/// 31 characters that are not there.
contract HeadlessStringERC20 {
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function symbol() external pure returns (string memory) {
        return "HEAD";
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        if (bytes4(data) == 0x06fdde03) return abi.encodePacked(uint256(0x20), uint256(31));
        revert("unknown");
    }
}

/// No `decimals()` at all.
contract NoDecimalsERC20 {
    function name() external pure returns (string memory) {
        return "NoDec";
    }

    function symbol() external pure returns (string memory) {
        return "ND";
    }
}

/// `decimals()` answers with a string (length ≠ 32) — must not read as 32 decimals.
contract StringDecimalsERC20 {
    function decimals() external pure returns (string memory) {
        return "18";
    }
}

/// `decimals()` answers 256 — does not fit a uint8.
contract HugeDecimalsERC20 {
    function decimals() external pure returns (uint256) {
        return 256;
    }
}

/// Any decimals in [0, 255], for the bound tests.
contract WeirdDecimalsERC20 is ERC20 {
    uint8 private immutable _d;

    constructor(uint8 d) ERC20("Weird", "WRD") {
        _d = d;
    }

    function decimals() public view override returns (uint8) {
        return _d;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A 100 KB `name()` — the read must stay bounded.
contract HugeNameERC20 is ERC20 {
    constructor() ERC20("", "HUGE") {}

    function name() public pure override returns (string memory) {
        return string(new bytes(100_000));
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// UTF-8 name — must sanitize to printable ASCII with `_` for every non-ASCII byte.
contract NonAsciiNameERC20 is ERC20 {
    constructor() ERC20(unicode"Nülo€", unicode"N€") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// `name()` tries to re-enter the factory. Under `staticcall` any state change reverts, so the
/// read must simply fail and the word default to empty.
contract ReentrantNameERC20 is ERC20 {
    IPortalFactory public factory;

    constructor() ERC20("", "REENT") {}

    function setFactory(IPortalFactory f) external {
        factory = f;
    }

    function name() public view override returns (string memory) {
        // A view function cannot call a non-view one directly; use a low-level call so the reentrancy
        // attempt actually reaches the factory (and reverts under STATICCALL).
        (bool ok,) = address(factory).staticcall(abi.encodeWithSelector(IPortalFactory.createPortal.selector, address(this)));
        return ok ? "reentered" : "blocked";
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Skims `taxBps` of every transfer.
contract FeeOnTransferERC20 is ERC20 {
    uint256 public immutable taxBps;

    constructor(uint256 taxBps_) ERC20("Taxed", "TAX") {
        taxBps = taxBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * taxBps) / 10_000;
            super._update(from, address(0xdead), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Charges the SENDER `surchargeBps` on top of every transfer: the recipient nets the full value,
/// so the deposit-side check passes and only the sender's own debit shows it.
contract SenderSurchargeERC20 is ERC20 {
    uint256 public immutable surchargeBps;

    constructor(uint256 surchargeBps_) ERC20("Surcharged", "SUR") {
        surchargeBps = surchargeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0xdead), (value * surchargeBps) / 10_000);
        }
        super._update(from, to, value);
    }
}

/// A plain 18-decimal token with a public mint, for the happy paths.
contract PlainERC20 is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
