const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("ArmoreumLockReleaseBridge", function () {
  async function deployPair() {
    const [owner, creator, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("FixedSupplyLaunchToken");
    const sourceToken = await Token.deploy("Source Launch", "SRC", creator.address);
    const destinationToken = await Token.deploy("Destination Launch", "DST", owner.address);
    const Endpoint = await ethers.getContractFactory("MockLayerZeroEndpoint");
    const sourceEndpoint = await Endpoint.deploy();
    const destinationEndpoint = await Endpoint.deploy();
    const Bridge = await ethers.getContractFactory("ArmoreumLockReleaseBridge");
    const launchId = ethers.keccak256(ethers.toUtf8Bytes("launch:test-1"));
    const maxBridgeAmount = ethers.parseUnits("1000", 18);
    const receiveGas = 300_000;
    const sourceBridge = await Bridge.deploy(
      await sourceEndpoint.getAddress(),
      owner.address,
      30416,
      await sourceToken.getAddress(),
      await destinationToken.getAddress(),
      launchId,
      maxBridgeAmount,
      receiveGas,
    );
    const destinationBridge = await Bridge.deploy(
      await destinationEndpoint.getAddress(),
      owner.address,
      30101,
      await destinationToken.getAddress(),
      await sourceToken.getAddress(),
      launchId,
      maxBridgeAmount,
      receiveGas,
    );
    const sourceAddress = await sourceBridge.getAddress();
    const destinationAddress = await destinationBridge.getAddress();
    const asBytes32Address = (address) => ethers.zeroPadValue(address, 32);

    await sourceBridge.setPeer(30416, asBytes32Address(destinationAddress));
    await destinationBridge.setPeer(30101, asBytes32Address(sourceAddress));
    await destinationToken.transfer(destinationAddress, maxBridgeAmount);
    await destinationBridge.activateInbound();
    await sourceBridge.activateOutbound();

    return {
      owner,
      creator,
      recipient,
      sourceToken,
      destinationToken,
      sourceEndpoint,
      destinationEndpoint,
      sourceBridge,
      destinationBridge,
      sourceAddress,
      destinationAddress,
      launchId,
      maxBridgeAmount,
      asBytes32Address,
    };
  }

  it("locks source tokens and releases prefunded destination tokens without minting or burning", async function () {
    const {
      creator,
      recipient,
      sourceToken,
      destinationToken,
      sourceEndpoint,
      destinationEndpoint,
      sourceBridge,
      destinationBridge,
      sourceAddress,
      maxBridgeAmount,
      asBytes32Address,
    } = await deployPair();
    const amount = ethers.parseUnits("5", 18);
    assert.equal(sourceToken.interface.getFunction("owner"), null);
    assert.equal(destinationToken.interface.getFunction("owner"), null);
    const sourceSupplyBefore = await sourceToken.totalSupply();
    const destinationSupplyBefore = await destinationToken.totalSupply();
    const recipientBefore = await destinationToken.balanceOf(recipient.address);
    const destinationFee = (amount * 20n) / 10_000n;
    const recipientAmount = amount - destinationFee;
    const fee = await sourceBridge.quoteLock(recipient.address, amount, "0x");

    await sourceToken.connect(creator).approve(sourceAddress, amount);
    await sourceBridge.connect(creator).lockAndSend(recipient.address, amount, "0x", {
      value: fee.nativeFee,
    });

    assert.equal(await sourceToken.balanceOf(sourceAddress), amount);
    assert.equal(await sourceToken.totalSupply(), sourceSupplyBefore);
    assert.equal(await destinationToken.totalSupply(), destinationSupplyBefore);

    const origin = {
      srcEid: 30101,
      sender: asBytes32Address(sourceAddress),
      nonce: 1,
    };
    const message = await sourceEndpoint.lastMessage();
    const guid = await sourceEndpoint.lastGuid();
    await destinationEndpoint.deliver(
      await destinationBridge.getAddress(),
      origin,
      guid,
      message,
    );

    assert.equal(
      await destinationToken.balanceOf(recipient.address),
      recipientBefore + recipientAmount,
    );
    assert.equal(
      await destinationToken.balanceOf(await destinationBridge.getAddress()),
      maxBridgeAmount - recipientAmount,
    );
    assert.equal(await destinationBridge.inboundReleased(), amount);
    assert.equal(await destinationBridge.destinationFeesAccrued(), destinationFee);
    assert.equal(await destinationBridge.BRIDGE_FEE_BPS(), 20n);
    assert.equal(await sourceToken.totalSupply(), sourceSupplyBefore);
    assert.equal(await destinationToken.totalSupply(), destinationSupplyBefore);

    await assert.rejects(
      destinationEndpoint.deliver(
        await destinationBridge.getAddress(),
        origin,
        guid,
        message,
      ),
      /TransferAlreadyConsumed/,
    );
  });

  it("retains the same 0.2% fee in the opposite destination vault", async function () {
    const {
      owner,
      creator,
      recipient,
      sourceToken,
      destinationToken,
      sourceEndpoint,
      destinationEndpoint,
      sourceBridge,
      destinationBridge,
      sourceAddress,
      destinationAddress,
      maxBridgeAmount,
      asBytes32Address,
    } = await deployPair();

    await sourceToken.connect(creator).transfer(sourceAddress, maxBridgeAmount);
    await sourceBridge.activateInbound();
    await destinationBridge.activateOutbound();

    const amount = ethers.parseUnits("5", 18);
    const sourceRecipientBefore = await sourceToken.balanceOf(recipient.address);
    const fee = await destinationBridge.connect(owner).quoteLock(recipient.address, amount, "0x");
    await destinationToken.connect(owner).approve(destinationAddress, amount);
    await destinationBridge.connect(owner).lockAndSend(recipient.address, amount, "0x", {
      value: fee.nativeFee,
    });

    const origin = {
      srcEid: 30416,
      sender: asBytes32Address(destinationAddress),
      nonce: 1,
    };
    await sourceEndpoint.deliver(
      sourceAddress,
      origin,
      await destinationEndpoint.lastGuid(),
      await destinationEndpoint.lastMessage(),
    );

    const destinationFee = (amount * 20n) / 10_000n;
    const recipientAmount = amount - destinationFee;
    assert.equal(
      await sourceToken.balanceOf(recipient.address),
      sourceRecipientBefore + recipientAmount,
    );
    assert.equal(
      await sourceToken.balanceOf(sourceAddress),
      maxBridgeAmount - recipientAmount,
    );
    assert.equal(await sourceBridge.inboundReleased(), amount);
    assert.equal(await sourceBridge.destinationFeesAccrued(), destinationFee);
  });

  it("does not accept a second peer or locks above the immutable launch cap", async function () {
    const { owner, creator, recipient, sourceToken, sourceBridge, sourceAddress } = await deployPair();
    await assert.rejects(
      sourceBridge.connect(owner).setPeer(30416, ethers.ZeroHash),
      /PeerAlreadyConfigured/,
    );
    const amountAboveCap = ethers.parseUnits("1001", 18);
    await sourceToken.connect(creator).approve(sourceAddress, amountAboveCap);
    await assert.rejects(
      sourceBridge.connect(creator).lockAndSend(recipient.address, amountAboveCap, "0x"),
      /OutboundLimitExceeded/,
    );
    assert.equal(await sourceToken.balanceOf(sourceAddress), 0n);
  });

  it("requires the destination vault to be fully prefunded before inbound activation", async function () {
    const [owner, creator] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("FixedSupplyLaunchToken");
    const sourceToken = await Token.deploy("Source Launch", "SRC", creator.address);
    const destinationToken = await Token.deploy("Destination Launch", "DST", owner.address);
    const Endpoint = await ethers.getContractFactory("MockLayerZeroEndpoint");
    const endpoint = await Endpoint.deploy();
    const Bridge = await ethers.getContractFactory("ArmoreumLockReleaseBridge");
    const bridge = await Bridge.deploy(
      await endpoint.getAddress(),
      owner.address,
      30101,
      await destinationToken.getAddress(),
      await sourceToken.getAddress(),
      ethers.keccak256(ethers.toUtf8Bytes("launch:test-2")),
      ethers.parseUnits("1000", 18),
      300_000,
    );
    await bridge.setPeer(30101, ethers.zeroPadValue(creator.address, 32));
    await assert.rejects(bridge.activateInbound(), /InsufficientVaultInventory/);
  });
});
