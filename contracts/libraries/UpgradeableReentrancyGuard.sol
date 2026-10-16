// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Stateless, namespaced reentrancy guard suitable for UUPS implementations.
/// The zero-initialized proxy slot is treated as NOT_ENTERED on its first call.
abstract contract UpgradeableReentrancyGuard {
    error ReentrantCall();

    bytes32 private constant REENTRANCY_GUARD_STORAGE =
        0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;
    uint256 private constant ENTERED = 2;

    modifier nonReentrant() {
        bytes32 slot = REENTRANCY_GUARD_STORAGE;
        uint256 status;
        assembly ("memory-safe") {
            status := sload(slot)
        }
        if (status == ENTERED) revert ReentrantCall();
        assembly ("memory-safe") {
            sstore(slot, ENTERED)
        }
        _;
        assembly ("memory-safe") {
            sstore(slot, 1)
        }
    }
}
