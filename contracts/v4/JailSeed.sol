// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {ArmoreumV4TaxHook} from "./ArmoreumV4TaxHook.sol";
import {TaxRouter} from "../TaxRouter.sol";

/// @notice Ownerless, token-only V4 launch liquidity. No ETH seed or withdrawal function.
/// @dev Principal and rounding dust are permanently committed. Pool LP fees are separate from swap taxes.
contract JailSeed is IUnlockCallback {
    using SafeERC20 for IERC20;
    using BalanceDeltaLibrary for BalanceDelta;
    using PoolIdLibrary for PoolKey;

    uint256 public constant FIXED_SUPPLY = 1_000_000_000 ether;
    uint24 public constant POOL_FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    uint256 private constant Q96 = 1 << 96;
    IPoolManager public immutable poolManager;
    error InvalidConfiguration();
    error UnauthorizedCallback();
    event PoolSeeded(address indexed token, address indexed creator, address indexed hook,
        bytes32 poolId, uint160 sqrtPriceX96, uint128 liquidity, uint256 tokenDeposited, uint256 roundingDust);
    event RoundingDustDonated(address indexed token, uint256 amount);

    struct Seed {
        address creator;
        address hook;
        uint128 liquidity;
        uint256 roundingDust;
        uint256 tokenInventory;
        uint256 bridgeReserve;
    }
    mapping(address token => Seed) public seeds;

    constructor(IPoolManager manager) {
        if (block.chainid != 1 || address(manager).code.length == 0) revert InvalidConfiguration();
        poolManager = manager;
    }

    /// @notice Tick-aligned opening price nearest the nominal 0.017 ETH per 10m tokens.
    /// @dev Native ETH is currency0; all currency1 inventory is above the range's upper boundary.
    ///      A buy moves price down into the range; ETH from buys subsequently backs sells.
    function openingPrice() public pure returns (int24 lower, int24 upper, uint160 sqrtPriceX96) {
        uint160 target = uint160(Math.sqrt(FullMath.mulDiv(10_000_000 ether, 1 << 192, 0.017 ether)));
        upper = (TickMath.getTickAtSqrtPrice(target) / TICK_SPACING) * TICK_SPACING;
        lower = TickMath.minUsableTick(TICK_SPACING);
        sqrtPriceX96 = TickMath.getSqrtPriceAtTick(upper);
    }

    function poolKey(address token, address hook) public pure returns (PoolKey memory) {
        return PoolKey(Currency.wrap(address(0)), Currency.wrap(token), POOL_FEE, TICK_SPACING, IHooks(hook));
    }

    function seed(address token, address hookAddress) external virtual returns (bytes32 poolId) {
        ArmoreumV4TaxHook hook = ArmoreumV4TaxHook(payable(hookAddress));
        if (
            address(hook.poolManager()) != address(poolManager) || hook.launchToken() != token
                || hook.jailSeed() != address(this) || hook.admin() != address(0)
                || address(hook.taxRouter()) == address(0)
        ) revert InvalidConfiguration();
        TaxRouter router = hook.taxRouter();
        if (router.creator() != msg.sender || router.taxDistributionMode() != TaxRouter.TaxDistributionMode.CreatorOnly) {
            revert InvalidConfiguration();
        }
        PoolKey memory key = poolKey(token, hookAddress);
        poolId = PoolId.unwrap(key.toId());
        Seed storage record = seeds[token];
        if (record.hook != address(0)) {
            if (
                record.creator != msg.sender || record.hook != hookAddress
                    || record.bridgeReserve != 0 || record.tokenInventory != FIXED_SUPPLY
            ) revert InvalidConfiguration();
            return poolId;
        }
        if (IERC20(token).totalSupply() != FIXED_SUPPLY) revert InvalidConfiguration();
        record.creator = msg.sender;
        record.hook = hookAddress;
        record.tokenInventory = FIXED_SUPPLY;
        IERC20(token).safeTransferFrom(msg.sender, address(this), FIXED_SUPPLY);
        (int24 lower,, uint160 sqrtPrice) = openingPrice();
        uint256 liquidity = FullMath.mulDiv(FIXED_SUPPLY, Q96, sqrtPrice - TickMath.getSqrtPriceAtTick(lower));
        if (liquidity == 0 || liquidity > uint128(type(int128).max)) revert InvalidConfiguration();
        record.liquidity = uint128(liquidity);
        poolManager.initialize(key, sqrtPrice);
        uint256 deposited = abi.decode(poolManager.unlock(abi.encode(token, false)), (uint256));
        record.roundingDust = FIXED_SUPPLY - deposited;
        emit PoolSeeded(token, msg.sender, hookAddress, poolId, sqrtPrice, uint128(liquidity), deposited, record.roundingDust);
    }

    /// @notice Seeds only the non-bridge inventory for an Ethereum Multichain launch.
    /// @dev The creator transfers the separately-accounted bridge reserve to its vault first.
    function seedMultichain(
        address token,
        address hookAddress,
        address bridgeVault,
        uint256 bridgeReserve
    ) external returns (bytes32 poolId) {
        ArmoreumV4TaxHook hook = ArmoreumV4TaxHook(payable(hookAddress));
        if (
            address(hook.poolManager()) != address(poolManager) || hook.launchToken() != token
                || hook.jailSeed() != address(this) || hook.admin() != address(0)
                || address(hook.taxRouter()) == address(0) || bridgeVault.code.length == 0
                || bridgeReserve == 0 || bridgeReserve >= FIXED_SUPPLY
        ) revert InvalidConfiguration();
        TaxRouter router = hook.taxRouter();
        if (
            router.creator() != msg.sender
                || router.taxDistributionMode() != TaxRouter.TaxDistributionMode.Creator80Buyback20
                || router.bridgeVault() != bridgeVault || router.buybackExecutor() != bridgeVault
        ) revert InvalidConfiguration();

        PoolKey memory key = poolKey(token, hookAddress);
        poolId = PoolId.unwrap(key.toId());
        Seed storage record = seeds[token];
        if (record.hook != address(0)) {
            if (
                record.creator != msg.sender || record.hook != hookAddress
                    || record.bridgeReserve != bridgeReserve
                    || record.tokenInventory != FIXED_SUPPLY - bridgeReserve
            ) revert InvalidConfiguration();
            return poolId;
        }

        uint256 poolInventory = FIXED_SUPPLY - bridgeReserve;
        if (
            IERC20(token).totalSupply() != FIXED_SUPPLY
                || IERC20(token).balanceOf(msg.sender) < poolInventory
                || IERC20(token).balanceOf(bridgeVault) < bridgeReserve
        ) revert InvalidConfiguration();
        record.creator = msg.sender;
        record.hook = hookAddress;
        record.tokenInventory = poolInventory;
        record.bridgeReserve = bridgeReserve;
        IERC20(token).safeTransferFrom(msg.sender, address(this), poolInventory);
        (int24 lower,, uint160 sqrtPrice) = openingPrice();
        uint256 liquidity = FullMath.mulDiv(
            poolInventory,
            Q96,
            sqrtPrice - TickMath.getSqrtPriceAtTick(lower)
        );
        if (liquidity == 0 || liquidity > uint128(type(int128).max)) revert InvalidConfiguration();
        record.liquidity = uint128(liquidity);
        poolManager.initialize(key, sqrtPrice);
        uint256 deposited = abi.decode(poolManager.unlock(abi.encode(token, false)), (uint256));
        record.roundingDust = poolInventory - deposited;
        emit PoolSeeded(
            token,
            msg.sender,
            hookAddress,
            poolId,
            sqrtPrice,
            uint128(liquidity),
            deposited,
            record.roundingDust
        );
    }

    /// @notice Sends integer rounding dust to the pool after the first buy activates liquidity.
    /// @dev Permissionless; no token can be withdrawn to an EOA. Reverts if the pool isn't active yet.
    function donateRoundingDust(address token) external {
        if (seeds[token].roundingDust == 0) revert InvalidConfiguration();
        poolManager.unlock(abi.encode(token, true));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnauthorizedCallback();
        (address token, bool donateDust) = abi.decode(data, (address, bool));
        Seed storage record = seeds[token];
        if (record.hook == address(0)) revert InvalidConfiguration();
        PoolKey memory key = poolKey(token, record.hook);
        BalanceDelta delta;
        if (donateDust) {
            uint256 dust = record.roundingDust;
            record.roundingDust = 0;
            delta = poolManager.donate(key, 0, dust, "");
            emit RoundingDustDonated(token, dust);
        } else {
            (int24 lower, int24 upper,) = openingPrice();
            (delta,) = poolManager.modifyLiquidity(key, ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(record.liquidity)),
                salt: bytes32(0)
            }), "");
        }
        // A token-only position must never demand an ETH seed or leave unsettled pool debt.
        if (delta.amount0() != 0 || delta.amount1() >= 0) revert InvalidConfiguration();
        uint256 owed = uint256(-int256(delta.amount1()));
        poolManager.sync(Currency.wrap(token));
        IERC20(token).safeTransfer(address(poolManager), owed);
        if (poolManager.settle() != owed) revert InvalidConfiguration();
        return abi.encode(owed);
    }
}
