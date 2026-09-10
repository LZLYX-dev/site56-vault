// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-only token that burns 1% of every ordinary transfer.
/// @dev CityVault must reject it because an exact city payment would leave the
///      vault with fewer tokens than its accounting assumes.
contract FeeOnTransferERC20 is ERC20 {
    uint256 private constant FEE_BPS = 100;
    uint256 private constant BPS_DENOMINATOR = 10_000;

    constructor() ERC20("Fee-on-transfer City Token", "FCT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || amount == 0) {
            super._update(from, to, amount);
            return;
        }

        uint256 fee = (amount * FEE_BPS) / BPS_DENOMINATOR;
        super._update(from, address(0), fee);
        super._update(from, to, amount - fee);
    }
}
