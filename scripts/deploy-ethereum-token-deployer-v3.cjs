const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");
const partialPath = path.join(__dirname, "..", "deployments", "1.ArmoreumTokenDeployerV3.partial.json");
const chainId = 1n;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== chainId) throw new Error(`Refusing chain ${network.chainId}; Ethereum mainnet is required.`);

  const signer = (await ethers.getSigners())[0];
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const configuredOwner = new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address;
  if ((await signer.getAddress()).toLowerCase() !== configuredOwner.toLowerCase()) {
    throw new Error("The Ethereum signer does not match the configured deployment owner.");
  }

  const create2Address = ethers.getAddress(required("ETHEREUM_CREATE2_DEPLOYER_ADDRESS"));
  const expectedFactoryHash = required("ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH");
  const create2Code = await ethers.provider.getCode(create2Address);
  if (
    !/^0x[\da-f]{64}$/i.test(expectedFactoryHash) ||
    create2Code === "0x" ||
    ethers.keccak256(create2Code).toLowerCase() !== expectedFactoryHash.toLowerCase()
  ) {
    throw new Error("The Ethereum CREATE2 deployer does not match its verified runtime hash.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || manifest.launchEnabled !== true || !Array.isArray(manifest.contracts)) {
    throw new Error("Ethereum mainnet readiness is not enabled in the deployment manifest.");
  }
  if (fs.existsSync(partialPath)) throw new Error(`A prior deployment needs reconciliation: ${partialPath}`);

  const artifact = await artifacts.readArtifact("ArmoreumTokenDeployerV3");
  const initCode = artifact.bytecode;
  const initCodeHash = ethers.keccak256(initCode);
  const stateFile = path.join(
    __dirname, "..", "deployments", "1.vanity",
    `ArmoreumTokenDeployerV3-${initCodeHash.slice(2, 10)}.json`,
  );
  const saltResult = await mineVanitySalt({
    deployer: create2Address,
    initCode,
    stateFile,
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const address = ethers.getAddress(ethers.getCreate2Address(create2Address, saltResult.salt, initCodeHash));
  if (address.toLowerCase() !== saltResult.address.toLowerCase() || !address.toLowerCase().startsWith(PREFIX)) {
    throw new Error("The CREATE2 address does not match the mined vanity result.");
  }

  const existing = manifest.contracts.find((item) => item.name === "ArmoreumTokenDeployerV3");
  const existingCode = await ethers.provider.getCode(address);
  if (existing) {
    const runtimeHash = existingCode === "0x" ? "" : ethers.keccak256(existingCode);
    if (
      existing.address.toLowerCase() !== address.toLowerCase() ||
      runtimeHash.toLowerCase() !== String(existing.runtimeCodeHash).toLowerCase() ||
      runtimeHash.toLowerCase() !== ethers.keccak256(artifact.deployedBytecode).toLowerCase()
    ) {
      throw new Error("The V3 deployment record conflicts with live bytecode.");
    }
    process.stdout.write(`${JSON.stringify({
      chainId: 1,
      alreadyDeployed: true,
      address,
      transactionHash: existing.transactionHash,
    }, null, 2)}\n`);
    return;
  }
  if (existingCode !== "0x") throw new Error("The predicted V3 address already contains unregistered code.");

  const data = encodeCreate2Deployment(saltResult.salt, initCode);
  const request = { from: await signer.getAddress(), to: create2Address, data };
  const estimatedGas = await ethers.provider.estimateGas(request);
  const gasLimit = (estimatedGas * 120n) / 100n;
  await ethers.provider.call({ ...request, gasLimit });
  const feeData = await ethers.provider.getFeeData();
  const maxGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maxGasPrice == null) throw new Error("Ethereum RPC did not return usable gas data.");
  const maxCost = gasLimit * maxGasPrice;
  const balance = await ethers.provider.getBalance(await signer.getAddress());
  if (balance < maxCost) throw new Error("The deployment signer balance is below the estimated maximum gas cost.");

  const report = {
    chainId: 1,
    network: "Ethereum mainnet",
    broadcast,
    contract: "ArmoreumTokenDeployerV3",
    tokenContractName: "ArmoreumTokenLaunch",
    address,
    create2Deployer: create2Address,
    salt: saltResult.salt,
    initCodeHash,
    estimatedGas: estimatedGas.toString(),
    gasLimit: gasLimit.toString(),
    maximumGasPriceWei: maxGasPrice.toString(),
    maximumCostWei: maxCost.toString(),
    maximumCostEth: ethers.formatEther(maxCost),
    deploymentSignerBalanceEth: ethers.formatEther(balance),
    sourceVerification: "pending",
    note: "Adds the ArmoreumTokenLaunch contract name while preserving ERC-7572 metadata, fixed supply, and existing launch economics.",
  };
  if (!broadcast) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  writeJsonAtomically(partialPath, { ...report, status: "prepared", createdAt: new Date().toISOString() });
  const transaction = await signer.sendTransaction({ to: create2Address, data, gasLimit });
  writeJsonAtomically(partialPath, { ...report, status: "broadcast", transactionHash: transaction.hash });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error("The V3 deployment failed; its partial record was retained.");

  const runtimeCode = await ethers.provider.getCode(address);
  const runtimeCodeHash = ethers.keccak256(runtimeCode);
  if (
    runtimeCode === "0x" ||
    runtimeCodeHash.toLowerCase() !== ethers.keccak256(artifact.deployedBytecode).toLowerCase()
  ) {
    throw new Error("Live V3 bytecode differs from the compiled artifact; partial record retained.");
  }
  const record = {
    name: "ArmoreumTokenDeployerV3",
    address,
    salt: saltResult.salt,
    deployer: create2Address,
    initCodeHash,
    runtimeCodeHash,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    sourceVerification: "pending",
  };
  writeJsonAtomically(manifestPath, {
    ...manifest,
    status: "ArmoreumTokenLaunch deployer V3 deployed; source verification pending",
    contracts: [...manifest.contracts, record],
    tokenDeployerV3: { address, transactionHash: receipt.hash, sourceVerification: "pending" },
  });
  fs.rmSync(partialPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ...report,
    broadcast: true,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash,
    status: "deployed; live bytecode verified",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum TokenDeployer V3 deployment failed"}\n`);
  process.exitCode = 1;
});
