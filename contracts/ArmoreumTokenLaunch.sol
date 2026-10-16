// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/**
 * Project: Armoreum
 * Description: Programmable asset protection and security infrastructure for a decentralized world.
 * Website: https://armoreum.io
 * @notice Ownerless, fixed-supply Armoreum launch token with ERC-7572 metadata.
 * @dev Supply and token controls are unchanged from the existing launch token.
 */
contract ArmoreumTokenLaunch is ERC20 {
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

    /// @notice ERC-7572 contract metadata URI, uniquely derived from this token address.
    function contractURI() external view returns (string memory) {
        return string.concat(
            "https://armoreum.io/api/tokens/",
            Strings.toHexString(uint256(uint160(address(this))), 20),
            "/metadata"
        );
    }
}
