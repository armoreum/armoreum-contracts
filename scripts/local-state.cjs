const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { keccak256 } = require("ethers");

const LOCAL_CHAINS = [
  { chainId: 31337, port: 8545, networkName: "localEthereum" },
  { chainId: 46630, port: 8546, networkName: "localRobinhood" },
];

function portOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(2000);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error(`Cannot inspect local port ${port}.`));
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Local port ${port} timed out.`)); });
  });
}

async function rpc(port, method, params = []) {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Local RPC ${port} rejected ${method}.`);
  const body = await response.json();
  if (body.error || body.result === undefined) throw new Error(`Local RPC ${port} failed ${method}.`);
  return body.result;
}

async function inspectChain(chain, call = rpc, isOpen = portOpen) {
  if (!LOCAL_CHAINS.some((c) => c.port === chain.port && c.chainId === chain.chainId)) {
    throw new Error("Only the two configured local EVM endpoints may be inspected.");
  }
  if (!(await isOpen(chain.port))) return null;
  const chainId = Number(BigInt(await call(chain.port, "eth_chainId")));
  if (chainId !== chain.chainId) {
    throw new Error(`Local port ${chain.port} has chain ${chainId}; expected ${chain.chainId}. Refusing to replace it.`);
  }
  const metadata = await call(chain.port, "hardhat_metadata");
  if (Number(metadata.chainId) !== chain.chainId || !/^0x[0-9a-f]{64}$/i.test(metadata.instanceId || "")) {
    throw new Error(`Local port ${chain.port} is not a recognized Hardhat instance.`);
  }
  return { chainId, instanceId: metadata.instanceId };
}

function normalizeRuntime(bytecode, references) {
  let normalized = bytecode.toLowerCase().replace(/^0x/, "");
  for (const ranges of Object.values(references || {})) {
    for (const { start, length } of ranges) {
      if (start < 0 || length <= 0 || (start + length) * 2 > normalized.length) {
        throw new Error("Invalid compiler immutable reference.");
      }
      normalized = normalized.slice(0, start * 2) + "0".repeat(length * 2) + normalized.slice((start + length) * 2);
    }
  }
  return normalized;
}

function artifactFor(name) {
  const sources = {
    LocalTaxSource: "contracts/local/LocalTaxSource.sol",
    LocalBridgeAdapter: "contracts/local/LocalBridgeAdapter.sol",
    LocalPonsV2Adapter: "contracts/local/LocalPonsV2Adapter.sol",
    LocalPoolManagerDeployer: "contracts/local/LocalPoolManagerDeployer.sol",
    TestCreate2Deployer: "contracts/test/TestCreate2Deployer.sol",
    ArmoreumFactoryProxy: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    VaultFactoryProxy: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    JailTokenFactoryProxy: "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
    JailToken: "contracts/JailReceiptToken.sol",
    JailETHReceipt: "contracts/JailReceiptToken.sol",
    UniswapV4PoolManager: "@uniswap/v4-core/src/PoolManager.sol",
  };
  const source = sources[name] || `contracts/${name}.sol`;
  const isProxy = [
    "ArmoreumFactoryProxy",
    "VaultFactoryProxy",
    "JailTokenFactoryProxy",
  ].includes(name);
  const contractName = isProxy
    ? "ERC1967Proxy"
    : name === "UniswapV4PoolManager"
      ? "PoolManager"
      : name;
  const location = path.join(__dirname, "..", "artifacts", source, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(location, "utf8"));
  const debug = JSON.parse(fs.readFileSync(location.replace(/\.json$/, ".dbg.json"), "utf8"));
  const build = JSON.parse(fs.readFileSync(path.resolve(path.dirname(location), debug.buildInfo), "utf8"));
  const compiled = build.output.contracts[source][contractName].evm.deployedBytecode;
  return { bytecode: artifact.deployedBytecode, references: compiled.immutableReferences };
}

async function verifyManifest(chain, call = rpc, readArtifact = artifactFor) {
  const location = path.join(__dirname, "..", "deployments", "local", `${chain.chainId}.json`);
  if (!fs.existsSync(location)) throw new Error(`Local manifest ${chain.chainId} is missing; start the local EVM workflow first.`);
  const manifest = JSON.parse(fs.readFileSync(location, "utf8"));
  return validateManifest(chain, manifest, call, readArtifact);
}

