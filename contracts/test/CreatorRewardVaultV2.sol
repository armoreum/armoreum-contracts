// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreatorRewardVault} from "../CreatorRewardVault.sol";

/// @dev Test-only implementation used to verify storage-compatible UUPS upgrades.
contract CreatorRewardVaultV2 is CreatorRewardVault {
    /// @custom:oz-upgrades-validate-as-initializer
    function initializeV2() external reinitializer(2) {}

    function implementationVersionForTest() external pure returns (uint256) {
        return 2;
    }
}
