// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @notice Non-transferable receipt token controlled by one JailSwap vault.
/// @dev The vault is the only issuer, burner, and transfer path. Implementations are UUPS.
abstract contract JailReceiptToken is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    error InvalidConfiguration();
    error OnlyVault();
    error ProtectedTransferOnly();

    bytes32 public launchId;
    address public backingAsset;
    address public vault;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _initializeReceipt(
        string memory name_,
        string memory symbol_,
        bytes32 launchId_,
        address backingAsset_,
        address vault_,
        address admin_,
        address upgrader_
    ) internal onlyInitializing {
        if (
            bytes(name_).length == 0 || bytes(symbol_).length == 0
                || launchId_ == bytes32(0) || vault_.code.length == 0
                || admin_ == address(0) || upgrader_ == address(0)
        ) revert InvalidConfiguration();
        __ERC20_init(name_, symbol_);
        __AccessControl_init();
        launchId = launchId_;
        backingAsset = backingAsset_;
        vault = vault_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, upgrader_);
    }

    function vaultMint(address account, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        _mint(account, amount);
    }

    function vaultBurn(address account, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        _burn(account, amount);
    }

    function vaultTransfer(address from, address to, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        _transfer(from, to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        revert ProtectedTransferOnly();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert ProtectedTransferOnly();
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert ProtectedTransferOnly();
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    uint256[44] private __gap;
}

/// @notice Per-launch receipt for the corresponding original token held by JailSwap.
contract JailToken is JailReceiptToken {
    function initialize(
        string calldata name_,
        string calldata symbol_,
        bytes32 launchId_,
        address backingToken_,
        address vault_,
        address admin_,
        address upgrader_
    ) external initializer {
        if (backingToken_.code.length == 0) revert InvalidConfiguration();
        _initializeReceipt(
            name_, symbol_, launchId_, backingToken_, vault_, admin_, upgrader_
        );
    }
}

/// @notice Per-launch receipt for users' ETH proceeds from JailSwap sells.
/// @dev This is not the creator-reward JailETH embedded in CreatorRewardVault.
contract JailETHReceipt is JailReceiptToken {
    function initialize(
        string calldata name_,
        string calldata symbol_,
        bytes32 launchId_,
        address vault_,
        address admin_,
        address upgrader_
    ) external initializer {
        _initializeReceipt(
            name_, symbol_, launchId_, address(0), vault_, admin_, upgrader_
        );
    }
}