async function validateManifest(chain, manifest, call = rpc, readArtifact = artifactFor) {
  if (manifest.environment !== "local-only" || manifest.chainId !== chain.chainId ||
      manifest.rpcUrl !== `http://127.0.0.1:${chain.port}` || !Array.isArray(manifest.contracts) ||
      !/^0x[0-9a-f]{64}$/i.test(manifest.hardhatInstanceId || "")) {
    throw new Error(`Invalid local deployment manifest ${chain.chainId}.`);
  }
  const metadata = await call(chain.port, "hardhat_metadata");
  if (Number(metadata.chainId) !== chain.chainId || metadata.instanceId !== manifest.hardhatInstanceId) {
    throw new Error(`Stale local manifest: chain ${chain.chainId} belongs to a different Hardhat instance.`);
  }
  const required = ["LocalTaxSource", "LocalBridgeAdapter",
    "TestCreate2Deployer", "ArmoreumPasskeyVerifier", "CreatorRewardVault", "TaxRouter",
    "ArmoreumFactory", "ArmoreumFactoryProxy", "VaultFactory", "VaultFactoryProxy",
    "JailToken", "JailETHReceipt", "JailTokenFactory", "JailTokenFactoryProxy",
    "JailSwapVault"];
  if (chain.chainId === 31337) {
    const poolManagerDeployed = Boolean(manifest.integrations?.uniswapV4?.poolManager);
    if (!poolManagerDeployed && manifest.integrations?.uniswapV4?.status !== "not-deployed") {
      throw new Error("Invalid local Uniswap V4 deployment status.");
    }
    if (poolManagerDeployed) required.push("LocalPoolManagerDeployer", "UniswapV4PoolManager");
  } else {
    required.push("LocalPonsV2Adapter");
  }
  const names = manifest.contracts.map((c) => c.name);
  const hasTokenDeployer = names.includes("ArmoreumTokenDeployer") ||
    names.includes("FixedSupplyTokenDeployer");
  if (names.length !== required.length + 1 || !hasTokenDeployer ||
      new Set(names).size !== names.length || required.some((name) => !names.includes(name))) {
    throw new Error(`Local manifest ${chain.chainId} is incomplete or has duplicate contracts.`);
  }
  const evidence = [];
  for (const record of manifest.contracts) {
    if (!/^0x[0-9a-f]{40}$/i.test(record.address || "") || !/^0x[0-9a-f]{64}$/i.test(record.transactionHash || "")) {
      throw new Error(`Invalid deployment reference for ${record.name}.`);
    }
    const code = await call(chain.port, "eth_getCode", [record.address, "latest"]);
    const receipt = await call(chain.port, "eth_getTransactionReceipt", [record.transactionHash]);
    if (code === "0x" || !receipt || BigInt(receipt.status) !== 1n) {
      throw new Error(`Stale local manifest: ${record.name} has no confirmed deployment. Refusing automatic redeployment.`);
    }
    if (receipt.contractAddress && receipt.contractAddress.toLowerCase() !== record.address.toLowerCase()) {
      throw new Error(`Deployment receipt address mismatch for ${record.name}.`);
    }
    const hash = keccak256(code);
    if (record.runtimeCodeHash && record.runtimeCodeHash.toLowerCase() !== hash) {
      throw new Error(`Stored runtime hash mismatch for ${record.name}.`);
    }
    if (record.name === "FixedSupplyTokenDeployer") {
      if (!record.runtimeCodeHash) {
        throw new Error("Legacy local token deployer requires a recorded runtime code hash.");
      }
      evidence.push({ name: record.name, address: record.address, runtimeCodeHash: hash });
      continue;
    }
    const artifact = readArtifact(record.name);
    if (normalizeRuntime(code, artifact.references) !== normalizeRuntime(artifact.bytecode, artifact.references)) {
      throw new Error(`Runtime code does not match the compiled artifact for ${record.name}.`);
    }
    evidence.push({ name: record.name, address: record.address, runtimeCodeHash: hash });
  }
  return evidence;
}

async function waitForChain(chain, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await inspectChain(chain);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Local chain ${chain.chainId} is unavailable. Start the Armoreum Local EVMs workflow.`);
}

module.exports = { LOCAL_CHAINS, rpc, inspectChain, verifyManifest, validateManifest, normalizeRuntime, waitForChain };
