// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FixedSupplyLaunchTokenV2} from "./FixedSupplyLaunchTokenV2.sol";

/**
 * Project: Armoreum
 * Description: Programmable asset protection and security infrastructure for a decentralized world.
 * Website: https://armoreum.io
 * @notice Permissionless CREATE2 deployer for ownerless, fixed-supply launch tokens.
 * @dev This version only adds ERC-7572 metadata support to the token it creates.
 *      It does not create pools, change fees, or configure rewards or bridges.
 */
contract ArmoreumTokenDeployerV2 {
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
        FixedSupplyLaunchTokenV2 token = new FixedSupplyLaunchTokenV2{salt: salt}(
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
                type(FixedSupplyLaunchTokenV2).creationCode,
                abi.encode(name_, symbol_, initialHolder_)
            )
        );
    }
}
