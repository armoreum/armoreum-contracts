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
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

interface IMultichainTaxRouterIdentity {
    function launchId() external view returns (bytes32);
    function creator() external view returns (address);
    function launchToken() external view returns (address);
    function taxSource() external view returns (address);
    function buybackExecutor() external view returns (address);
    function bridgeVault() external view returns (address);
    function taxDistributionMode() external view returns (uint8);
}

interface IPonsV2CurveBuy {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        returns (uint256 tokensOut);
}

interface ILockReleaseBridgeIdentity {
    function launchId() external view returns (bytes32);
    function localToken() external view returns (IERC20);
    function maxBridgeAmount() external view returns (uint256);
}

/// @notice Per-launch custody for Multichain bridge inventory and tax-funded buybacks.
/// @dev The initial bridge allocation is accounted separately from tokens bought back later.
contract ArmoreumMultichainVault is Initializable, IUnlockCallback {
    using TransientStateLibrary for IPoolManager;
    using SafeERC20 for IERC20;

    uint256 public constant BUYBACK_THRESHOLD = 0.0025 ether;
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;
    uint8 public constant TAX_DISTRIBUTION_MULTICHAIN_ETHEREUM = 1;
    uint8 public constant TAX_DISTRIBUTION_MULTICHAIN_PONS = 3;

    uint8 private constant MARKET_UNBOUND = 0;
    uint8 private constant MARKET_PONS_CURVE = 1;
    uint8 private constant MARKET_UNISWAP_V4 = 2;

    error InvalidConfiguration();
    error UnauthorizedFactory();
    error UnauthorizedTaxRouter();
    error UnauthorizedUnlockCallback();
    error UnauthorizedSelfCall();
    error BuybackBelowThreshold();
    error InvalidSwapDelta();
    error BuybackInputTooLarge();
    error BridgeAlreadyBound();
    error InsufficientBridgeReserve();
    error InvalidBridge();
    error UnsupportedMarket();

    event TaxRouterRegistered(address indexed taxRouter);
    event LaunchBound(
        address indexed token,
        uint8 indexed market,
        address curve,
        uint256 bridgeReserve
    );
    event BridgeInventoryTransferred(
        address indexed bridge,
        uint256 amount,
        uint256 remainingReserve
    );
    event BuybackEthDeposited(uint256 amount, uint256 accruedBalance);
    event BuybackExecuted(uint256 ethSpent, uint256 tokensBought, uint8 market);
    event BuybackDeferred(uint256 accruedBalance, bytes32 reasonHash);

    bytes32 public launchId;
    address public creator;
    address public launchFactory;
    address public canonicalOwner;

    address public taxRouter;
    address public launchToken;
    address public ponsCurve;
    address public bridge;
    uint8 public market;

    uint256 public initialBridgeReserve;
    uint256 public bridgeInventoryTransferred;
    uint256 public buybackEthAccrued;
    uint256 public totalBuybackEthReceived;
    uint256 public totalBuybackEthSpent;
    uint256 public totalBuybackTokens;

    IPoolManager public poolManager;
    PoolKey private poolKey;
    uint160 public sqrtPriceLimitX96;
    bool private executingBuyback;
    // Appended for proxy storage compatibility. Existing Pons/Ethereum-only vault layouts are unchanged.
    uint8 public taxDistributionMode;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        bytes32 launchId_,
        address creator_,
        address launchFactory_,
        address canonicalOwner_
    ) external initializer {
        if (
            launchId_ == bytes32(0) || creator_ == address(0)
                || launchFactory_.code.length == 0 || canonicalOwner_ == address(0)
        ) revert InvalidConfiguration();
        launchId = launchId_;
        creator = creator_;
        launchFactory = launchFactory_;
        canonicalOwner = canonicalOwner_;
    }

    modifier onlyLaunchFactory() {
        if (msg.sender != launchFactory) revert UnauthorizedFactory();
        _;
    }

    /// @notice Registers the fee router while the token address is still unknown.
    function registerTaxRouter(address taxRouter_) external onlyLaunchFactory {
        if (taxRouter != address(0) || taxRouter_.code.length == 0) {
            revert InvalidConfiguration();
        }
        IMultichainTaxRouterIdentity router =
            IMultichainTaxRouterIdentity(taxRouter_);
        uint8 routerDistributionMode = router.taxDistributionMode();
        if (
            router.launchId() != launchId || router.creator() != creator
                || router.launchToken() != address(0)
                || router.buybackExecutor() != address(this)
                || router.bridgeVault() != address(this)
                || (
                    routerDistributionMode != TAX_DISTRIBUTION_MULTICHAIN_ETHEREUM
                        && routerDistributionMode != TAX_DISTRIBUTION_MULTICHAIN_PONS
                )
        ) revert InvalidConfiguration();
        taxDistributionMode = routerDistributionMode;
        taxRouter = taxRouter_;
        emit TaxRouterRegistered(taxRouter_);
    }

    /// @notice Binds the Robinhood Pons curve after atomic launch-and-buy confirms.
    /// @dev The measured token balance is the reserve; it is never a Creator Vault asset.
    function bindPonsLaunch(address token_, address curve_, uint256 reserveAmount)
        external
        onlyLaunchFactory
    {
        if (
            launchToken != address(0) || token_.code.length == 0
                || curve_.code.length == 0 || reserveAmount == 0
                || taxDistributionMode != TAX_DISTRIBUTION_MULTICHAIN_PONS
                || IERC20(token_).balanceOf(address(this)) < reserveAmount
        ) revert InvalidConfiguration();
        launchToken = token_;
        ponsCurve = curve_;
        initialBridgeReserve = reserveAmount;
        market = MARKET_PONS_CURVE;
        emit LaunchBound(token_, MARKET_PONS_CURVE, curve_, reserveAmount);
    }

    /// @notice Binds an Ethereum V4 pool after token deployment and pool initialization.
    function bindEthereumLaunch(
        address token_,
        uint256 reserveAmount,
        IPoolManager poolManager_,
        PoolKey calldata poolKey_,
        uint160 sqrtPriceLimitX96_
    ) external onlyLaunchFactory {
        if (
            launchToken != address(0) || token_.code.length == 0 || reserveAmount == 0
                || taxDistributionMode != TAX_DISTRIBUTION_MULTICHAIN_ETHEREUM
                || IERC20(token_).balanceOf(address(this)) < reserveAmount
                || address(poolManager_).code.length == 0
                || Currency.unwrap(poolKey_.currency0) != address(0)
                || Currency.unwrap(poolKey_.currency1) != token_
                || address(poolKey_.hooks).code.length == 0
                || sqrtPriceLimitX96_ < MIN_SQRT_PRICE_PLUS_ONE
        ) revert InvalidConfiguration();
        launchToken = token_;
        initialBridgeReserve = reserveAmount;
        poolManager = poolManager_;
        poolKey = poolKey_;
        sqrtPriceLimitX96 = sqrtPriceLimitX96_;
        market = MARKET_UNISWAP_V4;
        emit LaunchBound(token_, MARKET_UNISWAP_V4, address(0), reserveAmount);
    }

    /// @notice Transfers only the configured launch reserve into its paired lock/release OApp.
    /// @dev Any buyback tokens held by this vault are excluded from the initial bridge allocation.
    function transferBridgeInventory(address bridge_, uint256 amount) external {
        if (msg.sender != launchFactory && msg.sender != canonicalOwner) {
            revert UnauthorizedFactory();
        }
        if (
            bridge != address(0) || launchToken == address(0) || bridge_.code.length == 0
                || amount == 0 || amount > initialBridgeReserve
                || amount > IERC20(launchToken).balanceOf(address(this))
        ) revert BridgeAlreadyBound();
        ILockReleaseBridgeIdentity target = ILockReleaseBridgeIdentity(bridge_);
        if (
            target.launchId() != launchId
                || address(target.localToken()) != launchToken
                || target.maxBridgeAmount() > amount
        ) revert InvalidBridge();

        bridge = bridge_;
        bridgeInventoryTransferred = amount;
        IERC20(launchToken).safeTransfer(bridge_, amount);
        emit BridgeInventoryTransferred(
            bridge_, amount, initialBridgeReserve - amount
        );
    }

    /// @notice Accepts the Pons 20% buyback share or Ethereum Multichain buyback share.
    function depositBuybackEth() external payable returns (uint256 tokensBought) {
        if (msg.sender != taxRouter || taxRouter == address(0)) {
            revert UnauthorizedTaxRouter();
        }
        if (msg.value == 0) return 0;
        buybackEthAccrued += msg.value;
        totalBuybackEthReceived += msg.value;
        if (market == MARKET_UNISWAP_V4) {
            tokensBought = _tryV4Buyback();
        }
        emit BuybackEthDeposited(msg.value, buybackEthAccrued);
    }

    /// @notice Retries a Robinhood Pons curve buy with a caller-simulated minimum output.
    /// @dev The destination keeper pays gas; on any failed curve call, ETH remains accrued.
    function executePendingPonsBuyback(uint256 minTokensOut)
        external
        returns (uint256 tokensBought)
    {
        if (market != MARKET_PONS_CURVE || ponsCurve.code.length == 0) {
            revert UnsupportedMarket();
        }
        uint256 amountIn = buybackEthAccrued;
        if (amountIn < BUYBACK_THRESHOLD || executingBuyback) {
            revert BuybackBelowThreshold();
        }
        buybackEthAccrued = 0;
        executingBuyback = true;
        try this.executePonsBuyback{value: amountIn}(amountIn, minTokensOut)
            returns (uint256 bought, uint256 spent)
        {
            tokensBought = bought;
            totalBuybackEthSpent += spent;
            totalBuybackTokens += bought;
            executingBuyback = false;
            emit BuybackExecuted(spent, bought, MARKET_PONS_CURVE);
        } catch (bytes memory reason) {
            buybackEthAccrued += amountIn;
            executingBuyback = false;
            emit BuybackDeferred(amountIn, keccak256(reason));
        }
    }

    function executePonsBuyback(uint256 amountIn, uint256 minTokensOut)
        external
        payable
        returns (uint256 tokensBought, uint256 spent)
    {
        if (msg.sender != address(this)) revert UnauthorizedSelfCall();
        if (
            !executingBuyback || msg.value != amountIn
                || amountIn < BUYBACK_THRESHOLD
                || amountIn > uint256(uint128(type(int128).max))
        ) revert BuybackBelowThreshold();

        uint256 beforeBalance = address(this).balance;
        tokensBought = IPonsV2CurveBuy(ponsCurve).buy{value: amountIn}(
            amountIn, minTokensOut, address(this)
        );
        uint256 refund = buybackRefundedDuringCall;
        buybackRefundedDuringCall = 0;
        if (refund > amountIn) revert InvalidConfiguration();
        spent = amountIn - refund;
        if (address(this).balance < beforeBalance - amountIn + refund) {
            revert InvalidConfiguration();
        }
        buybackEthAccrued += refund;
    }

    /// @dev Pons may refund the unfilled remainder near curve graduation.
    uint256 private buybackRefundedDuringCall;

    receive() external payable {
        if (!executingBuyback || msg.sender != ponsCurve) {
            revert InvalidConfiguration();
        }
        buybackRefundedDuringCall += msg.value;
    }

    /// @notice Permissionless retry for a threshold-ready Ethereum V4 buyback.
    function executePendingV4Buyback() external returns (uint256) {
        if (market != MARKET_UNISWAP_V4) revert UnsupportedMarket();
        if (buybackEthAccrued < BUYBACK_THRESHOLD) revert BuybackBelowThreshold();
        return _tryV4Buyback();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnauthorizedUnlockCallback();
        return abi.encode(_swapForLaunchToken(abi.decode(data, (uint256))));
    }

    function _tryV4Buyback() private returns (uint256 tokensBought) {
        uint256 amountIn = buybackEthAccrued;
        if (amountIn < BUYBACK_THRESHOLD || executingBuyback) return 0;
        buybackEthAccrued = 0;
        executingBuyback = true;
        try this.executeV4Buyback{value: amountIn}(amountIn) returns (uint256 bought) {
            tokensBought = bought;
            totalBuybackEthSpent += amountIn;
            totalBuybackTokens += bought;
            emit BuybackExecuted(amountIn, bought, MARKET_UNISWAP_V4);
        } catch (bytes memory reason) {
            buybackEthAccrued = amountIn;
            emit BuybackDeferred(amountIn, keccak256(reason));
        }
        executingBuyback = false;
    }

    function executeV4Buyback(uint256 amountIn)
        external
        payable
        returns (uint256 tokensBought)
    {
        if (msg.sender != address(this)) revert UnauthorizedSelfCall();
        if (
            !executingBuyback || msg.value != amountIn
                || amountIn < BUYBACK_THRESHOLD
                || amountIn > uint256(uint128(type(int128).max))
        ) revert BuybackBelowThreshold();
        if (poolManager.isUnlocked()) return _swapForLaunchToken(amountIn);
        return abi.decode(poolManager.unlock(abi.encode(amountIn)), (uint256));
    }

    function _swapForLaunchToken(uint256 amountIn)
        private
        returns (uint256 tokensBought)
    {
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
