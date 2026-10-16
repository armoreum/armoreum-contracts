const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

async function vanityProxy(helper, implementation, initialization) {
  const initCode = await helper.proxyInitCode(implementation, initialization);
  const initCodeHash = ethers.keccak256(initCode);
  const deployer = await helper.getAddress();
  for (let counter = 1n; counter < 2_000_000n; counter += 1n) {
    const salt = ethers.toBeHex(counter, 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (!predicted.toLowerCase().startsWith("0x6900")) continue;
    await (await helper.deploy(salt, initCode)).wait();
    assert.notEqual(await ethers.provider.getCode(predicted), "0x");
    return predicted;
  }
  throw new Error("VaultFactory proxy vanity search exceeded its limit.");
}

async function vanityContract(helper, initCode) {
  const initCodeHash = ethers.keccak256(initCode);
  const deployer = await helper.getAddress();
  for (let counter = 2_000_001n; counter < 4_000_000n; counter += 1n) {
    const salt = ethers.toBeHex(counter, 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (!predicted.toLowerCase().startsWith("0x6900")) continue;
    await (await helper.deploy(salt, initCode)).wait();
    assert.notEqual(await ethers.provider.getCode(predicted), "0x");
    return predicted;
  }
  throw new Error("VaultFactory implementation vanity search exceeded its limit.");
}

describe("VaultFactory", function () {
  this.timeout(120_000);

  it("records token-isolated vault sets idempotently and rejects conflicting mappings", async function () {
    const [owner, creator, tokenSigner] = await ethers.getSigners();
    const launchId = ethers.id("vault-factory-test-launch");
    const helper = await (await ethers.getContractFactory("TestCreate2Deployer")).deploy();
    await helper.waitForDeployment();
    const caller = await (
      await ethers.getContractFactory("MockVaultFactoryLaunchCaller")
    ).deploy();
    await caller.waitForDeployment();
    const token = await (
      await ethers.getContractFactory("MockLaunchToken")
    ).deploy(owner.address, ethers.parseEther("1000"));
    await token.waitForDeployment();
    const feeVault = await (
      await ethers.getContractFactory("MockVaultFactoryComponent")
    ).deploy(launchId, creator.address, await token.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress);
    await feeVault.waitForDeployment();
    const creatorVault = await (
      await ethers.getContractFactory("MockVaultFactoryComponent")
    ).deploy(launchId, creator.address, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress);
    await creatorVault.waitForDeployment();
    const implementation = await (await ethers.getContractFactory("VaultFactory")).deploy();
    await implementation.waitForDeployment();
    const initData = implementation.interface.encodeFunctionData("initialize", [
      owner.address,
      owner.address,
      await caller.getAddress(),
    ]);
    const proxyAddress = await vanityProxy(
      helper,
      await implementation.getAddress(),
      initData,
    );
    const registry = await ethers.getContractAt("VaultFactory", proxyAddress, owner);

    const register = caller.register(
      proxyAddress,
      launchId,
      await token.getAddress(),
      creator.address,
      await feeVault.getAddress(),
      await creatorVault.getAddress(),
      ethers.ZeroAddress,
    );
    await (await register).wait();
    await (await caller.register(
      proxyAddress,
      launchId,
      await token.getAddress(),
      creator.address,
      await feeVault.getAddress(),
      await creatorVault.getAddress(),
      ethers.ZeroAddress,
    )).wait();

    const set = await registry.getVaultSet(launchId);
    assert.equal(set.registered, true);
    assert.equal(set.token, await token.getAddress());
    assert.equal(set.creator, creator.address);
    assert.equal(set.feeVault, await feeVault.getAddress());
    assert.equal(set.creatorVault, await creatorVault.getAddress());
    assert.equal(set.bridgeVault, ethers.ZeroAddress);
    assert.equal(set.chainId, (await ethers.provider.getNetwork()).chainId);
    assert.notEqual(set.configurationHash, ethers.ZeroHash);

    await assert.rejects(
      caller.register(
        proxyAddress,
        launchId,
        await token.getAddress(),
        tokenSigner.address,
        await feeVault.getAddress(),
        await creatorVault.getAddress(),
        ethers.ZeroAddress,
      ),
    );
    await assert.rejects(
      registry.connect(creator).registerVaultSet(
        launchId,
        await token.getAddress(),
        creator.address,
        await feeVault.getAddress(),
        await creatorVault.getAddress(),
        ethers.ZeroAddress,
      ),
    );

    const targetFactory = await ethers.getContractFactory("MockVaultFactoryUupsTarget");
    const implementationAddress = await vanityContract(helper, targetFactory.bytecode);
    await (await registry.setImplementations(implementationAddress, implementationAddress, 1)).wait();
    const proxyLaunchId = ethers.id("vault-factory-proxy-launch");
    const proxySalt = ethers.id("creator-vault-proxy-salt");
    const initialization = targetFactory.interface.encodeFunctionData("initialize", [
      creator.address,
      42,
    ]);
    const predictedProxy = await registry.predictCreatorVaultAddress(
      proxyLaunchId,
      proxySalt,
      initialization,
    );
    await (await caller.deployCreatorVault(
      proxyAddress,
      proxyLaunchId,
      proxySalt,
      initialization,
    )).wait();
    await (await caller.deployCreatorVault(
      proxyAddress,
      proxyLaunchId,
      proxySalt,
      initialization,
    )).wait();
    const proxy = targetFactory.attach(predictedProxy);
    assert.equal(await proxy.owner(), creator.address);
    assert.equal(await proxy.value(), 42n);
    assert.equal(await registry.creatorVaultByLaunch(proxyLaunchId), predictedProxy);
    await assert.rejects(
      caller.deployCreatorVault(
        proxyAddress,
        proxyLaunchId,
        ethers.id("different-salt"),
        initialization,
      ),
    );
  });
});
