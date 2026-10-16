// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ArmoreumBridgeVault} from "./bridge/ArmoreumBridgeVault.sol";
import {JailSwapVault} from "./JailSwapVault.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";
import {TaxRouter} from "./TaxRouter.sol";

interface ILaunchModePolicy {
    function isTaxSourceApprovedForMode(
        address factory,
        uint8 taxDistributionMode,
        address taxSource
    ) external view returns (bool);
}

interface IRewardVaultIdentity {
    function launchId() external view returns (bytes32);
    function creator() external view returns (address);
}

interface IFeeVaultIdentity {
    function launchId() external view returns (bytes32);
    function creator() external view returns (address);
    function launchToken() external view returns (address);
    function buybackExecutor() external view returns (address);
    function bridgeVault() external view returns (address);
}

interface IMultichainVaultIdentity {
    function launchId() external view returns (bytes32);
    function creator() external view returns (address);
    function launchFactory() external view returns (address);
    function launchToken() external view returns (address);
    function taxRouter() external view returns (address);
}

interface IJailTokenFactory {
    function jailTokenImplementation() external view returns (address);
    function jailEthImplementation() external view returns (address);
    function jailTokens(bytes32 launchId) external view returns (address);
    function jailEthReceipts(bytes32 launchId) external view returns (address);
    function createJailToken(
        bytes32 launchId,
        address mainToken,
        address vault,
        string calldata name,
        string calldata symbol,
        address instanceAdmin,
        address instanceUpgrader
    ) external returns (address jailToken);
}

interface IPersonalJailVaultFactory {
    function vaultFactory() external view returns (address);
    function isVault(address candidate) external view returns (bool);
}

