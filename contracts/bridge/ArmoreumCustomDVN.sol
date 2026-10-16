// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ILayerZeroDVN} from "@layerzerolabs/lz-evm-messagelib-v2/contracts/uln/interfaces/ILayerZeroDVN.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

interface IArmoreumReceiveUln302 {
    function verify(bytes calldata packetHeader, bytes32 payloadHash, uint64 confirmations) external;
}

/// @notice Armoreum-operated LayerZero V2 DVN for allowlisted Armoreum OApp paths.
/// @dev Verification authority is intentionally centralized in one chain-specific worker.
contract ArmoreumCustomDVN is ILayerZeroDVN, Ownable2Step, EIP712 {
    using PacketV1Codec for bytes;

    bytes32 public constant ATTESTATION_TYPEHASH = keccak256(
        "PacketAttestation(uint32 srcEid,uint32 dstEid,bytes32 headerHash,bytes32 payloadHash,uint64 confirmations,bytes32 sourceBlockHash)"
    );

    uint32 public immutable localEid;
    address public operator;
    address public attestationSigner;

    mapping(address => bool) public isMessageLibrary;
    mapping(uint32 => mapping(address => bool)) public outboundSenderAllowed;
    mapping(uint32 => address) public receiveLibraryForSrcEid;
    mapping(uint32 => uint64) public minimumConfirmationsForSrcEid;
    mapping(uint32 => mapping(bytes32 => bool)) private inboundPathAllowed;
    mapping(uint32 => uint256) public feeForDstEid;
    mapping(bytes32 => bool) public verificationSubmitted;

    error InvalidAddress();
    error InvalidEndpointEid(uint32 expected, uint32 actual);
    error UnauthorizedMessageLibrary(address caller);
    error UnauthorizedOperator(address caller);
    error InvalidAttestationSigner(address recoveredSigner);
    error UnsupportedPath();
    error InvalidPacketHeader();
    error InsufficientConfirmations(uint64 provided, uint64 required);
    error InvalidReceiveLibrary();
    error InsufficientFee(uint256 provided, uint256 required);

    event MessageLibrarySet(address indexed messageLibrary, bool enabled);
    event OutboundPathSet(uint32 indexed dstEid, address indexed sender, bool enabled);
    event InboundPathSet(
        uint32 indexed srcEid,
        bytes32 indexed remoteSender,
        address indexed localReceiver,
        address receiveLibrary,
        uint64 minimumConfirmations,
        bool enabled
    );
    event OperatorSet(address indexed previousOperator, address indexed newOperator);
    event AttestationSignerSet(address indexed previousSigner, address indexed newSigner);
    event DestinationFeeSet(uint32 indexed dstEid, uint256 fee);
    event VerificationJobAssigned(
        uint32 indexed dstEid,
        address indexed sender,
        bytes32 indexed payloadHash,
        bytes packetHeader,
        uint64 confirmations
    );
    event VerificationSubmitted(
        uint32 indexed srcEid,
        bytes32 indexed payloadHash,
        address indexed receiver,
        address receiveLibrary,
        bytes32 sourceBlockHash,
        address attestationSigner
    );
    event NativeWithdrawn(address indexed recipient, uint256 amount);

    constructor(uint32 localEid_, address endpoint_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
        EIP712("ArmoreumCustomDVN", "1")
    {
        if (endpoint_ == address(0) || initialOperator == address(0)) revert InvalidAddress();
        uint32 actualEid = ILayerZeroEndpointV2(endpoint_).eid();
        if (actualEid != localEid_) revert InvalidEndpointEid(localEid_, actualEid);
        localEid = localEid_;
        operator = initialOperator;
        attestationSigner = initialOwner;
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

    function setInboundPath(
        uint32 srcEid,
        bytes32 remoteSourceOApp,
        address localReceiver,
        address receiveLibrary,
        uint64 minimumConfirmations,
        bool enabled
    ) external onlyOwner {
        if (srcEid == 0 || remoteSourceOApp == bytes32(0) || localReceiver == address(0)) {
            revert InvalidAddress();
        }
        if (enabled && (receiveLibrary == address(0) || receiveLibrary.code.length == 0)) {
            revert InvalidReceiveLibrary();
        }

        bytes32 pathKey = _inboundPathKey(remoteSourceOApp, localReceiver);
        inboundPathAllowed[srcEid][pathKey] = enabled;
        if (enabled) {
            receiveLibraryForSrcEid[srcEid] = receiveLibrary;
            minimumConfirmationsForSrcEid[srcEid] = minimumConfirmations;
        }
        emit InboundPathSet(
            srcEid,
            remoteSourceOApp,
            localReceiver,
            receiveLibrary,
            minimumConfirmations,
            enabled
        );
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert InvalidAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorSet(previous, newOperator);
    }

    function setAttestationSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previous = attestationSigner;
        attestationSigner = newSigner;
        emit AttestationSignerSet(previous, newSigner);
    }

    function setDestinationFee(uint32 dstEid, uint256 fee) external onlyOwner {
        if (dstEid == 0) revert InvalidAddress();
        feeForDstEid[dstEid] = fee;
        emit DestinationFeeSet(dstEid, fee);
    }

    /// @notice Called by the configured send message library; the Armoreum worker pays destination gas.
    function assignJob(AssignJobParam calldata param, bytes calldata)
        external
        payable
        override
        returns (uint256 fee)
    {
        if (!isMessageLibrary[msg.sender]) revert UnauthorizedMessageLibrary(msg.sender);
        if (
            param.packetHeader.srcEid() != localEid || param.packetHeader.dstEid() != param.dstEid
                || param.packetHeader.sender() != bytes32(uint256(uint160(param.sender)))
                || !outboundSenderAllowed[param.dstEid][param.sender]
        ) revert UnsupportedPath();

        fee = feeForDstEid[param.dstEid];
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);
        emit VerificationJobAssigned(
            param.dstEid,
            param.sender,
            param.payloadHash,
            param.packetHeader,
            param.confirmations
        );
    }

    function getFee(uint32 dstEid, uint64, address sender, bytes calldata)
        external
        view
        override
        returns (uint256 fee)
    {
        if (!outboundSenderAllowed[dstEid][sender]) revert UnsupportedPath();
        return feeForDstEid[dstEid];
    }

    /// @notice Submit the worker's source-chain attestation to the destination ReceiveUln302.
    /// @dev The worker must verify PacketSent, the source receipt, configured peer and finality first.
    function verifyPacket(
        bytes calldata packetHeader,
        bytes32 payloadHash,
        uint64 confirmations,
        bytes32 sourceBlockHash,
        bytes calldata ownerAttestation
    )
        external
    {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        uint32 srcEid = packetHeader.srcEid();
        address receiver = packetHeader.receiverB20();
        bytes32 remoteSender = packetHeader.sender();
        address receiveLibrary = receiveLibraryForSrcEid[srcEid];
        uint64 minimumConfirmations = minimumConfirmationsForSrcEid[srcEid];

        if (
            packetHeader.dstEid() != localEid || receiver == address(0) || receiveLibrary == address(0)
                || !inboundPathAllowed[srcEid][_inboundPathKey(remoteSender, receiver)]
        ) revert UnsupportedPath();
        if (confirmations < minimumConfirmations) {
            revert InsufficientConfirmations(confirmations, minimumConfirmations);
        }
        if (sourceBlockHash == bytes32(0)) revert InvalidPacketHeader();

        bytes32 attestationHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                srcEid,
                localEid,
                keccak256(packetHeader),
                payloadHash,
                confirmations,
                sourceBlockHash
            )
        );
        address recoveredSigner = ECDSA.recover(_hashTypedDataV4(attestationHash), ownerAttestation);
        if (recoveredSigner != attestationSigner) revert InvalidAttestationSigner(recoveredSigner);

        bytes32 verificationKey = keccak256(abi.encode(receiveLibrary, keccak256(packetHeader), payloadHash));
        if (verificationSubmitted[verificationKey]) return;

        IArmoreumReceiveUln302(receiveLibrary).verify(packetHeader, payloadHash, confirmations);
        verificationSubmitted[verificationKey] = true;
        emit VerificationSubmitted(srcEid, payloadHash, receiver, receiveLibrary, sourceBlockHash, recoveredSigner);
    }

    function withdrawNative(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0) || amount > address(this).balance) revert InvalidAddress();
        (bool success,) = recipient.call{value: amount}("");
        require(success, "NATIVE_TRANSFER_FAILED");
        emit NativeWithdrawn(recipient, amount);
    }

    function _inboundPathKey(bytes32 remoteSourceOApp, address localReceiver) private pure returns (bytes32) {
        return keccak256(abi.encode(remoteSourceOApp, localReceiver));
    }
}
