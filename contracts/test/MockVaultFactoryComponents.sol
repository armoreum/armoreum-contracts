// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultSetRegistry {
    function registerVaultSet(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address creatorVault,
        address bridgeVault
    ) external;
    function deployCreatorVaultProxy(bytes32 launchId, bytes32 salt, bytes calldata initialization)
        external
        returns (address);
}

contract MockVaultFactoryLaunchCaller {
    function register(
        address registry,
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address creatorVault,
        address bridgeVault
    ) external {
        IVaultSetRegistry(registry).registerVaultSet(
            launchId, token, creator, feeVault, creatorVault, bridgeVault
        );
    }

    function deployCreatorVault(
        address registry,
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address) {
        return IVaultSetRegistry(registry).deployCreatorVaultProxy(
            launchId, salt, initialization
        );
    }
}

contract MockVaultFactoryComponent {
    bytes32 public launchId;
    address public creator;
    address public launchToken;
    address public buybackExecutor;
    address public bridgeVault;

    constructor(
        bytes32 launchId_,
        address creator_,
        address launchToken_,
        address buybackExecutor_,
        address bridgeVault_
    ) {
        launchId = launchId_;
        creator = creator_;
        launchToken = launchToken_;
        buybackExecutor = buybackExecutor_;
        bridgeVault = bridgeVault_;
    }
}

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract MockVaultFactoryUupsTarget is Initializable, UUPSUpgradeable {
    address public owner;
    uint256 public value;

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, uint256 value_) external initializer {
        owner = owner_;
        value = value_;
    }

    function _authorizeUpgrade(address) internal view override {
        require(msg.sender == owner, "not owner");
    }
}

contract MockVaultFactoryPoolManager {}
