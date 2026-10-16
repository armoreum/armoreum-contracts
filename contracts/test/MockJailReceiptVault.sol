// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IJailReceiptActions {
    function vaultMint(address account, uint256 amount) external;
    function vaultBurn(address account, uint256 amount) external;
    function vaultTransfer(address from, address to, uint256 amount) external;
}

/// @dev Test helper only. Never use as a production vault.
contract MockJailReceiptVault {
    function mint(address receipt, address account, uint256 amount) external {
        IJailReceiptActions(receipt).vaultMint(account, amount);
    }

    function burn(address receipt, address account, uint256 amount) external {
        IJailReceiptActions(receipt).vaultBurn(account, amount);
    }

    function move(address receipt, address from, address to, uint256 amount) external {
        IJailReceiptActions(receipt).vaultTransfer(from, to, amount);
    }
}
