// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPersonalJailVaultFactoryView {
    function vaultFactory() external view returns (address);
    function isVault(address candidate) external view returns (bool);
}

interface IPersonalJailVaultLaunchRegistry {
    function jailSwapVaultByLaunch(bytes32 launchId) external view returns (address);
}

interface IPersonalJailSwapVault {
    function buyFromPersonalVault(uint256 minimumJailTokenOut, uint256 deadline)
        external
        payable
        returns (uint256 jailTokenOut);

    function sellFromPersonalVault(
        uint256 jailTokenAmount,
        uint256 minimumJailEthOut,
        uint256 deadline
    ) external returns (uint256 jailEthOut);

    function unjailTokenFromPersonalVault(
        uint256 amount,
        address recipient,
        uint256 deadline
    ) external;

    function redeemJailETHFromPersonalVault(uint256 amount, uint256 deadline) external;
}

/// @notice A wallet-owned account which keeps one user's native ETH and per-launch Jail receipts.
/// @dev The factory deploys non-upgradeable minimal proxies. No user assets are pooled together.
contract PersonalJailVault is Initializable, ReentrancyGuard {
    error InvalidConfiguration();
    error Unauthorized();
    error InvalidAmount();
    error MissingLaunchVault();
    error InsufficientETH();
    error PayoutFailed();

    address public owner;
    address public factory;
    mapping(bytes32 launchId => bool tracked) private _trackedLaunch;
    bytes32[] private _trackedLaunchIds;

    event NativeETHReceived(address indexed sender, uint256 amount);
    event NativeETHWithdrawn(address indexed owner, uint256 amount);
    event PersonalJailSwapBought(
        bytes32 indexed launchId, uint256 ethSupplied, uint256 minimumJailTokenOut
    );
    event PersonalJailSwapSold(
        bytes32 indexed launchId, uint256 jailTokenAmount, uint256 minimumJailEthOut
    );
    event PersonalJailTokenUnjailed(
        bytes32 indexed launchId, uint256 amount, address indexed recipient
    );
    event PersonalJailETHRedeemed(bytes32 indexed launchId, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_) external initializer {
        if (owner_ == address(0) || msg.sender.code.length == 0) {
            revert InvalidConfiguration();
        }
        address configuredVaultFactory = IPersonalJailVaultFactoryView(msg.sender).vaultFactory();
        if (
            configuredVaultFactory.code.length == 0
                || !IPersonalJailVaultFactoryView(msg.sender).isVault(address(this))
        ) revert InvalidConfiguration();
        owner = owner_;
        factory = msg.sender;
    }

    receive() external payable {
        emit NativeETHReceived(msg.sender, msg.value);
    }

    function vaultFactory() public view returns (address) {
        return IPersonalJailVaultFactoryView(factory).vaultFactory();
    }

    function trackedLaunchIds() external view returns (bytes32[] memory) {
        return _trackedLaunchIds;
    }

    /// @notice Swap this vault's native ETH into the selected launch's JailToken.
    /// @dev ETH can be supplied with this call or drawn from the vault's existing balance.
    function buy(
        bytes32 launchId,
        uint256 amountIn,
        uint256 minimumJailTokenOut,
        uint256 deadline
    ) external payable onlyOwner nonReentrant returns (uint256 jailTokenOut) {
        if (launchId == bytes32(0) || amountIn == 0) revert InvalidAmount();
        if (address(this).balance < amountIn) revert InsufficientETH();
        IPersonalJailSwapVault jailSwapVault = _jailSwapVault(launchId);
        jailTokenOut = jailSwapVault.buyFromPersonalVault{value: amountIn}(
            minimumJailTokenOut, deadline
        );
        _trackLaunch(launchId);
        emit PersonalJailSwapBought(launchId, amountIn, minimumJailTokenOut);
    }

    /// @notice Swap this vault's per-launch JailToken into its JailETH receipt.
    function sell(
        bytes32 launchId,
        uint256 jailTokenAmount,
        uint256 minimumJailEthOut,
        uint256 deadline
    ) external onlyOwner nonReentrant returns (uint256 jailEthOut) {
        if (launchId == bytes32(0) || jailTokenAmount == 0) revert InvalidAmount();
        jailEthOut = _jailSwapVault(launchId).sellFromPersonalVault(
            jailTokenAmount, minimumJailEthOut, deadline
        );
        emit PersonalJailSwapSold(launchId, jailTokenAmount, minimumJailEthOut);
    }

    /// @notice Burn this vault's JailToken and send the original launch token to its owner.
    function unjailToken(bytes32 launchId, uint256 amount, uint256 deadline)
        external
        onlyOwner
        nonReentrant
    {
        if (launchId == bytes32(0) || amount == 0) revert InvalidAmount();
        _jailSwapVault(launchId).unjailTokenFromPersonalVault(amount, owner, deadline);
        emit PersonalJailTokenUnjailed(launchId, amount, owner);
    }

    /// @notice Redeem JailETH into native ETH held in this personal vault.
    function redeemJailETH(bytes32 launchId, uint256 amount, uint256 deadline)
        external
        onlyOwner
        nonReentrant
    {
        if (launchId == bytes32(0) || amount == 0) revert InvalidAmount();
        _jailSwapVault(launchId).redeemJailETHFromPersonalVault(amount, deadline);
        emit PersonalJailETHRedeemed(launchId, amount);
    }

    /// @notice Withdraw native ETH from this vault to its owner wallet.
    function withdrawETH(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < amount) revert InsufficientETH();
        (bool success,) = payable(owner).call{value: amount}("");
        if (!success) revert PayoutFailed();
        emit NativeETHWithdrawn(owner, amount);
    }

    function _jailSwapVault(bytes32 launchId)
        private
        view
        returns (IPersonalJailSwapVault jailSwapVault)
    {
        address registry = vaultFactory();
        address vault = IPersonalJailVaultLaunchRegistry(registry)
            .jailSwapVaultByLaunch(launchId);
        if (vault.code.length == 0) revert MissingLaunchVault();
        jailSwapVault = IPersonalJailSwapVault(vault);
    }

    function _trackLaunch(bytes32 launchId) private {
        if (!_trackedLaunch[launchId]) {
            _trackedLaunch[launchId] = true;
            _trackedLaunchIds.push(launchId);
        }
    }
}
