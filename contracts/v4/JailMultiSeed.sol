// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JailSeed} from "./JailSeed.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

/// @notice Ethereum Multichain-only V4 seed contract.
/// @dev Uses the shared six-field inventory record, but cannot seed an Ethereum-only pool.
contract JailMultiSeed is JailSeed {
    error MultichainOnly();

    constructor(IPoolManager manager) JailSeed(manager) {}

    function seed(address, address) external pure override returns (bytes32) {
        revert MultichainOnly();
    }
}
