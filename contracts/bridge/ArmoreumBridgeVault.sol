// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IBuybackTaxRouterView {
    function launchId() external view returns (bytes32);
    function launchToken() external view returns (address);
    function taxSource() external view returns (address);
    function buybackExecutor() external view returns (address);
    function bridgeVault() external view returns (address);
    function taxDistributionMode() external view returns (uint8);
}

interface IBuybackV4HookView {
    function poolManager() external view returns (address);
    function launchToken() external view returns (address);
}

interface IPonsV2BuybackHookView {
    function poolManager() external view returns (address);
    function feeEscrow() external view returns (address);
}

/// @notice Holds each launch's 20% ETH buyback share and buys that launch token at threshold.
contract ArmoreumBridgeVault is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    uint256 public constant BUYBACK_THRESHOLD = 0.0025 ether;
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;

    error InvalidConfiguration();
    error UnauthorizedFactory();
    error UnauthorizedTaxRouter();
    error UnauthorizedUnlockCallback();
    error UnauthorizedSelfCall();
    error BuybackBelowThreshold();
    error InvalidSwapDelta();
    error BuybackInputTooLarge();
    error DirectEthDepositDisabled();
    error DepositRequired();
    error UnauthorizedEmergencyOperator();
    error InvalidEmergencyAsset();

    event BuybackEthDeposited(uint256 amount, uint256 accruedBalance);
    event BuybackExecuted(uint256 ethSpent, uint256 tokensBought);
    event BuybackDeferred(uint256 accruedBalance, bytes32 reasonHash);
    event TaxRouterRegistered(address indexed taxRouter);
    event EmergencyOperatorChanged(address indexed previousOperator, address indexed newOperator);
    event JailbreakExecuted(
        address indexed vault,
        address indexed asset,
        address indexed destination,
        uint256 amount,
        address caller,
        uint256 cancelledPendingBuyback
    );

    bytes32 public immutable launchId;
    address public immutable launchToken;
    address public immutable admin;
    address public immutable launchFactory;
    IPoolManager public immutable poolManager;
    PoolKey private poolKey;
    uint160 public immutable sqrtPriceLimitX96;

    address public taxRouter;
    address public emergencyOperator;
    uint256 public buybackEthAccrued;
    uint256 public totalBuybackEthReceived;
    uint256 public totalBuybackEthSpent;
    uint256 public totalBuybackTokens;
    uint256 public totalJailbreakEthWithdrawn;
    uint256 public totalJailbreakPendingBuybackCancelled;
    uint256 public totalJailbreakTokensWithdrawn;
    bool private executingBuyback;

    constructor(
        IPoolManager poolManager_,
        bytes32 launchId_,
        address launchToken_,
        address admin_,
        address emergencyOperator_,
        address launchFactory_,
        PoolKey memory poolKey_,
        uint160 sqrtPriceLimitX96_
    ) {
        bool supportedHook;
        address hookAddress = address(poolKey_.hooks);
        if (hookAddress.code.length != 0) {
            try IBuybackV4HookView(address(poolKey_.hooks)).poolManager()
                returns (address hookPoolManager)
            {
                if (hookPoolManager == address(poolManager_)) {
                    try IBuybackV4HookView(hookAddress).launchToken()
                        returns (address hookLaunchToken)
                    {
                        supportedHook = hookLaunchToken == launchToken_;
                    } catch {
                        try IPonsV2BuybackHookView(hookAddress).feeEscrow()
                            returns (address escrow)
                        {
                            supportedHook = escrow.code.length != 0;
                        } catch {}
                    }
                }
            } catch {}
        }
        if (
            address(poolManager_).code.length == 0 || launchId_ == bytes32(0)
                || launchToken_.code.length == 0 || admin_ == address(0)
                || emergencyOperator_ == address(0)
                || launchFactory_.code.length == 0
                || Currency.unwrap(poolKey_.currency0) != address(0)
                || Currency.unwrap(poolKey_.currency1) != launchToken_
                || !supportedHook
                || sqrtPriceLimitX96_ < MIN_SQRT_PRICE_PLUS_ONE
        ) revert InvalidConfiguration();

        poolManager = poolManager_;
        launchId = launchId_;
        launchToken = launchToken_;
        admin = admin_;
        emergencyOperator = emergencyOperator_;
        launchFactory = launchFactory_;
        poolKey = poolKey_;
        sqrtPriceLimitX96 = sqrtPriceLimitX96_;
    }

    receive() external payable {
        revert DirectEthDepositDisabled();
    }

    /// @notice Binds the one factory-created router after its initialization.
    function registerTaxRouter(address taxRouter_) external {
        if (msg.sender != launchFactory) revert UnauthorizedFactory();
        if (taxRouter != address(0) || taxRouter_.code.length == 0) {
            revert InvalidConfiguration();
        }
        IBuybackTaxRouterView router = IBuybackTaxRouterView(taxRouter_);
        if (
            router.launchId() != launchId || router.launchToken() != launchToken
                || router.taxSource() != address(poolKey.hooks)
                || router.buybackExecutor() != address(this)
                || router.bridgeVault() != address(this)
                || (
                    router.taxDistributionMode() != 1
                        && router.taxDistributionMode() != 3
                )
        ) revert InvalidConfiguration();

        taxRouter = taxRouter_;
        emit TaxRouterRegistered(taxRouter_);
    }

    /// @notice Records this deposit and attempts a buyback immediately if it crosses the threshold.
    function depositBuybackEth() external payable returns (uint256 tokensBought) {
        if (msg.sender != taxRouter || taxRouter == address(0)) {
            revert UnauthorizedTaxRouter();
        }
        if (msg.value == 0) return 0;
        buybackEthAccrued += msg.value;
        totalBuybackEthReceived += msg.value;
        tokensBought = _tryBuyback();
        emit BuybackEthDeposited(msg.value, buybackEthAccrued);
    }

    /// @notice Permissionless retry for threshold-ready ETH after a pool or swap failure.
    function executePendingBuyback() external returns (uint256) {
        if (buybackEthAccrued < BUYBACK_THRESHOLD) revert BuybackBelowThreshold();
        return _tryBuyback();
    }

    function setEmergencyOperator(address emergencyOperator_) external {
        if (msg.sender != admin) revert UnauthorizedEmergencyOperator();
        if (emergencyOperator_ == address(0)) revert InvalidConfiguration();
        address previousOperator = emergencyOperator;
        emergencyOperator = emergencyOperator_;
        emit EmergencyOperatorChanged(previousOperator, emergencyOperator_);
    }

    /// @notice Emergency override; the operator is separately configurable, while the recipient stays fixed.
    /// @dev Native withdrawals cancel the pending buyback liability before transferring all ETH.
    function jailbreak(address asset) external returns (uint256 amount) {
        if (msg.sender != emergencyOperator) revert UnauthorizedEmergencyOperator();
        uint256 cancelledPendingBuyback;
        if (asset == address(0)) {
            cancelledPendingBuyback = buybackEthAccrued;
            buybackEthAccrued = 0;
            amount = address(this).balance;
            (bool success,) = payable(admin).call{value: amount}("");
            if (!success) revert InvalidConfiguration();
            totalJailbreakEthWithdrawn += amount;
            totalJailbreakPendingBuybackCancelled += cancelledPendingBuyback;
        } else {
            if (asset == address(this) || asset.code.length == 0) {
                revert InvalidEmergencyAsset();
            }
            amount = IERC20(asset).balanceOf(address(this));
            if (amount != 0) SafeERC20.safeTransfer(IERC20(asset), admin, amount);
            totalJailbreakTokensWithdrawn += amount;
        }
        emit JailbreakExecuted(
            address(this),
            asset,
            admin,
            amount,
            msg.sender,
            cancelledPendingBuyback
        );
    }

    /// @dev The PoolManager calls this only when this vault opened a new unlock session.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnauthorizedUnlockCallback();
        uint256 amountIn = abi.decode(data, (uint256));
        return abi.encode(_swapForLaunchToken(amountIn));
    }

    function _tryBuyback() private returns (uint256 tokensBought) {
        uint256 amountIn = buybackEthAccrued;
        if (amountIn < BUYBACK_THRESHOLD || executingBuyback) return 0;

        buybackEthAccrued = 0;
        executingBuyback = true;
        try this.executeBuyback{value: amountIn}(amountIn) returns (uint256 bought) {
            tokensBought = bought;
            totalBuybackEthSpent += amountIn;
            totalBuybackTokens += bought;
            emit BuybackExecuted(amountIn, bought);
        } catch (bytes memory reason) {
            buybackEthAccrued = amountIn;
            emit BuybackDeferred(amountIn, keccak256(reason));
        }
        executingBuyback = false;
    }

    /// @dev Isolated in a self-call so a failed swap leaves ETH accrued without reverting a trade.
    function executeBuyback(uint256 amountIn) external payable returns (uint256 tokensBought) {
        if (msg.sender != address(this)) revert UnauthorizedSelfCall();
        if (msg.value != amountIn || amountIn < BUYBACK_THRESHOLD) {
            revert BuybackBelowThreshold();
        }
        if (amountIn > uint256(uint128(type(int128).max))) revert BuybackInputTooLarge();

        if (poolManager.isUnlocked()) return _swapForLaunchToken(amountIn);
        return abi.decode(poolManager.unlock(abi.encode(amountIn)), (uint256));
    }

    function _swapForLaunchToken(uint256 amountIn) private returns (uint256 tokensBought) {
        PoolKey memory key = poolKey;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: sqrtPriceLimitX96
            }),
            bytes("")
        );

        int128 ethDelta = delta.amount0();
        int128 tokenDelta = delta.amount1();
        if (ethDelta >= 0 || tokenDelta <= 0) revert InvalidSwapDelta();
        uint256 ethSpent = uint256(uint128(-ethDelta));
        if (ethSpent != amountIn) revert InvalidSwapDelta();
        tokensBought = uint256(uint128(tokenDelta));

        poolManager.settle{value: amountIn}();
        poolManager.take(key.currency1, address(this), tokensBought);
    }
}
