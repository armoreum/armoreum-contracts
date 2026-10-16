// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CreatorRewardVault} from "./CreatorRewardVault.sol";
import {TaxRouter} from "./TaxRouter.sol";
import {ArmoreumMultichainVault} from "./bridge/ArmoreumMultichainVault.sol";
import {IArmoreumPasskeyVerifier} from "./interfaces/IArmoreumPasskeyVerifier.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";

interface IBridgeVaultTaxRouterRegistrar {
    function registerTaxRouter(address taxRouterProxy) external;
}

interface IVaultFactoryRegistrar {
    function launchFactory() external view returns (address);
    function emergencyOperator() external view returns (address);
    function creatorVaultImplementation() external view returns (address);
    function feeVaultImplementation() external view returns (address);
    function creatorProxyInitCodeHash(bytes calldata initialization)
        external
        view
        returns (bytes32);
    function feeProxyInitCodeHash(bytes calldata initialization)
        external
        view
        returns (bytes32);
    function multichainVaultImplementation() external view returns (address);
    function multichainVaultProxyByLaunch(bytes32 launchId) external view returns (address);
    function predictCreatorVaultAddress(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external view returns (address);
    function predictFeeVaultAddress(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external view returns (address);
    function deployCreatorVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address);
    function deployFeeVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address);
    function predictMultichainVaultAddress(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external view returns (address);
    function deployMultichainVaultProxy(
        bytes32 launchId,
        bytes32 salt,
        bytes calldata initialization
    ) external returns (address);
    function registerVaultSet(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address creatorVault,
        address bridgeVault
    ) external;
    function registerMultichainVault(
        bytes32 launchId,
        address token,
        address creator,
        address feeVault,
        address bridgeVault
    ) external;
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
    ) external returns (address vault, address jailToken, address jailEthReceipt);
}

interface IPasswordCreatorAuthorizationVault {
    function consumePasswordAuthorization(
        uint8 purpose,
        bytes32 digest,
        bytes32 oneTimeProof,
        bytes calldata passwordSignature
    ) external;
}

