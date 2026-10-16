// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TaxRouter} from "../TaxRouter.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Test-only callback source used to exercise router accounting.
contract MockTaxSource {
    address public feeEscrow;

    function setFeeEscrow(address feeEscrow_) external {
        feeEscrow = feeEscrow_;
    }

    function collect(TaxRouter router, uint256 grossTradeValue, bytes32 distributionId)
        external
        payable
    {
        router.collectTradeTaxes{value: msg.value}(grossTradeValue, distributionId);
    }

    function collectBase(TaxRouter router, uint256 grossTradeValue, bytes32 distributionId)
        external
        payable
    {
        router.collectBaseTax{value: msg.value}(grossTradeValue, distributionId);
    }

    function collectAdditional(
        TaxRouter router,
        uint256 grossTradeValue,
        bytes32 distributionId
    ) external payable {
        router.collectAdditionalTax{value: msg.value}(grossTradeValue, distributionId);
    }

}

contract MockPonsV2Hook {
    address public immutable poolManager;
    address public immutable feeEscrow;

    constructor(address poolManager_, address feeEscrow_) {
        poolManager = poolManager_;
        feeEscrow = feeEscrow_;
    }
}

contract MockBridgePoolManager {
    function isUnlocked() external pure returns (bool) {
        return false;
    }

    function unlock(bytes calldata) external pure returns (bytes memory) {
        revert("pool unavailable");
    }
}

contract MockPonsV2FeeEscrow {
    mapping(address recipient => uint256 amount) public balanceOf;

    function credit(address recipient) external payable {
        require(recipient != address(0), "zero recipient");
        balanceOf[recipient] += msg.value;
    }

    function claim() external returns (uint256 amount) {
        amount = balanceOf[msg.sender];
        balanceOf[msg.sender] = 0;
        (bool success,) = payable(msg.sender).call{value: amount}("");
        require(success, "claim failed");
    }
}

contract MockLaunchToken is ERC20 {
    constructor(address initialHolder, uint256 initialSupply)
        ERC20("Mock Launch Token", "MLT")
    {
        _mint(initialHolder, initialSupply);
    }
}

contract MockBuybackExecutor {
    using SafeERC20 for IERC20;

    IERC20 public immutable launchToken;
    uint256 public immutable tokensPerEth;
    uint256 public totalEthReceived;

    constructor(IERC20 launchToken_, uint256 tokensPerEth_) {
        launchToken = launchToken_;
        tokensPerEth = tokensPerEth_;
    }

    function executeBuyback() external payable returns (uint256 tokensBought) {
        totalEthReceived += msg.value;
        tokensBought = (msg.value * tokensPerEth) / 1 ether;
        if (tokensBought != 0) launchToken.safeTransfer(msg.sender, tokensBought);
    }
}

contract MockBridgeVault {
    uint256 public constant BUYBACK_THRESHOLD = 0.01 ether;

    IERC20 public immutable launchToken;
    MockBuybackExecutor public immutable buybackExecutor;
    address public taxRouter;
    uint256 public buybackEthAccrued;
    uint256 public totalBuybackEthSpent;
    uint256 public totalBuybackTokens;

    constructor(IERC20 launchToken_, MockBuybackExecutor buybackExecutor_) {
        launchToken = launchToken_;
        buybackExecutor = buybackExecutor_;
    }

    function registerTaxRouter(address taxRouter_) external {
        require(
            taxRouter == address(0) && taxRouter_.code.length != 0,
            "already registered"
        );
        taxRouter = taxRouter_;
    }

    function depositBuybackEth() external payable returns (uint256 tokensBought) {
        require(msg.sender == taxRouter, "unauthorized tax router");
        if (msg.value == 0) return 0;
        buybackEthAccrued += msg.value;
        if (buybackEthAccrued >= BUYBACK_THRESHOLD) {
            uint256 amount = buybackEthAccrued;
            buybackEthAccrued = 0;
            try buybackExecutor.executeBuyback{value: amount}() returns (uint256 bought) {
                uint256 actualBalance = launchToken.balanceOf(address(this));
                require(actualBalance >= totalBuybackTokens + bought, "missing purchased tokens");
                totalBuybackEthSpent += amount;
                totalBuybackTokens += bought;
                tokensBought = bought;
            } catch {
                buybackEthAccrued = amount;
            }
        }
    }
}
