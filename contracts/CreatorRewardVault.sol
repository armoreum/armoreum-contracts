// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IArmoreumPasskeyVerifier} from "./interfaces/IArmoreumPasskeyVerifier.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";
import {UpgradeableReentrancyGuard} from "./libraries/UpgradeableReentrancyGuard.sol";
import {AuthorizationHashChain} from "./libraries/AuthorizationHashChain.sol";

interface IRewardRouter {
    function launchId() external view returns (bytes32);
    function launchToken() external view returns (address);
}

/// @notice One isolated, ETH-backed creator reward vault and soulbound jailETH token per launch.
/// @dev Creator rewards auto-issue as fully backed JailETH on every credit; Unjail requires a
/// distinct one-time hash-chain proof.
contract CreatorRewardVault is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    EIP712Upgradeable,
    UpgradeableReentrancyGuard,
    UUPSUpgradeable
{
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant EMERGENCY_WITHDRAWER_ROLE =
        keccak256("EMERGENCY_WITHDRAWER_ROLE");

    uint256 public constant MIN_CLAIM = 0.01 ether;
    uint32 public constant MAX_AUTHORIZATION_EPOCHS = 64;
    uint16 public constant AUTHORIZATION_PROOFS_PER_EPOCH = 100;
    uint16 public constant ROTATION_THRESHOLD = 32;
    uint256 private constant EPOCH_MERKLE_DEPTH = 6;
    uint8 private constant OPERATION_NONE = 0;
    uint8 private constant OPERATION_CLAIM = 1;
    uint8 private constant OPERATION_UNJAIL = 2;

    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(bytes32 launchId,address creator,uint256 amount,address recipient,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant REDEEM_TYPEHASH = keccak256(
        "Redeem(bytes32 launchId,address creator,uint256 amount,address recipient,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant PROTECTED_PAYOUT_TYPEHASH = keccak256(
        "ProtectedPayout(bytes32 launchId,address creator,uint256 chainId,address vault,address payoutAddress,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant UNJAIL_REQUEST_TYPEHASH = keccak256(
        "UnjailRequest(bytes32 launchId,address creator,uint256 chainId,address vault,uint256 amount,address recipient,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant CANCEL_PENDING_TYPEHASH = keccak256(
        "CancelPendingRewardOperation(bytes32 launchId,address creator,uint256 chainId,address vault,uint8 operation,uint256 amount,address recipient,uint256 operationNonce,uint32 expectedEpoch,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant ROTATE_OLD_TYPEHASH = keccak256(
        "RotateOld(bytes32 launchId,address creator,bytes32 newKeyX,bytes32 newKeyY,bytes32 newCredentialIdHash,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );
    bytes32 private constant ROTATE_NEW_TYPEHASH = keccak256(
        "RotateNew(bytes32 launchId,address creator,bytes32 newKeyX,bytes32 newKeyY,bytes32 newCredentialIdHash,uint256 nonce,uint256 deadline,uint256 nextCredentialVersion)"
    );
    bytes32 private constant PASSWORD_ROTATION_TYPEHASH = keccak256(
        "PasswordAuthorizationRotation(bytes32 launchId,address creator,uint32 expectedEpoch,bytes32 nextClaimCommitment,bytes32 nextRedemptionCommitment,bytes32 nextRotationCommitment,bytes32 nextRecoveryCommitment,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant PASSWORD_RECOVERY_TYPEHASH = keccak256(
        "PasswordAuthorizationRecovery(bytes32 launchId,address creator,uint32 expectedEpoch,bytes32 nextClaimCommitment,bytes32 nextRedemptionCommitment,bytes32 nextRotationCommitment,bytes32 nextRecoveryCommitment,uint256 nonce,uint256 deadline)"
    );

    error UnauthorizedFactory();
    error UnauthorizedCreator();
    error InvalidConfiguration();
    error InvalidPasskey();
    error ExpiredAuthorization();
    error InvalidAmount();
    error InsufficientRewards();
    error InsufficientBacking();
    error NonTransferable();
    error RouterAlreadyBound();
    error WrongLaunch();
    error DuplicateDistribution();
    error PausedOperation();
    error InvalidRecipient();
    error PayoutFailed();
    error NoExcessBacking();
    error DirectDepositsDisabled();
    error AuthorizationNotConfigured();
    error InvalidAuthorizationProof();
    error InvalidEpochProof();
    error StaleAuthorizationEpoch();
    error AuthorizationExhausted();
    error RotationNotReady();
    error AuthorizationEpochLimitReached();
    error PendingOperationExists();
    error NoPendingRewardOperation();
    error InvalidRewardOperation();
    error InvalidProtectedPayout();
    error ProtectedPayoutNotRegistered();
    error WrongPonsChain();
    error NoThresholdRewards();
    error PendingOperationNotExpired();
    error AutomaticIssuanceOnly();
    error InvalidEmergencyAsset();

    event RewardsAccrued(bytes32 indexed launchId, bytes32 indexed distributionId, uint256 amount);
    event RewardsClaimed(
        bytes32 indexed launchId,
        address indexed creator,
        uint256 amount,
        uint256 nonce,
        uint256 credentialVersion
    );
    event JailETHThresholdReady(
        bytes32 indexed launchId,
        bytes32 indexed depositDistributionId,
        uint256 newlyEligibleAmount,
        uint256 accruedRewards
    );
    event JailETHAutomaticallyIssued(
        bytes32 indexed launchId,
        address indexed creator,
        bytes32 indexed triggeringDistributionId,
        uint256 amount,
        uint256 remainingAccruedRewards
    );
    event JailETHRedeemed(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed recipient,
        uint256 amountBurned,
        uint256 grossEthPayout,
        uint256 serviceFee,
        uint256 nonce,
        uint256 credentialVersion
    );
    event PasskeyRotated(
        bytes32 indexed launchId,
        address indexed creator,
        bytes32 credentialIdHash,
        uint256 credentialVersion
    );
    event VaultPauseChanged(bool accrual, bool issuance, bool redemption);
    event ExcessBackingWithdrawn(address indexed treasury, uint256 amount);
    event JailbreakExecuted(
        address indexed vault,
        address indexed asset,
        address indexed destination,
        uint256 amount,
        address caller,
        uint256 cancelledAccruedRewards,
        uint256 cancelledJailETH
    );
    event TaxRouterBound(address indexed router);
    event AuthorizationInitialized(
        bytes32 indexed launchId, address indexed creator, uint32 indexed epoch, bytes32 epochRoot
    );
    event AuthorizationRotated(
        bytes32 indexed launchId, uint32 indexed oldEpoch, uint32 indexed newEpoch
    );
    event AuthorizationRecovered(
        bytes32 indexed launchId, uint32 indexed oldEpoch, uint32 indexed newEpoch
    );
    event RewardOperationRequested(
        bytes32 indexed launchId,
        uint256 indexed nonce,
        uint8 indexed operation,
        uint256 amount,
        address recipient,
        uint32 authorizationEpoch,
        uint256 deadline
    );
    event RewardOperationCancelled(
        bytes32 indexed launchId, uint256 indexed nonce, uint8 indexed operation
    );
    event ProtectedPayoutAddressRegistered(
        bytes32 indexed launchId,
        address indexed creator,
        address indexed previousAddress,
        address payoutAddress,
        uint256 nonce,
        uint256 credentialVersion
    );
    event CreatorUnjailed(
        bytes32 indexed launchId,
        address indexed creatorIdentity,
        address indexed payoutAddress,
        uint256 amountBurned,
        uint256 amountPaid,
        bytes32 operationId,
        uint256 credentialVersion
    );
    event PasswordAuthorizationEnabled(address indexed signer, uint16 proofsPerEpoch);

    bytes32 public launchId;
    address public creator;
    address public factory;
    address public canonicalOwner;
    address public platformTreasury;
    address public taxRouter;
    address public passkeyVerifier;
    bytes32 public rpIdHash;
    bytes32 public passkeyX;
    bytes32 public passkeyY;
    bytes32 public credentialIdHash;
    uint256 public credentialVersion;
    uint256 public nonce;
    uint256 public accruedRewards;
    uint256 public lifetimeClaimed;
    uint256 public lifetimeRedeemed;
    bool public accrualPaused;
    bool public issuancePaused;
    bool public redemptionPaused;
    mapping(bytes32 distributionId => bool processed) public processedDistributions;

    // Appended storage for UUPS layout compatibility.
    bytes32 public authorizationEpochRoot;
    bytes32 public claimCommitment;
    bytes32 public redemptionCommitment;
    bytes32 public rotationCommitment;
    bytes32 public recoveryCommitment;
    uint32 public authorizationEpoch;
    uint16 public claimProofsRemaining;
    uint16 public redemptionProofsRemaining;
    uint16 public rotationProofsRemaining;
    uint16 public recoveryProofsRemaining;
    bool public authorizationConfigured;

    struct PendingRewardOperation {
        uint8 operation;
        uint256 amount;
        address recipient;
        uint256 operationNonce;
        uint32 expectedEpoch;
        uint256 deadline;
    }

    PendingRewardOperation public pendingRewardOperation;

    // Appended storage: keep all existing UUPS storage slots stable.
    address public protectedPayoutAddress;
    uint256 public lifetimeAutoIssued;
    // Appended storage: emergency withdrawals explicitly write off liabilities they consume.
    uint256 public lifetimeJailbreakLoss;
    uint256 public lifetimeJailbreakWithdrawals;
    bool public passwordAuthorizationMode;
    address public passwordAuthorizationSigner;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        bytes32 launchId_,
        address creator_,
        address factory_,
        address platformTreasury_,
        address passkeyVerifier_,
        bytes32 rpIdHash_,
        bytes32 passkeyX_,
        bytes32 passkeyY_,
        bytes32 credentialIdHash_,
        address admin_,
        address upgrader_,
        address pauser_,
        address emergencyWithdrawer_
    ) external initializer {
        if (
            launchId_ == bytes32(0) || creator_ == address(0) || factory_ == address(0)
                || platformTreasury_ == address(0) || passkeyVerifier_.code.length == 0
                || rpIdHash_ == bytes32(0) || passkeyX_ == bytes32(0) || passkeyY_ == bytes32(0)
                || credentialIdHash_ == bytes32(0) || admin_ == address(0)
                || upgrader_ == address(0) || pauser_ == address(0)
                || emergencyWithdrawer_ == address(0)
                || platformTreasury_ != admin_ || upgrader_ != admin_ || pauser_ != admin_
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(passkeyVerifier_);

        __ERC20_init("jailETH", "jailETH");
        __AccessControl_init();
        __EIP712_init("ArmoreumCreatorRewardVault", "1");

        launchId = launchId_;
        creator = creator_;
        factory = factory_;
        canonicalOwner = admin_;
        platformTreasury = platformTreasury_;
        passkeyVerifier = passkeyVerifier_;
        rpIdHash = rpIdHash_;
        passkeyX = passkeyX_;
        passkeyY = passkeyY_;
        credentialIdHash = credentialIdHash_;
        credentialVersion = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, upgrader_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(EMERGENCY_WITHDRAWER_ROLE, emergencyWithdrawer_);
    }

    /// @notice Initializes a fresh password-authorized creator vault.
    /// @dev This is the launch path for the password + H100→H0 authorization version.
    ///      It deliberately leaves all WebAuthn fields unset; inherited passkey selectors
    ///      therefore cannot authorize actions on this vault.
    function initializePassword(
        bytes32 launchId_,
        address creator_,
        address factory_,
        address platformTreasury_,
        address authorizationSigner_,
        address admin_,
        address upgrader_,
        address pauser_,
        address emergencyWithdrawer_
    ) external initializer {
        if (
            launchId_ == bytes32(0) || creator_ == address(0) || factory_ == address(0)
                || platformTreasury_ == address(0) || authorizationSigner_ == address(0)
                || admin_ == address(0) || upgrader_ == address(0) || pauser_ == address(0)
                || emergencyWithdrawer_ == address(0) || platformTreasury_ != admin_
                || upgrader_ != admin_ || pauser_ != admin_
        ) revert InvalidConfiguration();

        __ERC20_init("jailETH", "jailETH");
        __AccessControl_init();
        __EIP712_init("ArmoreumCreatorRewardVault", "2");

        launchId = launchId_;
        creator = creator_;
        factory = factory_;
        canonicalOwner = admin_;
        platformTreasury = platformTreasury_;
        credentialVersion = 1;
        passwordAuthorizationMode = true;
        passwordAuthorizationSigner = authorizationSigner_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, upgrader_);
        _grantRole(PAUSER_ROLE, pauser_);
        _grantRole(EMERGENCY_WITHDRAWER_ROLE, emergencyWithdrawer_);
        emit PasswordAuthorizationEnabled(
            authorizationSigner_, AUTHORIZATION_PROOFS_PER_EPOCH
        );
    }

    function bindTaxRouter(address router_) external {
        if (msg.sender != factory) revert UnauthorizedFactory();
        if (taxRouter != address(0)) revert RouterAlreadyBound();
        if (router_.code.length == 0) revert InvalidConfiguration();
        if (IRewardRouter(router_).launchId() != launchId) revert WrongLaunch();
        taxRouter = router_;
        emit TaxRouterBound(router_);
    }

    /// @dev The factory calls this once in the same transaction that creates the vault.
    /// The recovery phrase and unrevealed chain material remain exclusively in the client.
    function initializeAuthorization(
        bytes32 epochRoot_,
        bytes32 claimCommitment_,
        bytes32 redemptionCommitment_,
        bytes32 rotationCommitment_,
        bytes32 recoveryCommitment_,
        bytes32[] calldata initialEpochProof
    ) external {
        if (msg.sender != factory) revert UnauthorizedFactory();
        if (authorizationConfigured) revert InvalidConfiguration();
        if (
            epochRoot_ == bytes32(0) || claimCommitment_ == bytes32(0)
                || redemptionCommitment_ == bytes32(0) || rotationCommitment_ == bytes32(0)
                || recoveryCommitment_ == bytes32(0)
        ) revert InvalidConfiguration();
        if (
            !_verifyEpochProof(
                1,
                claimCommitment_,
                redemptionCommitment_,
                rotationCommitment_,
                recoveryCommitment_,
                initialEpochProof,
                epochRoot_
            )
        ) revert InvalidEpochProof();

        authorizationEpochRoot = epochRoot_;
        claimCommitment = claimCommitment_;
        redemptionCommitment = redemptionCommitment_;
        rotationCommitment = rotationCommitment_;
        recoveryCommitment = recoveryCommitment_;
        authorizationEpoch = 1;
        claimProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        redemptionProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        rotationProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        recoveryProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        authorizationConfigured = true;
        emit AuthorizationInitialized(launchId, creator, 1, epochRoot_);
    }

    function creditCreatorRewards(bytes32 launchId_, bytes32 distributionId)
        external
        payable
    {
        if (msg.sender != taxRouter || taxRouter == address(0)) revert UnauthorizedFactory();
        if (launchId_ != launchId) revert WrongLaunch();
        if (accrualPaused) revert PausedOperation();
        if (msg.value == 0) revert InvalidAmount();
        if (processedDistributions[distributionId]) revert DuplicateDistribution();

        processedDistributions[distributionId] = true;
        uint256 eligibleBeforeNewCredit = _thresholdRewardAmount(accruedRewards);
        accruedRewards += msg.value;
        emit RewardsAccrued(launchId, distributionId, msg.value);
        uint256 eligibleAfterNewCredit = _thresholdRewardAmount(accruedRewards);
        if (eligibleAfterNewCredit > eligibleBeforeNewCredit) {
            emit JailETHThresholdReady(
                launchId,
                distributionId,
                eligibleAfterNewCredit - eligibleBeforeNewCredit,
                accruedRewards
            );
        }
        _issueAllAccruedRewards(distributionId);
        _requireSolvent();
    }

    /// @notice Converts the post-launch creator wallet surplus into fully backed JailETH.
    /// @dev The generated creator wallet sends the value directly through this function;
    ///      ordinary direct ETH transfers remain disabled. This path intentionally issues
    ///      every wei, including amounts below MIN_CLAIM, so small launch leftovers are not
    ///      stranded as unissued rewards.
    function depositCreatorSurplus() external payable nonReentrant {
        if (msg.sender != creator) revert UnauthorizedCreator();
        if (
            !passwordAuthorizationMode || !authorizationConfigured || taxRouter == address(0)
                || msg.value == 0
                || IRewardRouter(taxRouter).launchId() != launchId
                || IRewardRouter(taxRouter).launchToken().code.length == 0
        ) revert InvalidConfiguration();
        if (accrualPaused || issuancePaused) revert PausedOperation();

        _requireSolvent();
        _mint(creator, msg.value);
        lifetimeAutoIssued += msg.value;
        _requireSolvent();
    }

    function requestRewardClaim(uint256, uint256) external pure {
        revert AutomaticIssuanceOnly();
    }

    /// @notice Legacy selector retained for compatibility; issuance is deposit-triggered.
    function requestPonsThresholdRewardClaim() external pure {
        revert AutomaticIssuanceOnly();
    }

    /// @notice Converts any rewards accrued before the immediate-issuance upgrade into JailETH.
    /// @dev Restricted to the upgrader so it can be invoked atomically with upgradeToAndCall.
    function migrateAccruedRewardsToJailETH() external onlyRole(UPGRADER_ROLE) {
        if (issuancePaused) revert PausedOperation();
        bytes32 migrationId = keccak256(
            abi.encode(
                "CREATOR_REWARD_ISSUANCE_MIGRATION",
                block.chainid,
                launchId,
                address(this),
                accruedRewards,
                lifetimeAutoIssued
            )
        );
        _issueAllAccruedRewards(migrationId);
    }

    function thresholdClaimableRewards() external view returns (uint256) {
        return _thresholdRewardAmount(accruedRewards);
    }

    function claimRewards(uint32, bytes32) external pure {
        revert AutomaticIssuanceOnly();
    }

    function unjailRequestAuthorizationDigest(
        uint256 amount,
        address recipient,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    UNJAIL_REQUEST_TYPEHASH,
                    launchId,
                    creator,
                    block.chainid,
                    address(this),
                    amount,
                    recipient,
                    nonce,
                    deadline,
                    credentialVersion
                )
            )
        );
    }

    function requestUnjailETH(
        uint256 amount,
        address payable recipient,
        uint256 deadline,
        bytes calldata passkeyAssertion
    ) external {
        if (msg.sender != creator) revert InvalidAuthorizationProof();
        if (redemptionPaused) revert PausedOperation();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (
            amount == 0 || balanceOf(creator) < amount
                || recipient == address(0) || recipient == address(this)
        ) revert InvalidAmount();
        if (recipient == creator) {
            revert InvalidProtectedPayout();
        }
        _verifyPasskey(
            unjailRequestAuthorizationDigest(amount, recipient, deadline),
            passkeyAssertion,
            passkeyX,
            passkeyY
        );
        _setPendingRewardOperation(
            OPERATION_UNJAIL, amount, recipient, deadline
        );
    }

    function requestUnjailETHWithPassword(
        uint256 amount,
        address payable recipient,
        uint256 deadline,
        bytes32 oneTimeProof,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature
    ) external {
        if (!passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (redemptionPaused) revert PausedOperation();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (
            amount == 0 || balanceOf(creator) < amount
                || recipient == address(0) || recipient == address(this)
        ) revert InvalidAmount();
        if (recipient == creator) {
            revert InvalidProtectedPayout();
        }

        bytes32 digest = unjailRequestAuthorizationDigest(amount, recipient, deadline);
        _verifyCreatorWalletSignature(digest, creatorSignature);
        _verifyPasswordSignature(digest, passwordSignature);
        _verifyAuthorizationProof(
            authorizationEpoch,
            oneTimeProof,
            redemptionCommitment,
            redemptionProofsRemaining
        );
        redemptionCommitment = oneTimeProof;
        redemptionProofsRemaining -= 1;
        _setPendingRewardOperation(OPERATION_UNJAIL, amount, recipient, deadline);
    }

    /// @notice Registers a payout destination using a cryptographically verified passkey assertion.
    /// @dev EIP-712 domain binds the signature to this vault and chain; the typed data also binds
    /// the launch, compromised creator identity, nonce, deadline, and current credential version.
    function protectedPayoutAuthorizationDigest(address payoutAddress, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PROTECTED_PAYOUT_TYPEHASH,
                    launchId,
                    creator,
                    block.chainid,
                    address(this),
                    payoutAddress,
                    nonce,
                    deadline,
                    credentialVersion
                )
            )
        );
    }

    function registerProtectedPayoutAddress(
        address payoutAddress,
        uint256 deadline,
        bytes calldata passkeyAssertion
    ) external {
        if (msg.sender != creator) revert InvalidAuthorizationProof();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (
            payoutAddress == address(0) || payoutAddress == creator
                || payoutAddress == address(this)
        ) revert InvalidProtectedPayout();
        if (pendingRewardOperation.operation != OPERATION_NONE) {
            revert PendingOperationExists();
        }

        uint256 usedNonce = nonce;
        bytes32 digest = protectedPayoutAuthorizationDigest(payoutAddress, deadline);
        _verifyPasskey(digest, passkeyAssertion, passkeyX, passkeyY);

        address previousAddress = protectedPayoutAddress;
        protectedPayoutAddress = payoutAddress;
        nonce = usedNonce + 1;
        emit ProtectedPayoutAddressRegistered(
            launchId,
            creator,
            previousAddress,
            payoutAddress,
            usedNonce,
            credentialVersion
        );
    }

    function registerProtectedPayoutAddressWithPassword(
        address payoutAddress,
        uint256 deadline,
        bytes32 oneTimeProof,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature
    ) external {
        if (!passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (
            payoutAddress == address(0) || payoutAddress == creator
                || payoutAddress == address(this)
        ) revert InvalidProtectedPayout();
        if (pendingRewardOperation.operation != OPERATION_NONE) {
            revert PendingOperationExists();
        }

        uint256 usedNonce = nonce;
        bytes32 digest = protectedPayoutAuthorizationDigest(payoutAddress, deadline);
        _verifyCreatorWalletSignature(digest, creatorSignature);
        _verifyPasswordSignature(digest, passwordSignature);
        _verifyAuthorizationProof(
            authorizationEpoch, oneTimeProof, claimCommitment, claimProofsRemaining
        );
        claimCommitment = oneTimeProof;
        claimProofsRemaining -= 1;

        address previousAddress = protectedPayoutAddress;
        protectedPayoutAddress = payoutAddress;
        nonce = usedNonce + 1;
        emit ProtectedPayoutAddressRegistered(
            launchId,
            creator,
            previousAddress,
            payoutAddress,
            usedNonce,
            credentialVersion
        );
    }

    function redeemJailETH(uint32 expectedEpoch, bytes32 oneTimeProof)
        external
        nonReentrant
    {
        if (!passwordAuthorizationMode && msg.sender != creator) {
            revert InvalidAuthorizationProof();
        }
        if (redemptionPaused) revert PausedOperation();
        PendingRewardOperation memory pending = _requirePendingRewardOperation(
            OPERATION_UNJAIL, expectedEpoch
        );
        if (
            pending.amount == 0 || balanceOf(creator) < pending.amount
                || pending.recipient == address(0) || pending.recipient == address(this)
        ) revert InvalidAmount();
        if (pending.recipient == creator) revert InvalidProtectedPayout();
        _requireSolvent();
        _verifyAuthorizationProof(
            expectedEpoch, oneTimeProof, redemptionCommitment, redemptionProofsRemaining
        );
        redemptionCommitment = oneTimeProof;
        redemptionProofsRemaining -= 1;

        uint256 usedNonce = nonce++;
        _burn(creator, pending.amount);
        lifetimeRedeemed += pending.amount;
        delete pendingRewardOperation;

        bytes32 operationId = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                launchId,
                creator,
                pending.recipient,
                pending.amount,
                usedNonce
            )
        );
        (bool success,) = payable(pending.recipient).call{value: pending.amount}("");
        if (!success) revert PayoutFailed();

        _requireSolvent();
        emit JailETHRedeemed(
            launchId,
            creator,
            pending.recipient,
            pending.amount,
            pending.amount,
            0,
            usedNonce,
            authorizationEpoch
        );
        emit CreatorUnjailed(
            launchId,
            creator,
            pending.recipient,
            pending.amount,
            pending.amount,
            operationId,
            credentialVersion
        );
    }

    function pendingRewardOperationCancellationDigest() public view returns (bytes32) {
        PendingRewardOperation memory pending = pendingRewardOperation;
        if (pending.operation == OPERATION_NONE) revert NoPendingRewardOperation();
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CANCEL_PENDING_TYPEHASH,
                    launchId,
                    creator,
                    block.chainid,
                    address(this),
                    pending.operation,
                    pending.amount,
                    pending.recipient,
                    pending.operationNonce,
                    pending.expectedEpoch,
                    pending.deadline,
                    credentialVersion
                )
            )
        );
    }

    function cancelPendingRewardOperation(bytes calldata passkeyAssertion) external {
        if (msg.sender != creator) revert InvalidAuthorizationProof();
        PendingRewardOperation memory pending = pendingRewardOperation;
        if (pending.operation == OPERATION_NONE) revert NoPendingRewardOperation();
        _verifyPasskey(
            pendingRewardOperationCancellationDigest(),
            passkeyAssertion,
            passkeyX,
            passkeyY
        );
        delete pendingRewardOperation;
        nonce = pending.operationNonce + 1;
        emit RewardOperationCancelled(launchId, pending.operationNonce, pending.operation);
    }

    function cancelPendingRewardOperationWithPassword(
        bytes32 oneTimeProof,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature
    ) external {
        if (!passwordAuthorizationMode) revert InvalidAuthorizationProof();
        PendingRewardOperation memory pending = pendingRewardOperation;
        if (pending.operation == OPERATION_NONE) revert NoPendingRewardOperation();
        bytes32 digest = pendingRewardOperationCancellationDigest();
        _verifyCreatorWalletSignature(digest, creatorSignature);
        _verifyPasswordSignature(digest, passwordSignature);
        _verifyAuthorizationProof(
            authorizationEpoch, oneTimeProof, claimCommitment, claimProofsRemaining
        );
        claimCommitment = oneTimeProof;
        claimProofsRemaining -= 1;
        delete pendingRewardOperation;
        nonce = pending.operationNonce + 1;
        emit RewardOperationCancelled(launchId, pending.operationNonce, pending.operation);
    }

    function consumePasswordAuthorization(
        uint8 purpose,
        bytes32 digest,
        bytes32 oneTimeProof,
        bytes calldata passwordSignature
    ) external {
        if (msg.sender != factory || !passwordAuthorizationMode) revert UnauthorizedFactory();
        _verifyPasswordSignature(digest, passwordSignature);
        if (purpose == OPERATION_CLAIM) {
            _verifyAuthorizationProof(
                authorizationEpoch, oneTimeProof, claimCommitment, claimProofsRemaining
            );
            claimCommitment = oneTimeProof;
            claimProofsRemaining -= 1;
        } else if (purpose == OPERATION_UNJAIL) {
            _verifyAuthorizationProof(
                authorizationEpoch, oneTimeProof, redemptionCommitment, redemptionProofsRemaining
            );
            redemptionCommitment = oneTimeProof;
            redemptionProofsRemaining -= 1;
        } else {
            revert InvalidRewardOperation();
        }
        nonce += 1;
    }

    /// @notice Lets anyone clear an expired keeper request so it cannot lock the creator's next claim.
    function cancelExpiredRewardOperation() external {
        PendingRewardOperation memory pending = pendingRewardOperation;
        if (pending.operation == OPERATION_NONE) revert NoPendingRewardOperation();
        if (block.timestamp <= pending.deadline) revert PendingOperationNotExpired();
        delete pendingRewardOperation;
        emit RewardOperationCancelled(launchId, pending.operationNonce, pending.operation);
    }

    /// @notice Rotates to the next precommitted epoch before an operation chain is nearly exhausted.
    function rotateAuthorization(
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        bytes32 oneTimeProof,
        bytes32[] calldata nextEpochProof
    ) external {
        if (passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (msg.sender != creator) revert InvalidAuthorizationProof();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (expectedEpoch != authorizationEpoch) revert StaleAuthorizationEpoch();
        if (
            claimProofsRemaining > ROTATION_THRESHOLD
                && redemptionProofsRemaining > ROTATION_THRESHOLD
                && rotationProofsRemaining > ROTATION_THRESHOLD
        ) revert RotationNotReady();
        if (rotationProofsRemaining == 0) revert AuthorizationExhausted();
        _advanceAuthorization(
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            oneTimeProof,
            nextEpochProof,
            false
        );
    }

    /// @notice Resets local chain position only by advancing to the next precommitted epoch.
    /// Reward liabilities are untouched and arbitrary replacement commitments are rejected.
    function recoverAuthorization(
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        bytes32 oneTimeProof,
        bytes32[] calldata nextEpochProof
    ) external {
        if (passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (msg.sender != creator) revert InvalidAuthorizationProof();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (expectedEpoch != authorizationEpoch) revert StaleAuthorizationEpoch();
        if (recoveryProofsRemaining == 0) revert AuthorizationExhausted();
        _advanceAuthorization(
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            oneTimeProof,
            nextEpochProof,
            true
        );
    }

    function passwordAuthorizationChangeDigest(
        bool recovered,
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        uint256 deadline
    ) public view returns (bytes32) {
        bytes32 typeHash = recovered
            ? PASSWORD_RECOVERY_TYPEHASH
            : PASSWORD_ROTATION_TYPEHASH;
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    typeHash,
                    launchId,
                    creator,
                    expectedEpoch,
                    nextClaimCommitment,
                    nextRedemptionCommitment,
                    nextRotationCommitment,
                    nextRecoveryCommitment,
                    nonce,
                    deadline
                )
            )
        );
    }

    function rotateAuthorizationWithPassword(
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        bytes32 oneTimeProof,
        bytes32[] calldata nextEpochProof,
        uint256 deadline,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature
    ) external {
        if (!passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (expectedEpoch != authorizationEpoch) revert StaleAuthorizationEpoch();
        if (
            claimProofsRemaining > ROTATION_THRESHOLD
                && redemptionProofsRemaining > ROTATION_THRESHOLD
                && rotationProofsRemaining > ROTATION_THRESHOLD
        ) revert RotationNotReady();
        bytes32 digest = passwordAuthorizationChangeDigest(
            false,
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            deadline
        );
        _verifyCreatorWalletSignature(digest, creatorSignature);
        _verifyPasswordSignature(digest, passwordSignature);
        _advanceAuthorization(
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            oneTimeProof,
            nextEpochProof,
            false
        );
        nonce += 1;
    }

    function recoverAuthorizationWithPassword(
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        bytes32 oneTimeProof,
        bytes32[] calldata nextEpochProof,
        uint256 deadline,
        bytes calldata creatorSignature,
        bytes calldata passwordSignature
    ) external {
        if (!passwordAuthorizationMode) revert InvalidAuthorizationProof();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (expectedEpoch != authorizationEpoch) revert StaleAuthorizationEpoch();
        if (recoveryProofsRemaining == 0) revert AuthorizationExhausted();
        bytes32 digest = passwordAuthorizationChangeDigest(
            true,
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            deadline
        );
        _verifyCreatorWalletSignature(digest, creatorSignature);
        _verifyPasswordSignature(digest, passwordSignature);
        _advanceAuthorization(
            expectedEpoch,
            nextClaimCommitment,
            nextRedemptionCommitment,
            nextRotationCommitment,
            nextRecoveryCommitment,
            oneTimeProof,
            nextEpochProof,
            true
        );
        nonce += 1;
    }

    function rotatePasskey(
        bytes32 newKeyX,
        bytes32 newKeyY,
        bytes32 newCredentialIdHash,
        uint256 deadline,
        bytes calldata oldPasskeyAssertion,
        bytes calldata newPasskeyAssertion
    ) external {
        if (block.timestamp > deadline) revert ExpiredAuthorization();
        if (
            newKeyX == bytes32(0) || newKeyY == bytes32(0)
                || newCredentialIdHash == bytes32(0)
        ) revert InvalidConfiguration();

        uint256 usedNonce = nonce;
        uint256 nextVersion = credentialVersion + 1;
        bytes32 oldDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ROTATE_OLD_TYPEHASH,
                    launchId,
                    creator,
                    newKeyX,
                    newKeyY,
                    newCredentialIdHash,
                    usedNonce,
                    deadline,
                    credentialVersion
                )
            )
        );
        bytes32 newDigest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ROTATE_NEW_TYPEHASH,
                    launchId,
                    creator,
                    newKeyX,
                    newKeyY,
                    newCredentialIdHash,
                    usedNonce,
                    deadline,
                    nextVersion
                )
            )
        );

        _verifyPasskey(oldDigest, oldPasskeyAssertion, passkeyX, passkeyY);
        _verifyPasskey(newDigest, newPasskeyAssertion, newKeyX, newKeyY);

        nonce = usedNonce + 1;
        passkeyX = newKeyX;
        passkeyY = newKeyY;
        credentialIdHash = newCredentialIdHash;
        credentialVersion = nextVersion;
        emit PasskeyRotated(launchId, creator, newCredentialIdHash, nextVersion);
    }

    function setPauseStates(bool pauseAccrual, bool pauseIssuance, bool pauseRedemption)
        external
        onlyRole(PAUSER_ROLE)
    {
        accrualPaused = pauseAccrual;
        issuancePaused = pauseIssuance;
        redemptionPaused = pauseRedemption;
        emit VaultPauseChanged(pauseAccrual, pauseIssuance, pauseRedemption);
    }

    function backingStatus()
        external
        view
        returns (uint256 ethBalance, uint256 liabilities, uint256 excess, bool solvent)
    {
        ethBalance = address(this).balance;
        liabilities = accruedRewards + totalSupply();
        solvent = ethBalance >= liabilities;
        excess = solvent ? ethBalance - liabilities : 0;
    }

    function withdrawExcessBacking(uint256 amount)
        external
        nonReentrant
        onlyRole(EMERGENCY_WITHDRAWER_ROLE)
    {
        _requireSolvent();
        uint256 excess = address(this).balance - accruedRewards - totalSupply();
        if (amount == 0 || amount > excess) revert NoExcessBacking();

        (bool success,) = payable(platformTreasury).call{value: amount}("");
        if (!success) revert PayoutFailed();
        emit ExcessBackingWithdrawn(platformTreasury, amount);
        _requireSolvent();
    }

    /// @notice Emergency override that can consume creator backing and cancel outstanding claims.
    /// @dev The destination is fixed to platformTreasury. Native-asset withdrawals write off
    /// unissued rewards and burn this vault's soulbound JailETH before transferring the balance.
    function jailbreak(address asset)
        external
        nonReentrant
        onlyRole(EMERGENCY_WITHDRAWER_ROLE)
        returns (uint256 amount)
    {
        if (asset == address(0)) {
            uint256 cancelledRewards = accruedRewards;
            uint256 cancelledJailETH = totalSupply();
            accruedRewards = 0;
            if (cancelledJailETH != 0) _burn(creator, cancelledJailETH);

            PendingRewardOperation memory pending = pendingRewardOperation;
            if (pending.operation != OPERATION_NONE) {
                delete pendingRewardOperation;
                emit RewardOperationCancelled(
                    launchId, pending.operationNonce, pending.operation
                );
            }

            lifetimeJailbreakLoss += cancelledRewards + cancelledJailETH;
            amount = address(this).balance;
            (bool success,) = payable(platformTreasury).call{value: amount}("");
            if (!success) revert PayoutFailed();
            _requireSolvent();
            emit JailbreakExecuted(
                address(this),
                address(0),
                platformTreasury,
                amount,
                msg.sender,
                cancelledRewards,
                cancelledJailETH
            );
        } else {
            if (asset == address(this) || asset.code.length == 0) {
                revert InvalidEmergencyAsset();
            }
            amount = IERC20(asset).balanceOf(address(this));
            if (amount != 0) SafeERC20.safeTransfer(IERC20(asset), platformTreasury, amount);
            emit JailbreakExecuted(
                address(this), asset, platformTreasury, amount, msg.sender, 0, 0
            );
        }
        lifetimeJailbreakWithdrawals += amount;
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert NonTransferable();
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
    }

    function _requireSolvent() private view {
        if (address(this).balance < accruedRewards + totalSupply()) {
            revert InsufficientBacking();
        }
    }

    function _issueAllAccruedRewards(bytes32 triggeringDistributionId) private {
        if (issuancePaused) return;
        uint256 amount = accruedRewards;
        if (amount == 0) return;

        _requireSolvent();
        accruedRewards -= amount;
        lifetimeAutoIssued += amount;
        _mint(creator, amount);
        _requireSolvent();
        emit JailETHAutomaticallyIssued(
            launchId,
            creator,
            triggeringDistributionId,
            amount,
            accruedRewards
        );
    }

    function _thresholdRewardAmount(uint256 amount)
        private
        pure
        returns (uint256)
    {
        return (amount / MIN_CLAIM) * MIN_CLAIM;
    }

    function _verifyAuthorizationProof(
        uint32 expectedEpoch,
        bytes32 oneTimeProof,
        bytes32 currentCommitment,
        uint16 remainingProofs
    ) private view {
        if (!authorizationConfigured) revert AuthorizationNotConfigured();
        if (expectedEpoch != authorizationEpoch) revert StaleAuthorizationEpoch();
        if (remainingProofs == 0) revert AuthorizationExhausted();
        if (
            currentCommitment == bytes32(0)
                || AuthorizationHashChain.commitmentForProof(oneTimeProof)
                    != currentCommitment
        ) revert InvalidAuthorizationProof();
    }

    function _setPendingRewardOperation(
        uint8 operation,
        uint256 amount,
        address recipient,
        uint256 deadline
    ) private {
        if (pendingRewardOperation.operation != OPERATION_NONE) {
            revert PendingOperationExists();
        }
        pendingRewardOperation = PendingRewardOperation({
            operation: operation,
            amount: amount,
            recipient: recipient,
            operationNonce: nonce,
            expectedEpoch: authorizationEpoch,
            deadline: deadline
        });
        emit RewardOperationRequested(
            launchId,
            nonce,
            operation,
            amount,
            recipient,
            authorizationEpoch,
            deadline
        );
    }

    function _requirePendingRewardOperation(uint8 operation, uint32 expectedEpoch)
        private
        view
        returns (PendingRewardOperation memory pending)
    {
        pending = pendingRewardOperation;
        if (pending.operation == OPERATION_NONE) revert NoPendingRewardOperation();
        if (pending.operation != operation) revert InvalidRewardOperation();
        if (block.timestamp > pending.deadline) revert ExpiredAuthorization();
        if (
            pending.operationNonce != nonce || expectedEpoch != authorizationEpoch
                || pending.expectedEpoch != expectedEpoch
        ) revert StaleAuthorizationEpoch();
    }

    function _advanceAuthorization(
        uint32 expectedEpoch,
        bytes32 nextClaimCommitment,
        bytes32 nextRedemptionCommitment,
        bytes32 nextRotationCommitment,
        bytes32 nextRecoveryCommitment,
        bytes32 oneTimeProof,
        bytes32[] calldata nextEpochProof,
        bool recovered
    ) private {
        if (expectedEpoch >= MAX_AUTHORIZATION_EPOCHS) {
            revert AuthorizationEpochLimitReached();
        }
        if (pendingRewardOperation.operation != OPERATION_NONE) {
            revert PendingOperationExists();
        }
        uint32 nextEpoch = expectedEpoch + 1;
        if (
            nextClaimCommitment == bytes32(0) || nextRedemptionCommitment == bytes32(0)
                || nextRotationCommitment == bytes32(0) || nextRecoveryCommitment == bytes32(0)
        ) revert InvalidConfiguration();
        if (
            !_verifyEpochProof(
                nextEpoch,
                nextClaimCommitment,
                nextRedemptionCommitment,
                nextRotationCommitment,
                nextRecoveryCommitment,
                nextEpochProof,
                authorizationEpochRoot
            )
        ) revert InvalidEpochProof();

        if (recovered) {
            _verifyAuthorizationProof(
                expectedEpoch, oneTimeProof, recoveryCommitment, recoveryProofsRemaining
            );
            recoveryCommitment = oneTimeProof;
            recoveryProofsRemaining -= 1;
        } else {
            _verifyAuthorizationProof(
                expectedEpoch, oneTimeProof, rotationCommitment, rotationProofsRemaining
            );
            rotationCommitment = oneTimeProof;
            rotationProofsRemaining -= 1;
        }

        uint32 previousEpoch = authorizationEpoch;
        authorizationEpoch = nextEpoch;
        claimCommitment = nextClaimCommitment;
        redemptionCommitment = nextRedemptionCommitment;
        rotationCommitment = nextRotationCommitment;
        recoveryCommitment = nextRecoveryCommitment;
        claimProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        redemptionProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        rotationProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;
        recoveryProofsRemaining = AUTHORIZATION_PROOFS_PER_EPOCH;

        if (recovered) {
            emit AuthorizationRecovered(launchId, previousEpoch, nextEpoch);
        } else {
            emit AuthorizationRotated(launchId, previousEpoch, nextEpoch);
        }
    }

    function _verifyEpochProof(
        uint32 epoch,
        bytes32 claim,
        bytes32 redemption,
        bytes32 rotation,
        bytes32 recovery,
        bytes32[] calldata proof,
        bytes32 expectedRoot
    ) private view returns (bool) {
        bytes32 leaf = AuthorizationHashChain.epochLeaf(
            block.chainid,
            address(this),
            creator,
            launchId,
            epoch,
            claim,
            redemption,
            rotation,
            recovery
        );
        return AuthorizationHashChain.verifyMerkleProof(
            leaf, proof, expectedRoot, EPOCH_MERKLE_DEPTH
        );
    }

    function _verifyPasskey(
        bytes32 digest,
        bytes calldata assertion,
        bytes32 keyX,
        bytes32 keyY
    ) private view {
        if (passwordAuthorizationMode) revert InvalidPasskey();
        try IArmoreumPasskeyVerifier(passkeyVerifier).verify(
            digest,
            assertion,
            rpIdHash,
            keyX,
            keyY
        ) returns (bool valid) {
            if (!valid) revert InvalidPasskey();
        } catch {
            revert InvalidPasskey();
        }
    }

    function _verifyPasswordSignature(bytes32 digest, bytes calldata signature) private view {
        if (
            !passwordAuthorizationMode || passwordAuthorizationSigner == address(0)
                || ECDSA.recover(digest, signature) != passwordAuthorizationSigner
        ) revert InvalidAuthorizationProof();
    }

    function _verifyCreatorWalletSignature(bytes32 digest, bytes calldata signature) private view {
        if (ECDSA.recover(digest, signature) != creator) {
            revert InvalidAuthorizationProof();
        }
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

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

    receive() external payable {
        revert DirectDepositsDisabled();
    }
}
