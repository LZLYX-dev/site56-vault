// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Malicious test token that calls arbitrary vault calldata while the
///         vault is paying a previous owner. The failed callback is swallowed so
///         the outer capture can prove both reentrancy isolation and liveness.
contract ReentrantERC20 is ERC20 {
    address public hookVault;
    address public hookRecipient;
    bytes public hookCalldata;
    bool public attackEnabled;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    bytes public reentryReturnData;

    constructor() ERC20("Reentrant City Token", "RCT") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function configureHook(
        address vault,
        address recipient,
        bytes calldata callData
    ) external {
        hookVault = vault;
        hookRecipient = recipient;
        hookCalldata = callData;
        attackEnabled = true;
        reentryAttempted = false;
        reentrySucceeded = false;
        delete reentryReturnData;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool success = super.transfer(to, amount);

        if (attackEnabled && msg.sender == hookVault && to == hookRecipient) {
            attackEnabled = false;
            reentryAttempted = true;
            bytes memory returnData;
            (reentrySucceeded, returnData) = hookVault.call(hookCalldata);
            reentryReturnData = returnData;
        }

        return success;
    }
}
