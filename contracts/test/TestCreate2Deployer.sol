// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Test-only helper. Production deployments use a separately verified CREATE2 deployer.
contract TestCreate2Deployer {
    error Create2DeploymentFailed();

    function deploy(bytes32 salt, bytes calldata initCode)
        external
        returns (address deployed)
    {
        bytes memory code = initCode;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) revert Create2DeploymentFailed();
    }

    function proxyInitCode(address implementation, bytes calldata initialization)
        external
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(implementation, initialization)
        );
    }
}
