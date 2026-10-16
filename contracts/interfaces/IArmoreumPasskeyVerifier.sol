// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArmoreumPasskeyVerifier {
    function verify(
        bytes32 challenge,
        bytes calldata encodedAssertion,
        bytes32 expectedRpIdHash,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external view returns (bool);
}
