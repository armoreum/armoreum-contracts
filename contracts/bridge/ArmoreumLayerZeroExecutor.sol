// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ILayerZeroEndpointV2, Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

interface IArmoreumExecutorWorker {
    function assignJob(uint32 dstEid, address sender, uint256 calldataSize, bytes calldata options)
        external
        payable
        returns (uint256 price);

    function getFee(uint32 dstEid, address sender, uint256 calldataSize, bytes calldata options)
        external
        view
        returns (uint256 price);
}

/// @notice Armoreum's LayerZero fee worker and permissioned destination executor.
/// @dev The configured operator pays destination gas from its chain-specific wallet.
contract ArmoreumLayerZeroExecutor is IArmoreumExecutorWorker, Ownable2Step {
    uint32 public immutable localEid;
    ILayerZeroEndpointV2 public immutable endpoint;
    address public operator;

    mapping(address => bool) public isMessageLibrary;
    mapping(uint32 => mapping(address => bool)) public outboundSenderAllowed;
    mapping(uint32 => mapping(bytes32 => bool)) private inboundPathAllowed;
    mapping(uint32 => uint256) public feeForDstEid;

    error InvalidAddress();
    error InvalidEndpointEid(uint32 expected, uint32 actual);
    error UnauthorizedMessageLibrary(address caller);
    error UnauthorizedOperator(address caller);
    error UnsupportedPath();
    error InsufficientFee(uint256 provided, uint256 required);

    event MessageLibrarySet(address indexed messageLibrary, bool enabled);
    event OutboundPathSet(uint32 indexed dstEid, address indexed sender, bool enabled);
    event InboundPathSet(uint32 indexed srcEid, bytes32 indexed remoteSender, address indexed localReceiver, bool enabled);
    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event DestinationFeeSet(uint32 indexed dstEid, uint256 fee);
    event ExecutionJobAssigned(uint32 indexed dstEid, address indexed sender, uint256 calldataSize, uint256 fee);
    event MessageExecuted(uint32 indexed srcEid, bytes32 indexed guid, address indexed receiver, uint64 nonce);

    constructor(uint32 localEid_, address endpoint_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
    {
        if (endpoint_ == address(0) || initialOperator == address(0)) revert InvalidAddress();
        uint32 actualEid = ILayerZeroEndpointV2(endpoint_).eid();
        if (actualEid != localEid_) revert InvalidEndpointEid(localEid_, actualEid);
        localEid = localEid_;
        endpoint = ILayerZeroEndpointV2(endpoint_);
        operator = initialOperator;
    }

    function setMessageLibrary(address messageLibrary, bool enabled) external onlyOwner {
        if (messageLibrary == address(0)) revert InvalidAddress();
        isMessageLibrary[messageLibrary] = enabled;
        emit MessageLibrarySet(messageLibrary, enabled);
    }

    function setOutboundPath(uint32 dstEid, address sourceOApp, bool enabled) external onlyOwner {
        if (dstEid == 0 || sourceOApp == address(0)) revert InvalidAddress();
        outboundSenderAllowed[dstEid][sourceOApp] = enabled;
        emit OutboundPathSet(dstEid, sourceOApp, enabled);
    }

    function setInboundPath(uint32 srcEid, bytes32 remoteSourceOApp, address localReceiver, bool enabled)
        external
        onlyOwner
    {
        if (srcEid == 0 || remoteSourceOApp == bytes32(0) || localReceiver == address(0)) {
            revert InvalidAddress();
        }
        inboundPathAllowed[srcEid][_inboundPathKey(remoteSourceOApp, localReceiver)] = enabled;
        emit InboundPathSet(srcEid, remoteSourceOApp, localReceiver, enabled);
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    function setDestinationFee(uint32 dstEid, uint256 fee) external onlyOwner {
        if (dstEid == 0) revert InvalidAddress();
        feeForDstEid[dstEid] = fee;
        emit DestinationFeeSet(dstEid, fee);
    }

    function assignJob(uint32 dstEid, address sender, uint256 calldataSize, bytes calldata)
        external
        payable
        override
        returns (uint256 price)
    {
        if (!isMessageLibrary[msg.sender]) revert UnauthorizedMessageLibrary(msg.sender);
        if (!outboundSenderAllowed[dstEid][sender]) revert UnsupportedPath();
        price = feeForDstEid[dstEid];
        if (msg.value < price) revert InsufficientFee(msg.value, price);
        emit ExecutionJobAssigned(dstEid, sender, calldataSize, price);
    }

    function getFee(uint32 dstEid, address sender, uint256, bytes calldata)
        external
        view
        override
        returns (uint256 price)
    {
        if (!outboundSenderAllowed[dstEid][sender]) revert UnsupportedPath();
        return feeForDstEid[dstEid];
    }

    /// @notice Execute a message only through Armoreum's chain-specific keeper.
    /// @dev Endpoint enforces that the packet is committed and executable before invoking the OApp.
    function execute(
        Origin calldata origin,
        address receiver,
        bytes32 guid,
        bytes calldata message,
        bytes calldata extraData
    ) external {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        if (!inboundPathAllowed[origin.srcEid][_inboundPathKey(origin.sender, receiver)]) {
            revert UnsupportedPath();
        }
        endpoint.lzReceive(origin, receiver, guid, message, extraData);
        emit MessageExecuted(origin.srcEid, guid, receiver, origin.nonce);
    }

    function withdrawNative(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0) || amount > address(this).balance) revert InvalidAddress();
        (bool success,) = recipient.call{value: amount}("");
        require(success, "NATIVE_TRANSFER_FAILED");
    }

    function _inboundPathKey(bytes32 remoteSourceOApp, address localReceiver) private pure returns (bytes32) {
        return keccak256(abi.encode(remoteSourceOApp, localReceiver));
    }
}
