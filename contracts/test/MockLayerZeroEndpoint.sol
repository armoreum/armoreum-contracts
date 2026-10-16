// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { MessagingParams, MessagingFee, MessagingReceipt, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import { IOAppReceiver } from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppReceiver.sol";

/// @dev Local test fixture only. It does not authenticate or relay cross-chain messages.
contract MockLayerZeroEndpoint {
    uint256 public constant TEST_FEE = 0.01 ether;

    uint64 private nonce;
    bytes public lastMessage;
    bytes32 public lastGuid;
    bytes32 public lastReceiver;

    function setDelegate(address) external {}

    function quote(
        MessagingParams calldata,
        address
    ) external pure returns (MessagingFee memory) {
        return MessagingFee(TEST_FEE, 0);
    }

    function send(
        MessagingParams calldata params,
        address
    ) external payable returns (MessagingReceipt memory receipt) {
        require(msg.value == TEST_FEE, "incorrect test fee");
        nonce += 1;
        bytes32 guid = keccak256(abi.encode(msg.sender, nonce, params.receiver, params.message));
        lastMessage = params.message;
        lastGuid = guid;
        lastReceiver = params.receiver;
        return MessagingReceipt(guid, nonce, MessagingFee(TEST_FEE, 0));
    }

    function deliver(
        address receiver,
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message
    ) external {
        IOAppReceiver(receiver).lzReceive(origin, guid, message, msg.sender, bytes(""));
    }
}
