const { test } = require("node:test");
const assert = require("node:assert/strict");
const { keccak256 } = require("ethers");
const { LOCAL_CHAINS, inspectChain, validateManifest, normalizeRuntime } = require("../local-state.cjs");

const chain = LOCAL_CHAINS[1];
const address = "0x" + "1".repeat(40);
const hash = "0x" + "2".repeat(64);
const names = ["ArmoreumTokenDeployer", "LocalTaxSource", "LocalBridgeAdapter",
  "TestCreate2Deployer", "ArmoreumPasskeyVerifier", "CreatorRewardVault", "TaxRouter",
  "ArmoreumFactory", "ArmoreumFactoryProxy", "VaultFactory", "VaultFactoryProxy",
  "JailToken", "JailETHReceipt", "JailTokenFactory", "JailTokenFactoryProxy",
  "JailSwapVault",
  "LocalPonsV2Adapter"];
const fixture = () => ({ environment: "local-only", chainId: chain.chainId,
  hardhatInstanceId: hash,
  rpcUrl: `http://127.0.0.1:${chain.port}`,
  contracts: names.map((name) => ({ name, address, transactionHash: hash })) });
const call = async (_port, method) => method === "hardhat_metadata" ?
  { chainId: chain.chainId, instanceId: hash } : method === "eth_getCode" ? "0x6000" :
  { status: "0x1", contractAddress: address };
const artifact = () => ({ bytecode: "0x6000", references: {} });

test("absent local port is not mistaken for an existing chain", async () => {
  assert.equal(await inspectChain(chain, async () => assert.fail("must not call RPC"), async () => false), null);
});
test("wrong chain refuses reuse rather than resetting it", async () => {
  await assert.rejects(inspectChain(chain, async () => "0x1", async () => true), /expected 46630/);
});
test("arbitrary endpoints and mainnet chain identities are forbidden", async () => {
  await assert.rejects(inspectChain({ port: 8546, chainId: 4663 }), /Only the two/);
});
test("recognized Hardhat instance can be reused", async () => {
  const state = await inspectChain(chain, async (_port, method) =>
    method === "eth_chainId" ? "0xb626" : { chainId: 46630, instanceId: hash }, async () => true);
  assert.deepEqual(state, { chainId: 46630, instanceId: hash });
});
test("non-Hardhat server on a local port is rejected", async () => {
  await assert.rejects(inspectChain(chain, async (_port, method) =>
    method === "eth_chainId" ? "0xb626" : {}, async () => true), /not a recognized/);
});
test("complete confirmed matching deployments are verified read-only", async () => {
  const methods = [];
  const result = await validateManifest(chain, fixture(), async (port, method, params) => {
    methods.push(method); return call(port, method, params);
  }, artifact);
  assert.equal(result.length, names.length);
  assert.equal(result[0].runtimeCodeHash, keccak256("0x6000"));
  assert.ok(methods.every((method) => ["hardhat_metadata", "eth_getCode", "eth_getTransactionReceipt"].includes(method)));
});
test("legacy local token-deployer manifests remain readable without triggering redeployment", async () => {
  const manifest = fixture();
  manifest.contracts = manifest.contracts.map((record) =>
    record.name === "ArmoreumTokenDeployer"
      ? {
          ...record,
          name: "FixedSupplyTokenDeployer",
          runtimeCodeHash: keccak256("0x6000"),
        }
      : record);
  const result = await validateManifest(chain, manifest, call, artifact);
  assert.equal(result[0].name, "FixedSupplyTokenDeployer");
  assert.equal(result.length, names.length);
});
test("persistent Ethereum manifests may omit V4 PoolManager but cannot register a partial one", async () => {
  const ethereum = LOCAL_CHAINS[0];
  const manifest = {
    ...fixture(),
    chainId: ethereum.chainId,
    rpcUrl: `http://127.0.0.1:${ethereum.port}`,
    integrations: { uniswapV4: { status: "not-deployed" } },
    contracts: fixture().contracts.filter((record) => record.name !== "LocalPonsV2Adapter"),
  };
  const ethereumCall = async (port, method, params) => {
    if (method === "hardhat_metadata") return { chainId: ethereum.chainId, instanceId: hash };
    return call(port, method, params);
  };
  const evidence = await validateManifest(ethereum, manifest, ethereumCall, artifact);
  assert.equal(evidence.length, manifest.contracts.length);

  manifest.integrations.uniswapV4 = { status: "pool-manager-deployed", poolManager: address };
  await assert.rejects(
    validateManifest(ethereum, manifest, ethereumCall, artifact),
    /incomplete or has duplicate contracts/,
  );
});
test("wrong environment, chain, endpoint and duplicate records fail closed", async () => {
  for (const changes of [{ environment: "mainnet" }, { chainId: 4663 }, { rpcUrl: "https://example.com" },
    { contracts: [...fixture().contracts, fixture().contracts[0]] }]) {
    await assert.rejects(validateManifest(chain, { ...fixture(), ...changes }, call, artifact), /Invalid|incomplete/);
  }
});
test("stale chain and pending or reverted deployments cannot trigger redeployment", async () => {
  for (const receipt of [null, { status: "0x0" }]) {
    await assert.rejects(validateManifest(chain, fixture(), async (_port, method) =>
      method === "hardhat_metadata" ? { chainId: chain.chainId, instanceId: hash } :
      method === "eth_getCode" ? "0x6000" : receipt, artifact), /Refusing automatic redeployment/);
  }
  await assert.rejects(validateManifest(chain, fixture(), async (_port, method) =>
    method === "hardhat_metadata" ? { chainId: chain.chainId, instanceId: hash } : "0x",
    artifact), /Stale local manifest/);
});
test("deployment receipt must match the recorded address", async () => {
  await assert.rejects(validateManifest(chain, fixture(), async (_port, method) =>
    method === "hardhat_metadata" ? { chainId: chain.chainId, instanceId: hash } :
    method === "eth_getCode" ? "0x6000" : { status: "0x1", contractAddress: "0x" + "3".repeat(40) },
    artifact), /receipt address mismatch/);
});
test("a replacement instance cannot reuse an old manifest even with matching bytecode", async () => {
  await assert.rejects(validateManifest(chain, fixture(), async (_port, method) =>
    method === "hardhat_metadata" ? { chainId: chain.chainId, instanceId: "0x" + "3".repeat(64) } :
    call(_port, method), artifact), /different Hardhat instance/);
});
test("legacy manifests without an instance identity cannot be reused", async () => {
  const manifest = fixture();
  delete manifest.hardhatInstanceId;
  await assert.rejects(validateManifest(chain, manifest, call, artifact), /Invalid local deployment/);
});
test("runtime mismatch and stored hash mismatch are rejected", async () => {
  await assert.rejects(validateManifest(chain, fixture(), call,
    () => ({ bytecode: "0x6001", references: {} })), /compiled artifact/);
  const manifest = fixture();
  manifest.contracts[0].runtimeCodeHash = hash;
  await assert.rejects(validateManifest(chain, manifest, call, artifact), /Stored runtime hash mismatch/);
});
test("immutable byte ranges may differ, other runtime bytes must match", () => {
  const references = { "1": [{ start: 1, length: 1 }] };
  assert.equal(normalizeRuntime("0x600160", references), normalizeRuntime("0x600260", references));
  assert.notEqual(normalizeRuntime("0x600161", references), normalizeRuntime("0x600260", references));
  assert.throws(() => normalizeRuntime("0x60", references), /Invalid compiler/);
});
