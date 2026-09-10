// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @title ICompensationOracle
/// @notice Minimal fail-closed oracle interface used by the CityVault testnet draft.
/// @dev Implementations are responsible for TWAP freshness, liquidity and deviation
///      checks. Returning `valid == false` must be treated exactly like a zero quote.
interface ICompensationOracle {
    /// @notice Quotes a tax-token amount in native BNB wei.
    /// @param token The tax token being quoted.
    /// @param tokenAmount The token amount, using the token's native decimals.
    /// @return nativeAmount The conservative native-BNB quote in wei.
    /// @return valid Whether the quote passed every oracle validity check.
    function quoteTokenToNative(address token, uint256 tokenAmount)
        external
        view
        returns (uint256 nativeAmount, bool valid);
}
