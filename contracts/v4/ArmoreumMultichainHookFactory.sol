// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArmoreumHookFactory} from "./ArmoreumHookFactory.sol";
import {ArmoreumV4TaxHook} from "./ArmoreumV4TaxHook.sol";
import {TaxRouter} from "../TaxRouter.sol";

/// @notice Separate Ethereum Multichain hook registry bound to JailMultiSeed.
/// @dev Only accepts Multichain routers whose buyback executor is their Bridge Vault.
contract ArmoreumMultichainHookFactory is ArmoreumHookFactory {
    constructor(IPoolManager manager, address seed) ArmoreumHookFactory(manager, seed) {}

    function bindHook(address hook, address routerAddress) external override {
        Provenance memory record = provenance[hook];
        if (record.creator != msg.sender || routerAddress.code.length == 0) {
            revert UnauthorizedCreator();
        }

        TaxRouter router = TaxRouter(payable(routerAddress));
        address bridgeVault = router.bridgeVault();
        if (
            router.creator() != msg.sender || router.launchId() != record.launchId
                || router.launchToken() != record.token || router.taxSource() != address(this)
                || router.taxDistributionMode() != TaxRouter.TaxDistributionMode.Creator80Buyback20
                || bridgeVault == address(0) || router.buybackExecutor() != bridgeVault
        ) {
            revert InvalidConfiguration();
        }

        address existingRouter = taxRouterByHook[hook];
        if (existingRouter != address(0) && existingRouter != routerAddress) {
            revert InvalidConfiguration();
        }

        ArmoreumV4TaxHook deployed = ArmoreumV4TaxHook(payable(hook));
        if (address(deployed.taxRouter()) == routerAddress && deployed.admin() == address(0)) return;
        taxRouterByHook[hook] = routerAddress;
        deployed.configureTaxRouter(routerAddress);
        emit HookBound(hook, routerAddress);
    }
}
