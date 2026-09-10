// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {CityVault} from "../CityVault.sol";

/// @notice Test-only harness for reaching the final global upgrade slot without
///         executing all 1,120 captures needed by the production state machine.
contract CityVaultHarness is CityVault {
    constructor(
        address taxToken_,
        address creator_,
        address treasury_,
        uint256 dispatchThreshold_,
        uint64 legacyCaptureDelay_
    ) CityVault(
        taxToken_,
        creator_,
        treasury_,
        dispatchThreshold_,
        legacyCaptureDelay_
    ) {}

    function setRemainingUpgradeSlotsForTest(uint16 slots) external {
        remainingUpgradeSlots = slots;
    }
}
