// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ArmoreumMultichainLaunchModule} from "./ArmoreumMultichainLaunchModule.sol";

interface IModePolicyFactory {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function approvedTaxSources(address taxSource) external view returns (bool);
}

/// @notice Multichain launch module with a per-factory, per-mode tax-source allowlist.
/// @dev The policy is stored in this module's own storage. ArmoreumFactory queries it
///      externally, while multichain launch operations continue to use delegatecall.
contract ArmoreumLaunchModeModule is ArmoreumMultichainLaunchModule {
    error InvalidModeApproval();
    error UnauthorizedModeApproval();

    event TaxSourceModeApprovalChanged(
        address indexed factory,
        uint8 indexed taxDistributionMode,
        address indexed taxSource,
        bool approved
    );

    mapping(address factory => mapping(uint8 mode => mapping(address taxSource => bool approved)))
        private _taxSourceModeApprovals;

    function setTaxSourceModeApprovals(
        address factory,
        uint8[] calldata taxDistributionModes,
        address[] calldata taxSources,
        bool[] calldata approvals
    ) external {
        uint256 length = taxDistributionModes.length;
        if (
            factory.code.length == 0 || length == 0 || length > 16
                || taxSources.length != length || approvals.length != length
                || !IModePolicyFactory(factory).hasRole(bytes32(0), msg.sender)
        ) revert UnauthorizedModeApproval();

        IModePolicyFactory policyFactory = IModePolicyFactory(factory);
        for (uint256 i; i < length; ++i) {
            uint8 mode = taxDistributionModes[i];
            address source = taxSources[i];
            bool approved = approvals[i];
            if (
                !_modeAllowedOnCurrentChain(mode) || source == address(0)
                    || (approved && (source.code.length == 0 || !policyFactory.approvedTaxSources(source)))
            ) revert InvalidModeApproval();
            _taxSourceModeApprovals[factory][mode][source] = approved;
            emit TaxSourceModeApprovalChanged(factory, mode, source, approved);
        }
    }

    function isTaxSourceApprovedForMode(
        address factory,
        uint8 taxDistributionMode,
        address taxSource
    ) external view returns (bool) {
        return _modeAllowedOnCurrentChain(taxDistributionMode)
            && _taxSourceModeApprovals[factory][taxDistributionMode][taxSource];
    }

    function _modeAllowedOnCurrentChain(uint8 mode) private view returns (bool) {
        if (mode > 3) return false;
        if (block.chainid == 1) return mode <= 1;
        if (block.chainid == 4663) return mode >= 2;
        return true;
    }
}
