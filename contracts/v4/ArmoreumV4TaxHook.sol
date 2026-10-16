// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TaxRouter} from "../TaxRouter.sol";

interface IArmoreumHookTaxRelay {
    function collectTradeTaxes(uint256 grossTradeValue, bytes32 distributionId) external payable;
}

/**
 * Project: Armoreum
 * Description: Programmable asset protection and security infrastructure for a decentralized world.
 * Website: https://armoreum.io
 * @notice Collects ETH taxes and a token-denominated multichain share from ETH/token V4 pools.
 */
contract ArmoreumV4TaxHook {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeCast for uint256;

    address public constant PERMANENT_CONTROL_SINK =
        0x000000000000000000000000000000000000dEaD;

    error UnauthorizedPoolManager();
    error UnauthorizedAdmin();
    error InvalidConfiguration();
    error InvalidPoolKey();
    error TaxRouterNotConfigured();

    event TaxRouterConfigured(address indexed router);
    event HookAdminRenounced(address indexed previousAdmin);

    IPoolManager public immutable poolManager;
    bytes32 public immutable launchId;
    address public immutable launchToken;
    address public immutable hookFactory;
    address public admin;

    TaxRouter public taxRouter;
    uint256 public swapNonce;
    address public jailSeed;

    constructor(
        IPoolManager poolManager_,
        bytes32 launchId_,
        address launchToken_,
        address admin_
    ) {
        if (
            address(poolManager_).code.length == 0 || launchId_ == bytes32(0)
                || launchToken_.code.length == 0 || admin_ == address(0)
        ) revert InvalidConfiguration();
        poolManager = poolManager_;
        launchId = launchId_;
        launchToken = launchToken_;
        hookFactory = admin_;
        admin = admin_;

        Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions());
    }

    receive() external payable {}

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.beforeSwap = true;
        permissions.afterSwap = true;
        permissions.beforeSwapReturnDelta = true;
        permissions.afterSwapReturnDelta = true;
    }

    /// @notice Locks the initial pool creator to the immutable Ethereum seeding contract.
    function configureJailSeed(address seed) external {
        if (msg.sender != admin) revert UnauthorizedAdmin();
        if (block.chainid != 1 || jailSeed != address(0) || seed.code.length == 0) {
            revert InvalidConfiguration();
        }
        jailSeed = seed;
    }

    /// @notice Binds the one launch router after the factory has created it.
    function configureTaxRouter(address taxRouter_) external {
        if (msg.sender != admin) revert UnauthorizedAdmin();
        if (address(taxRouter) != address(0) || taxRouter_.code.length == 0) {
            revert InvalidConfiguration();
        }

        TaxRouter router = TaxRouter(payable(taxRouter_));
        if (
            router.launchId() != launchId || router.launchToken() != launchToken
                || router.taxSource() != hookFactory
        ) revert InvalidConfiguration();
        taxRouter = router;
        admin = address(0);
        emit TaxRouterConfigured(taxRouter_);
        emit HookAdminRenounced(msg.sender);
    }

    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        view
        returns (bytes4)
    {
        _onlyPoolManager();
        _validatePoolKey(key);
        if (address(taxRouter) == address(0)) revert TaxRouterNotConfigured();
        if (jailSeed != address(0) && sender != jailSeed) revert InvalidConfiguration();
        return IHooks.beforeInitialize.selector;
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) external view returns (bytes4, BeforeSwapDelta, uint24) {
        _onlyPoolManager();
        _validatePoolKey(key);
        if (address(taxRouter) == address(0)) revert TaxRouterNotConfigured();
        if (sender == taxRouter.buybackExecutor()) {
            return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
        }
        Currency specifiedCurrency = _specifiedCurrency(key, params);
        if (Currency.unwrap(specifiedCurrency) == address(0)) {
            uint256 grossTradeValue = _absolute(params.amountSpecified);
            (,,,, uint256 totalTax) = taxRouter.previewTax(grossTradeValue);
            return (
                IHooks.beforeSwap.selector,
                toBeforeSwapDelta(totalTax.toInt128(), 0),
                0
            );
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDelta.wrap(0), 0);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) external returns (bytes4, int128) {
        _onlyPoolManager();
        _validatePoolKey(key);
        if (address(taxRouter) == address(0)) revert TaxRouterNotConfigured();
        if (sender == taxRouter.buybackExecutor()) {
            return (IHooks.afterSwap.selector, 0);
        }

        Currency specifiedCurrency = _specifiedCurrency(key, params);
        Currency unspecifiedCurrency = _unspecifiedCurrency(key, params);
        bool nativeSpecified = Currency.unwrap(specifiedCurrency) == address(0);
        int128 nativeDelta = Currency.unwrap(key.currency0) == address(0)
            ? delta.amount0()
            : delta.amount1();
        uint256 grossTradeValue = nativeSpecified
            ? _absolute(params.amountSpecified)
            : _absolute(int256(nativeDelta));
        (,,,, uint256 totalTax) = taxRouter.previewTax(grossTradeValue);
        // A native-specified fee was reserved beforeSwap. Do not overcharge a partially filled swap.
        if (nativeSpecified && int256(nativeDelta) != params.amountSpecified + int256(totalTax)) {
            revert InvalidConfiguration();
        }
        if (totalTax == 0) return (IHooks.afterSwap.selector, 0);
        bytes32 distributionId = _nextDistributionId(sender);
        poolManager.take(Currency.wrap(address(0)), address(this), totalTax);
        IArmoreumHookTaxRelay(hookFactory).collectTradeTaxes{value: totalTax}(
            grossTradeValue, distributionId
        );

        int128 unspecifiedFee = Currency.unwrap(unspecifiedCurrency) == address(0)
            ? totalTax.toInt128()
            : int128(0);
        return (IHooks.afterSwap.selector, unspecifiedFee);
    }

    function _validatePoolKey(PoolKey calldata key) private view {
        address currency0 = Currency.unwrap(key.currency0);
        address currency1 = Currency.unwrap(key.currency1);
        if (
            address(key.hooks) != address(this)
                || !(
                    (currency0 == address(0) && currency1 == launchToken)
                        || (currency1 == address(0) && currency0 == launchToken)
                )
        ) revert InvalidPoolKey();
    }

    function _specifiedCurrency(PoolKey calldata key, SwapParams calldata params)
        private
        pure
        returns (Currency)
    {
        bool specifiedCurrencyIs0 = params.zeroForOne == (params.amountSpecified < 0);
        return specifiedCurrencyIs0 ? key.currency0 : key.currency1;
    }

    function _unspecifiedCurrency(PoolKey calldata key, SwapParams calldata params)
        private
        pure
        returns (Currency)
    {
        bool specifiedCurrencyIs0 = params.zeroForOne == (params.amountSpecified < 0);
        return specifiedCurrencyIs0 ? key.currency1 : key.currency0;
    }

    function _nextDistributionId(address sender) private returns (bytes32) {
        swapNonce += 1;
        return keccak256(abi.encode(address(this), launchId, block.chainid, sender, swapNonce));
    }

    function _absolute(int256 value) private pure returns (uint256) {
        if (value == type(int256).min) revert InvalidConfiguration();
        return uint256(value < 0 ? -value : value);
    }

    function _onlyPoolManager() private view {
        if (msg.sender != address(poolManager)) revert UnauthorizedPoolManager();
    }
}
