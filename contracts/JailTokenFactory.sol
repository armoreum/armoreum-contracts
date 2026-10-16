// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";
import {JailETHReceipt, JailToken} from "./JailReceiptToken.sol";

/// @notice Idempotently deploys one isolated JailToken proxy for each launch on this chain.
contract JailTokenFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant LAUNCH_FACTORY_ROLE = keccak256("LAUNCH_FACTORY_ROLE");

    error InvalidConfiguration();
    error DuplicateLaunchConfiguration();
    error InvalidImplementation();
    error MissingImplementation();

    event LaunchFactoryPermissionChanged(address indexed factory, bool enabled);
    event JailTokenCreated(
        bytes32 indexed launchId,
        uint256 indexed chainId,
        address indexed mainToken,
        address jailToken,
        address vault,
        bytes32 configurationHash
    );
    event JailEthReceiptCreated(
        bytes32 indexed launchId,
        uint256 indexed chainId,
        address indexed jailEthReceipt,
        address vault,
        bytes32 configurationHash
    );

    address public jailTokenImplementation;
    mapping(bytes32 launchId => address jailToken) public jailTokens;
    mapping(bytes32 launchId => bytes32 configurationHash) public launchConfigurationHashes;
    address public jailEthImplementation;
    mapping(bytes32 launchId => address receipt) public jailEthReceipts;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin_, address upgrader_, address implementation_)
        external
        initializer
    {
        _initialize(admin_, upgrader_, implementation_, address(0));
    }

    function initializeWithJailEth(
        address admin_,
        address upgrader_,
        address jailTokenImplementation_,
        address jailEthImplementation_
    ) external initializer {
        _initialize(
            admin_,
            upgrader_,
            jailTokenImplementation_,
            jailEthImplementation_
        );
    }

    function _initialize(
        address admin_,
        address upgrader_,
        address jailTokenImplementation_,
        address jailEthImplementation_
    ) private onlyInitializing {
        if (
            admin_ == address(0) || upgrader_ == address(0)
                || jailTokenImplementation_.code.length == 0
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(address(this));
        _validateImplementation(jailTokenImplementation_);
        if (jailEthImplementation_ != address(0)) {
            _validateImplementation(jailEthImplementation_);
        }
        __AccessControl_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, upgrader_);
        jailTokenImplementation = jailTokenImplementation_;
        jailEthImplementation = jailEthImplementation_;
    }

    function setLaunchFactory(address factory, bool enabled)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (factory == address(0)) revert InvalidConfiguration();
        if (enabled) _grantRole(LAUNCH_FACTORY_ROLE, factory);
        else _revokeRole(LAUNCH_FACTORY_ROLE, factory);
        emit LaunchFactoryPermissionChanged(factory, enabled);
    }

    function setJailTokenImplementation(address implementation)
        external
        onlyRole(UPGRADER_ROLE)
    {
        _validateImplementation(implementation);
        jailTokenImplementation = implementation;
    }

    function setJailEthImplementation(address implementation)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _validateImplementation(implementation);
        jailEthImplementation = implementation;
    }

    function createJailToken(
        bytes32 launchId,
        address mainToken,
        address vault,
        string calldata name,
        string calldata symbol,
        address instanceAdmin,
        address instanceUpgrader
    ) external onlyRole(LAUNCH_FACTORY_ROLE) returns (address jailToken) {
        if (
            launchId == bytes32(0) || mainToken.code.length == 0
                || vault.code.length == 0 || instanceAdmin == address(0)
                || instanceUpgrader == address(0)
        ) revert InvalidConfiguration();
        if (jailEthImplementation.code.length == 0) revert MissingImplementation();

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid,
                launchId,
                mainToken,
                vault,
                name,
                symbol,
                instanceAdmin,
                instanceUpgrader
            )
        );
        jailToken = jailTokens[launchId];
        if (jailToken != address(0)) {
            if (
                launchConfigurationHashes[launchId] != configHash
                    || jailEthReceipts[launchId] == address(0)
            ) {
                revert DuplicateLaunchConfiguration();
            }
            return jailToken;
        }

        bytes memory jailTokenInitialization = abi.encodeCall(
            JailToken.initialize,
            (name, symbol, launchId, mainToken, vault, instanceAdmin, instanceUpgrader)
        );
        bytes memory jailEthInitialization = abi.encodeCall(
            JailETHReceipt.initialize,
            (
                string.concat("jailETH ", name),
                string.concat("jETH-", symbol),
                launchId,
                vault,
                instanceAdmin,
                instanceUpgrader
            )
        );
        bytes32 jailTokenSalt = keccak256(
            abi.encode(block.chainid, launchId, address(this), bytes32("JAIL_TOKEN"))
        );
        bytes32 jailEthSalt = keccak256(
            abi.encode(block.chainid, launchId, address(this), bytes32("JAIL_ETH_RECEIPT"))
        );
        jailToken = address(
            new ERC1967Proxy{salt: jailTokenSalt}(
                jailTokenImplementation, jailTokenInitialization
            )
        );
        address jailEthReceipt = address(
            new ERC1967Proxy{salt: jailEthSalt}(
                jailEthImplementation, jailEthInitialization
            )
        );
        jailTokens[launchId] = jailToken;
        jailEthReceipts[launchId] = jailEthReceipt;
        launchConfigurationHashes[launchId] = configHash;
        emit JailTokenCreated(
            launchId, block.chainid, mainToken, jailToken, vault, configHash
        );
        emit JailEthReceiptCreated(
            launchId, block.chainid, jailEthReceipt, vault, configHash
        );
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _validateImplementation(address implementation) private view {
        AddressPrefix.require6900(implementation);
        try IERC1822Proxiable(implementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) {
                revert InvalidImplementation();
            }
        } catch {
            revert InvalidImplementation();
        }
    }

    uint256[46] private __gap;
}
