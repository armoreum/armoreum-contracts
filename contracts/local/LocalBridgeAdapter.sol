// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Local-only lock/release adapter used to exercise a relay against prefunded inventory.
/// @dev Robinhood-compatible local chain is 46630; Ethereum-compatible local chain is 31337.
///      The operator relay is not trustless and this contract must not be deployed publicly.
contract LocalBridgeAdapter {
    using SafeERC20 for IERC20;

    error LocalEvmOnly();
    error UnauthorizedOperator();
    error InvalidMessage();
    error MessageAlreadyConsumed();
    error InsufficientInventory();

    event BridgeLockInitiated(
        bytes32 indexed messageId,
        bytes32 indexed launchId,
        address indexed sender,
        address sourceToken,
        address destinationToken,
        address recipient,
        uint256 amount,
        uint256 nonce
    );
    event BridgeReleaseRelayed(
        bytes32 indexed messageId,
        bytes32 indexed launchId,
        address indexed recipient,
        address destinationToken,
        uint256 amount
    );

    address public immutable operator;
    mapping(address sender => uint256 nonce) public nonces;
    mapping(bytes32 messageId => bool) public outboundMessages;
    mapping(bytes32 messageId => bool) public consumedMessages;

    constructor(address operator_) {
        if (block.chainid != 31337 && block.chainid != 46630) revert LocalEvmOnly();
        if (operator_ == address(0)) revert InvalidMessage();
        operator = operator_;
    }

    function initiateLock(
        bytes32 launchId,
        address sourceToken,
        address destinationToken,
        address recipient,
        uint256 amount
    ) external returns (bytes32 messageId) {
        if (block.chainid != 46630) revert LocalEvmOnly();
        if (
            launchId == bytes32(0) ||
            sourceToken.code.length == 0 ||
            destinationToken == address(0) ||
            recipient == address(0) ||
            amount == 0
        ) revert InvalidMessage();

        uint256 nonce = nonces[msg.sender]++;
        messageId = computeMessageId(
            46630,
            31337,
            launchId,
            sourceToken,
            destinationToken,
            msg.sender,
            recipient,
            amount,
            nonce
        );
        if (outboundMessages[messageId]) revert MessageAlreadyConsumed();
        IERC20(sourceToken).safeTransferFrom(msg.sender, address(this), amount);
        outboundMessages[messageId] = true;
        emit BridgeLockInitiated(
            messageId,
            launchId,
            msg.sender,
            sourceToken,
            destinationToken,
            recipient,
            amount,
            nonce
        );
    }

    function relayRelease(
        bytes32 messageId,
        bytes32 launchId,
        uint256 sourceChainId,
        uint256 destinationChainId,
        address sourceToken,
        address destinationToken,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) external {
        if (block.chainid != 31337) revert LocalEvmOnly();
        if (msg.sender != operator) revert UnauthorizedOperator();
        if (
            sourceChainId != 46630 ||
            destinationChainId != 31337 ||
            launchId == bytes32(0) ||
            sourceToken == address(0) ||
            destinationToken.code.length == 0 ||
            sender == address(0) ||
            recipient == address(0) ||
            amount == 0
        ) revert InvalidMessage();

        bytes32 expected = computeMessageId(
            sourceChainId,
            destinationChainId,
            launchId,
            sourceToken,
            destinationToken,
            sender,
            recipient,
            amount,
            nonce
        );
        if (expected != messageId) revert InvalidMessage();
        if (consumedMessages[messageId]) revert MessageAlreadyConsumed();

        IERC20 token = IERC20(destinationToken);
        if (token.balanceOf(address(this)) < amount) revert InsufficientInventory();
        consumedMessages[messageId] = true;
        token.safeTransfer(recipient, amount);
        emit BridgeReleaseRelayed(messageId, launchId, recipient, destinationToken, amount);
    }

    function computeMessageId(
        uint256 sourceChainId,
        uint256 destinationChainId,
        bytes32 launchId,
        address sourceToken,
        address destinationToken,
        address sender,
        address recipient,
        uint256 amount,
        uint256 nonce
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                sourceChainId,
                destinationChainId,
                launchId,
                sourceToken,
                destinationToken,
                sender,
                recipient,
                amount,
                nonce
            )
        );
    }
}
