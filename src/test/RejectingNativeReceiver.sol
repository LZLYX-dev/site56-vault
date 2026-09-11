// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICityVaultTestTarget {
    function claimCity(uint8 cityId, uint256 payment) external;
    function captureCity(uint8 cityId, uint256 maxPayment, uint256 deadline, uint256 minCompOut) external;
    function claimRevenue() external;
}

/// @notice Test actor proving revenue is pull-based and receiver failures cannot
///         block capture or settlement for other city owners.
contract RejectingNativeReceiver {
    error NativeRejected();

    receive() external payable {
        revert NativeRejected();
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    function claimCity(address vault, uint8 cityId) external {
        ICityVaultTestTarget(vault).claimCity(cityId, 560_000 ether);
    }

    function captureCity(
        address vault,
        uint8 cityId,
        uint256 maxPayment,
        uint256 deadline,
        uint256 minCompOut
    ) external {
        ICityVaultTestTarget(vault).captureCity(cityId, maxPayment, deadline, minCompOut);
    }

    function claimRevenue(address vault) external {
        ICityVaultTestTarget(vault).claimRevenue();
    }
}
