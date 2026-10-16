// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

/// @dev Thin local-only wrappers that compile the upstream V4 test routers
///      into artifacts for end-to-end PoolManager tests.
contract LocalV4SwapHarness is PoolSwapTest {
    constructor(IPoolManager manager) PoolSwapTest(manager) {}
}

contract LocalV4LiquidityHarness is PoolModifyLiquidityTest {
    constructor(IPoolManager manager) PoolModifyLiquidityTest(manager) {}
}
