// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UpgradeableReentrancyGuard} from "./libraries/UpgradeableReentrancyGuard.sol";

interface ICreatorRewardReceiver {
    function creditCreatorRewards(bytes32 launchId, bytes32 distributionId)
        external
        payable;
}

interface IBuybackBridgeVault {
    function depositBuybackEth() external payable returns (uint256 tokensBought);
}

interface IPonsV2FeeEscrow {
    function balanceOf(address recipient) external view returns (uint256);
    function claim() external returns (uint256 amount);
}

interface IPonsV2FeePolicyView {
    function feeEscrow() external view returns (address);
}

/// @notice Routes the base tax and mode-specific additional tax atomically.
contract TaxRouter is
    Initializable,
    AccessControlUpgradeable,
    UpgradeableReentrancyGuard,
    UUPSUpgradeable
{
    address public constant PERMANENT_CONTROL_SINK =
        0x000000000000000000000000000000000000dEaD;
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TREASURY_ROLE = keccak256("TREASURY_ROLE");
    bytes32 public constant EMERGENCY_WITHDRAWER_ROLE =
        keccak256("EMERGENCY_WITHDRAWER_ROLE");
    bytes32 public constant PONS_FEE_PROCESSOR_ROLE =
        keccak256("PONS_FEE_PROCESSOR_ROLE");

    uint16 public constant BASE_TAX_BPS = 70;
    uint16 public constant MIN_ADDITIONAL_TAX_BPS = 100;
    uint16 public constant MAX_ADDITIONAL_TAX_BPS = 1000;
    uint16 public constant TAX_STEP_BPS = 1;
    uint16 public constant ETHEREUM_CREATOR_SHARE_BPS = 10_000;
    uint16 public constant MULTICHAIN_CREATOR_SHARE_BPS = 8_000;
    uint16 public constant MULTICHAIN_BUYBACK_SHARE_BPS = 2_000;
    uint16 public constant PONS_SINGLE_CREATOR_SHARE_BPS = 9_000;
    uint16 public constant PONS_PLATFORM_SHARE_BPS = 1_000;
    uint16 public constant PONS_MULTICHAIN_CREATOR_SHARE_BPS = 7_000;
    uint16 public constant PONS_MULTICHAIN_BUYBACK_SHARE_BPS = 2_000;
    uint256 public constant PONS_FEE_SPLIT_THRESHOLD = 0.01 ether;
    uint256 public constant ETHEREUM_FEE_BATCH_THRESHOLD = 0.01 ether;
    uint16 private constant BPS_DENOMINATOR = 10_000;

    enum TaxDistributionMode {
        CreatorOnly,
        Creator80Buyback20,
        PonsCreator90Platform10,
        PonsCreator70Platform10Buyback20
    }

    error InvalidConfiguration();
    error UnauthorizedTaxSource();
    error InvalidTaxAmount();
    error DuplicateDistribution();
    error PausedOperation();
    error InvalidWithdrawal();
    error TreasuryPayoutFailed();
    error FoundationPayoutFailed();
    error BuybackDepositFailed();
    error DirectDepositsDisabled();
    error UnauthorizedSelfCall();
    error NoPendingFeeBatch();
    error InvalidEmergencyAsset();

    event TradeTaxesCollected(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 grossTradeValue,
        uint256 baseTax,
        uint256 additionalTax
    );
    event TradeTaxesDistributed(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 grossTradeValue,
        uint256 baseTax,
        uint256 additionalTax,
        uint256 creatorAmount,
        uint256 buybackEthAmount,
        uint256 buybackTokens
    );
    event BaseTaxDistributed(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 grossTradeValue,
        uint256 baseTax,
        address indexed foundationRecipient
    );
    event AdditionalTaxDistributed(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 tradeValue,
        uint256 additionalTax,
        uint256 creatorAmount,
        uint256 buybackEthAmount,
        uint256 buybackTokens
    );
    event PlatformTaxWithdrawn(address indexed treasury, uint256 amount, bool emergency);
    event PlatformExcessWithdrawn(address indexed treasury, uint256 amount);
    event PlatformPauseChanged(bool paused);
    event PonsAdditionalTaxAccumulated(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 addedAmount,
        uint256 totalAccrued
    );
    event PonsFeeBatchDistributed(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 totalAdditionalTax,
        uint256 creatorAmount,
        uint256 platformAmount,
        uint256 buybackEthAmount,
        uint256 buybackTokens
    );
    event PonsFeeBatchDeferred(
        bytes32 indexed launchId,
        bytes32 indexed triggeringDistributionId,
        uint256 pendingAmount,
        bytes32 reasonHash
    );
    event PonsCreatorFeesClaimed(
        bytes32 indexed launchId,
        bytes32 indexed claimId,
        address indexed feeEscrow,
        uint256 amount,
        uint256 remainingEscrowBalance
    );
    event PonsLaunchTokenBound(bytes32 indexed launchId, address indexed launchToken);
    event MultichainLaunchTokenBound(bytes32 indexed launchId, address indexed launchToken);
    event AdditionalTaxBatchAccrued(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 addedAmount,
        uint256 totalAccrued
    );
    event AdditionalTaxBatchReady(
        bytes32 indexed launchId,
        bytes32 indexed distributionId,
        uint256 eligibleAmount
    );
    event AdditionalTaxBatchDeferred(
        bytes32 indexed launchId,
        bytes32 indexed triggeringDistributionId,
        uint256 pendingAmount,
        bytes32 reasonHash
    );
    event AdditionalTaxBatchDistributed(
        bytes32 indexed launchId,
        bytes32 indexed triggeringDistributionId,
        bytes32 indexed batchDistributionId,
        uint256 totalAdditionalTax,
        uint256 creatorAmount,
        uint256 buybackEthAmount,
        uint256 buybackTokens
    );
    event JailbreakExecuted(
        address indexed vault,
        address indexed asset,
        address indexed destination,
        uint256 amount,
        address caller,
        uint256 cancelledPonsTax,
        uint256 cancelledEthereumTax,
        uint256 cancelledPlatformFees
    );

    bytes32 public launchId;
    address public creator;
    address public canonicalOwner;
    address public creatorVault;
    address public taxSource;
    address public platformTreasury;
    uint16 public additionalTaxBps;
    uint256 public platformAccrued;
    uint256 public totalTaxCollected;
    uint256 public totalCreatorRouted;
    uint256 public totalPlatformAccrued;
    uint256 public creatorSplitRemainder;
    bool public routingPaused;
    mapping(bytes32 distributionId => bool processed) public processedDistributions;

    address public foundationRecipient;
    TaxDistributionMode public taxDistributionMode;
    address public launchToken;
    address public buybackExecutor;
    address public bridgeVault;
    uint256 public totalFoundationRouted;
    uint256 public totalBuybackEth;
    uint256 public totalBuybackTokens;
    mapping(bytes32 distributionId => bool processed) public processedBaseDistributions;
    uint256 public totalBridgeVaultTokensRouted;
    uint256 public ponsAdditionalTaxAccrued;
    uint256 public ponsFeeBatchNonce;
    // Separate per-launch balance for Ethereum-only and Ethereum/multichain additional tax.
    uint256 public ethereumAdditionalTaxAccrued;
    uint256 public ethereumFeeBatchNonce;
    uint256 public lifetimeJailbreakWithdrawn;
    uint256 public lifetimeJailbreakCancelled;
    // Appended storage: Pons credits all creator proceeds to this router's
    // recipient balance, which is claimed and split in a separate keeper tx.
    address public ponsFeeEscrow;
    uint256 public ponsEscrowClaimNonce;
    uint256 public ponsProcessNonce;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        bytes32 launchId_,
        address creator_,
        address creatorVault_,
        address taxSource_,
        address platformTreasury_,
        uint16 additionalTaxBps_,
        address admin_,
        address upgrader_,
        address pauser_,
        address treasury_,
        address emergencyWithdrawer_,
        address foundationRecipient_,
        TaxDistributionMode taxDistributionMode_,
        address launchToken_,
        address buybackExecutor_,
        address bridgeVault_,
        address ponsFeeProcessor_
    ) external initializer {
        if (
            launchId_ == bytes32(0) || creator_ == address(0)
                || creatorVault_.code.length == 0 || taxSource_.code.length == 0
                || platformTreasury_ == address(0) || admin_ == address(0)
                || foundationRecipient_ == address(0)
                || (
                    launchToken_.code.length == 0
                        && taxDistributionMode_
                            != TaxDistributionMode.Creator80Buyback20
                        && taxDistributionMode_
                            != TaxDistributionMode.PonsCreator90Platform10
                        && taxDistributionMode_
                            != TaxDistributionMode.PonsCreator70Platform10Buyback20
                )
                || upgrader_ == address(0) || pauser_ == address(0)
                || treasury_ == address(0) || emergencyWithdrawer_ == address(0)
                || platformTreasury_ != admin_ || upgrader_ != admin_ || pauser_ != admin_
                || treasury_ != admin_
                || !_validTaxBps(additionalTaxBps_)
        ) revert InvalidConfiguration();
        if (
            (
                taxDistributionMode_ == TaxDistributionMode.PonsCreator90Platform10
                    || taxDistributionMode_
                        == TaxDistributionMode.PonsCreator70Platform10Buyback20
            )
                && (
                    ponsFeeProcessor_ == address(0)
                        || ponsFeeProcessor_ == creator_
                )
        ) revert InvalidConfiguration();
        if (
            taxDistributionMode_ == TaxDistributionMode.CreatorOnly
                || taxDistributionMode_ == TaxDistributionMode.PonsCreator90Platform10
        ) {
            if (
                buybackExecutor_ != address(0) || bridgeVault_ != address(0)
            ) revert InvalidConfiguration();
        } else if (
            taxDistributionMode_ == TaxDistributionMode.Creator80Buyback20
                || taxDistributionMode_
                    == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            if (
                buybackExecutor_.code.length == 0 || bridgeVault_.code.length == 0
            ) revert InvalidConfiguration();
        } else {
            revert InvalidConfiguration();
        }

        __AccessControl_init();

        launchId = launchId_;
        creator = creator_;
        canonicalOwner = admin_;
        creatorVault = creatorVault_;
        taxSource = taxSource_;
        platformTreasury = platformTreasury_;
        additionalTaxBps = additionalTaxBps_;
        foundationRecipient = foundationRecipient_;
        taxDistributionMode = taxDistributionMode_;
        launchToken = launchToken_;
        buybackExecutor = buybackExecutor_;
        bridgeVault = bridgeVault_;
        if (
            taxDistributionMode_ == TaxDistributionMode.PonsCreator90Platform10
                || taxDistributionMode_
                    == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            (bool success, bytes memory result) = taxSource_.staticcall(
                abi.encodeWithSelector(IPonsV2FeePolicyView.feeEscrow.selector)
            );
            if (!success || result.length < 32) revert InvalidConfiguration();
            address escrow = abi.decode(result, (address));
            if (escrow.code.length == 0) revert InvalidConfiguration();
            ponsFeeEscrow = escrow;
        }

        // New per-launch routers have no live pause, upgrade, or emergency
        // withdrawal authority. The treasury role remains active so the
        // existing fixed-recipient fee distribution continues to work.
        super._grantRole(DEFAULT_ADMIN_ROLE, PERMANENT_CONTROL_SINK);
        super._grantRole(UPGRADER_ROLE, PERMANENT_CONTROL_SINK);
        super._grantRole(PAUSER_ROLE, PERMANENT_CONTROL_SINK);
        _grantRole(TREASURY_ROLE, treasury_);
        super._grantRole(EMERGENCY_WITHDRAWER_ROLE, PERMANENT_CONTROL_SINK);
        if (
            taxDistributionMode_ == TaxDistributionMode.PonsCreator90Platform10
                || taxDistributionMode_
                    == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            _grantRole(PONS_FEE_PROCESSOR_ROLE, ponsFeeProcessor_);
        }
    }

    /// @notice Binds the token after a Pons-only 90/10 reward system is prepared.
    /// @dev This lets Pons escrow fees to the router from the first trade.
    function bindPonsLaunchToken(address launchToken_) external {
        if (
            msg.sender != creator
                || taxDistributionMode != TaxDistributionMode.PonsCreator90Platform10
                || launchToken != address(0) || launchToken_.code.length == 0
        ) revert InvalidConfiguration();
        launchToken = launchToken_;
        emit PonsLaunchTokenBound(launchId, launchToken_);
    }

    /// @notice Binds the token after a staged Multichain launch has confirmed on-chain.
    /// @dev The token address is one-time and must be the creator's newly deployed contract.
    function bindMultichainLaunchToken(address launchToken_) external {
        if (
            msg.sender != creator
                || (
                    taxDistributionMode != TaxDistributionMode.Creator80Buyback20
                        && taxDistributionMode
                            != TaxDistributionMode.PonsCreator70Platform10Buyback20
                )
                || launchToken != address(0) || launchToken_.code.length == 0
        ) revert InvalidConfiguration();
        launchToken = launchToken_;
        emit MultichainLaunchTokenBound(launchId, launchToken_);
    }

    function collectTradeTaxes(uint256 grossTradeValue, bytes32 distributionId)
        external
        payable
        nonReentrant
    {
        _checkTaxSourceAndPause();
        if (_isPonsMode()) revert InvalidTaxAmount();
        _checkDistributionId(distributionId);
        if (processedDistributions[distributionId] || processedBaseDistributions[distributionId]) {
            revert DuplicateDistribution();
        }

        uint256 baseTax = Math.mulDiv(grossTradeValue, BASE_TAX_BPS, BPS_DENOMINATOR);
        uint256 additionalTax =
            Math.mulDiv(grossTradeValue, additionalTaxBps, BPS_DENOMINATOR);
        uint256 expectedTotalTax = baseTax + additionalTax;
        if (expectedTotalTax == 0 || msg.value != expectedTotalTax) {
            revert InvalidTaxAmount();
        }

        processedDistributions[distributionId] = true;
        processedBaseDistributions[distributionId] = true;
        _routeBaseTax(grossTradeValue, distributionId, baseTax);
        _routeAdditionalTax(grossTradeValue, distributionId, additionalTax);
        emit TradeTaxesCollected(
            launchId, distributionId, grossTradeValue, baseTax, additionalTax
        );
    }

    /// @notice Routes the base fee separately when a verified source pays it directly.
    function collectBaseTax(uint256 grossTradeValue, bytes32 distributionId)
        external
        payable
        nonReentrant
    {
        _checkTaxSourceAndPause();
        if (taxDistributionMode != TaxDistributionMode.CreatorOnly) {
            revert InvalidTaxAmount();
        }
        _checkDistributionId(distributionId);
        if (processedBaseDistributions[distributionId]) revert DuplicateDistribution();
        uint256 baseTax = Math.mulDiv(grossTradeValue, BASE_TAX_BPS, BPS_DENOMINATOR);
        if (baseTax == 0 || msg.value != baseTax) revert InvalidTaxAmount();
        processedBaseDistributions[distributionId] = true;
        _routeBaseTax(grossTradeValue, distributionId, baseTax);
    }

    /// @notice Routes additional tax when the source sends the base fee directly to the foundation.
    function collectAdditionalTax(uint256 grossTradeValue, bytes32 distributionId)
        external
        payable
        nonReentrant
    {
        _checkTaxSourceAndPause();
        if (
            taxDistributionMode != TaxDistributionMode.CreatorOnly
                && !_isPonsMode()
        ) {
            revert InvalidTaxAmount();
        }
        _checkDistributionId(distributionId);
        if (processedDistributions[distributionId]) revert DuplicateDistribution();
        uint256 additionalTax =
            Math.mulDiv(grossTradeValue, additionalTaxBps, BPS_DENOMINATOR);
        if (additionalTax == 0 || msg.value != additionalTax) revert InvalidTaxAmount();
        processedDistributions[distributionId] = true;
        if (_isPonsMode()) {
            _accumulatePonsAdditionalTax(distributionId, additionalTax);
        } else {
            _routeAdditionalTax(grossTradeValue, distributionId, additionalTax);
        }
    }

    function _routeBaseTax(
        uint256 grossTradeValue,
        bytes32 distributionId,
        uint256 baseTax
    ) private {
        totalTaxCollected += baseTax;
        if (baseTax == 0) return;
        totalFoundationRouted += baseTax;
        (bool foundationPaid,) = payable(foundationRecipient).call{value: baseTax}("");
        if (!foundationPaid) revert FoundationPayoutFailed();
        emit BaseTaxDistributed(
            launchId,
            distributionId,
            grossTradeValue,
            baseTax,
            foundationRecipient
        );
    }

    function _routeAdditionalTax(
        uint256,
        bytes32 distributionId,
        uint256 additionalTax
    ) private {
        totalTaxCollected += additionalTax;
        uint256 accruedBeforeDeposit = ethereumAdditionalTaxAccrued;
        ethereumAdditionalTaxAccrued += additionalTax;
        emit AdditionalTaxBatchAccrued(
            launchId,
            distributionId,
            additionalTax,
            ethereumAdditionalTaxAccrued
        );
        if (
            accruedBeforeDeposit < ETHEREUM_FEE_BATCH_THRESHOLD
                && ethereumAdditionalTaxAccrued >= ETHEREUM_FEE_BATCH_THRESHOLD
        ) {
            emit AdditionalTaxBatchReady(
                launchId,
                distributionId,
                ethereumAdditionalTaxAccrued
            );
        }
        if (ethereumAdditionalTaxAccrued >= ETHEREUM_FEE_BATCH_THRESHOLD) {
            _tryDistributeEthereumFeeBatch(distributionId);
        }
    }

    /// @notice Permissionlessly retries a threshold-ready Ethereum or multichain fee batch.
    /// @dev Failed isolated distribution calls roll back their partial writes; accrued tax remains here.
    function retryEthereumFeeBatch() external nonReentrant returns (bool distributed) {
        if (_isPonsMode()) revert InvalidConfiguration();
        if (routingPaused) revert PausedOperation();
        if (ethereumAdditionalTaxAccrued < ETHEREUM_FEE_BATCH_THRESHOLD) {
            revert NoPendingFeeBatch();
        }
        bytes32 retryId = keccak256(
            abi.encode(
                "ETHEREUM_FEE_BATCH_RETRY",
                block.chainid,
                launchId,
                msg.sender,
                block.number,
                ethereumFeeBatchNonce,
                ethereumAdditionalTaxAccrued
            )
        );
        return _tryDistributeEthereumFeeBatch(retryId);
    }

    function _tryDistributeEthereumFeeBatch(bytes32 triggeringDistributionId)
        private
        returns (bool distributed)
    {
        try this.distributeEthereumFeeBatch(triggeringDistributionId) {
            return true;
        } catch (bytes memory reason) {
            emit AdditionalTaxBatchDeferred(
                launchId,
                triggeringDistributionId,
                ethereumAdditionalTaxAccrued,
                keccak256(reason)
            );
            return false;
        }
    }

    function _accumulatePonsAdditionalTax(
        bytes32 distributionId,
        uint256 additionalTax
    ) private {
        totalTaxCollected += additionalTax;
        ponsAdditionalTaxAccrued += additionalTax;
        emit PonsAdditionalTaxAccumulated(
            launchId, distributionId, additionalTax, ponsAdditionalTaxAccrued
        );
        _tryDistributePonsFeeBatch(distributionId);
    }

    /// @notice Claims all Pons creator proceeds once this launch's escrow balance reaches 0.01 ETH.
    /// @dev Pons V2 has no callback into Armoreum, so only the configured keeper may submit this separate tx.
    function processPonsCreatorFees()
        external
        onlyRole(PONS_FEE_PROCESSOR_ROLE)
        nonReentrant
        returns (uint256 claimedAmount)
    {
        if (!_isPonsMode()) revert InvalidConfiguration();
        if (routingPaused) revert PausedOperation();

        uint256 available = IPonsV2FeeEscrow(ponsFeeEscrow).balanceOf(address(this));
        if (available >= PONS_FEE_SPLIT_THRESHOLD) {
            claimedAmount = IPonsV2FeeEscrow(ponsFeeEscrow).claim();
            if (claimedAmount != available) revert InvalidTaxAmount();

            bytes32 claimId = keccak256(
                abi.encode(
                    "PONS_CREATOR_FEE_CLAIM",
                    block.chainid,
                    launchId,
                    ++ponsEscrowClaimNonce,
                    claimedAmount
                )
            );
            emit PonsCreatorFeesClaimed(
                launchId,
                claimId,
                ponsFeeEscrow,
                claimedAmount,
                IPonsV2FeeEscrow(ponsFeeEscrow).balanceOf(address(this))
            );
            _accumulatePonsAdditionalTax(claimId, claimedAmount);
            return claimedAmount;
        }

        // A failed payout is kept in this router and may be retried by the
        // configured fee processor, even if the Pons escrow has no new balance.
        if (ponsAdditionalTaxAccrued < PONS_FEE_SPLIT_THRESHOLD) {
            revert NoPendingFeeBatch();
        }
        bytes32 retryId = keccak256(
            abi.encode(
                "PONS_CREATOR_FEE_RETRY",
                block.chainid,
                launchId,
                ++ponsProcessNonce,
                msg.sender
            )
        );
        _tryDistributePonsFeeBatch(retryId);
    }

    function _tryDistributePonsFeeBatch(bytes32 triggeringDistributionId) private {
        if (ponsAdditionalTaxAccrued < PONS_FEE_SPLIT_THRESHOLD) return;
        try this.distributePonsFeeBatch(triggeringDistributionId) {
            // Distribution runs atomically in this isolated self-call.
        } catch (bytes memory reason) {
            emit PonsFeeBatchDeferred(
                launchId,
                triggeringDistributionId,
                ponsAdditionalTaxAccrued,
                keccak256(reason)
            );
        }
    }

    /// @dev Only an isolated self-call may distribute a Pons batch.
    function distributePonsFeeBatch(bytes32 triggeringDistributionId) external {
        if (msg.sender != address(this)) revert UnauthorizedSelfCall();
        uint256 feeBatch = ponsAdditionalTaxAccrued;
        if (feeBatch < PONS_FEE_SPLIT_THRESHOLD) revert NoPendingFeeBatch();
        ponsAdditionalTaxAccrued = 0;
        uint256 platformAmount = Math.mulDiv(
            feeBatch, PONS_PLATFORM_SHARE_BPS, BPS_DENOMINATOR
        );
        uint256 buybackEthAmount;
        if (
            taxDistributionMode
                == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            buybackEthAmount = Math.mulDiv(
                feeBatch, PONS_MULTICHAIN_BUYBACK_SHARE_BPS, BPS_DENOMINATOR
            );
        }
        uint256 creatorAmount = feeBatch - platformAmount - buybackEthAmount;
        bytes32 batchDistributionId = keccak256(
            abi.encode(launchId, triggeringDistributionId, ++ponsFeeBatchNonce)
        );

        totalCreatorRouted += creatorAmount;
        totalPlatformAccrued += platformAmount;
        platformAccrued += platformAmount;
        if (creatorAmount != 0) {
            ICreatorRewardReceiver(creatorVault).creditCreatorRewards{
                value: creatorAmount
            }(launchId, batchDistributionId);
        }

        uint256 buybackTokens;
        if (buybackEthAmount != 0) {
            totalBuybackEth += buybackEthAmount;
            try IBuybackBridgeVault(bridgeVault).depositBuybackEth{
                value: buybackEthAmount
            }() returns (uint256 tokensBought) {
                buybackTokens = tokensBought;
                totalBuybackTokens += tokensBought;
            } catch {
                revert BuybackDepositFailed();
            }
        }

        emit PonsFeeBatchDistributed(
            launchId,
            triggeringDistributionId,
            feeBatch,
            creatorAmount,
            platformAmount,
            buybackEthAmount,
            buybackTokens
        );
    }

    /// @dev Only an isolated self-call from an eligible fee deposit or permissionless retry may distribute an ETH batch.
    function distributeEthereumFeeBatch(bytes32 triggeringDistributionId) external {
        if (msg.sender != address(this)) revert UnauthorizedSelfCall();
        uint256 feeBatch = ethereumAdditionalTaxAccrued;
        if (feeBatch < ETHEREUM_FEE_BATCH_THRESHOLD) revert NoPendingFeeBatch();
        ethereumAdditionalTaxAccrued = 0;

        uint16 creatorShareBps = taxDistributionMode == TaxDistributionMode.CreatorOnly
            ? ETHEREUM_CREATOR_SHARE_BPS
            : MULTICHAIN_CREATOR_SHARE_BPS;
        uint256 creatorNumeratorRemainder =
            mulmod(feeBatch, creatorShareBps, BPS_DENOMINATOR)
                + creatorSplitRemainder;
        uint256 creatorAmount = Math.mulDiv(
            feeBatch, creatorShareBps, BPS_DENOMINATOR
        ) + creatorNumeratorRemainder / BPS_DENOMINATOR;
        creatorSplitRemainder = creatorNumeratorRemainder % BPS_DENOMINATOR;
        uint256 buybackEthAmount = feeBatch - creatorAmount;
        bytes32 batchDistributionId = keccak256(
            abi.encode(launchId, triggeringDistributionId, ++ethereumFeeBatchNonce)
        );

        totalCreatorRouted += creatorAmount;
        if (creatorAmount != 0) {
            ICreatorRewardReceiver(creatorVault).creditCreatorRewards{
                value: creatorAmount
            }(launchId, batchDistributionId);
        }

        uint256 buybackTokens;
        if (
            taxDistributionMode == TaxDistributionMode.Creator80Buyback20
                && buybackEthAmount != 0
        ) {
            totalBuybackEth += buybackEthAmount;
            try IBuybackBridgeVault(bridgeVault).depositBuybackEth{
                value: buybackEthAmount
            }() returns (uint256 tokensBought) {
                buybackTokens = tokensBought;
                totalBuybackTokens += tokensBought;
            } catch {
                revert BuybackDepositFailed();
            }
        }

        emit AdditionalTaxBatchDistributed(
            launchId,
            triggeringDistributionId,
            batchDistributionId,
            feeBatch,
            creatorAmount,
            buybackEthAmount,
            buybackTokens
        );
    }

    function _isPonsMode() private view returns (bool) {
        return taxDistributionMode == TaxDistributionMode.PonsCreator90Platform10
            || taxDistributionMode
                == TaxDistributionMode.PonsCreator70Platform10Buyback20;
    }

    function _creatorShare(uint256 additionalTax) private view returns (uint256 creatorAmount) {
        uint16 creatorShareBps;
        if (taxDistributionMode == TaxDistributionMode.CreatorOnly) {
            creatorShareBps = ETHEREUM_CREATOR_SHARE_BPS;
        } else if (
            taxDistributionMode
                == TaxDistributionMode.PonsCreator90Platform10
        ) {
            creatorShareBps = PONS_SINGLE_CREATOR_SHARE_BPS;
        } else if (
            taxDistributionMode
                == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            creatorShareBps = PONS_MULTICHAIN_CREATOR_SHARE_BPS;
        } else {
            creatorShareBps = MULTICHAIN_CREATOR_SHARE_BPS;
        }
        uint256 splitRemainder =
            mulmod(additionalTax, creatorShareBps, BPS_DENOMINATOR)
                + creatorSplitRemainder;
        creatorAmount =
            Math.mulDiv(additionalTax, creatorShareBps, BPS_DENOMINATOR)
                + splitRemainder / BPS_DENOMINATOR;
    }

    function _checkTaxSourceAndPause() private view {
        if (msg.sender != taxSource) revert UnauthorizedTaxSource();
        if (routingPaused) revert PausedOperation();
    }

    function _checkDistributionId(bytes32 distributionId) private pure {
        if (distributionId == bytes32(0)) revert DuplicateDistribution();
    }

    function withdrawPlatform(uint256 amount)
        external
        nonReentrant
        onlyRole(TREASURY_ROLE)
    {
        _withdrawPlatform(amount, false);
    }

    function emergencyWithdrawPlatform(uint256 amount)
        external
        nonReentrant
        onlyRole(EMERGENCY_WITHDRAWER_ROLE)
    {
        _withdrawPlatform(amount, true);
    }

    function withdrawPlatformExcess(uint256 amount)
        external
        nonReentrant
        onlyRole(EMERGENCY_WITHDRAWER_ROLE)
    {
        uint256 reserved =
            platformAccrued + ponsAdditionalTaxAccrued + ethereumAdditionalTaxAccrued;
        uint256 excess = address(this).balance - reserved;
        if (amount == 0 || amount > excess) revert InvalidWithdrawal();
        (bool success,) = payable(platformTreasury).call{value: amount}("");
        if (!success) revert TreasuryPayoutFailed();
        emit PlatformExcessWithdrawn(platformTreasury, amount);
    }

    /// @notice Emergency override that clears pending allocations before sending assets to the fixed treasury.
    /// @dev Native withdrawal cancels outstanding Pons/ETH additional-tax batches and platform fees.
    /// Historical totals and processed-distribution markers remain intact to prevent replay.
    function jailbreak(address asset)
        external
        nonReentrant
        onlyRole(EMERGENCY_WITHDRAWER_ROLE)
        returns (uint256 amount)
    {
        uint256 cancelledPonsTax;
        uint256 cancelledEthereumTax;
        uint256 cancelledPlatformFees;
        if (asset == address(0)) {
            cancelledPonsTax = ponsAdditionalTaxAccrued;
            cancelledEthereumTax = ethereumAdditionalTaxAccrued;
            cancelledPlatformFees = platformAccrued;
            ponsAdditionalTaxAccrued = 0;
            ethereumAdditionalTaxAccrued = 0;
            platformAccrued = 0;

            amount = address(this).balance;
            (bool success,) = payable(platformTreasury).call{value: amount}("");
            if (!success) revert TreasuryPayoutFailed();
        } else {
            if (asset.code.length == 0) revert InvalidEmergencyAsset();
            amount = IERC20(asset).balanceOf(address(this));
            if (amount != 0) SafeERC20.safeTransfer(IERC20(asset), platformTreasury, amount);
        }

        lifetimeJailbreakWithdrawn += amount;
        lifetimeJailbreakCancelled +=
            cancelledPonsTax + cancelledEthereumTax + cancelledPlatformFees;
        emit JailbreakExecuted(
            address(this),
            asset,
            platformTreasury,
            amount,
            msg.sender,
            cancelledPonsTax,
            cancelledEthereumTax,
            cancelledPlatformFees
        );
    }

    function setRoutingPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        routingPaused = paused;
        emit PlatformPauseChanged(paused);
    }

    function previewTax(uint256 grossTradeValue)
        external
        view
        returns (
            uint256 baseTax,
            uint256 additionalTax,
            uint256 creatorShare,
            uint256 buybackShare,
            uint256 totalTax
        )
    {
        baseTax = _isPonsMode()
            ? 0
            : Math.mulDiv(grossTradeValue, BASE_TAX_BPS, BPS_DENOMINATOR);
        additionalTax =
            Math.mulDiv(grossTradeValue, additionalTaxBps, BPS_DENOMINATOR);
        creatorShare = _creatorShare(additionalTax);
        if (
            taxDistributionMode == TaxDistributionMode.Creator80Buyback20
                || taxDistributionMode
                    == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            buybackShare = Math.mulDiv(
                additionalTax,
                taxDistributionMode == TaxDistributionMode.Creator80Buyback20
                    ? MULTICHAIN_BUYBACK_SHARE_BPS
                    : PONS_MULTICHAIN_BUYBACK_SHARE_BPS,
                BPS_DENOMINATOR
            );
        }
        totalTax = baseTax + additionalTax;
    }

    function previewPonsFeeBatch(uint256 feeBatch)
        external
        view
        returns (uint256 creatorAmount, uint256 platformAmount, uint256 buybackEthAmount)
    {
        if (!_isPonsMode()) revert InvalidConfiguration();
        platformAmount = Math.mulDiv(
            feeBatch, PONS_PLATFORM_SHARE_BPS, BPS_DENOMINATOR
        );
        if (
            taxDistributionMode
                == TaxDistributionMode.PonsCreator70Platform10Buyback20
        ) {
            buybackEthAmount = Math.mulDiv(
                feeBatch, PONS_MULTICHAIN_BUYBACK_SHARE_BPS, BPS_DENOMINATOR
            );
        }
        creatorAmount = feeBatch - platformAmount - buybackEthAmount;
    }

    function withdrawablePlatformBalance() external view returns (uint256) {
        return platformAccrued;
    }

    function _withdrawPlatform(uint256 amount, bool emergency) private {
        if (amount == 0 || amount > platformAccrued) revert InvalidWithdrawal();
        platformAccrued -= amount;
        (bool success,) = payable(platformTreasury).call{value: amount}("");
        if (!success) revert TreasuryPayoutFailed();
        emit PlatformTaxWithdrawn(platformTreasury, amount, emergency);
    }

    function _validTaxBps(uint16 value) private pure returns (bool) {
        return value >= MIN_ADDITIONAL_TAX_BPS && value <= MAX_ADDITIONAL_TAX_BPS
            && (value - MIN_ADDITIONAL_TAX_BPS) % TAX_STEP_BPS == 0;
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
        return role == DEFAULT_ADMIN_ROLE || role == UPGRADER_ROLE || role == PAUSER_ROLE
            || role == TREASURY_ROLE;
    }

    receive() external payable {
        if (!_isPonsMode() || msg.sender != ponsFeeEscrow) {
            revert DirectDepositsDisabled();
        }
    }
}
