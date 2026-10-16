const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function vanitySalt(deployer, initCodeHash) {
  for (let counter = 1n; counter < 2_000_000n; counter += 1n) {
    const salt = ethers.toBeHex(counter, 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (predicted.toLowerCase().startsWith("0x6900")) return { salt, predicted };
  }
  throw new Error("Test CREATE2 vanity search exceeded its limit");
}

async function deployVanity(helper, initCode) {
  const deployer = await helper.getAddress();
  const initCodeHash = ethers.keccak256(initCode);
  const { salt, predicted } = await vanitySalt(deployer, initCodeHash);
  await (await helper.deploy(salt, initCode)).wait();
  assert.notEqual(await ethers.provider.getCode(predicted), "0x");
  return predicted;
}

async function testSigners() {
  const { chainId } = await ethers.provider.getNetwork();
  const rpcUrl =
    chainId === 31337n
      ? "http://127.0.0.1:8545"
      : chainId === 46630n
        ? "http://127.0.0.1:8546"
        : null;
  if (!rpcUrl) return ethers.getSigners();

  const provider = new ethers.JsonRpcProvider(rpcUrl, Number(chainId), {
    staticNetwork: true,
  });
  const addresses = await provider.send("eth_accounts", []);
  if (addresses.length < 5) throw new Error("The local EVM exposes fewer than five unlocked test accounts.");
  return Promise.all(addresses.slice(0, 5).map((address) => provider.getSigner(address)));
}

describe("per-launch JailToken receipts", function () {
  it("creates one idempotent receipt per launch and blocks direct transfers", async function () {
    this.timeout(120_000);
    const [admin, launchFactory, holder, recipient, upgrader] =
      await testSigners();
    const receiptVaultFactory =
      await ethers.getContractFactory("MockJailReceiptVault", admin);
    const receiptVault = await receiptVaultFactory.deploy();
    await receiptVault.waitForDeployment();
    const mainTokenFactory =
      await ethers.getContractFactory("FixedSupplyLaunchToken", admin);
    const mainToken = await mainTokenFactory.deploy(
      "Launch Asset",
      "LCH",
      holder.address,
    );
    await mainToken.waitForDeployment();

    const tokenImplementationFactory = await ethers.getContractFactory("JailToken", admin);
    const jailEthImplementationFactory =
      await ethers.getContractFactory("JailETHReceipt", admin);
    const helperFactory = await ethers.getContractFactory("TestCreate2Deployer");
    const signedHelperFactory = helperFactory.connect(admin);
    const helper = await signedHelperFactory.deploy();
    await helper.waitForDeployment();
    const tokenImplementationAddress = await deployVanity(
      helper,
      tokenImplementationFactory.bytecode,
    );
    const jailEthImplementationAddress = await deployVanity(
      helper,
      jailEthImplementationFactory.bytecode,
    );
    const factoryImplementationFactory =
      await ethers.getContractFactory("JailTokenFactory", admin);
    const factoryImplementationAddress = await deployVanity(
      helper,
      factoryImplementationFactory.bytecode,
    );
    const initializeData =
      factoryImplementationFactory.interface.encodeFunctionData(
        "initializeWithJailEth",
        [
          admin.address,
          upgrader.address,
          tokenImplementationAddress,
          jailEthImplementationAddress,
        ],
      );
    const factoryInitCode = await helper.proxyInitCode(
      factoryImplementationAddress,
      initializeData,
    );
    const proxyAddress = await deployVanity(helper, factoryInitCode);
    const factory = factoryImplementationFactory.attach(proxyAddress).connect(admin);
    await factory.connect(admin).setLaunchFactory(launchFactory.address, true);

    const launchId = ethers.id("launch-one");
    await factory
      .connect(launchFactory)
      .createJailToken(
        launchId,
        await mainToken.getAddress(),
        await receiptVault.getAddress(),
        "Jail Launch Asset",
        "jLCH",
        admin.address,
        upgrader.address,
      );
    const jailTokenAddress = await factory.jailTokens(launchId);
    const jailEthReceiptAddress = await factory.jailEthReceipts(launchId);
    assert.notEqual(jailTokenAddress, ethers.ZeroAddress);
    assert.notEqual(jailEthReceiptAddress, ethers.ZeroAddress);
    const jailToken = tokenImplementationFactory.attach(jailTokenAddress).connect(admin);
    const jailEthReceipt =
      jailEthImplementationFactory.attach(jailEthReceiptAddress).connect(admin);
    assert.equal(await jailToken.launchId(), launchId);
    assert.equal(await jailToken.backingAsset(), await mainToken.getAddress());
    assert.equal(await jailToken.vault(), await receiptVault.getAddress());
    assert.equal(await jailEthReceipt.launchId(), launchId);
    assert.equal(await jailEthReceipt.backingAsset(), ethers.ZeroAddress);
    assert.equal(await jailEthReceipt.vault(), await receiptVault.getAddress());
    assert.equal(await jailEthReceipt.name(), "jailETH Jail Launch Asset");
    assert.equal(await jailEthReceipt.symbol(), "jETH-jLCH");

    await factory
      .connect(launchFactory)
      .createJailToken(
        launchId,
        await mainToken.getAddress(),
        await receiptVault.getAddress(),
        "Jail Launch Asset",
        "jLCH",
        admin.address,
        upgrader.address,
      );
    assert.equal(await factory.jailTokens(launchId), jailTokenAddress);
    assert.equal(await factory.jailEthReceipts(launchId), jailEthReceiptAddress);

    await receiptVault.mint(jailTokenAddress, holder.address, 5n);
    await assert.rejects(
      jailToken.connect(holder).transfer(recipient.address, 1n),
      /ProtectedTransferOnly/,
    );
    await assert.rejects(
      jailToken.connect(holder).approve(recipient.address, 1n),
      /ProtectedTransferOnly/,
    );
    await receiptVault.move(jailTokenAddress, holder.address, recipient.address, 2n);
    assert.equal(await jailToken.balanceOf(holder.address), 3n);
    assert.equal(await jailToken.balanceOf(recipient.address), 2n);
    await receiptVault.mint(jailEthReceiptAddress, holder.address, 7n);
    assert.equal(await jailEthReceipt.balanceOf(holder.address), 7n);
    await assert.rejects(
      jailEthReceipt.connect(holder).transfer(recipient.address, 1n),
      /ProtectedTransferOnly/,
    );

    await assert.rejects(
      factory
        .connect(launchFactory)
        .createJailToken(
          launchId,
          await mainToken.getAddress(),
          await receiptVault.getAddress(),
          "Changed Name",
          "jLCH",
          admin.address,
          upgrader.address,
        ),
    );
    await assert.rejects(
      jailToken.connect(admin).vaultMint(holder.address, 1n),
    );
  });
});