/// @notice Creates each launch's Bridge Vault and keeps the authoritative per-chain vault map.
/// @dev The existing ArmoreumFactory remains responsible for the passkey-gated Creator Vault
///      and fee-routing proxy pair. It registers those instances here in the same launch tx.
contract VaultFactory is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    error InvalidConfiguration();
    error UnauthorizedLaunchFactory();
    error DuplicateLaunch();
    error VaultSetMismatch();

    event BridgeVaultCreated(
        bytes32 indexed launchId,
        address indexed token,
        address indexed creator,
        address bridgeVault,
        uint256 chainId,
        bytes32 configurationHash
    );
    event VaultSetRegistered(
        bytes32 indexed launchId,
        address indexed token,
        address indexed creator,
        address feeVault,
        address creatorVault,
        address bridgeVault,
        uint256 chainId,
        bytes32 configurationHash
    );
    event VaultImplementationsChanged(
        address indexed creatorVaultImplementation,
        address indexed feeVaultImplementation,
        uint256 version
    );
    event JailSwapImplementationsChanged(
        address indexed jailSwapVaultImplementation,
        address indexed jailTokenFactory,
        uint256 version
    );
    event JailSwapSystemCreated(
        bytes32 indexed launchId,
        address indexed token,
        address indexed jailSwapVault,
        address jailToken,
        address jailEthReceipt,
        uint256 chainId,
        bytes32 configurationHash
    );

    struct VaultSet {
        address token;
        address creator;
        address feeVault;
        address creatorVault;
        address bridgeVault;
        uint256 chainId;
        bytes32 configurationHash;
        bool registered;
    }

    struct JailAssetPosition {
        bytes32 launchId;
        address jailSwapVault;
        address launchToken;
        address jailToken;
        uint256 jailTokenBalance;
        address jailEthReceipt;
        uint256 jailEthBalance;
    }

    address public canonicalOwner;
    address public emergencyOperator;
    address public launchFactory;
    address public creatorVaultImplementation;
    address public feeVaultImplementation;
    uint256 public implementationVersion;
    mapping(bytes32 launchId => VaultSet vaults) private vaultSets;
    mapping(bytes32 launchId => address bridgeVault) public bridgeVaultByLaunch;
    mapping(bytes32 launchId => address creator) public bridgeCreatorByLaunch;
    mapping(bytes32 launchId => bytes32 configurationHash) public bridgeConfigurationHash;
    mapping(bytes32 launchId => address creatorVault) public creatorVaultByLaunch;
    mapping(bytes32 launchId => address feeVault) public feeVaultByLaunch;
    mapping(address token => bytes32 launchId) public launchIdByToken;
    address public jailSwapVaultImplementation;
    address public jailTokenFactory;
    uint256 public jailSwapImplementationVersion;
    mapping(bytes32 launchId => address jailSwapVault) public jailSwapVaultByLaunch;
    mapping(bytes32 launchId => address jailToken) public jailTokenByLaunch;
    mapping(bytes32 launchId => address jailEthReceipt) public jailEthReceiptByLaunch;
    mapping(bytes32 launchId => bytes32 configurationHash) public jailSwapConfigurationHash;
    address public personalJailVaultFactory;
    address public multichainVaultImplementation;
    mapping(bytes32 launchId => address vault) public multichainVaultProxyByLaunch;
    uint256 public multichainVaultImplementationVersion;
    address public taxSourceModePolicy;

    event PersonalJailVaultFactoryChanged(address indexed factory);
    event MultichainVaultImplementationChanged(address indexed implementation, uint256 version);
    event TaxSourceModePolicyChanged(address indexed policy);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address canonicalOwner_,
        address emergencyOperator_,
        address launchFactory_
    ) external initializer {
        if (
            canonicalOwner_ == address(0) || emergencyOperator_ == address(0)
                || launchFactory_.code.length == 0
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(address(this));
        __AccessControl_init();
        canonicalOwner = canonicalOwner_;
        emergencyOperator = emergencyOperator_;
        launchFactory = launchFactory_;
        _grantRole(DEFAULT_ADMIN_ROLE, canonicalOwner_);
        _grantRole(UPGRADER_ROLE, canonicalOwner_);
    }

    function setImplementations(
        address creatorImplementation_,
        address feeImplementation_,
        uint256 version
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            creatorImplementation_.code.length == 0 || feeImplementation_.code.length == 0
                || version <= implementationVersion
        ) revert InvalidConfiguration();
        _requireUupsImplementation(creatorImplementation_);
        _requireUupsImplementation(feeImplementation_);
        AddressPrefix.require6900(creatorImplementation_);
        AddressPrefix.require6900(feeImplementation_);
        creatorVaultImplementation = creatorImplementation_;
        feeVaultImplementation = feeImplementation_;
        implementationVersion = version;
        emit VaultImplementationsChanged(creatorImplementation_, feeImplementation_, version);
    }

    /// @notice Sets the implementation used only for new staged Multichain vaults.
    function setMultichainVaultImplementation(address implementation_, uint256 version)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (
            implementation_.code.length == 0
                || version <= multichainVaultImplementationVersion
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(implementation_);
        multichainVaultImplementation = implementation_;
        multichainVaultImplementationVersion = version;
        emit MultichainVaultImplementationChanged(implementation_, version);
    }

    function setJailSwapImplementations(
        address jailSwapImplementation_,
        address jailTokenFactory_,
        uint256 version
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            jailSwapImplementation_.code.length == 0 || jailTokenFactory_.code.length == 0
                || version <= jailSwapImplementationVersion
        ) revert InvalidConfiguration();
        _requireUupsImplementation(jailSwapImplementation_);
        AddressPrefix.require6900(jailSwapImplementation_);
        AddressPrefix.require6900(jailTokenFactory_);
        IJailTokenFactory tokenFactory = IJailTokenFactory(jailTokenFactory_);
        address tokenImplementation = tokenFactory.jailTokenImplementation();
        address ethImplementation = tokenFactory.jailEthImplementation();
        if (
            tokenImplementation.code.length == 0 || ethImplementation.code.length == 0
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(tokenImplementation);
        AddressPrefix.require6900(ethImplementation);

        jailSwapVaultImplementation = jailSwapImplementation_;
        jailTokenFactory = jailTokenFactory_;
        jailSwapImplementationVersion = version;
        emit JailSwapImplementationsChanged(
            jailSwapImplementation_, jailTokenFactory_, version
        );
    }

    /// @notice Registers the one trusted factory allowed to create per-wallet Jail Vaults.
    function setPersonalJailVaultFactory(address factory_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (factory_.code.length == 0) revert InvalidConfiguration();
        AddressPrefix.require6900(factory_);
        if (IPersonalJailVaultFactory(factory_).vaultFactory() != address(this)) {
            revert InvalidConfiguration();
        }
        personalJailVaultFactory = factory_;
        emit PersonalJailVaultFactoryChanged(factory_);
    }

    function isPersonalJailVault(address candidate) external view returns (bool) {
        address factory_ = personalJailVaultFactory;
        if (factory_ == address(0) || candidate == address(0)) return false;
        return IPersonalJailVaultFactory(factory_).isVault(candidate);
    }

    /// @notice Reads only the two protected receipt types for a wallet across supplied launch IDs.
    function getJailAssetBalances(address account, bytes32[] calldata launchIds)
        external
        view
        returns (JailAssetPosition[] memory positions)
    {
        if (account == address(0)) revert InvalidConfiguration();
        positions = new JailAssetPosition[](launchIds.length);
        for (uint256 i; i < launchIds.length; ++i) {
            bytes32 launchId = launchIds[i];
            address swapVault = jailSwapVaultByLaunch[launchId];
            address launchToken = vaultSets[launchId].token;
            address jailToken = jailTokenByLaunch[launchId];
            address jailEthReceipt = jailEthReceiptByLaunch[launchId];
            uint256 jailTokenBalance;
            uint256 jailEthBalance;
            if (jailToken.code.length != 0) {
                jailTokenBalance = IERC20Metadata(jailToken).balanceOf(account);
            }
            if (jailEthReceipt.code.length != 0) {
                jailEthBalance = IERC20Metadata(jailEthReceipt).balanceOf(account);
            }
            positions[i] = JailAssetPosition({
                launchId: launchId,
                jailSwapVault: swapVault,
                launchToken: launchToken,
                jailToken: jailToken,
                jailTokenBalance: jailTokenBalance,
                jailEthReceipt: jailEthReceipt,
                jailEthBalance: jailEthBalance
            });
        }
    }

    function predictCreatorVaultAddress(bytes32 launchId, bytes32 salt, bytes calldata initialization)
        external
        view
        returns (address)
    {
        if (launchId == bytes32(0)) revert InvalidConfiguration();
        bytes memory initCode = _proxyInitCode(creatorVaultImplementation, initialization);
        return Create2.computeAddress(salt, keccak256(initCode), address(this));
    }

    function creatorProxyInitCodeHash(bytes calldata initialization)
        external
        view
        returns (bytes32)
    {
        if (creatorVaultImplementation.code.length == 0) revert InvalidConfiguration();
        return keccak256(_proxyInitCode(creatorVaultImplementation, initialization));
    }

    function predictFeeVaultAddress(bytes32 launchId, bytes32 salt, bytes calldata initialization)
        external
        view
        returns (address)
    {
        if (launchId == bytes32(0)) revert InvalidConfiguration();
        bytes memory initCode = _proxyInitCode(feeVaultImplementation, initialization);
        return Create2.computeAddress(salt, keccak256(initCode), address(this));
    }

    function feeProxyInitCodeHash(bytes calldata initialization)
        external
        view
        returns (bytes32)
    {
        if (feeVaultImplementation.code.length == 0) revert InvalidConfiguration();
        return keccak256(_proxyInitCode(feeVaultImplementation, initialization));
    }

    function predictMultichainVaultAddress(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external view returns (address) {
        if (launchId == bytes32(0) || multichainVaultImplementation.code.length == 0) {
            revert InvalidConfiguration();
        }
        bytes memory initCode =
            _proxyInitCode(multichainVaultImplementation, initialization);
        return Create2.computeAddress(salt, keccak256(initCode), address(this));
    }

    function deployCreatorVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address proxy) {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        if (launchId == bytes32(0) || creatorVaultImplementation == address(0)) {
            revert InvalidConfiguration();
        }
        proxy = Create2.computeAddress(
            salt,
            keccak256(_proxyInitCode(creatorVaultImplementation, initialization)),
            address(this)
        );
        address existing = creatorVaultByLaunch[launchId];
        if (existing != address(0)) {
            if (existing != proxy || proxy.code.length == 0) revert DuplicateLaunch();
            return existing;
        }
        if (proxy.code.length != 0) revert DuplicateLaunch();
        proxy = Create2.deploy(
            0, salt, _proxyInitCode(creatorVaultImplementation, initialization)
        );
        creatorVaultByLaunch[launchId] = proxy;
    }

    function deployFeeVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address proxy) {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        _requireTaxSourceModeApproval(initialization);
        if (launchId == bytes32(0) || feeVaultImplementation == address(0)) {
            revert InvalidConfiguration();
        }
        proxy = Create2.computeAddress(
            salt,
            keccak256(_proxyInitCode(feeVaultImplementation, initialization)),
            address(this)
        );
        address existing = feeVaultByLaunch[launchId];
        if (existing != address(0)) {
            if (existing != proxy || proxy.code.length == 0) revert DuplicateLaunch();
            return existing;
        }
        if (proxy.code.length != 0) revert DuplicateLaunch();
        proxy = Create2.deploy(
            0, salt, _proxyInitCode(feeVaultImplementation, initialization)
        );
        feeVaultByLaunch[launchId] = proxy;
    }

    function taxSourceModePolicyVersion() external pure returns (uint256) {
        return 1;
    }

    function setTaxSourceModePolicy(address policy) external onlyRole(UPGRADER_ROLE) {
        if (taxSourceModePolicy != address(0) || policy.code.length == 0) {
            revert InvalidConfiguration();
        }
        taxSourceModePolicy = policy;
        emit TaxSourceModePolicyChanged(policy);
    }

    function _requireTaxSourceModeApproval(bytes calldata initialization) private view {
        if (
            initialization.length != 548
                || bytes4(initialization[0:4]) != TaxRouter.initialize.selector
        ) revert InvalidConfiguration();

        address taxSource;
        uint8 taxDistributionMode;
        (
            ,
            ,
            ,
            taxSource,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            ,
            taxDistributionMode,
            ,
            ,
            ,

        ) = abi.decode(
            initialization[4:],
            (
                bytes32,
                address,
                address,
                address,
                address,
                uint16,
                address,
                address,
                address,
                address,
                address,
                address,
                uint8,
                address,
                address,
                address,
                address
            )
        );

        address modeModule = taxSourceModePolicy;
        if (
            modeModule.code.length == 0
                || !ILaunchModePolicy(modeModule).isTaxSourceApprovedForMode(
                    launchFactory, taxDistributionMode, taxSource
                )
        ) revert InvalidConfiguration();
    }

    /// @notice Deploys the per-launch vault before the token so Pons can send its initial buy directly to it.
    function deployMultichainVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address proxy) {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        if (launchId == bytes32(0) || multichainVaultImplementation.code.length == 0) {
            revert InvalidConfiguration();
        }
        bytes memory initCode =
            _proxyInitCode(multichainVaultImplementation, initialization);
        proxy = Create2.computeAddress(salt, keccak256(initCode), address(this));
        address existing = multichainVaultProxyByLaunch[launchId];
        if (existing != address(0)) {
            if (existing != proxy || proxy.code.length == 0) revert DuplicateLaunch();
            return existing;
        }
        if (proxy.code.length != 0) revert DuplicateLaunch();
        proxy = Create2.deploy(0, salt, initCode);
        multichainVaultProxyByLaunch[launchId] = proxy;
    }

    /// @notice Creates the launch-specific Bridge Vault before the reward system is enrolled.
    /// @dev A creator can retry an identical request, but cannot squat another creator's launch.
    function createBridgeVault(
        bytes32 launchId,
        address token,
        address creator,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 sqrtPriceLimitX96
    ) external returns (address bridgeVault) {
        if (
            launchId == bytes32(0) || token.code.length == 0 || creator != msg.sender
                || address(poolManager).code.length == 0
        ) revert InvalidConfiguration();

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid,
                launchId,
                token,
                creator,
                address(poolManager),
                poolKey.currency0,
                poolKey.currency1,
                poolKey.fee,
                poolKey.tickSpacing,
                poolKey.hooks,
                sqrtPriceLimitX96
            )
        );
        bridgeVault = bridgeVaultByLaunch[launchId];
        if (bridgeVault != address(0)) {
            if (
                bridgeCreatorByLaunch[launchId] != creator
                    || bridgeConfigurationHash[launchId] != configHash
            ) revert DuplicateLaunch();
            return bridgeVault;
        }
        if (launchIdByToken[token] != bytes32(0)) revert DuplicateLaunch();

        bytes32 salt = keccak256(abi.encode(block.chainid, launchId, token, creator));
        bridgeVault = address(
            new ArmoreumBridgeVault{salt: salt}(
                poolManager,
                launchId,
                token,
                canonicalOwner,
                emergencyOperator,
                launchFactory,
                poolKey,
                sqrtPriceLimitX96
            )
        );
        bridgeVaultByLaunch[launchId] = bridgeVault;
        bridgeCreatorByLaunch[launchId] = creator;
        bridgeConfigurationHash[launchId] = configHash;
        launchIdByToken[token] = launchId;
        emit BridgeVaultCreated(
            launchId, token, creator, bridgeVault, block.chainid, configHash
        );
    }

    /// @notice Creates a launch's passkey-gated JailSwap vault and its isolated receipts.
    /// @dev Only ArmoreumFactory may call after registering the corresponding reward system.
    function createJailSwapSystem(
        bytes32 launchId,
        address token,
        address creator,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 buySqrtPriceLimitX96,
        uint160 sellSqrtPriceLimitX96,
        address passkeyVerifier,
        bytes32 rpIdHash
    ) external returns (address vault, address jailToken, address jailEthReceipt) {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        VaultSet storage registered = vaultSets[launchId];
        if (
            !registered.registered || registered.token != token
                || registered.creator != creator || token.code.length == 0
                || address(poolManager).code.length == 0 || passkeyVerifier.code.length == 0
                || rpIdHash == bytes32(0) || jailSwapVaultImplementation == address(0)
                || jailTokenFactory == address(0)
        ) revert InvalidConfiguration();

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid,
                launchId,
                token,
                creator,
                address(poolManager),
                poolKey.currency0,
                poolKey.currency1,
                poolKey.fee,
                poolKey.tickSpacing,
                poolKey.hooks,
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96,
                passkeyVerifier,
                rpIdHash,
                jailSwapVaultImplementation,
                jailTokenFactory
            )
        );
        vault = jailSwapVaultByLaunch[launchId];
        if (vault != address(0)) {
            if (
                jailSwapConfigurationHash[launchId] != configHash
                    || jailTokenByLaunch[launchId] == address(0)
                    || jailEthReceiptByLaunch[launchId] == address(0)
            ) revert DuplicateLaunch();
            return (
                vault,
                jailTokenByLaunch[launchId],
                jailEthReceiptByLaunch[launchId]
            );
        }

        bytes memory initialization = abi.encodeCall(
            JailSwapVault.initialize,
            (
                launchId,
                token,
                address(poolManager),
                poolKey,
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96,
                address(this),
                passkeyVerifier,
                rpIdHash,
                canonicalOwner,
                canonicalOwner,
                emergencyOperator
            )
        );
        bytes32 salt = keccak256(
            abi.encode(block.chainid, launchId, token, creator, bytes32("JAILSWAP_VAULT"))
        );
        vault = Create2.deploy(
            0, salt, _proxyInitCode(jailSwapVaultImplementation, initialization)
        );

        string memory name = IERC20Metadata(token).name();
        string memory symbol = IERC20Metadata(token).symbol();
        jailToken = IJailTokenFactory(jailTokenFactory).createJailToken(
            launchId,
            token,
            vault,
            string.concat("Jail ", name),
            string.concat("j", symbol),
            canonicalOwner,
            canonicalOwner
        );
        jailEthReceipt = IJailTokenFactory(jailTokenFactory).jailEthReceipts(launchId);
        if (jailEthReceipt.code.length == 0) revert InvalidConfiguration();
        JailSwapVault(payable(vault)).configureReceipts(jailToken, jailEthReceipt);

        jailSwapVaultByLaunch[launchId] = vault;
        jailTokenByLaunch[launchId] = jailToken;
        jailEthReceiptByLaunch[launchId] = jailEthReceipt;
        jailSwapConfigurationHash[launchId] = configHash;
        emit JailSwapSystemCreated(
            launchId,
            token,
            vault,
            jailToken,
            jailEthReceipt,
            block.chainid,
            configHash
        );
    }

    /// @notice Records the vaults created for a launch; the fee vault is its TaxRouter.
    /// @dev Only the passkey-gated ArmoreumFactory may register a launch's vault set.
    function registerVaultSet(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address creatorVault,
        address bridgeVault
    ) external {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        if (
            launchId == bytes32(0) || token.code.length == 0 || creator == address(0)
                || feeVault.code.length == 0 || creatorVault.code.length == 0
        ) revert InvalidConfiguration();

        IFeeVaultIdentity fee = IFeeVaultIdentity(feeVault);
        IRewardVaultIdentity rewards = IRewardVaultIdentity(creatorVault);
        if (
            fee.launchId() != launchId || fee.creator() != creator
                || fee.launchToken() != token || rewards.launchId() != launchId
                || rewards.creator() != creator
        ) revert VaultSetMismatch();

        if (bridgeVault != address(0)) {
            if (
                bridgeVaultByLaunch[launchId] != bridgeVault
                    || bridgeCreatorByLaunch[launchId] != creator
                    || fee.bridgeVault() != bridgeVault
                    || fee.buybackExecutor() != bridgeVault
                    || ArmoreumBridgeVault(payable(bridgeVault)).taxRouter() != feeVault
            ) revert VaultSetMismatch();
        } else if (fee.bridgeVault() != address(0)) {
            revert VaultSetMismatch();
        }
        if (
            (creatorVaultImplementation != address(0) || feeVaultImplementation != address(0))
                && (
                    creatorVaultByLaunch[launchId] != creatorVault
                        || feeVaultByLaunch[launchId] != feeVault
                )
        ) revert VaultSetMismatch();

        bytes32 configHash = keccak256(
            abi.encode(
                block.chainid, launchId, token, creator, feeVault, creatorVault, bridgeVault
            )
        );
        VaultSet storage existing = vaultSets[launchId];
        if (existing.registered) {
            if (
                existing.token != token || existing.creator != creator
                    || existing.feeVault != feeVault || existing.creatorVault != creatorVault
                    || existing.bridgeVault != bridgeVault
                    || existing.configurationHash != configHash
            ) revert DuplicateLaunch();
            return;
        }
        bytes32 mappedLaunch = launchIdByToken[token];
        if (mappedLaunch != bytes32(0) && mappedLaunch != launchId) {
            revert DuplicateLaunch();
        }
        launchIdByToken[token] = launchId;
        vaultSets[launchId] = VaultSet({
            token: token,
            creator: creator,
            feeVault: feeVault,
            creatorVault: creatorVault,
            bridgeVault: bridgeVault,
            chainId: block.chainid,
            configurationHash: configHash,
            registered: true
        });
        emit VaultSetRegistered(
            launchId,
            token,
            creator,
            feeVault,
            creatorVault,
            bridgeVault,
            block.chainid,
            configHash
        );
    }

    /// @notice Registers a prepared Multichain vault after its token and market are bound.
    /// @dev The vault is created before launch so it can receive Pons's atomic initial buy.
    function registerMultichainVault(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address bridgeVault
    ) external {
        if (msg.sender != launchFactory) revert UnauthorizedLaunchFactory();
        if (
            launchId == bytes32(0) || token.code.length == 0 || creator == address(0)
                || feeVault.code.length == 0 || bridgeVault.code.length == 0
        ) revert InvalidConfiguration();

        IFeeVaultIdentity fee = IFeeVaultIdentity(feeVault);
        IMultichainVaultIdentity bridge = IMultichainVaultIdentity(bridgeVault);
        if (
            fee.launchId() != launchId || fee.creator() != creator
                || fee.launchToken() != token || fee.bridgeVault() != bridgeVault
                || fee.buybackExecutor() != bridgeVault
                || bridge.launchId() != launchId || bridge.creator() != creator
                || bridge.launchFactory() != launchFactory
                || bridge.launchToken() != token || bridge.taxRouter() != feeVault
        ) revert VaultSetMismatch();

        address existing = bridgeVaultByLaunch[launchId];
        if (existing != address(0)) {
            if (
                existing != bridgeVault || bridgeCreatorByLaunch[launchId] != creator
                    || bridgeConfigurationHash[launchId]
                        != keccak256(
                            abi.encode(
                                block.chainid, launchId, token, creator, feeVault, bridgeVault
                            )
                        )
            ) revert DuplicateLaunch();
            return;
        }
        bytes32 mappedLaunch = launchIdByToken[token];
        if (mappedLaunch != bytes32(0) && mappedLaunch != launchId) {
            revert DuplicateLaunch();
        }
        bridgeVaultByLaunch[launchId] = bridgeVault;
        bridgeCreatorByLaunch[launchId] = creator;
        bridgeConfigurationHash[launchId] = keccak256(
            abi.encode(block.chainid, launchId, token, creator, feeVault, bridgeVault)
        );
        launchIdByToken[token] = launchId;
        emit BridgeVaultCreated(
            launchId,
            token,
            creator,
            bridgeVault,
            block.chainid,
            bridgeConfigurationHash[launchId]
        );
    }

    function getVaultSet(bytes32 launchId) external view returns (VaultSet memory) {
        return vaultSets[launchId];
    }

    function _proxyInitCode(address implementation, bytes memory initialization)
        private
        pure
        returns (bytes memory)
    {
        if (implementation == address(0)) revert InvalidConfiguration();
        return abi.encodePacked(
            type(ERC1967Proxy).creationCode, abi.encode(implementation, initialization)
        );
    }

    function _requireUupsImplementation(address implementation) private view {
        try IERC1822Proxiable(implementation).proxiableUUID() returns (bytes32 slot) {
            if (
                slot
                    != 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
            ) revert InvalidConfiguration();
        } catch {
            revert InvalidConfiguration();
        }
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
