// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PacketV1Codec} from "@layerzerolabs/lz-evm-protocol-v2/contracts/messagelib/libs/PacketV1Codec.sol";
import {ILayerZeroEndpointV2, Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

interface IAtomicRelayDVN {
    function localEid() external view returns (uint32);
    function receiveLibraryForSrcEid(uint32) external view returns (address);
    function verifyPacket(bytes calldata, bytes32, uint64, bytes32, bytes calldata) external;
}

interface IAtomicRelayExecutor {
    function localEid() external view returns (uint32);
    function endpoint() external view returns (address);
    function execute(Origin calldata, address, bytes32, bytes calldata, bytes calldata) external;
}

interface IAtomicReceiveLibrary {
    function commitVerification(bytes calldata, bytes32) external;
}

interface IAtomicBridge {
    function consumedTransferIds(bytes32) external view returns (bool);
}

/// @notice Chain-local, keeper-authorized verify/commit/execute coordinator.
/// @dev Source receipt, confirmation and exposure checks remain the responsibility
/// of the Armoreum DVN attestation service. This contract does not prove source finality.
contract ArmoreumAtomicRelay is Ownable2Step, ReentrancyGuard {
    using PacketV1Codec for bytes;

    IAtomicRelayDVN public immutable dvn;
    IAtomicRelayExecutor public immutable executor;
    ILayerZeroEndpointV2 public immutable endpoint;
    uint32 public immutable localEid;
    address public keeper;

    error InvalidConfiguration();
    error UnauthorizedKeeper();
    error InvalidPacket();
    error ConflictingPayload();
    error DeliveryNotConsumed();

    event KeeperSet(address indexed keeper);
    event PacketDelivered(bytes32 indexed guid, bytes32 indexed transferId, address indexed receiver);

    constructor(address owner_, address keeper_, address dvn_, address executor_, address endpoint_)
        Ownable(owner_)
    {
        if (keeper_ == address(0) || dvn_.code.length == 0 || executor_.code.length == 0
            || endpoint_.code.length == 0) revert InvalidConfiguration();
        dvn = IAtomicRelayDVN(dvn_);
        executor = IAtomicRelayExecutor(executor_);
        endpoint = ILayerZeroEndpointV2(endpoint_);
        uint32 eid = endpoint.eid();
        if (dvn.localEid() != eid || executor.localEid() != eid || executor.endpoint() != endpoint_) {
            revert InvalidConfiguration();
        }
        localEid = eid;
        keeper = keeper_;
    }

    function setKeeper(address keeper_) external onlyOwner {
        if (keeper_ == address(0)) revert InvalidConfiguration();
        keeper = keeper_;
        emit KeeperSet(keeper_);
    }

    function relay(
        bytes calldata encodedPacket,
        uint64 confirmations,
        bytes32 sourceBlockHash,
        bytes calldata ownerAttestation
    ) external nonReentrant {
        if (msg.sender != keeper) revert UnauthorizedKeeper();
        // 81-byte V1 header + 32-byte GUID + the fixed 256-byte bridge message.
        if (encodedPacket.length != 369 || encodedPacket.version() != 1
            || encodedPacket.dstEid() != localEid || sourceBlockHash == bytes32(0)) revert InvalidPacket();
        address receiver = encodedPacket.receiverB20();
        bytes calldata message = encodedPacket.message();
        bytes32 transferId = abi.decode(message, (bytes32));
        if (receiver.code.length == 0 || transferId == bytes32(0)) revert InvalidPacket();
        // Replays after successful execution must not recommit consumed packets.
        if (IAtomicBridge(receiver).consumedTransferIds(transferId)) return;

        Origin memory origin = Origin(encodedPacket.srcEid(), encodedPacket.sender(), encodedPacket.nonce());
        bytes32 payloadHash = keccak256(encodedPacket.payload());
        bytes32 committed = endpoint.inboundPayloadHash(receiver, origin.srcEid, origin.sender, origin.nonce);
        if (committed != bytes32(0) && committed != payloadHash) revert ConflictingPayload();
        if (committed == bytes32(0)) {
            address library_ = dvn.receiveLibraryForSrcEid(origin.srcEid);
            (address configuredLibrary,) = endpoint.getReceiveLibrary(receiver, origin.srcEid);
            if (library_ == address(0) || library_ != configuredLibrary) revert InvalidConfiguration();
            dvn.verifyPacket(encodedPacket.header(), payloadHash, confirmations, sourceBlockHash, ownerAttestation);
            IAtomicReceiveLibrary(library_).commitVerification(encodedPacket.header(), payloadHash);
        }
        executor.execute(origin, receiver, encodedPacket.guid(), message, "");
        if (!IAtomicBridge(receiver).consumedTransferIds(transferId)) revert DeliveryNotConsumed();
        emit PacketDelivered(encodedPacket.guid(), transferId, receiver);
    }
}
