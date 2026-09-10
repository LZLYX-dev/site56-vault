// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ICompensationOracle} from "../ICompensationOracle.sol";

/// @title TestnetCompensationOracle
/// @notice TESTNET ONLY: manually operated quote source for public BSC Testnet exercises.
/// @dev This is not a production price oracle. It deliberately returns one operator-set
///      quote regardless of token or amount so end-to-end testnet flows remain deterministic.
contract TestnetCompensationOracle is ICompensationOracle {
    address public immutable operator;
    uint256 public nativeQuote;
    bool public valid;

    error ZeroOperator();
    error OnlyOperator(address caller);

    event QuoteUpdated(address indexed operator, uint256 nativeQuote, bool valid);

    constructor(address operator_) {
        if (operator_ == address(0)) revert ZeroOperator();
        operator = operator_;
    }

    /// @notice Sets the public-testnet quote and validity flag.
    /// @dev Only the immutable operator can mutate the quote.
    function setQuote(uint256 nativeQuote_, bool valid_) external {
        if (msg.sender != operator) revert OnlyOperator(msg.sender);
        nativeQuote = nativeQuote_;
        valid = valid_;
        emit QuoteUpdated(msg.sender, nativeQuote_, valid_);
    }

    /// @inheritdoc ICompensationOracle
    function quoteTokenToNative(address, uint256)
        external
        view
        override
        returns (uint256 nativeAmount, bool isValid)
    {
        return (nativeQuote, valid);
    }
}
