const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

describe("ArmoreumAtomicRelay", function () {
  async function fixture() {
    const [owner, keeper, stranger] = await ethers.getSigners();
    const deploy = async (name, ...args) => {
      const c = await (await ethers.getContractFactory(name)).deploy(...args);
      await c.waitForDeployment(); return c;
    };
    const endpoint = await deploy("AtomicEndpointMock");
    const library = await deploy("AtomicLibraryMock", endpoint.target);
    const dvn = await deploy("AtomicDVNMock", library.target);
    const executor = await deploy("AtomicExecutorMock", endpoint.target);
    const bridge = await deploy("AtomicBridgeMock");
    const relay = await deploy("ArmoreumAtomicRelay", owner.address, keeper.address, dvn.target, executor.target, endpoint.target);
    await endpoint.setLibrary(library.target);
    await library.configure(dvn.target, false);
    await dvn.setOperator(relay.target);
    await executor.configure(relay.target, false);
    const transferId = ethers.id("transfer"), guid = ethers.id("guid");
    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32","bytes32","address","address","address","address","uint256","uint64"],
      [transferId, ethers.id("launch"), owner.address, keeper.address, owner.address, keeper.address, 100n, 1],
    );
    const packet = ethers.solidityPacked(
      ["uint8","uint64","uint32","bytes32","uint32","bytes32","bytes32","bytes"],
      [1,1,30101,ethers.zeroPadValue(owner.address,32),30416,ethers.zeroPadValue(bridge.target,32),guid,message],
    );
    const args = [packet,3,ethers.id("source-block"),"0x"];
    return {owner,keeper,stranger,endpoint,library,dvn,executor,bridge,relay,transferId,args};
  }
  it("verifies, commits and consumes in one transaction; replay is harmless", async () => {
    const f = await fixture();
    const receipt = await (await f.relay.connect(f.keeper).relay(...f.args)).wait();
    assert.equal(receipt.status, 1);
    assert.equal(await f.dvn.verified(), true);
    assert.equal(await f.bridge.consumedTransferIds(f.transferId), true);
    await f.relay.connect(f.keeper).relay(...f.args);
    assert.equal(await f.endpoint.payload(), ethers.ZeroHash);
  });
  it("reverts verification and commitment too when execution fails", async () => {
    const f = await fixture(); await f.executor.configure(f.relay.target, true);
    await assert.rejects(f.relay.connect(f.keeper).relay(...f.args));
    assert.equal(await f.dvn.verified(), false);
    assert.equal(await f.endpoint.payload(), ethers.ZeroHash);
    assert.equal(await f.bridge.consumedTransferIds(f.transferId), false);
  });
  it("rejects unauthorized keepers and malformed packets", async () => {
    const f = await fixture();
    await assert.rejects(f.relay.connect(f.stranger).relay(...f.args));
    await assert.rejects(f.relay.connect(f.keeper).relay("0x",3,ethers.id("block"),"0x"));
    await assert.rejects(f.relay.connect(f.keeper).relay(f.args[0],3,ethers.ZeroHash,"0x"));
  });
  it("rejects conflicting/nilified endpoint payloads", async () => {
    const f = await fixture(); await f.endpoint.setHash(ethers.toBeHex(ethers.MaxUint256, 32));
    await assert.rejects(f.relay.connect(f.keeper).relay(...f.args));
    assert.equal(await f.dvn.verified(), false);
  });
  it("recovers an already committed packet without re-verifying", async () => {
    const f = await fixture();
    const hash = ethers.keccak256(`0x${f.args[0].slice(2 + 81 * 2)}`);
    await f.endpoint.setHash(hash);
    await f.relay.connect(f.keeper).relay(...f.args);
    assert.equal(await f.dvn.verified(), false);
    assert.equal(await f.bridge.consumedTransferIds(f.transferId), true);
  });
  it("keeper rotation is owner-only", async () => {
    const f = await fixture();
    await assert.rejects(f.relay.connect(f.stranger).setKeeper(f.stranger.address));
    await f.relay.setKeeper(f.stranger.address);
    await assert.rejects(f.relay.connect(f.keeper).relay(...f.args));
    await f.relay.connect(f.stranger).relay(...f.args);
  });
});
