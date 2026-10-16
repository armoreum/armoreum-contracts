// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library AuthorizationHashChain {
    bytes32 internal constant EPOCH_LEAF_DOMAIN =
        0xe20e3cf5c060538b219cbc5443726159f6f4ba6949556cde43f0425a795d692e;

    function commitmentForProof(bytes32 proof) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(proof));
    }

    function epochLeaf(
        uint256 chainId,
        address vault,
        address creator,
        bytes32 launchId,
        uint32 epoch,
        bytes32 claimCommitment,
        bytes32 redemptionCommitment,
        bytes32 rotationCommitment,
        bytes32 recoveryCommitment
    ) internal pure returns (bytes32) {
        return sha256(
            abi.encodePacked(
                EPOCH_LEAF_DOMAIN,
                chainId,
                vault,
                creator,
                launchId,
                epoch,
                claimCommitment,
                redemptionCommitment,
                rotationCommitment,
                recoveryCommitment
            )
        );
    }

    function verifyMerkleProof(
        bytes32 leaf,
        bytes32[] calldata proof,
        bytes32 expectedRoot,
        uint256 expectedDepth
    ) internal pure returns (bool) {
        if (proof.length != expectedDepth) return false;
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? sha256(abi.encodePacked(computed, sibling))
                : sha256(abi.encodePacked(sibling, computed));
        }
        return computed == expectedRoot;
    }
}
