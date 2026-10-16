// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library AddressPrefix {
    error RequiredAddressPrefix6900(address account);

    /// @dev These IDs are reserved by this repository's local-only EVM stack.
    ///      Callers apply the prefix rule only to designated core contracts.
    function isLocalChain() internal view returns (bool) {
        return block.chainid == 31337 || block.chainid == 46630;
    }

    function has6900(address account) internal pure returns (bool) {
        return uint160(account) >> 144 == 0x6900;
    }

    function require6900(address account) internal view {
        if (isLocalChain()) return;
        if (!has6900(account)) revert RequiredAddressPrefix6900(account);
    }
}
