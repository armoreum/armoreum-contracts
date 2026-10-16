// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {ArmoreumV4TaxHook} from "./ArmoreumV4TaxHook.sol";
import {TaxRouter} from "../TaxRouter.sol";

/// @notice Ethereum-only provenance registry for independently configured per-token hooks.
/// @dev No administrator, mutable allowlist, or hook-reconfiguration authority.
contract ArmoreumHookFactory {
    error InvalidConfiguration();
    error UnauthorizedCreator();
    event HookCreated(bytes32 indexed launchId, address indexed creator, address indexed hook, address token);
    event HookBound(address indexed hook, address indexed router);

    struct Provenance {
        bytes32 launchId;
        address token;
        address creator;
    }

    IPoolManager public immutable poolManager;
    address public immutable jailSeed;
    mapping(address hook => Provenance) public provenance;
    mapping(address creator => mapping(bytes32 launchId => address hook)) public hooks;
    mapping(address hook => address router) public taxRouterByHook;

    constructor(IPoolManager manager, address seed) {
        if (block.chainid != 1 || address(manager).code.length == 0 || seed.code.length == 0) {
            revert InvalidConfiguration();
        }
        poolManager = manager;
        jailSeed = seed;
    }

    function hookInitCodeHash(bytes32 launchId, address token) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            type(ArmoreumV4TaxHook).creationCode,
            abi.encode(poolManager, launchId, token, address(this))
        ));
    }

    function predictHook(address creator, bytes32 launchId, address token, bytes32 salt)
        public view returns (address)
    {
        bytes32 effectiveSalt = keccak256(abi.encode(creator, launchId, salt));
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff), address(this), effectiveSalt, hookInitCodeHash(launchId, token)
        )))));
    }

    /// @dev Salt must be mined for V4 permission bits. Namespacing prevents other callers consuming it.
    function deployHook(bytes32 launchId, address token, bytes32 salt) external returns (address hook) {
        hook = hooks[msg.sender][launchId];
        if (hook != address(0)) {
            if (provenance[hook].token != token) revert InvalidConfiguration();
            return hook;
        }
        if (launchId == bytes32(0) || token.code.length == 0) revert InvalidConfiguration();
        bytes32 effectiveSalt = keccak256(abi.encode(msg.sender, launchId, salt));
        ArmoreumV4TaxHook deployed = new ArmoreumV4TaxHook{salt: effectiveSalt}(
            poolManager, launchId, token, address(this)
        );
        hook = address(deployed);
        deployed.configureJailSeed(jailSeed);
        provenance[hook] = Provenance(launchId, token, msg.sender);
        hooks[msg.sender][launchId] = hook;
        emit HookCreated(launchId, msg.sender, hook, token);
    }

    function isHookFor(address hook, bytes32 launchId, address token, address creator)
        external view returns (bool)
    {
        Provenance memory record = provenance[hook];
        return hook.code.length != 0 && record.launchId == launchId
            && record.token == token && record.creator == creator;
    }

    /// @notice Only the recorded creator may bind; the hook validates the router and then renounces.
    function bindHook(address hook, address routerAddress) external virtual {
        Provenance memory record = provenance[hook];
        if (record.creator != msg.sender || routerAddress.code.length == 0) {
            revert UnauthorizedCreator();
        }
        TaxRouter router = TaxRouter(payable(routerAddress));
        if (
            router.creator() != msg.sender || router.launchId() != record.launchId
                || router.launchToken() != record.token || router.taxSource() != address(this)
                || router.taxDistributionMode() != TaxRouter.TaxDistributionMode.CreatorOnly
        ) {
            revert InvalidConfiguration();
        }
        address existingRouter = taxRouterByHook[hook];
        if (existingRouter != address(0) && existingRouter != routerAddress) {
            revert InvalidConfiguration();
        }
        ArmoreumV4TaxHook deployed = ArmoreumV4TaxHook(payable(hook));
        if (
            address(deployed.taxRouter()) == routerAddress
                && deployed.admin() == address(0)
        ) return;
        taxRouterByHook[hook] = routerAddress;
        deployed.configureTaxRouter(routerAddress);
        emit HookBound(hook, routerAddress);
    }

    /// @notice Forwards swap tax only from a hook created and bound by this immutable registry.
    function collectTradeTaxes(uint256 grossTradeValue, bytes32 distributionId) external payable {
        address router = taxRouterByHook[msg.sender];
        if (router == address(0) || msg.value == 0) revert InvalidConfiguration();
        TaxRouter(payable(router)).collectTradeTaxes{value: msg.value}(
            grossTradeValue, distributionId
        );
    }
}
