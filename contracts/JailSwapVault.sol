// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IArmoreumPasskeyVerifier} from "./interfaces/IArmoreumPasskeyVerifier.sol";
import {JailETHReceipt, JailToken} from "./JailReceiptToken.sol";
import {AddressPrefix} from "./libraries/AddressPrefix.sol";
import {UpgradeableReentrancyGuard} from "./libraries/UpgradeableReentrancyGuard.sol";

interface IJailSwapV4HookView {
    function poolManager() external view returns (address);
    function launchToken() external view returns (address);
}

interface IJailSwapPonsHookView {
    function poolManager() external view returns (address);
    function feeEscrow() external view returns (address);
}

interface IJailSwapPersonalVaultRegistry {
    function isPersonalJailVault(address candidate) external view returns (bool);
}

/// @notice Per-launch custody and passkey authorization for JailSwap.
/// @dev JailToken is backed by launchToken held here; JailETHReceipt is backed by ETH held here.
contract JailSwapVault is
    Initializable,
    AccessControlUpgradeable,
    EIP712Upgradeable,
    UpgradeableReentrancyGuard,
    UUPSUpgradeable,
    IUnlockCallback
{
    using SafeERC20 for IERC20;

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint8 private constant OP_BUY = 1;
    uint8 private constant OP_SELL = 2;
    uint8 private constant OP_UNJAIL_TOKEN = 3;
    uint8 private constant OP_REDEEM_JAIL_ETH = 4;
    uint8 private constant OP_TRANSFER_JAIL_TOKEN = 5;
    uint256 private constant MAX_POOL_INPUT = uint256(uint128(type(int128).max));
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    bytes32 private constant PASSKEY_ENROLLMENT_TYPEHASH = keccak256(
        "JailSwapPasskeyEnrollment(bytes32 launchId,address account,bytes32 passkeyX,bytes32 passkeyY,bytes32 credentialIdHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant OPERATION_TYPEHASH = keccak256(
        "JailSwapOperation(bytes32 launchId,address account,uint8 operation,uint256 amount,uint256 minimumOutput,address recipient,uint256 nonce,uint256 deadline,uint256 credentialVersion)"
    );

    error InvalidConfiguration();
    error InvalidPoolKey();
    error InvalidPasskey();
    error PasskeyNotRegistered();
    error PasskeyAlreadyRegistered();
    error ExpiredAuthorization();
    error InvalidAmount();
    error InvalidRecipient();
    error InvalidSwapDelta();
    error InsufficientOutput();
    error InputLimitExceeded();
    error PayoutFailed();
    error UnauthorizedFactory();
    error UnauthorizedPersonalJailVault();
    error UnauthorizedPoolManager();
    error ReceiptsNotConfigured();
    error DuplicateReceiptConfiguration();
    error SwapsPaused();
    error InvalidOperation();
    error InsolventVault();

    event PasskeyRegistered(
        bytes32 indexed launchId,
        address indexed account,
        bytes32 credentialIdHash,
        uint256 credentialVersion
    );
    event JailSwapBought(
        bytes32 indexed launchId,
        address indexed account,
        uint256 ethSupplied,
        uint256 ethUsed,
        uint256 launchTokensReceived
    );
    event JailSwapSold(
        bytes32 indexed launchId,
        address indexed account,
        uint256 jailTokensBurned,
        uint256 ethReceiptIssued
    );
    event JailTokenUnjailed(
        bytes32 indexed launchId,
        address indexed account,
        address indexed recipient,
        uint256 amount
    );
    event JailETHRedeemed(
        bytes32 indexed launchId,
        address indexed account,
        address indexed recipient,
        uint256 amount
    );
    event JailTokenTransferred(
        bytes32 indexed launchId,
        address indexed account,
        address indexed recipient,
        uint256 amount
    );
    event JailSwapPauseChanged(bool paused);
    event ReceiptsConfigured(address indexed jailToken, address indexed jailEthReceipt);

    struct UserPasskey {
        bytes32 publicKeyX;
        bytes32 publicKeyY;
        bytes32 credentialIdHash;
        uint256 credentialVersion;
        bool registered;
    }

    bytes32 public launchId;
    address public launchToken;
    address public factory;
    address public passkeyVerifier;
    bytes32 public rpIdHash;
    IPoolManager public poolManager;
    PoolKey private poolKey;
    uint160 public buySqrtPriceLimitX96;
    uint160 public sellSqrtPriceLimitX96;
    address public jailToken;
    address public jailEthReceipt;
    bool public swapsPaused;
    mapping(address account => UserPasskey passkey) private userPasskeys;
    mapping(address account => uint256 nonce) public operationNonces;
    mapping(address account => uint256 nonce) public registrationNonces;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        bytes32 launchId_,
        address launchToken_,
        address poolManager_,
        PoolKey calldata poolKey_,
        uint160 buySqrtPriceLimitX96_,
        uint160 sellSqrtPriceLimitX96_,
        address factory_,
        address passkeyVerifier_,
        bytes32 rpIdHash_,
        address admin_,
        address upgrader_,
        address pauser_
    ) external initializer {
        if (
            launchId_ == bytes32(0) || launchToken_.code.length == 0
                || poolManager_.code.length == 0 || factory_ == address(0)
                || passkeyVerifier_.code.length == 0 || rpIdHash_ == bytes32(0)
                || admin_ == address(0) || upgrader_ == address(0)
                || pauser_ == address(0)
                || buySqrtPriceLimitX96_ < MIN_SQRT_PRICE_PLUS_ONE
                || buySqrtPriceLimitX96_ > MAX_SQRT_PRICE_MINUS_ONE
                || sellSqrtPriceLimitX96_ < MIN_SQRT_PRICE_PLUS_ONE
                || sellSqrtPriceLimitX96_ > MAX_SQRT_PRICE_MINUS_ONE
                || Currency.unwrap(poolKey_.currency0) != address(0)
                || Currency.unwrap(poolKey_.currency1) != launchToken_
        ) revert InvalidConfiguration();
        AddressPrefix.require6900(passkeyVerifier_);
        _validateHook(poolManager_, launchToken_, address(poolKey_.hooks));

        __AccessControl_init();
        __EIP712_init("ArmoreumJailSwapVault", "1");
        launchId = launchId_;
        launchToken = launchToken_;
        factory = factory_;
        passkeyVerifier = passkeyVerifier_;
        rpIdHash = rpIdHash_;
        poolManager = IPoolManager(poolManager_);
        poolKey = poolKey_;
        buySqrtPriceLimitX96 = buySqrtPriceLimitX96_;
        sellSqrtPriceLimitX96 = sellSqrtPriceLimitX96_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
        _grantRole(UPGRADER_ROLE, upgrader_);
        _grantRole(PAUSER_ROLE, pauser_);
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert InvalidConfiguration();
    }

    function configureReceipts(address jailToken_, address jailEthReceipt_)
        external
    {
        if (msg.sender != factory) revert UnauthorizedFactory();
        if (jailToken != address(0) || jailEthReceipt != address(0)) {
            revert DuplicateReceiptConfiguration();
        }
        if (jailToken_.code.length == 0 || jailEthReceipt_.code.length == 0) {
            revert InvalidConfiguration();
        }
        JailToken tokenReceipt = JailToken(jailToken_);
        JailETHReceipt ethReceipt = JailETHReceipt(jailEthReceipt_);
        if (
            tokenReceipt.launchId() != launchId
                || tokenReceipt.backingAsset() != launchToken
                || tokenReceipt.vault() != address(this)
                || ethReceipt.launchId() != launchId
                || ethReceipt.backingAsset() != address(0)
                || ethReceipt.vault() != address(this)
        ) revert InvalidConfiguration();

        jailToken = jailToken_;
        jailEthReceipt = jailEthReceipt_;
        emit ReceiptsConfigured(jailToken_, jailEthReceipt_);
    }

    function passkeyEnrollmentDigest(
        address account,
        bytes32 publicKeyX,
        bytes32 publicKeyY,
        bytes32 credentialIdHash,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PASSKEY_ENROLLMENT_TYPEHASH,
                    launchId,
                    account,
                    publicKeyX,
                    publicKeyY,
                    credentialIdHash,
                    registrationNonces[account],
                    deadline
                )
            )
        );
    }

    /// @notice Binds an account to a passkey before it holds JailSwap receipts.
    function registerPasskey(
        bytes32 publicKeyX,
        bytes32 publicKeyY,
        bytes32 credentialIdHash,
        uint256 deadline,
        bytes calldata assertion
    ) external nonReentrant {
        if (userPasskeys[msg.sender].registered) revert PasskeyAlreadyRegistered();
        if (
            publicKeyX == bytes32(0) || publicKeyY == bytes32(0)
                || credentialIdHash == bytes32(0)
        ) revert InvalidConfiguration();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();

        bytes32 digest = passkeyEnrollmentDigest(
            msg.sender, publicKeyX, publicKeyY, credentialIdHash, deadline
        );
        _verifyPasskey(digest, assertion, publicKeyX, publicKeyY);
        registrationNonces[msg.sender] += 1;
        userPasskeys[msg.sender] = UserPasskey({
            publicKeyX: publicKeyX,
            publicKeyY: publicKeyY,
            credentialIdHash: credentialIdHash,
            credentialVersion: 1,
            registered: true
        });
        emit PasskeyRegistered(launchId, msg.sender, credentialIdHash, 1);
    }

    function getUserPasskey(address account)
        external
        view
        returns (
            bytes32 publicKeyX,
            bytes32 publicKeyY,
            bytes32 credentialIdHash,
            uint256 credentialVersion,
            bool registered
        )
    {
        UserPasskey storage passkey = userPasskeys[account];
        return (
            passkey.publicKeyX,
            passkey.publicKeyY,
            passkey.credentialIdHash,
            passkey.credentialVersion,
            passkey.registered
        );
    }

    function operationDigest(
        address account,
        uint8 operation,
        uint256 amount,
        uint256 minimumOutput,
        address recipient,
        uint256 deadline
    ) external view returns (bytes32) {
        return _operationDigest(
            account,
            operation,
            amount,
            minimumOutput,
            recipient,
            operationNonces[account],
            deadline,
            userPasskeys[account].credentialVersion
        );
    }

    /// @notice Swap ETH into the launch token inside the configured V4 pool and issue JailToken.
    function buy(uint256 minimumJailTokenOut, uint256 deadline, bytes calldata assertion)
        external
        payable
        nonReentrant
        returns (uint256 jailTokenOut)
    {
        _requireReceipts();
        if (swapsPaused) revert SwapsPaused();
        if (msg.value == 0 || msg.value > MAX_POOL_INPUT) revert InvalidAmount();
        _authorize(
            msg.sender,
            OP_BUY,
            msg.value,
            minimumJailTokenOut,
            msg.sender,
            deadline,
            assertion
        );

        uint256 ethUsed;
        (jailTokenOut, ethUsed) = _swapForLaunchToken(msg.value);
        if (jailTokenOut < minimumJailTokenOut) revert InsufficientOutput();
        JailToken(jailToken).vaultMint(msg.sender, jailTokenOut);
        uint256 refund = msg.value - ethUsed;
        if (refund != 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert PayoutFailed();
        }
        _assertSolvent();
        emit JailSwapBought(launchId, msg.sender, msg.value, ethUsed, jailTokenOut);
    }

    /// @notice Buy JailToken for a registered personal Jail Vault without per-token passkey enrollment.
    /// @dev The personal vault has already restricted this call to its wallet owner.
    function buyFromPersonalVault(uint256 minimumJailTokenOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 jailTokenOut)
    {
        _requireReceipts();
        _requirePersonalJailVault();
        if (swapsPaused) revert SwapsPaused();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (msg.value == 0 || msg.value > MAX_POOL_INPUT) revert InvalidAmount();

        uint256 ethUsed;
        (jailTokenOut, ethUsed) = _swapForLaunchToken(msg.value);
        if (jailTokenOut < minimumJailTokenOut) revert InsufficientOutput();
        JailToken(jailToken).vaultMint(msg.sender, jailTokenOut);
        uint256 refund = msg.value - ethUsed;
        if (refund != 0) {
            (bool refunded,) = payable(msg.sender).call{value: refund}("");
            if (!refunded) revert PayoutFailed();
        }
        _assertSolvent();
        emit JailSwapBought(launchId, msg.sender, msg.value, ethUsed, jailTokenOut);
    }

    /// @notice Sell JailToken through the configured pool and issue an ETH-backed JailETH receipt.
    function sell(
        uint256 jailTokenAmount,
        uint256 minimumJailEthOut,
        uint256 deadline,
        bytes calldata assertion
    ) external nonReentrant returns (uint256 jailEthOut) {
        _requireReceipts();
        if (swapsPaused) revert SwapsPaused();
        if (jailTokenAmount == 0 || jailTokenAmount > MAX_POOL_INPUT) {
            revert InvalidAmount();
        }
        _authorize(
            msg.sender,
            OP_SELL,
            jailTokenAmount,
            minimumJailEthOut,
            msg.sender,
            deadline,
            assertion
        );
        JailToken(jailToken).vaultBurn(msg.sender, jailTokenAmount);
        uint256 launchTokenSpent;
        (jailEthOut, launchTokenSpent) = _swapForEth(jailTokenAmount);
        if (launchTokenSpent != jailTokenAmount || jailEthOut < minimumJailEthOut) {
            revert InsufficientOutput();
        }
        JailETHReceipt(jailEthReceipt).vaultMint(msg.sender, jailEthOut);
        _assertSolvent();
        emit JailSwapSold(launchId, msg.sender, jailTokenAmount, jailEthOut);
    }

    /// @notice Sell JailToken held by a registered personal Jail Vault and issue JailETH to it.
    function sellFromPersonalVault(
        uint256 jailTokenAmount,
        uint256 minimumJailEthOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 jailEthOut) {
        _requireReceipts();
        _requirePersonalJailVault();
        if (swapsPaused) revert SwapsPaused();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (jailTokenAmount == 0 || jailTokenAmount > MAX_POOL_INPUT) {
            revert InvalidAmount();
        }

        JailToken(jailToken).vaultBurn(msg.sender, jailTokenAmount);
        uint256 launchTokenSpent;
        (jailEthOut, launchTokenSpent) = _swapForEth(jailTokenAmount);
        if (launchTokenSpent != jailTokenAmount || jailEthOut < minimumJailEthOut) {
            revert InsufficientOutput();
        }
        JailETHReceipt(jailEthReceipt).vaultMint(msg.sender, jailEthOut);
        _assertSolvent();
        emit JailSwapSold(launchId, msg.sender, jailTokenAmount, jailEthOut);
    }

    /// @notice Burn JailToken and release the original launch token to an authorized recipient.
    function unjailToken(
        uint256 amount,
        address recipient,
        uint256 deadline,
        bytes calldata assertion
    ) external nonReentrant {
        _requireReceipts();
        _validateRecipient(recipient);
        if (amount == 0) revert InvalidAmount();
        _authorize(
            msg.sender, OP_UNJAIL_TOKEN, amount, amount, recipient, deadline, assertion
        );
        JailToken(jailToken).vaultBurn(msg.sender, amount);
        IERC20(launchToken).safeTransfer(recipient, amount);
        _assertSolvent();
        emit JailTokenUnjailed(launchId, msg.sender, recipient, amount);
    }

    /// @notice Unjail JailToken held by a registered personal Jail Vault.
    function unjailTokenFromPersonalVault(uint256 amount, address recipient, uint256 deadline)
        external
        nonReentrant
    {
        _requireReceipts();
        _requirePersonalJailVault();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        _validateRecipient(recipient);
        if (amount == 0) revert InvalidAmount();
        JailToken(jailToken).vaultBurn(msg.sender, amount);
        IERC20(launchToken).safeTransfer(recipient, amount);
        _assertSolvent();
        emit JailTokenUnjailed(launchId, msg.sender, recipient, amount);
    }

    /// @notice Burn ETH receipts and pay real ETH from this token's vault.
    function redeemJailETH(
        uint256 amount,
        address payable recipient,
        uint256 deadline,
        bytes calldata assertion
    ) external nonReentrant {
        _requireReceipts();
        _validateRecipient(recipient);
        if (amount == 0) revert InvalidAmount();
        _authorize(
            msg.sender, OP_REDEEM_JAIL_ETH, amount, amount, recipient, deadline, assertion
        );
        JailETHReceipt(jailEthReceipt).vaultBurn(msg.sender, amount);
        (bool paid,) = recipient.call{value: amount}("");
        if (!paid) revert PayoutFailed();
        _assertSolvent();
        emit JailETHRedeemed(launchId, msg.sender, recipient, amount);
    }

    /// @notice Redeem JailETH held by a registered personal Jail Vault back into that vault's ETH.
    function redeemJailETHFromPersonalVault(uint256 amount, uint256 deadline)
        external
        nonReentrant
    {
        _requireReceipts();
        _requirePersonalJailVault();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        if (amount == 0) revert InvalidAmount();
        JailETHReceipt(jailEthReceipt).vaultBurn(msg.sender, amount);
        (bool paid,) = payable(msg.sender).call{value: amount}("");
        if (!paid) revert PayoutFailed();
        _assertSolvent();
        emit JailETHRedeemed(launchId, msg.sender, msg.sender, amount);
    }

    /// @notice The receipt can move only through this vault and requires passkey approval.
    function transferJailToken(
        address recipient,
        uint256 amount,
        uint256 deadline,
        bytes calldata assertion
    ) external nonReentrant {
        _requireReceipts();
        _validateRecipient(recipient);
        if (recipient == msg.sender || amount == 0) revert InvalidAmount();
        _authorize(
            msg.sender,
            OP_TRANSFER_JAIL_TOKEN,
            amount,
            amount,
            recipient,
            deadline,
            assertion
        );
        JailToken(jailToken).vaultTransfer(msg.sender, recipient, amount);
        emit JailTokenTransferred(launchId, msg.sender, recipient, amount);
    }

    function setSwapsPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        swapsPaused = paused;
        emit JailSwapPauseChanged(paused);
    }

    function backingStatus()
        external
        view
        returns (
            uint256 launchTokenBalance,
            uint256 jailTokenSupply,
            uint256 ethBalance,
            uint256 jailEthSupply,
            bool jailTokenSolvent,
            bool jailEthSolvent
        )
    {
        launchTokenBalance = IERC20(launchToken).balanceOf(address(this));
        ethBalance = address(this).balance;
        if (jailToken != address(0)) {
            jailTokenSupply = JailToken(jailToken).totalSupply();
            jailTokenSolvent = launchTokenBalance >= jailTokenSupply;
        }
        if (jailEthReceipt != address(0)) {
            jailEthSupply = JailETHReceipt(jailEthReceipt).totalSupply();
            jailEthSolvent = ethBalance >= jailEthSupply;
        }
    }

    /// @dev PoolManager invokes this inside an unlock opened by a JailSwap operation.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert UnauthorizedPoolManager();
        (uint8 operation, uint256 amountIn) = abi.decode(data, (uint8, uint256));
        if (operation == OP_BUY) {
            (uint256 amountOut, uint256 amountUsed) = _swapForLaunchTokenUnlocked(amountIn);
            return abi.encode(amountOut, amountUsed);
        }
        if (operation == OP_SELL) {
            (uint256 amountOut, uint256 amountUsed) = _swapForEthUnlocked(amountIn);
            return abi.encode(amountOut, amountUsed);
        }
        revert InvalidOperation();
    }

    function _swapForLaunchToken(uint256 amountIn)
        private
        returns (uint256 amountOut, uint256 amountUsed)
    {
        bytes memory result = poolManager.unlock(abi.encode(OP_BUY, amountIn));
        return abi.decode(result, (uint256, uint256));
    }

    function _swapForEth(uint256 amountIn)
        private
        returns (uint256 amountOut, uint256 amountUsed)
    {
        bytes memory result = poolManager.unlock(abi.encode(OP_SELL, amountIn));
        return abi.decode(result, (uint256, uint256));
    }

    function _swapForLaunchTokenUnlocked(uint256 amountIn)
        private
        returns (uint256 amountOut, uint256 amountUsed)
    {
        if (amountIn == 0 || amountIn > MAX_POOL_INPUT) revert InputLimitExceeded();
        PoolKey memory key = poolKey;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: buySqrtPriceLimitX96
            }),
            bytes("")
        );
        int128 ethDelta = delta.amount0();
        int128 tokenDelta = delta.amount1();
        if (ethDelta >= 0 || tokenDelta <= 0) revert InvalidSwapDelta();
        amountUsed = uint256(-int256(ethDelta));
        amountOut = uint256(uint128(tokenDelta));
        if (amountUsed > amountIn) revert InvalidSwapDelta();

        poolManager.settle{value: amountUsed}();
        poolManager.take(key.currency1, address(this), amountOut);
    }

    function _swapForEthUnlocked(uint256 amountIn)
        private
        returns (uint256 amountOut, uint256 amountUsed)
    {
        if (amountIn == 0 || amountIn > MAX_POOL_INPUT) revert InputLimitExceeded();
        PoolKey memory key = poolKey;
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: sellSqrtPriceLimitX96
            }),
            bytes("")
        );
        int128 ethDelta = delta.amount0();
        int128 tokenDelta = delta.amount1();
        if (ethDelta <= 0 || tokenDelta >= 0) revert InvalidSwapDelta();
        amountUsed = uint256(-int256(tokenDelta));
        amountOut = uint256(uint128(ethDelta));
        if (amountUsed != amountIn) revert InvalidSwapDelta();

        poolManager.sync(key.currency1);
        IERC20(launchToken).safeTransfer(address(poolManager), amountUsed);
        poolManager.settle();
        poolManager.take(key.currency0, address(this), amountOut);
    }

    function _authorize(
        address account,
        uint8 operation,
        uint256 amount,
        uint256 minimumOutput,
        address recipient,
        uint256 deadline,
        bytes calldata assertion
    ) private {
        UserPasskey storage passkey = userPasskeys[account];
        if (!passkey.registered) revert PasskeyNotRegistered();
        if (deadline <= block.timestamp) revert ExpiredAuthorization();
        bytes32 digest = _operationDigest(
            account,
            operation,
            amount,
            minimumOutput,
            recipient,
            operationNonces[account],
            deadline,
            passkey.credentialVersion
        );
        _verifyPasskey(digest, assertion, passkey.publicKeyX, passkey.publicKeyY);
        operationNonces[account] += 1;
    }

    function _operationDigest(
        address account,
        uint8 operation,
        uint256 amount,
        uint256 minimumOutput,
        address recipient,
        uint256 nonce,
        uint256 deadline,
        uint256 credentialVersion
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OPERATION_TYPEHASH,
                    launchId,
                    account,
                    operation,
                    amount,
                    minimumOutput,
                    recipient,
                    nonce,
                    deadline,
                    credentialVersion
                )
            )
        );
    }

    function _verifyPasskey(
        bytes32 digest,
        bytes calldata assertion,
        bytes32 publicKeyX,
        bytes32 publicKeyY
    ) private view {
        try IArmoreumPasskeyVerifier(passkeyVerifier).verify(
            digest, assertion, rpIdHash, publicKeyX, publicKeyY
        ) returns (bool valid) {
            if (!valid) revert InvalidPasskey();
        } catch {
            revert InvalidPasskey();
        }
    }

    function _validateRecipient(address recipient) private view {
        if (recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
    }

    function _requireReceipts() private view {
        if (jailToken == address(0) || jailEthReceipt == address(0)) {
            revert ReceiptsNotConfigured();
        }
    }

    function _requirePersonalJailVault() private view {
        try IJailSwapPersonalVaultRegistry(factory).isPersonalJailVault(msg.sender)
            returns (bool registered)
        {
            if (!registered) revert UnauthorizedPersonalJailVault();
        } catch {
            revert UnauthorizedPersonalJailVault();
        }
    }

    function _assertSolvent() private view {
        (,,,, bool jailTokenSolvent, bool jailEthSolvent) = this.backingStatus();
        if (!jailTokenSolvent || !jailEthSolvent) revert InsolventVault();
    }

    function _validateHook(address poolManager_, address launchToken_, address hookAddress)
        private
        view
    {
        bool supportedHook;
        if (hookAddress.code.length != 0) {
            try IJailSwapV4HookView(hookAddress).poolManager()
                returns (address hookPoolManager)
            {
                if (hookPoolManager == poolManager_) {
                    try IJailSwapV4HookView(hookAddress).launchToken()
                        returns (address hookLaunchToken)
                    {
                        supportedHook = hookLaunchToken == launchToken_;
                    } catch {
                        try IJailSwapPonsHookView(hookAddress).feeEscrow()
                            returns (address escrow)
                        {
                            supportedHook = escrow.code.length != 0;
                        } catch {}
                    }
                }
            } catch {}
        }
        if (!supportedHook) revert InvalidPoolKey();
    }

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}

    uint256[48] private __gap;
}
