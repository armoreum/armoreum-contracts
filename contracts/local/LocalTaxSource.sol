// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILocalTaxRouter {
    function collectTradeTaxes(uint256 grossTradeValue, bytes32 distributionId)
        external
        payable;
}

/// @notice Test-only tax callback for the isolated local EVMs.
/// @dev It intentionally cannot route fees on any network other than the
///      repository's local Ethereum and Robinhood-compatible chain IDs.
contract LocalTaxSource {
    error LocalNetworkOnly();
    error InvalidRouter();

    event LocalTaxForwarded(
        address indexed router,
        bytes32 indexed distributionId,
        uint256 grossTradeValue,
        uint256 taxPaid
    );

    function routeAdditionalTax(
        address router,
        uint256 grossTradeValue,
        bytes32 distributionId
    ) external payable {
        if (block.chainid != 31337 && block.chainid != 46630) {
            revert LocalNetworkOnly();
        }
        if (router.code.length == 0) revert InvalidRouter();

        ILocalTaxRouter(router).collectTradeTaxes{value: msg.value}(
            grossTradeValue,
            distributionId
        );
        emit LocalTaxForwarded(router, distributionId, grossTradeValue, msg.value);
    }
}
