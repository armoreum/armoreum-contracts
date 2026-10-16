// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Origin} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

contract AtomicEndpointMock {
    uint32 public constant eid = 30416;
    bytes32 public payload;
    address public library_;
    function setLibrary(address value) external { library_ = value; }
    function setHash(bytes32 value) external { payload = value; }
    function getReceiveLibrary(address, uint32) external view returns (address, bool) { return (library_, false); }
    function inboundPayloadHash(address, uint32, bytes32, uint64) external view returns (bytes32) { return payload; }
}
contract AtomicDVNMock {
    uint32 public constant localEid = 30416;
    address public library_;
    bool public verified;
    address public operator;
    constructor(address value) { library_ = value; }
    function setOperator(address value) external { operator = value; }
    function receiveLibraryForSrcEid(uint32) external view returns (address) { return library_; }
    function verifyPacket(bytes calldata, bytes32, uint64, bytes32, bytes calldata) external {
        require(msg.sender == operator, "OPERATOR");
        verified = true;
    }
}
contract AtomicLibraryMock {
    AtomicEndpointMock public endpoint;
    AtomicDVNMock public dvn;
    bool public fail;
    constructor(address value) { endpoint = AtomicEndpointMock(value); }
    function configure(address value, bool fail_) external { dvn = AtomicDVNMock(value); fail = fail_; }
    function commitVerification(bytes calldata, bytes32 value) external {
        require(dvn.verified() && !fail, "COMMIT");
        endpoint.setHash(value);
    }
}
contract AtomicBridgeMock {
    mapping(bytes32 => bool) public consumedTransferIds;
    function consume(bytes32 value) external { consumedTransferIds[value] = true; }
}
contract AtomicExecutorMock {
    uint32 public constant localEid = 30416;
    address public endpoint;
    bool public fail;
    address public operator;
    constructor(address value) { endpoint = value; }
    function configure(address value, bool fail_) external { operator = value; fail = fail_; }
    function execute(Origin calldata, address receiver, bytes32, bytes calldata message, bytes calldata) external {
        require(msg.sender == operator && !fail && AtomicEndpointMock(endpoint).payload() != bytes32(0), "EXECUTE");
        AtomicBridgeMock(receiver).consume(abi.decode(message, (bytes32)));
        AtomicEndpointMock(endpoint).setHash(bytes32(0));
    }
}
