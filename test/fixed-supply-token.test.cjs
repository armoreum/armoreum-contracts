const assert = require("node:assert/strict");
const { getCreate2Address, toBeHex, zeroPadValue } = require("ethers");
const { ethers } = require("hardhat");

describe("ArmoreumTokenDeployer", function () {
  it("mints a fixed supply once without imposing the core-contract prefix on launch tokens", async function () {
    const [creator, initialHolder] = await ethers.getSigners();
    const Deployer = await ethers.getContractFactory("ArmoreumTokenDeployer");
    const deployer = await Deployer.deploy();
    await deployer.waitForDeployment();

    const name = "Example Launch";
    const symbol = "EXL";
    const initCodeHash = await deployer.tokenInitCodeHash(
      name,
      symbol,
      initialHolder.address,
    );
    const deployerAddress = await deployer.getAddress();

    const salt = zeroPadValue(toBeHex(0), 32);
    const predictedAddress = getCreate2Address(
      deployerAddress,
      salt,
      initCodeHash,
    );

    await (await deployer.connect(creator).deployToken(
      name,
      symbol,
      initialHolder.address,
      salt,
    )).wait();

    const token = await ethers.getContractAt(
      "FixedSupplyLaunchToken",
      predictedAddress,
    );
    const supply = 1_000_000_000n * 10n ** 18n;
    assert.equal(await token.totalSupply(), supply);
    assert.equal(await token.balanceOf(initialHolder.address), supply);
    assert.equal(await token.name(), name);
    assert.equal(await token.symbol(), symbol);
    assert.equal(await token.decimals(), 18n);
    assert.equal(token.interface.getFunction("owner"), null);
    assert.equal(token.interface.getFunction("renounceOwnership"), null);

    assert.equal(predictedAddress.toLowerCase().startsWith("0x6900"), false);
  });
});
