// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArmoreumTokenDeployer {
    function computeTokenAddress(
        string calldata name,
        string calldata symbol,
        address initialHolder,
        bytes32 salt
    ) external view returns (address);

    function deployToken(
        string calldata name,
        string calldata symbol,
        address initialHolder,
        bytes32 salt
    ) external returns (address);
}

/// @notice Local-only Pons-shaped adapter that creates a fixed-supply token.
/// @dev This is not the official Pons V2 deployment and does not create a pool,
///      apply Pons fees, or enable trading.
contract LocalPonsV2Adapter {
    error LocalRobinhoodChainOnly();
    error UnauthorizedOperator();
    error InvalidLaunch();
    error LaunchAlreadyCreated();

    event LocalPonsCompatibleLaunchCreated(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed token,
        string name,
        string symbol,
        bytes32 configHash
    );

    address public immutable operator;
    IArmoreumTokenDeployer public immutable tokenDeployer;
    mapping(bytes32 launchId => address token) public launchTokens;
    mapping(bytes32 launchId => bytes32 configHash) public launchConfigHashes;

    constructor(address operator_, address tokenDeployer_) {
        if (block.chainid != 46630) revert LocalRobinhoodChainOnly();
        if (operator_ == address(0) || tokenDeployer_.code.length == 0) revert InvalidLaunch();
        operator = operator_;
        tokenDeployer = IArmoreumTokenDeployer(tokenDeployer_);
    }

    function createLaunch(
        bytes32 launchId,
        string calldata name,
        string calldata symbol,
        address creator,
        bytes32 salt
    ) external returns (address token) {
        if (block.chainid != 46630) revert LocalRobinhoodChainOnly();
        if (msg.sender != operator) revert UnauthorizedOperator();
        if (
            launchId == bytes32(0) || creator == address(0) || bytes(name).length == 0
                || bytes(symbol).length == 0
        ) revert InvalidLaunch();

        bytes32 configHash = keccak256(abi.encode(name, symbol, creator, salt));
        address existing = launchTokens[launchId];
        if (existing != address(0)) {
            if (launchConfigHashes[launchId] != configHash) revert LaunchAlreadyCreated();
            return existing;
        }

        token = tokenDeployer.deployToken(name, symbol, creator, salt);
        launchTokens[launchId] = token;
        launchConfigHashes[launchId] = configHash;
        emit LocalPonsCompatibleLaunchCreated(launchId, creator, token, name, symbol, configHash);
    }
}