/// @notice Deploys an isolated vault/router proxy pair for an ETH-denominated launch.
/// @dev This does not create a Pons token. The launch must set the predicted TaxRouter as Pons's creatorFeeRecipient.
contract ArmoreumFactory is
    Initializable,
    AccessControlUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 private constant ENROLLMENT_TYPEHASH = keccak256(
        "Enrollment(bytes32 launchId,address creator,address quoteAsset,address taxSource,uint16 additionalTaxBps,uint8 taxDistributionMode,address launchToken,address buybackExecutor,address bridgeVault,address ponsFeeProcessor,bytes32 rpIdHash,bytes32 passkeyX,bytes32 passkeyY,bytes32 credentialIdHash,bytes32 authorizationEpochRoot,bytes32 claimCommitment,bytes32 redemptionCommitment,bytes32 rotationCommitment,bytes32 recoveryCommitment,uint256 nonce,uint256 deadline,bytes32 vaultSalt,bytes32 taxRouterSalt)"
    );
    bytes32 private constant PASSWORD_ENROLLMENT_TYPEHASH = keccak256(
        "PasswordEnrollment(bytes32 launchId,address creator,address quoteAsset,address taxSource,uint16 additionalTaxBps,uint8 taxDistributionMode,address launchToken,address buybackExecutor,address bridgeVault,address ponsFeeProcessor,address authorizationSigner,bytes32 authorizationEpochRoot,bytes32 claimCommitment,bytes32 redemptionCommitment,bytes32 rotationCommitment,bytes32 recoveryCommitment,uint256 nonce,uint256 deadline,bytes32 vaultSalt,bytes32 taxRouterSalt)"
    );
    bytes32 private constant JAIL_SWAP_SETUP_TYPEHASH = keccak256(
        "JailSwapSetup(bytes32 launchId,address creator,address poolManager,bytes32 poolKeyHash,uint160 buySqrtPriceLimitX96,uint160 sellSqrtPriceLimitX96,uint256 nonce,uint256 deadline)"
    );

    error InvalidConfiguration();
    error LaunchAlreadyRegistered();
    error LaunchPaused();
    error UnsupportedQuoteAsset();
    error UnapprovedTaxSource();
    error MissingImplementation();
    error InvalidImplementation();
    error InvalidPasskey();
    error InvalidAuthorizationProof();
    error ExpiredAuthorization();

    event ImplementationsApproved(address indexed vaultImplementation, address indexed routerImplementation);
    event TaxSourceApprovalChanged(address indexed taxSource, bool approved);
    event RewardSystemCreated(
        bytes32 indexed launchId,
        address indexed creator,
        address vaultProxy,
        address taxRouterProxy,
        address taxSource,
        uint16 additionalTaxBps,
        TaxRouter.TaxDistributionMode taxDistributionMode,
        address launchToken,
        address buybackExecutor,
        address bridgeVault,
        uint256 implementationVersion
    );
    event NewLaunchesPaused(bool paused);
    event CreatorPasskeyEnrollmentUsed(address indexed creator, bytes32 indexed launchId, uint256 nonce);
    event CreatorPasswordEnrollmentUsed(
        address indexed creator, bytes32 indexed launchId, address indexed authorizationSigner, uint256 nonce
    );
    event InstanceEmergencyWithdrawerChanged(address indexed previousOperator, address indexed newOperator);
    event PonsFeeProcessorChanged(
        address indexed previousProcessor,
        address indexed newProcessor
    );
    event VaultFactoryChanged(address indexed previousFactory, address indexed newFactory);
    event PonsLaunchCompleted(
        bytes32 indexed launchId, address indexed creator, address indexed launchToken
    );
    event MultichainVaultPrepared(
        bytes32 indexed launchId, address indexed creator, address indexed vault
    );
    event MultichainLaunchCompleted(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed launchToken,
        address bridgeVault,
        uint8 market
    );

    struct LaunchConfig {
        bytes32 launchId;
        address quoteAsset;
        address taxSource;
        bytes32 passkeyX;
        bytes32 passkeyY;
        bytes32 credentialIdHash;
        uint16 additionalTaxBps;
        bytes32 authorizationEpochRoot;
        bytes32 claimCommitment;
        bytes32 redemptionCommitment;
        bytes32 rotationCommitment;
        bytes32 recoveryCommitment;
        TaxRouter.TaxDistributionMode taxDistributionMode;
        address launchToken;
        address buybackExecutor;
        address bridgeVault;
    }

    struct RewardSystem {
        address creator;
        address vault;
        address taxRouter;
        address taxSource;
        uint16 additionalTaxBps;
        uint256 implementationVersion;
        TaxRouter.TaxDistributionMode taxDistributionMode;
        address launchToken;
        address buybackExecutor;
        address bridgeVault;
    }

    address public platformTreasury;
    address public canonicalOwner;
    address public passkeyVerifier;
    bytes32 public rpIdHash;
    address public instanceAdmin;
    address public instanceUpgrader;
    address public instancePauser;
    address public instanceTreasury;
    address public instanceEmergencyWithdrawer;
    address public vaultImplementation;
    address public taxRouterImplementation;
    uint256 public implementationVersion;
    bool public newLaunchesPaused;
    mapping(bytes32 launchId => RewardSystem system) public rewardSystems;
    mapping(address taxSource => bool approved) public approvedTaxSources;
    mapping(address creator => uint256 nonce) public enrollmentNonces;
    address public foundationRecipient;
    address public ponsFeeProcessor;
    address public vaultFactory;
    mapping(bytes32 launchId => bytes32 configurationHash)
        public rewardSystemConfigurationHashes;
    mapping(bytes32 launchId => uint256 nonce) public jailSwapSetupNonces;
    mapping(bytes32 launchId => bytes32 configurationHash)
        public jailSwapSetupConfigurationHashes;
    address public multichainLaunchModule;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address canonicalOwner_,
        address passkeyVerifier_,
        bytes32 rpIdHash_,
        address vaultImplementation_,
        address taxRouterImplementation_,
        address initialTaxSource_,
        uint256 version,
        address foundationRecipient_,
        address ponsFeeProcessor_
    ) external initializer {
        _initialize(
            canonicalOwner_,
            passkeyVerifier_,
            rpIdHash_,
            vaultImplementation_,
            taxRouterImplementation_,
            initialTaxSource_,
            version,
            foundationRecipient_,
            canonicalOwner_,
            ponsFeeProcessor_
        );
    }

    function initializeWithEmergencyOperator(
        address canonicalOwner_,
        address passkeyVerifier_,
        bytes32 rpIdHash_,
        address vaultImplementation_,
        address taxRouterImplementation_,
        address initialTaxSource_,
        uint256 version,
        address foundationRecipient_,
        address emergencyWithdrawer_,
        address ponsFeeProcessor_
    ) external initializer {
        _initialize(
            canonicalOwner_,
            passkeyVerifier_,
            rpIdHash_,
            vaultImplementation_,
            taxRouterImplementation_,
            initialTaxSource_,
            version,
            foundationRecipient_,
            emergencyWithdrawer_,
            ponsFeeProcessor_
        );
    }

    function _initialize(
        address canonicalOwner_,
        address passkeyVerifier_,
        bytes32 rpIdHash_,
        address vaultImplementation_,
        address taxRouterImplementation_,
        address initialTaxSource_,
        uint256 version,
        address foundationRecipient_,
        address emergencyWithdrawer_,
        address ponsFeeProcessor_
    ) private {
        if (
            canonicalOwner_ == address(0) || passkeyVerifier_.code.length == 0
                || rpIdHash_ == bytes32(0)
                || (initialTaxSource_ != address(0) && initialTaxSource_.code.length == 0)
                || vaultImplementation_.code.length == 0
                || taxRouterImplementation_.code.length == 0 || version == 0
                || foundationRecipient_ == address(0) || emergencyWithdrawer_ == address(0)
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(address(this));
        AddressPrefix.require6900(passkeyVerifier_);
        _validateImplementation(vaultImplementation_);
        _validateImplementation(taxRouterImplementation_);

        __AccessControl_init();
        __EIP712_init("ArmoreumFactory", "1");

        platformTreasury = canonicalOwner_;
        canonicalOwner = canonicalOwner_;
        foundationRecipient = foundationRecipient_;
        ponsFeeProcessor = ponsFeeProcessor_;
        passkeyVerifier = passkeyVerifier_;
        rpIdHash = rpIdHash_;
        instanceAdmin = canonicalOwner_;
        instanceUpgrader = canonicalOwner_;
        instancePauser = canonicalOwner_;
        instanceTreasury = canonicalOwner_;
        instanceEmergencyWithdrawer = emergencyWithdrawer_;
        vaultImplementation = vaultImplementation_;
        taxRouterImplementation = taxRouterImplementation_;
        implementationVersion = version;
        if (initialTaxSource_ != address(0)) {
            approvedTaxSources[initialTaxSource_] = true;
        }
        _grantRole(DEFAULT_ADMIN_ROLE, canonicalOwner_);
        _grantRole(UPGRADER_ROLE, canonicalOwner_);
        _grantRole(PAUSER_ROLE, canonicalOwner_);
    }

    function approveImplementations(
        address vaultImplementation_,
        address taxRouterImplementation_,
        uint256 version
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            vaultImplementation_.code.length == 0 || taxRouterImplementation_.code.length == 0
                || version <= implementationVersion
        ) revert InvalidImplementation();
        _requireUupsImplementation(vaultImplementation_);
        _requireUupsImplementation(taxRouterImplementation_);
        AddressPrefix.require6900(vaultImplementation_);
        AddressPrefix.require6900(taxRouterImplementation_);
        vaultImplementation = vaultImplementation_;
        taxRouterImplementation = taxRouterImplementation_;
        implementationVersion = version;
        emit ImplementationsApproved(vaultImplementation_, taxRouterImplementation_);
    }

    function setTaxSourceApproval(address taxSource, bool approved)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (taxSource == address(0) || (approved && taxSource.code.length == 0)) {
            revert InvalidConfiguration();
        }
        approvedTaxSources[taxSource] = approved;
        emit TaxSourceApprovalChanged(taxSource, approved);
    }

    /// @notice Sets the emergency operator used for vaults created after this update.
    /// @dev Existing instances require their own role migration by the canonical admin.
    function setInstanceEmergencyWithdrawer(address emergencyWithdrawer_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (emergencyWithdrawer_ == address(0)) revert InvalidConfiguration();
        address previousOperator = instanceEmergencyWithdrawer;
        instanceEmergencyWithdrawer = emergencyWithdrawer_;
        emit InstanceEmergencyWithdrawerChanged(previousOperator, emergencyWithdrawer_);
    }

    /// @notice Sets the fee processor granted to future Pons TaxRouter instances.
    /// @dev Existing routers require their keeper role to be migrated separately.
    function setPonsFeeProcessor(address feeProcessor_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        address previousProcessor = ponsFeeProcessor;
        ponsFeeProcessor = feeProcessor_;
        emit PonsFeeProcessorChanged(previousProcessor, feeProcessor_);
    }

    /// @notice Sets the registry/factory that records per-token vault instances.
    function setVaultFactory(address vaultFactory_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            vaultFactory_.code.length == 0
                || IVaultFactoryRegistrar(vaultFactory_).launchFactory() != address(this)
                || IVaultFactoryRegistrar(vaultFactory_).emergencyOperator()
                    != instanceEmergencyWithdrawer
                || IVaultFactoryRegistrar(vaultFactory_).creatorVaultImplementation()
                    != vaultImplementation
                || IVaultFactoryRegistrar(vaultFactory_).feeVaultImplementation()
                    != taxRouterImplementation
        ) revert InvalidConfiguration();
        address previousFactory = vaultFactory;
        vaultFactory = vaultFactory_;
        emit VaultFactoryChanged(previousFactory, vaultFactory_);
    }

    function setMultichainLaunchModule(address module) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            module.code.length == 0
                || (
                    multichainLaunchModule != address(0)
                        && multichainLaunchModule != 0x6900E75917d8C2d10c4330dBD31cFA3Cf37ab447
                )
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(module);
        multichainLaunchModule = module;
    }

    /// @notice Predicts the staged Multichain vault address for one creator and launch ID.
    function predictMultichainVaultAddress(bytes32 launchId, address creator)
        public
        view
        returns (address)
    {
        if (multichainLaunchModule.code.length == 0) revert InvalidConfiguration();
        bytes memory data = abi.encodeWithSignature(
            "predictMultichainVaultAddress(bytes32,address)", launchId, creator
        );
        (bool ok, bytes memory result) = multichainLaunchModule.staticcall(data);
        if (!ok) assembly ("memory-safe") {
            revert(add(result, 0x20), mload(result))
        }
        return abi.decode(result, (address));
    }

    /// @notice Creates the launch-specific vault before either chain's token exists.
    /// @dev The creator must prepare this address before signing the TaxRouter enrollment.
    function createPasswordRewardSystem(
        LaunchConfig calldata config,
        address authorizationSigner,
        uint256 deadline,
        bytes calldata passwordSignature,
        bytes32 vaultSalt,
        bytes32 taxRouterSalt,
        bytes32[] calldata initialEpochProof
    ) external returns (address vaultProxy, address taxRouterProxy) {
        return _createRewardSystem(
            config,
            deadline,
            passwordSignature,
            vaultSalt,
            taxRouterSalt,
            initialEpochProof,
            authorizationSigner,
            msg.sender,
            bytes(""),
            false
        );
    }

    function createPasswordRewardSystemFor(
        LaunchConfig calldata config,
        address creator,
        address authorizationSigner,
        uint256 deadline,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature,
        bytes32 vaultSalt,
        bytes32 taxRouterSalt,
        bytes32[] calldata initialEpochProof
    ) external returns (address vaultProxy, address taxRouterProxy) {
        if (creator == address(0)) revert InvalidConfiguration();
        return _createRewardSystem(
            config,
            deadline,
            passwordSignature,
            vaultSalt,
            taxRouterSalt,
            initialEpochProof,
            authorizationSigner,
            creator,
            creatorSignature,
            true
        );
    }

    function passwordEnrollmentDigest(
        LaunchConfig calldata config,
        address creator,
        address authorizationSigner,
        uint256 deadline,
        bytes32 vaultSalt,
        bytes32 taxRouterSalt
    ) external view returns (bytes32) {
        return _passwordEnrollmentDigest(
            config,
            creator,
            authorizationSigner,
            enrollmentNonces[creator],
            deadline,
            vaultSalt,
            taxRouterSalt
        );
    }

    /// @notice Completes a registered launch with its isolated JailSwap vault and receipts.
    /// @dev Pool and hook details are supplied once they are available; retries are idempotent.
    function createJailSwapSystem(
        bytes32 launchId,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 buySqrtPriceLimitX96,
        uint160 sellSqrtPriceLimitX96,
        uint256 deadline,
        bytes calldata passkeyAssertion
    ) external returns (address vault, address jailToken, address jailEthReceipt) {
        RewardSystem storage system = rewardSystems[launchId];
        if (
            vaultFactory == address(0) || system.creator != msg.sender
                || system.launchToken.code.length == 0
                || system.taxSource != address(poolKey.hooks)
        ) revert InvalidConfiguration();

        bytes32 configurationHash = keccak256(
            abi.encode(
                block.chainid,
                launchId,
                msg.sender,
                address(poolManager),
                keccak256(abi.encode(poolKey)),
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96
            )
        );
        bytes32 previousConfigurationHash = jailSwapSetupConfigurationHashes[launchId];
        if (previousConfigurationHash != bytes32(0)) {
            if (previousConfigurationHash != configurationHash) revert LaunchAlreadyRegistered();
            (vault, jailToken, jailEthReceipt) =
                IVaultFactoryRegistrar(vaultFactory).createJailSwapSystem(
                    launchId,
                    system.launchToken,
                    msg.sender,
                    poolManager,
                    poolKey,
                    buySqrtPriceLimitX96,
                    sellSqrtPriceLimitX96,
                    passkeyVerifier,
                    rpIdHash
                );
            if (
                vault.code.length == 0 || jailToken.code.length == 0
                    || jailEthReceipt.code.length == 0
            ) revert InvalidConfiguration();
            return (vault, jailToken, jailEthReceipt);
        }
        if (deadline <= block.timestamp) revert ExpiredAuthorization();

        bytes32 digest = jailSwapSetupAuthorizationDigest(
            launchId,
            poolManager,
            poolKey,
            buySqrtPriceLimitX96,
            sellSqrtPriceLimitX96,
            deadline
        );
        bool passkeyValid;
        try IArmoreumPasskeyVerifier(passkeyVerifier).verify(
            digest,
            passkeyAssertion,
            rpIdHash,
            CreatorRewardVault(payable(system.vault)).passkeyX(),
            CreatorRewardVault(payable(system.vault)).passkeyY()
        ) returns (bool valid) {
            passkeyValid = valid;
        } catch {
            revert InvalidPasskey();
        }
        if (!passkeyValid) revert InvalidPasskey();

        jailSwapSetupNonces[launchId] += 1;
        (vault, jailToken, jailEthReceipt) =
            IVaultFactoryRegistrar(vaultFactory).createJailSwapSystem(
                launchId,
                system.launchToken,
                msg.sender,
                poolManager,
                poolKey,
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96,
                passkeyVerifier,
                rpIdHash
            );
        if (
            vault.code.length == 0 || jailToken.code.length == 0
                || jailEthReceipt.code.length == 0
        ) revert InvalidConfiguration();
        jailSwapSetupConfigurationHashes[launchId] = configurationHash;
        return (vault, jailToken, jailEthReceipt);
    }

    function createPasswordJailSwapSystem(
        bytes32 launchId,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 buySqrtPriceLimitX96,
        uint160 sellSqrtPriceLimitX96,
        uint256 deadline,
        bytes32 oneTimeProof,
        bytes calldata passwordSignature
    ) external returns (address vault, address jailToken, address jailEthReceipt) {
        RewardSystem storage system = rewardSystems[launchId];
        if (
            vaultFactory == address(0) || system.creator != msg.sender
                || system.launchToken.code.length == 0
                || system.taxSource != address(poolKey.hooks)
        ) revert InvalidConfiguration();

        bytes32 configurationHash = keccak256(
            abi.encode(
                block.chainid,
                launchId,
                msg.sender,
                address(poolManager),
                keccak256(abi.encode(poolKey)),
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96
            )
        );
        bytes32 previousConfigurationHash = jailSwapSetupConfigurationHashes[launchId];
        if (previousConfigurationHash != bytes32(0)) {
            if (previousConfigurationHash != configurationHash) revert LaunchAlreadyRegistered();
            (vault, jailToken, jailEthReceipt) =
                IVaultFactoryRegistrar(vaultFactory).createJailSwapSystem(
                    launchId,
                    system.launchToken,
                    msg.sender,
                    poolManager,
                    poolKey,
                    buySqrtPriceLimitX96,
                    sellSqrtPriceLimitX96,
                    passkeyVerifier,
                    rpIdHash
                );
            if (
                vault.code.length == 0 || jailToken.code.length == 0
                    || jailEthReceipt.code.length == 0
            ) revert InvalidConfiguration();
            return (vault, jailToken, jailEthReceipt);
        }
        if (deadline <= block.timestamp) revert ExpiredAuthorization();

        bytes32 digest = jailSwapSetupAuthorizationDigest(
            launchId,
            poolManager,
            poolKey,
            buySqrtPriceLimitX96,
            sellSqrtPriceLimitX96,
            deadline
        );
        IPasswordCreatorAuthorizationVault(system.vault).consumePasswordAuthorization(
            1, digest, oneTimeProof, passwordSignature
        );
        jailSwapSetupNonces[launchId] += 1;
        (vault, jailToken, jailEthReceipt) =
            IVaultFactoryRegistrar(vaultFactory).createJailSwapSystem(
                launchId,
                system.launchToken,
                msg.sender,
                poolManager,
                poolKey,
                buySqrtPriceLimitX96,
                sellSqrtPriceLimitX96,
                passkeyVerifier,
                rpIdHash
            );
        if (
            vault.code.length == 0 || jailToken.code.length == 0
                || jailEthReceipt.code.length == 0
        ) revert InvalidConfiguration();
        jailSwapSetupConfigurationHashes[launchId] = configurationHash;
    }

    function jailSwapSetupAuthorizationDigest(
        bytes32 launchId,
        IPoolManager poolManager,
        PoolKey calldata poolKey,
        uint160 buySqrtPriceLimitX96,
        uint160 sellSqrtPriceLimitX96,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    JAIL_SWAP_SETUP_TYPEHASH,
                    launchId,
                    msg.sender,
                    address(poolManager),
                    keccak256(abi.encode(poolKey)),
                    buySqrtPriceLimitX96,
                    sellSqrtPriceLimitX96,
                    jailSwapSetupNonces[launchId],
                    deadline
                )
            )
        );
    }

    function _createRewardSystem(
        LaunchConfig calldata config,
        uint256 deadline,
        bytes calldata enrollmentAssertion,
        bytes32 vaultSalt,
        bytes32 taxRouterSalt,
        bytes32[] calldata initialEpochProof,
        address authorizationSigner,
        address creator,
        bytes memory creatorSignature,
        bool requireCreatorSignature
    ) private returns (address vaultProxy, address taxRouterProxy) {
        if (vaultFactory.code.length == 0) revert InvalidConfiguration();
        // The mode-specific token/code validation is enforced atomically by
        // TaxRouter.initialize below, including staged Multichain enrollment.
        bytes32 configurationHash = keccak256(
            abi.encode(
                block.chainid,
                creator,
                config,
                authorizationSigner,
                vaultSalt,
                taxRouterSalt
            )
        );
        RewardSystem storage existingSystem = rewardSystems[config.launchId];
        if (existingSystem.creator != address(0)) {
            if (
                existingSystem.creator != creator
                    || rewardSystemConfigurationHashes[config.launchId] != configurationHash
                    || existingSystem.vault.code.length == 0
                    || existingSystem.taxRouter.code.length == 0
            ) revert LaunchAlreadyRegistered();
            return (existingSystem.vault, existingSystem.taxRouter);
        }

        if (newLaunchesPaused) revert LaunchPaused();
        if (config.quoteAsset != address(0)) revert UnsupportedQuoteAsset();
        if (config.launchId == bytes32(0)) revert LaunchAlreadyRegistered();
        if (!approvedTaxSources[config.taxSource]) revert UnapprovedTaxSource();
        if (vaultImplementation == address(0) || taxRouterImplementation == address(0)) {
            revert MissingImplementation();
        }
        if (
            (
                config.taxDistributionMode
                    == TaxRouter.TaxDistributionMode.PonsCreator90Platform10
                    || config.taxDistributionMode
                        == TaxRouter.TaxDistributionMode.PonsCreator70Platform10Buyback20
            ) && ponsFeeProcessor == address(0)
        ) revert InvalidConfiguration();
        if (!_validTaxBps(config.additionalTaxBps)) revert InvalidConfiguration();
        if (deadline == 0 || block.timestamp > deadline) revert ExpiredAuthorization();
        uint256 usedNonce = enrollmentNonces[creator];
        bytes32 digest;
        bytes memory vaultInitialization;
        if (
            authorizationSigner == address(0) || config.passkeyX != bytes32(0)
                || config.passkeyY != bytes32(0)
                || config.credentialIdHash != bytes32(0)
        ) revert InvalidConfiguration();
        digest = _passwordEnrollmentDigest(
            config,
            creator,
            authorizationSigner,
            usedNonce,
            deadline,
            vaultSalt,
            taxRouterSalt
        );
        if (ECDSA.recover(digest, enrollmentAssertion) != authorizationSigner) {
            revert InvalidAuthorizationProof();
        }
        if (requireCreatorSignature && ECDSA.recover(digest, creatorSignature) != creator) {
            revert InvalidAuthorizationProof();
        }
        if (
            config.taxDistributionMode == TaxRouter.TaxDistributionMode.Creator80Buyback20
                || config.taxDistributionMode
                    == TaxRouter.TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            if (config.buybackExecutor != config.bridgeVault) {
                revert InvalidConfiguration();
            }
            bytes memory deployedBridgeVault = _delegateMultichainModule(
                abi.encodeWithSignature(
                    "deployMultichainVault(bytes32,address,address)",
                    config.launchId,
                    creator,
                    config.bridgeVault
                )
            );
            if (abi.decode(deployedBridgeVault, (address)) != config.bridgeVault) {
                revert InvalidConfiguration();
            }
        }
        vaultInitialization =
            _passwordVaultProxyInitialization(config, creator, authorizationSigner);
        vaultProxy = IVaultFactoryRegistrar(vaultFactory).predictCreatorVaultAddress(
            config.launchId, vaultSalt, vaultInitialization
        );
        if (vaultProxy.code.length != 0) revert InvalidConfiguration();

        bytes memory routerInitialization =
            _taxRouterProxyInitialization(config, creator, vaultProxy);
        taxRouterProxy = IVaultFactoryRegistrar(vaultFactory).predictFeeVaultAddress(
            config.launchId, taxRouterSalt, routerInitialization
        );
        if (taxRouterProxy.code.length != 0) revert InvalidConfiguration();

        enrollmentNonces[creator] = usedNonce + 1;
        emit CreatorPasswordEnrollmentUsed(
            creator, config.launchId, authorizationSigner, usedNonce
        );

        address deployedVault = IVaultFactoryRegistrar(vaultFactory)
            .deployCreatorVaultProxy(config.launchId, vaultSalt, vaultInitialization);
        address deployedRouter = IVaultFactoryRegistrar(vaultFactory)
            .deployFeeVaultProxy(config.launchId, taxRouterSalt, routerInitialization);
        if (deployedVault != vaultProxy || deployedRouter != taxRouterProxy) {
            revert InvalidConfiguration();
        }
        CreatorRewardVault(payable(vaultProxy)).initializeAuthorization(
            config.authorizationEpochRoot,
            config.claimCommitment,
            config.redemptionCommitment,
            config.rotationCommitment,
            config.recoveryCommitment,
            initialEpochProof
        );
        CreatorRewardVault(payable(vaultProxy)).bindTaxRouter(taxRouterProxy);
        if (
            config.taxDistributionMode == TaxRouter.TaxDistributionMode.Creator80Buyback20
                || config.taxDistributionMode
                    == TaxRouter.TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            IBridgeVaultTaxRouterRegistrar(config.bridgeVault).registerTaxRouter(
                taxRouterProxy
            );
        }
        if (vaultFactory != address(0) && config.launchToken != address(0)) {
            IVaultFactoryRegistrar(vaultFactory).registerVaultSet(
                config.launchId,
                config.launchToken,
                creator,
                taxRouterProxy,
                vaultProxy,
                config.bridgeVault
            );
        }

        rewardSystems[config.launchId] = RewardSystem({
            creator: creator,
            vault: vaultProxy,
            taxRouter: taxRouterProxy,
            taxSource: config.taxSource,
            additionalTaxBps: config.additionalTaxBps,
            implementationVersion: implementationVersion,
            taxDistributionMode: config.taxDistributionMode,
            launchToken: config.launchToken,
            buybackExecutor: config.buybackExecutor,
            bridgeVault: config.bridgeVault
        });
        rewardSystemConfigurationHashes[config.launchId] = configurationHash;
        emit RewardSystemCreated(
            config.launchId,
            creator,
            vaultProxy,
            taxRouterProxy,
            config.taxSource,
            config.additionalTaxBps,
            config.taxDistributionMode,
            config.launchToken,
            config.buybackExecutor,
            config.bridgeVault,
            implementationVersion
        );
    }

    /// @notice Finalizes a Pons-only launch after its fee router has been prepared.
    /// @dev The creator first binds the launched token to the router, then registers the
    ///      completed vault set here. This lets Pons escrow fees to the router from launch.
    function completePonsLaunch(bytes32 launchId, address launchToken_) external {
        RewardSystem storage system = rewardSystems[launchId];
        if (
            system.creator != msg.sender
                || system.taxDistributionMode
                    != TaxRouter.TaxDistributionMode.PonsCreator90Platform10
                || system.launchToken != address(0) || launchToken_.code.length == 0
                || system.vault.code.length == 0 || system.taxRouter.code.length == 0
                || TaxRouter(payable(system.taxRouter)).launchToken() != launchToken_
        ) revert InvalidConfiguration();

        if (vaultFactory != address(0)) {
            IVaultFactoryRegistrar(vaultFactory).registerVaultSet(
                launchId,
                launchToken_,
                msg.sender,
                system.taxRouter,
                system.vault,
                address(0)
            );
        }
        system.launchToken = launchToken_;
        emit PonsLaunchCompleted(launchId, msg.sender, launchToken_);
    }

    /// @notice Finalizes a staged Multichain launch after its token and market exist.
    /// @dev The launch module validates the market selector and registers the final vault set.
    function completeMultichainLaunch(
        bytes32 launchId,
        address launchToken_,
        uint256,
        uint8,
        address,
        IPoolManager,
        PoolKey calldata,
        uint160
    ) external {
        _delegateMultichainModule(msg.data);
        rewardSystems[launchId].launchToken = launchToken_;
    }

    function vaultProxyInitCodeHash(LaunchConfig calldata config, address creator)
        external
        view
        returns (bytes32)
    {
        return IVaultFactoryRegistrar(vaultFactory).creatorProxyInitCodeHash(
            _vaultProxyInitialization(config, creator)
        );
    }

    function taxRouterProxyInitCodeHash(
        LaunchConfig calldata config,
        address creator,
        address vaultProxy
    ) external view returns (bytes32) {
        return IVaultFactoryRegistrar(vaultFactory).feeProxyInitCodeHash(
            _taxRouterProxyInitialization(config, creator, vaultProxy)
        );
    }

    function predictVaultProxyAddress(
        LaunchConfig calldata config,
        address creator,
        bytes32 salt
    ) external view returns (address) {
        return IVaultFactoryRegistrar(vaultFactory).predictCreatorVaultAddress(
            config.launchId, salt, _vaultProxyInitialization(config, creator)
        );
    }

    function predictPasswordVaultProxyAddress(
        LaunchConfig calldata config,
        address creator,
        address authorizationSigner,
        bytes32 salt
    ) external view returns (address) {
        bytes memory initialization =
            _passwordVaultProxyInitialization(config, creator, authorizationSigner);
        return IVaultFactoryRegistrar(vaultFactory).predictCreatorVaultAddress(
            config.launchId, salt, initialization
        );
    }

    function predictTaxRouterProxyAddress(
        LaunchConfig calldata config,
        address creator,
        address vaultProxy,
        bytes32 salt
    ) external view returns (address) {
        return IVaultFactoryRegistrar(vaultFactory).predictFeeVaultAddress(
            config.launchId,
            salt,
            _taxRouterProxyInitialization(config, creator, vaultProxy)
        );
    }

    function _vaultProxyInitialization(LaunchConfig calldata config, address creator)
        private
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            CreatorRewardVault.initialize,
            (
                config.launchId,
                creator,
                address(this),
                platformTreasury,
                passkeyVerifier,
                rpIdHash,
                config.passkeyX,
                config.passkeyY,
                config.credentialIdHash,
                instanceAdmin,
                instanceUpgrader,
                instancePauser,
                instanceEmergencyWithdrawer
            )
        );
    }

    function _passwordVaultProxyInitialization(
        LaunchConfig calldata config,
        address creator,
        address authorizationSigner
    ) private view returns (bytes memory) {
        return abi.encodeCall(
            CreatorRewardVault.initializePassword,
            (
                config.launchId,
                creator,
                address(this),
                platformTreasury,
                authorizationSigner,
                instanceAdmin,
                instanceUpgrader,
                instancePauser,
                instanceEmergencyWithdrawer
            )
        );
    }

    function _taxRouterProxyInitialization(
        LaunchConfig calldata config,
        address creator,
        address vaultProxy
    ) private view returns (bytes memory) {
        return abi.encodeCall(
            TaxRouter.initialize,
            (
                config.launchId,
                creator,
                vaultProxy,
                config.taxSource,
                platformTreasury,
                config.additionalTaxBps,
                instanceAdmin,
                instanceUpgrader,
                instancePauser,
                instanceTreasury,
                instanceEmergencyWithdrawer,
                foundationRecipient,
                config.taxDistributionMode,
                config.launchToken,
                config.buybackExecutor,
                config.bridgeVault,
                ponsFeeProcessor
            )
        );
    }

    function _passwordEnrollmentDigest(
        LaunchConfig calldata config,
        address creator,
        address authorizationSigner,
        uint256 usedNonce,
        uint256 deadline,
        bytes32 vaultSalt,
        bytes32 taxRouterSalt
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PASSWORD_ENROLLMENT_TYPEHASH,
                    config.launchId,
                    creator,
                    config.quoteAsset,
                    config.taxSource,
                    config.additionalTaxBps,
                    config.taxDistributionMode,
                    config.launchToken,
                    config.buybackExecutor,
                    config.bridgeVault,
                    ponsFeeProcessor,
                    authorizationSigner,
                    config.authorizationEpochRoot,
                    config.claimCommitment,
                    config.redemptionCommitment,
                    config.rotationCommitment,
                    config.recoveryCommitment,
                    usedNonce,
                    deadline,
                    vaultSalt,
                    taxRouterSalt
                )
            )
        );
    }

    function _delegateMultichainModule(bytes memory data)
        private
        returns (bytes memory result)
    {
        address module = multichainLaunchModule;
        if (module.code.length == 0) revert InvalidConfiguration();
        (bool ok, bytes memory returned) = module.delegatecall(data);
        if (!ok) assembly ("memory-safe") {
            revert(add(returned, 0x20), mload(returned))
        }
        return returned;
    }

    function setNewLaunchesPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        newLaunchesPaused = paused;
        emit NewLaunchesPaused(paused);
    }

    function _requireUupsImplementation(address implementation) private view {
        try IERC1822Proxiable(implementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) {
                revert InvalidImplementation();
            }
        } catch {
            revert InvalidImplementation();
        }
    }

    function _validTaxBps(uint16 value) private pure returns (bool) {
        return value >= 100 && value <= 1000;
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    function _validateImplementation(address implementation) private view {
        AddressPrefix.require6900(implementation);
        _requireUupsImplementation(implementation);
    }

    function _grantRole(bytes32 role, address account)
        internal
        override
        returns (bool)
    {
        if (_isProtectedRole(role) && account != canonicalOwner) revert InvalidConfiguration();
        return super._grantRole(role, account);
    }

    function _revokeRole(bytes32 role, address account)
        internal
        override
        returns (bool)
    {
        if (_isProtectedRole(role) && account == canonicalOwner) revert InvalidConfiguration();
        return super._revokeRole(role, account);
    }

    function _isProtectedRole(bytes32 role) private pure returns (bool) {
        return role == DEFAULT_ADMIN_ROLE || role == UPGRADER_ROLE || role == PAUSER_ROLE;
    }

}
