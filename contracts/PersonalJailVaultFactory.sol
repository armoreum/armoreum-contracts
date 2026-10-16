// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";

interface IPersonalJailVaultInitializer {
    function initialize(address owner) external;
}

/// @notice Deterministically creates one isolated Jail Vault for each wallet on this chain.
contract PersonalJailVaultFactory {
    error InvalidConfiguration();
    error VaultAlreadyExists();

    address public immutable implementation;
    address public immutable vaultFactory;

    mapping(address owner => address vault) public vaultByOwner;
    mapping(address vault => address owner) public ownerByVault;

    event PersonalJailVaultCreated(
        address indexed owner,
        address indexed vault,
        uint256 indexed chainId
    );

    constructor(address implementation_, address vaultFactory_) {
        if (implementation_.code.length == 0 || vaultFactory_.code.length == 0) {
            revert InvalidConfiguration();
        }
        AddressPrefix.require6900(implementation_);
        AddressPrefix.require6900(vaultFactory_);
        implementation = implementation_;
        vaultFactory = vaultFactory_;
    }

    function createVault() external returns (address vault) {
        if (vaultByOwner[msg.sender] != address(0)) revert VaultAlreadyExists();
        bytes32 salt = _salt(msg.sender);
        vault = Clones.cloneDeterministic(implementation, salt);
        vaultByOwner[msg.sender] = vault;
        ownerByVault[vault] = msg.sender;
        IPersonalJailVaultInitializer(vault).initialize(msg.sender);
        emit PersonalJailVaultCreated(msg.sender, vault, block.chainid);
    }

    function predictVaultAddress(address owner) external view returns (address) {
        if (owner == address(0)) revert InvalidConfiguration();
        return Clones.predictDeterministicAddress(
            implementation, _salt(owner), address(this)
        );
    }

    function isVault(address candidate) external view returns (bool) {
        address owner = ownerByVault[candidate];
        return owner != address(0) && vaultByOwner[owner] == candidate;
    }

    function isVaultForOwner(address candidate, address owner) external view returns (bool) {
        return owner != address(0) && vaultByOwner[owner] == candidate;
    }

    function _salt(address owner) private view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, owner));
    }
}
