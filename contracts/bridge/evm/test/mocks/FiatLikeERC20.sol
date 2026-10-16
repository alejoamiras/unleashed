// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.27;

import {ERC20} from "@oz/token/ERC20/ERC20.sol";

/// FiatToken (USDC) allowance semantics: `transferFrom` decrements every allowance, `type(uint256).max` included,
/// where OpenZeppelin treats a max allowance as infinite.
contract FiatLikeERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 decimals_) ERC20("FiatLike", "FIAT") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _spendAllowance(address owner, address spender, uint256 value) internal override {
        uint256 current = allowance(owner, spender);
        if (current < value) revert ERC20InsufficientAllowance(spender, current, value);
        unchecked {
            _approve(owner, spender, current - value, false);
        }
    }
}
