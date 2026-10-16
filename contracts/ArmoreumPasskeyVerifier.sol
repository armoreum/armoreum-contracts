// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IArmoreumPasskeyVerifier} from "./interfaces/IArmoreumPasskeyVerifier.sol";

/// @notice Immutable, stateless WebAuthn/P-256 assertion verifier.
/// @dev RP ID hash is checked here; the relying-party server must also verify
/// the exact expected origin during the WebAuthn ceremony.
contract ArmoreumPasskeyVerifier is IArmoreumPasskeyVerifier {
    function verify(
        bytes32 challenge,
        bytes calldata encodedAssertion,
        bytes32 expectedRpIdHash,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) external view returns (bool) {
        if (expectedRpIdHash == bytes32(0) || publicKeyX == bytes32(0) || publicKeyY == bytes32(0)) {
            return false;
        }

        (bool decoded, WebAuthn.WebAuthnAuth calldata assertion) =
            WebAuthn.tryDecodeAuth(encodedAssertion);
        if (!decoded) return false;

        if (assertion.authenticatorData.length < 37) {
            return false;
        }

        bytes32 observedRpIdHash;
        bytes memory authenticatorData = assertion.authenticatorData;
        assembly ("memory-safe") {
            observedRpIdHash := mload(add(authenticatorData, 0x20))
        }
        if (observedRpIdHash != expectedRpIdHash) {
            return false;
        }

        return WebAuthn.verify(
            abi.encodePacked(challenge),
            assertion,
            publicKeyX,
            publicKeyY,
            true
        );
    }
}
