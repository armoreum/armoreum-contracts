// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArmoreumMultichainVault} from "./ArmoreumMultichainVault.sol";
import {TaxRouter} from "../TaxRouter.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

interface IMultichainLaunchHost {
    function canonicalOwner() external view returns (address);
    function vaultFactory() external view returns (address);
    function rewardSystems(bytes32 launchId)
        external
        view
        returns (
            address creator,
            address vault,
            address taxRouter,
            address taxSource,
            uint16 additionalTaxBps,
            uint256 implementationVersion,
            TaxRouter.TaxDistributionMode taxDistributionMode,
            address launchToken,
            address buybackExecutor,
            address bridgeVault
        );
}

interface IMultichainVaultFactory {
    function multichainVaultImplementation() external view returns (address);
    function multichainVaultProxyByLaunch(bytes32 launchId) external view returns (address);
    function predictMultichainVaultAddress(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external view returns (address);
    function deployMultichainVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address);
    function registerMultichainVault(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address bridgeVault
    ) external;
    function registerVaultSet(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address creatorVault,
        address bridgeVault
    ) external;
}

contract ArmoreumMultichainLaunchModule {
    uint256 public constant MULTICHAIN_MODE_POLICY_VERSION = 1;

    error InvalidConfiguration();
    error LaunchAlreadyRegistered();

    uint8 private constant MARKET_PONS_CURVE = 1;
    uint8 private constant MARKET_UNISWAP_V4 = 2;

    event MultichainVaultPrepared(
        bytes32 indexed launchId, address indexed creator, address indexed vault
    );
    event MultichainLaunchCompleted(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed launchToken,
        address bridgeVault,
        uint8 market
    );

    /// @notice Called only during an authenticated reward-system enrollment via ArmoreumFactory.
    function deployMultichainVault(
        bytes32 launchId,
        address creator,
        address expectedVault
    )
        external
        returns (address vault)
    {
        if (
            launchId == bytes32(0) || creator == address(0)
                || expectedVault == address(0)
        ) revert InvalidConfiguration();
        IMultichainLaunchHost host = IMultichainLaunchHost(address(this));
        address registryAddress = host.vaultFactory();
        if (registryAddress.code.length == 0) revert InvalidConfiguration();
        IMultichainVaultFactory registry = IMultichainVaultFactory(registryAddress);
        if (registry.multichainVaultImplementation().code.length == 0) {
            revert InvalidConfiguration();
        }

        vault = registry.multichainVaultProxyByLaunch(launchId);
        if (vault != address(0)) {
            if (
                vault.code.length == 0
                    || ArmoreumMultichainVault(payable(vault)).creator() != creator
                    || vault != expectedVault
            ) revert LaunchAlreadyRegistered();
            return vault;
        }

        bytes memory initialization = abi.encodeCall(
            ArmoreumMultichainVault.initialize,
            (launchId, creator, address(this), host.canonicalOwner())
        );
        bytes32 salt = _salt(launchId, creator);
        vault = registry.deployMultichainVaultProxy(
            launchId, salt, initialization
        );
        if (vault != expectedVault) revert InvalidConfiguration();
        emit MultichainVaultPrepared(launchId, creator, vault);
    }

    /// @notice Computes the proxy address using the live VaultFactory implementation pointer.
    function predictMultichainVaultAddress(bytes32 launchId, address creator)
        external
        view
        returns (address)
    {
        if (
            launchId == bytes32(0) || creator == address(0)
                || msg.sender.code.length == 0
        ) revert InvalidConfiguration();
        IMultichainLaunchHost host = IMultichainLaunchHost(msg.sender);
        address registryAddress = host.vaultFactory();
        if (registryAddress.code.length == 0) revert InvalidConfiguration();
        IMultichainVaultFactory registry = IMultichainVaultFactory(registryAddress);
        if (registry.multichainVaultImplementation().code.length == 0) {
            revert InvalidConfiguration();
        }
        bytes memory initialization = abi.encodeCall(
            ArmoreumMultichainVault.initialize,
            (launchId, creator, msg.sender, host.canonicalOwner())
        );
        return registry.predictMultichainVaultAddress(
            launchId, _salt(launchId, creator), initialization
        );
    }

    /// @notice Called by ArmoreumFactory through delegatecall after both chain transactions settle.
    function completeMultichainLaunch(
        bytes32 launchId,
        address launchToken,
        uint256 bridgeReserve,
        uint8 market,
        address ponsCurve,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 sqrtPriceLimitX96
    ) external {
        IMultichainLaunchHost host = IMultichainLaunchHost(address(this));
        (
            address creator,
            address creatorVault,
            address taxRouter,
            ,
            ,
            ,
            TaxRouter.TaxDistributionMode mode,
            address existingToken,
            address buybackExecutor,
            address bridgeVault
        ) = host.rewardSystems(launchId);
        if (
            creator != msg.sender
                || (
                    mode != TaxRouter.TaxDistributionMode.Creator80Buyback20
                        && mode != TaxRouter.TaxDistributionMode.PonsCreator70Platform10Buyback20
                )
                || existingToken != address(0) || launchToken.code.length == 0
                || creatorVault.code.length == 0 || taxRouter.code.length == 0
                || bridgeVault.code.length == 0 || buybackExecutor != bridgeVault
                || bridgeVault != IMultichainVaultFactory(host.vaultFactory())
                    .multichainVaultProxyByLaunch(launchId)
        ) revert InvalidConfiguration();
        ArmoreumMultichainVault vault = ArmoreumMultichainVault(payable(bridgeVault));
        if (
            vault.launchId() != launchId || vault.creator() != creator
                || vault.launchFactory() != address(this)
                || vault.taxRouter() != taxRouter
                || TaxRouter(payable(taxRouter)).launchToken() != launchToken
        ) revert InvalidConfiguration();

        if (market == MARKET_PONS_CURVE) {
            if (
                ponsCurve.code.length == 0 || address(poolManager) != address(0)
                    || bridgeReserve == 0
                    || mode != TaxRouter.TaxDistributionMode.PonsCreator70Platform10Buyback20
            ) revert InvalidConfiguration();
            vault.bindPonsLaunch(launchToken, ponsCurve, bridgeReserve);
        } else if (market == MARKET_UNISWAP_V4) {
            if (
                ponsCurve != address(0) || address(poolManager).code.length == 0
                    || bridgeReserve == 0
                    || mode != TaxRouter.TaxDistributionMode.Creator80Buyback20
            ) revert InvalidConfiguration();
            vault.bindEthereumLaunch(
                launchToken,
                bridgeReserve,
                poolManager,
                poolKey,
                sqrtPriceLimitX96
            );
        } else {
            revert InvalidConfiguration();
        }

        IMultichainVaultFactory registry =
            IMultichainVaultFactory(host.vaultFactory());
        registry.registerMultichainVault(
            launchId, launchToken, creator, taxRouter, bridgeVault
        );
        registry.registerVaultSet(
            launchId, launchToken, creator, taxRouter, creatorVault, bridgeVault
        );
        emit MultichainLaunchCompleted(
            launchId, creator, launchToken, bridgeVault, market
        );
    }

    function _salt(bytes32 launchId, address creator) private view returns (bytes32) {
        return keccak256(
            abi.encode("ARMOREUM_MULTICHAIN_VAULT_V1", block.chainid, launchId, creator)
        );
    }
}
