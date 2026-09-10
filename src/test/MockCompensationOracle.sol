// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @notice Test oracle that returns a caller-configured native-asset quote.
/// @dev The quote is intentionally independent of tokenAmount so boundary tests
///      can exercise an empty, partially funded, or fully funded compensation pool.
contract MockCompensationOracle {
    uint256 public nativeQuote;
    bool public valid;

    function setQuote(uint256 nativeQuote_, bool valid_) external {
        nativeQuote = nativeQuote_;
        valid = valid_;
    }

    function quoteTokenToNative(address, uint256) external view returns (uint256 nativeAmount, bool isValid) {
        return (nativeQuote, valid);
    }
}
