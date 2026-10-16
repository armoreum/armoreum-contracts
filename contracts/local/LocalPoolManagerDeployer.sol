// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";

/// @notice Deploys the unmodified Uniswap V4 core PoolManager for local tests.
/// @dev The helper is local-only. The deployed PoolManager is the upstream core
///      implementation; this helper does not add hooks, liquidity, or routers.
contract LocalPoolManagerDeployer {
    error LocalEthereumOnly();
    error InvalidOwner();
    error AlreadyDeployed();

    address public poolManager;

    event PoolManagerDeployed(address indexed poolManager, address indexed owner);

    function deploy(address initialOwner) external returns (address deployed) {
        if (block.chainid != 31337) revert LocalEthereumOnly();
        if (initialOwner == address(0)) revert InvalidOwner();
        if (poolManager != address(0)) revert AlreadyDeployed();

        deployed = address(new PoolManager(initialOwner));
        poolManager = deployed;
        emit PoolManagerDeployed(deployed, initialOwner);
    }
}
