// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArmoreumTokenLaunch} from "./ArmoreumTokenLaunch.sol";

/**
 * Project: Armoreum
 * Description: Programmable asset protection and security infrastructure for a decentralized world.
 * Website: https://armoreum.io
 * @notice Permissionless CREATE2 deployer for Armoreum fixed-supply launch tokens.
 * @dev The child token's verified Solidity contract name is ArmoreumTokenLaunch.
 *      It does not create pools or change fees, rewards, or bridge configuration.
 */
contract ArmoreumTokenDeployerV3 {
    uint8 public constant TOKEN_METADATA_VERSION = 1;

    event TokenDeployed(
        address indexed creator,
        address indexed token,
        address indexed initialHolder,
        string name,
        string symbol,
        bytes32 salt
    );

    function computeTokenAddress(
        string calldata name_,
        string calldata symbol_,
        address initialHolder_,
        bytes32 salt
    ) public view returns (address predictedAddress) {
        bytes32 initCodeHash = _tokenInitCodeHash(name_, symbol_, initialHolder_);
        predictedAddress = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }

    function tokenInitCodeHash(
        string calldata name_,
        string calldata symbol_,
        address initialHolder_
    ) external pure returns (bytes32) {
        return _tokenInitCodeHash(name_, symbol_, initialHolder_);
    }

    function deployToken(
        string calldata name_,
        string calldata symbol_,
        address initialHolder_,
        bytes32 salt
    ) external returns (address tokenAddress) {
        ArmoreumTokenLaunch token = new ArmoreumTokenLaunch{salt: salt}(
            name_,
            symbol_,
            initialHolder_
        );
        tokenAddress = address(token);
        emit TokenDeployed(msg.sender, tokenAddress, initialHolder_, name_, symbol_, salt);
    }

    function _tokenInitCodeHash(
        string memory name_,
        string memory symbol_,
        address initialHolder_
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                type(ArmoreumTokenLaunch).creationCode,
                abi.encode(name_, symbol_, initialHolder_)
            )
        );
    }
}
