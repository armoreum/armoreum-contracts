// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArmoreumPasskeyVerifier} from "../interfaces/IArmoreumPasskeyVerifier.sol";

/// @dev Test-only authorization stub. Never approve or deploy this as production code.
contract MockPasskeyVerifier is IArmoreumPasskeyVerifier {
    function verify(
        bytes32 challenge,
        bytes calldata encodedAssertion,
        bytes32,
        bytes32,
        bytes32
    ) external pure returns (bool) {
        if (encodedAssertion.length != 32) return false;
        return abi.decode(encodedAssertion, (bytes32)) == challenge;
    }
}
