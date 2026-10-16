const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

const { ethers } = hre;
const NETWORKS = {
  ethereum: {
    chainId: 1,
    endpointId: 30101,
    endpoint: "0x1a44076050125825900e736c501f859c50fE728c",
    keeperEnv: "lz_eth",
  },
  robinhood: {
    chainId: 4663,
    endpointId: 30416,
    endpoint: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
    keeperEnv: "lz_robinhood",
  },
};
const FACTORY_ABI = [
  "function canonicalOwner() view returns (address)",
];

function requiredSecret(name) {
  const value = process.env[name];
  if (!value || !/^(0x)?[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`Required signing secret ${name} is unavailable or malformed.`);
  }
  return value.startsWith("0x") ? value : `0x${value}`;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function main() {
  const network = NETWORKS[hre.network.name];
  if (!network) throw new Error("Run this script only on ethereum or robinhood.");

  const provider = ethers.provider;
  const liveChainId = Number((await provider.getNetwork()).chainId);
  if (liveChainId !== network.chainId) {
    throw new Error(`Expected chain ${network.chainId}, received ${liveChainId}.`);
  }

  const ownerKey = requiredSecret("PLATFORM_OWNER_PRIVATE_KEY");
  const deployerKey = requiredSecret("DEPLOYER_PRIVATE_KEY");
  const keeperKey = requiredSecret(network.keeperEnv);
  const owner = new ethers.Wallet(ownerKey, provider);
  const keeper = new ethers.Wallet(keeperKey, provider);
  const deployer = new ethers.Wallet(deployerKey, provider);
  if (owner.address.toLowerCase() === keeper.address.toLowerCase()) {
    throw new Error("The destination keeper must not use the owner signer.");
  }

  const chainId = String(network.chainId);
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const existingPath = path.join(deploymentsDir, `${chainId}.json`);
  const existing = JSON.parse(fs.readFileSync(existingPath, "utf8"));
  const factoryAddress = existing.multichainCore?.factoryProxy;
  if (!factoryAddress) throw new Error(`No active ArmoreumFactory is recorded for chain ${chainId}.`);
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const factoryCanonicalOwner = await factory.canonicalOwner();

  const endpointCode = await provider.getCode(network.endpoint);
  if (endpointCode === "0x") throw new Error("Configured LayerZero endpoint has no code.");
  const endpoint = new ethers.Contract(
    network.endpoint,
    ["function eid() view returns (uint32)"],
    provider,
  );
  if (Number(await endpoint.eid()) !== network.endpointId) {
    throw new Error("Configured LayerZero endpoint ID does not match this chain.");
  }

  const outputPath = path.join(deploymentsDir, `${chainId}.multichain-bridge-operators.json`);
  const previous = fs.existsSync(outputPath) ? JSON.parse(fs.readFileSync(outputPath, "utf8")) : {};
  const current = {
    schemaVersion: 1,
    chainId,
    endpointId: network.endpointId,
    endpoint: network.endpoint,
    factory: factoryAddress,
    factoryCanonicalOwner,
    owner: owner.address,
    keeper: keeper.address,
    contracts: previous.contracts ?? {},
    deploymentTransactions: previous.deploymentTransactions ?? {},
    updatedAt: new Date().toISOString(),
  };
  const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  if (broadcast && process.env.ARMOREUM_MAINNET_CONFIRMATION !== `I confirm Armoreum bridge operator deployment on chain ${network.chainId}`) {
    throw new Error("Explicit chain-specific deployment confirmation is required.");
  }

  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Live base fee is unavailable; refusing to price a mainnet transaction.");
  }
  const gasPriceCap = (block.baseFeePerGas * 120n + 99n) / 100n;
  const [quotedGasPrice, rpcGasPrice] = await Promise.all([
    provider.getFeeData().then((fees) => fees.gasPrice ?? 0n),
    provider.send("eth_gasPrice", []),
  ]);
  const highestQuote = [quotedGasPrice, BigInt(rpcGasPrice)].reduce(
    (highest, candidate) => candidate > highest ? candidate : highest,
    0n,
  );
  if (highestQuote > gasPriceCap) {
    throw new Error("Current RPC fee quote exceeds the base fee +20% cap.");
  }

  const definitions = [
    {
      name: "ArmoreumCustomDVN",
      args: [network.endpointId, network.endpoint, owner.address, keeper.address],
    },
    {
      name: "ArmoreumLayerZeroExecutor",
      args: [network.endpointId, network.endpoint, owner.address, keeper.address],
    },
  ];
  const results = [];
  for (const definition of definitions) {
    const savedAddress = current.contracts[definition.name];
    if (savedAddress && await provider.getCode(savedAddress) !== "0x") {
      results.push({ name: definition.name, address: savedAddress, reused: true });
      continue;
    }
    const factoryContract = await ethers.getContractFactory(definition.name, deployer);
    const deployment = await factoryContract.getDeployTransaction(...definition.args);
    const gasEstimate = await provider.estimateGas({
      ...deployment,
      from: deployer.address,
    });
    const gasLimit = (gasEstimate * 120n + 99n) / 100n;
    const requiredBalance = gasLimit * gasPriceCap;
    const deployerBalance = await provider.getBalance(deployer.address);
    if (deployerBalance < requiredBalance) {
      throw new Error(`${definition.name} deployer balance is below the estimated gas requirement.`);
    }

    const deploymentPlan = {
      network: hre.network.name,
      chainId,
      deployer: deployer.address,
      owner: owner.address,
      keeper: keeper.address,
      contract: definition.name,
      endpoint: network.endpoint,
      endpointId: network.endpointId,
      constructorArgs: definition.args,
      gasEstimate: gasEstimate.toString(),
      gasLimit: gasLimit.toString(),
      gasPriceCap: gasPriceCap.toString(),
      maxFeeWei: requiredBalance.toString(),
      broadcast,
    };
    console.log(JSON.stringify(deploymentPlan, null, 2));
    if (!broadcast) {
      results.push({ name: definition.name, simulated: true, gasEstimate: gasEstimate.toString() });
      continue;
    }

    const contract = await factoryContract.deploy(...definition.args, {
      gasLimit,
      gasPrice: gasPriceCap,
    });
    const receipt = await contract.deploymentTransaction().wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${definition.name} deployment did not receive a successful receipt.`);
    }
    const address = await contract.getAddress();
    current.contracts[definition.name] = address;
    current.deploymentTransactions[definition.name] = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
    current.updatedAt = new Date().toISOString();
    writeJsonAtomic(outputPath, current);
    results.push({
      name: definition.name,
      address,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  }

  console.log(JSON.stringify({
    network: hre.network.name,
    chainId,
    owner: owner.address,
    keeper: keeper.address,
    outputPath,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
