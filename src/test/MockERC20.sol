// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Test-only 18-decimal token with unrestricted minting.
contract MockERC20 is ERC20, ERC20Burnable {
    constructor() ERC20("Mock City Token", "MCT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
