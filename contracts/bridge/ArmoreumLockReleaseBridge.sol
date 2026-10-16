// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { OApp, MessagingFee, MessagingReceipt, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { OAppOptionsType3 } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";
import { EnforcedOptionParam } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppOptionsType3.sol";
import { OptionsBuilder } from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OptionsBuilder.sol";

/// @notice One fixed token pair and one LayerZero peer for a single Armoreum launch.
/// @dev Locks source tokens and releases prefunded destination tokens. This contract never mints or burns.
contract ArmoreumLockReleaseBridge is OApp, OAppOptionsType3, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using OptionsBuilder for bytes;

    uint256 public constant BRIDGE_FEE_BPS = 20;
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;
    error InvalidConfiguration();
    error PeerAlreadyConfigured();
    error PeerNotConfigured();
    error WrongRemoteEndpoint(uint32 actual, uint32 expected);
    error OutboundDisabled();
    error InboundDisabled();
    error ZeroAmount();
    error InvalidRecipient();
    error OutboundLimitExceeded();
    error InboundLimitExceeded();
    error InsufficientVaultInventory();
    error InvalidTransferMessage();
    error TransferAlreadyConsumed(bytes32 transferId);

    uint16 public constant SEND = 1;

    struct LockedTransfer {
        address sender;
        address recipient;
        uint256 amount;
        uint64 nonce;
        bytes32 layerZeroGuid;
    }

    uint32 public immutable remoteEndpointId;
    IERC20 public immutable localToken;
    address public immutable remoteToken;
    bytes32 public immutable launchId;
    uint256 public immutable maxBridgeAmount;
    uint128 public immutable destinationReceiveGasLimit;

    uint64 public outboundNonce;
    uint256 public outboundTotal;
    uint256 public inboundReleased;
    uint256 public destinationFeesAccrued;
    bool public peerConfigured;
    bool public outboundEnabled;
    bool public inboundEnabled;

    mapping(bytes32 transferId => LockedTransfer) public lockedTransfers;
    mapping(bytes32 transferId => bool) public consumedTransferIds;

    event PeerConfigured(uint32 indexed remoteEndpointId, bytes32 indexed peer);
    event OutboundEnabled();
    event InboundEnabled(uint256 prefundedAmount);
    event TransferLocked(
        bytes32 indexed transferId,
        bytes32 indexed guid,
        bytes32 indexed launchId,
        address sender,
        address recipient,
        uint256 amount,
        uint64 nonce
    );
    event TransferReleased(
        bytes32 indexed transferId,
        bytes32 indexed guid,
        bytes32 indexed launchId,
        address recipient,
        uint256 grossAmount,
        uint256 destinationFee,
        uint256 recipientAmount
    );

    constructor(
        address endpoint_,
        address owner_,
        uint32 remoteEndpointId_,
        address localToken_,
        address remoteToken_,
        bytes32 launchId_,
        uint256 maxBridgeAmount_,
        uint128 destinationReceiveGasLimit_
    ) OApp(endpoint_, owner_) Ownable(owner_) {
        if (
            endpoint_ == address(0) ||
            owner_ == address(0) ||
            remoteEndpointId_ == 0 ||
            localToken_.code.length == 0 ||
            remoteToken_ == address(0) ||
            launchId_ == bytes32(0) ||
            maxBridgeAmount_ == 0 ||
            destinationReceiveGasLimit_ == 0
        ) revert InvalidConfiguration();

        remoteEndpointId = remoteEndpointId_;
        localToken = IERC20(localToken_);
        remoteToken = remoteToken_;
        launchId = launchId_;
        maxBridgeAmount = maxBridgeAmount_;
        destinationReceiveGasLimit = destinationReceiveGasLimit_;
        enforcedOptions[remoteEndpointId_][SEND] = OptionsBuilder
            .newOptions()
            .addExecutorLzReceiveOption(destinationReceiveGasLimit_, 0);
    }

    /// @dev Receive gas is fixed at deployment to prevent accidental underfunding.
    function setEnforcedOptions(EnforcedOptionParam[] calldata) public pure override {
        revert InvalidConfiguration();
    }

    /// @notice Binds this vault to its one remote launch vault. The peer cannot be changed afterward.
    function setPeer(uint32 endpointId_, bytes32 peer_) public override onlyOwner {
        if (peerConfigured) revert PeerAlreadyConfigured();
        if (endpointId_ != remoteEndpointId) revert WrongRemoteEndpoint(endpointId_, remoteEndpointId);
        if (peer_ == bytes32(0)) revert InvalidConfiguration();
        _setPeer(endpointId_, peer_);
        peerConfigured = true;
        emit PeerConfigured(endpointId_, peer_);
    }

    /// @notice Enables outbound locks after operators verify both chain deployments and peer settings.
    function activateOutbound() external onlyOwner {
        if (!peerConfigured) revert PeerNotConfigured();
        if (outboundEnabled) revert InvalidConfiguration();
        outboundEnabled = true;
        emit OutboundEnabled();
    }

    /// @notice Enables inbound releases only after the full fixed allocation is deposited in this vault.
    function activateInbound() external onlyOwner {
        if (!peerConfigured) revert PeerNotConfigured();
        if (inboundEnabled || localToken.balanceOf(address(this)) < maxBridgeAmount) {
            revert InsufficientVaultInventory();
        }
        inboundEnabled = true;
        emit InboundEnabled(localToken.balanceOf(address(this)));
    }

    function quoteLock(
        address recipient,
        uint256 amount,
        bytes calldata options
    ) external view returns (MessagingFee memory) {
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        bytes memory message = _encodeTransfer(
            _nextTransferId(msg.sender, recipient, amount, outboundNonce + 1),
            msg.sender,
            recipient,
            amount,
            outboundNonce + 1
        );
        return _quote(remoteEndpointId, message, combineOptions(remoteEndpointId, SEND, options), false);
    }

    /// @notice Locks source tokens and sends a LayerZero message requesting release of prefunded destination tokens.
    function lockAndSend(
        address recipient,
        uint256 amount,
        bytes calldata options
    ) external payable nonReentrant returns (bytes32 transferId) {
        if (!outboundEnabled) revert OutboundDisabled();
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxBridgeAmount) revert OutboundLimitExceeded();

        uint64 nonce = outboundNonce + 1;
        transferId = _nextTransferId(msg.sender, recipient, amount, nonce);
        bytes memory message = _encodeTransfer(transferId, msg.sender, recipient, amount, nonce);
        bytes memory combinedOptions = combineOptions(remoteEndpointId, SEND, options);
        MessagingFee memory fee = _quote(remoteEndpointId, message, combinedOptions, false);

        localToken.safeTransferFrom(msg.sender, address(this), amount);
        outboundNonce = nonce;
        outboundTotal += amount;

        MessagingReceipt memory receipt = _lzSend(
            remoteEndpointId,
            message,
            combinedOptions,
            fee,
            msg.sender
        );
        lockedTransfers[transferId] = LockedTransfer({
            sender: msg.sender,
            recipient: recipient,
            amount: amount,
            nonce: nonce,
            layerZeroGuid: receipt.guid
        });

        emit TransferLocked(transferId, receipt.guid, launchId, msg.sender, recipient, amount, nonce);
    }

    function remainingOutboundCapacity() external view returns (uint256) {
        return maxBridgeAmount;
    }

    function availableInboundInventory() external view returns (uint256) {
        if (!inboundEnabled) return 0;
        uint256 actualBalance = localToken.balanceOf(address(this));
        uint256 spendableBalance =
            actualBalance > destinationFeesAccrued ? actualBalance - destinationFeesAccrued : 0;
        return spendableBalance;
    }

    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address,
        bytes calldata
    ) internal override nonReentrant {
        if (origin.srcEid != remoteEndpointId) {
            revert WrongRemoteEndpoint(origin.srcEid, remoteEndpointId);
        }
        (
            bytes32 transferId,
            bytes32 messageLaunchId,
            address sourceToken,
            address destinationToken,
            address sourceSender,
            address recipient,
            uint256 amount,
            uint64 sourceNonce
        ) = abi.decode(message, (bytes32, bytes32, address, address, address, address, uint256, uint64));

        if (
            transferId == bytes32(0) ||
            messageLaunchId != launchId ||
            sourceToken != remoteToken ||
            destinationToken != address(localToken) ||
            sourceSender == address(0) ||
            recipient == address(0) ||
            amount == 0 ||
            sourceNonce == 0
        ) revert InvalidTransferMessage();
        if (consumedTransferIds[transferId]) revert TransferAlreadyConsumed(transferId);
        if (!inboundEnabled) revert InboundDisabled();
        if (amount > maxBridgeAmount) revert InboundLimitExceeded();
        uint256 actualBalance = localToken.balanceOf(address(this));
        uint256 spendableBalance =
            actualBalance > destinationFeesAccrued ? actualBalance - destinationFeesAccrued : 0;
        if (spendableBalance < amount) revert InsufficientVaultInventory();

        uint256 destinationFee = Math.mulDiv(amount, BRIDGE_FEE_BPS, BASIS_POINTS_DENOMINATOR);
        uint256 recipientAmount = amount - destinationFee;
        consumedTransferIds[transferId] = true;
        inboundReleased += amount;
        destinationFeesAccrued += destinationFee;
        localToken.safeTransfer(recipient, recipientAmount);
        emit TransferReleased(
            transferId,
            guid,
            launchId,
            recipient,
            amount,
            destinationFee,
            recipientAmount
        );
    }

    function _nextTransferId(
        address sender,
        address recipient,
        uint256 amount,
        uint64 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), remoteEndpointId, launchId, nonce, sender, recipient, amount)
        );
    }

    function _encodeTransfer(
        bytes32 transferId,
        address sender,
        address recipient,
        uint256 amount,
        uint64 nonce
    ) internal view returns (bytes memory) {
        return abi.encode(
            transferId,
            launchId,
            address(localToken),
            remoteToken,
            sender,
            recipient,
            amount,
            nonce
        );
    }
}
