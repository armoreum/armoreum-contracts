// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * Project: Armoreum
 * Description: Programmable asset protection and security infrastructure for a decentralized world.
 * Website: https://armoreum.io
 * @notice Immutable-supply ERC-20 primitive for future launch integrations.
 * @dev The full supply is minted once to the launch's initial holder. This token has no owner or privileged post-deployment controls.
 */
contract FixedSupplyLaunchToken is ERC20 {
    uint256 public constant FIXED_SUPPLY = 1_000_000_000 ether;

    error InvalidInitialHolder();

    constructor(
        string memory name_,
        string memory symbol_,
        address initialHolder_
    ) ERC20(name_, symbol_) {
        if (initialHolder_ == address(0)) revert InvalidInitialHolder();
        _mint(initialHolder_, FIXED_SUPPLY);
    }
}
