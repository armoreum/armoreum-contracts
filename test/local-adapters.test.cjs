const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function deployWithSigner(contractName, signer, ...args) {
  const factory = await ethers.getContractFactory(contractName, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function localUnlockedSigners() {
  const { chainId } = await ethers.provider.getNetwork();
  const rpcUrl = chainId === 31337n
    ? "http://127.0.0.1:8545"
    : chainId === 46630n
      ? "http://127.0.0.1:8546"
      : null;
  if (!rpcUrl) throw new Error(`Unsupported local test chain: ${chainId}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(chainId), {
    staticNetwork: true,
  });
  const addresses = await provider.send("eth_accounts", []);
  if (addresses.length < 3) throw new Error("The local EVM exposes fewer than three unlocked test accounts.");
  return Promise.all(addresses.slice(0, 3).map((address) => provider.getSigner(address)));
}

describe("Local launch adapters", function () {
  let operator;
  let creator;
  let recipient;

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 46630n) this.skip();
  });

  beforeEach(async function () {
    [operator, creator, recipient] = await localUnlockedSigners();
  });

  it("creates an idempotent fixed-supply launch through the local Pons-compatible adapter", async function () {
    const tokenDeployer = await deployWithSigner("ArmoreumTokenDeployer", operator);
    const adapter = await deployWithSigner(
      "LocalPonsV2Adapter",
      operator,
      operator.address,
      await tokenDeployer.getAddress(),
    );
    const launchId = ethers.id("local-pons-launch");
    const salt = ethers.id("local-pons-token");
    const tokenAddress = await tokenDeployer.computeTokenAddress(
      "Local Pons Token",
      "LPT",
      creator.address,
      salt,
    );

    const transaction = await adapter.createLaunch(
      launchId,
      "Local Pons Token",
      "LPT",
      creator.address,
      salt,
    );
    const receipt = await transaction.wait();
    assert.equal(await adapter.launchTokens(launchId), tokenAddress);
    assert.ok(receipt.logs.some((log) => {
      try {
        return adapter.interface.parseLog(log)?.name === "LocalPonsCompatibleLaunchCreated";
      } catch {
        return false;
      }
    }));

    const token = await ethers.getContractAt("FixedSupplyLaunchToken", tokenAddress, creator);
    assert.equal(await token.totalSupply(), 1_000_000_000n * 10n ** 18n);
    assert.equal(await token.balanceOf(creator.address), 1_000_000_000n * 10n ** 18n);
    assert.equal(await adapter.createLaunch.staticCall(
      launchId,
      "Local Pons Token",
      "LPT",
      creator.address,
      salt,
    ), tokenAddress);
    await assert.rejects(adapter.createLaunch(
      launchId,
      "Different Token",
      "DIFF",
      creator.address,
      salt,
    ));
  });

});

describe("Local Ethereum launch adapter", function () {
  let operator;
  let creator;

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 31337n) this.skip();
  });

  beforeEach(async function () {
    [operator, creator] = await localUnlockedSigners();
  });

  it("deploys the deterministic fixed-supply token to the creator", async function () {
    const tokenDeployer = await deployWithSigner("ArmoreumTokenDeployer", operator);
    const salt = ethers.id("local-ethereum-launch");
    const tokenAddress = await tokenDeployer.computeTokenAddress(
      "Local Ethereum Token",
      "LET",
      creator.address,
      salt,
    );
    const transaction = await tokenDeployer.deployToken(
      "Local Ethereum Token",
      "LET",
      creator.address,
      salt,
    );
    const receipt = await transaction.wait();
    assert.equal(receipt.status, 1);

    const token = await ethers.getContractAt("FixedSupplyLaunchToken", tokenAddress, creator);
    const expectedSupply = 1_000_000_000n * 10n ** 18n;
    assert.equal(await token.totalSupply(), expectedSupply);
    assert.equal(await token.balanceOf(creator.address), expectedSupply);
    assert.ok(receipt.logs.some((log) => {
      try {
        return tokenDeployer.interface.parseLog(log)?.name === "TokenDeployed";
      } catch {
        return false;
      }
    }));
  });
});

describe("Local bridge source lock", function () {
  let operator;
  let creator;
  let recipient;

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 46630n) this.skip();
  });

  beforeEach(async function () {
    [operator, creator, recipient] = await localUnlockedSigners();
  });

  it("locks actual ERC-20 tokens and emits a unique relay message", async function () {
    const tokenDeployer = await deployWithSigner("ArmoreumTokenDeployer", operator);
    const bridge = await deployWithSigner("LocalBridgeAdapter", operator, operator.address);
    const salt = ethers.id("source-lock-token");
    const tokenAddress = await tokenDeployer.computeTokenAddress(
      "Source Token",
      "SRC",
      creator.address,
      salt,
    );
    await tokenDeployer.deployToken("Source Token", "SRC", creator.address, salt);
    const token = await ethers.getContractAt("FixedSupplyLaunchToken", tokenAddress, creator);
    const amount = 123n;
    const launchId = ethers.id("source-lock-launch");
    const destinationToken = "0x0000000000000000000000000000000000000002";
    const supplyBefore = await token.totalSupply();
    const expectedMessageId = await bridge.computeMessageId(
      46630,
      31337,
      launchId,
      tokenAddress,
      destinationToken,
      creator.address,
      recipient.address,
      amount,
      0,
    );

    await token.connect(creator).approve(await bridge.getAddress(), amount);
    await bridge.connect(creator).initiateLock(
      launchId,
      tokenAddress,
      destinationToken,
      recipient.address,
      amount,
    );
    assert.equal(await token.balanceOf(await bridge.getAddress()), amount);
    assert.equal(await bridge.outboundMessages(expectedMessageId), true);
    assert.equal(await bridge.nonces(creator.address), 1n);
    assert.equal(await token.totalSupply(), supplyBefore);
  });
});

describe("Local bridge destination release", function () {
  let operator;
  let creator;
  let recipient;

  before(async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 31337n) this.skip();
  });

  beforeEach(async function () {
    [operator, creator, recipient] = await localUnlockedSigners();
  });

  it("releases only prefunded destination tokens and consumes each relay once", async function () {
    const bridge = await deployWithSigner("LocalBridgeAdapter", operator, operator.address);
    const tokenDeployer = await deployWithSigner("ArmoreumTokenDeployer", operator);
    const salt = ethers.id("destination-release-token");
    const tokenAddress = await tokenDeployer.computeTokenAddress(
      "Destination Token",
      "DST",
      operator.address,
      salt,
    );
    await tokenDeployer.deployToken("Destination Token", "DST", operator.address, salt);
    const token = await ethers.getContractAt("FixedSupplyLaunchToken", tokenAddress, operator);
    const amount = 125n;
    const launchId = ethers.id("destination-release-launch");
    const sourceToken = "0x0000000000000000000000000000000000000001";
    const messageId = await bridge.computeMessageId(
      46630,
      31337,
      launchId,
      sourceToken,
      tokenAddress,
      creator.address,
      recipient.address,
      amount,
      0,
    );
    const supplyBefore = await token.totalSupply();
    const recipientBefore = await token.balanceOf(recipient.address);
    await token.connect(operator).transfer(await bridge.getAddress(), amount);
    await bridge.relayRelease(
      messageId,
      launchId,
      46630,
      31337,
      sourceToken,
      tokenAddress,
      creator.address,
      recipient.address,
      amount,
      0,
    );

    assert.equal(await token.balanceOf(recipient.address), recipientBefore + amount);
    assert.equal(await token.totalSupply(), supplyBefore);
    assert.equal(await bridge.consumedMessages(messageId), true);
    await assert.rejects(bridge.relayRelease(
      messageId,
      launchId,
      46630,
      31337,
      sourceToken,
      tokenAddress,
      creator.address,
      recipient.address,
      amount,
      0,
    ));
    await assert.rejects(bridge.connect(creator).relayRelease(
      ethers.id("forged-message"),
      launchId,
      46630,
      31337,
      sourceToken,
      tokenAddress,
      creator.address,
      recipient.address,
      amount,
      1,
    ));
  });
});
