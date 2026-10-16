const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CHAIN_ID = 1n;
const CREATE2_ADDRESS = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const CONFIRMATION = "I confirm deployment to Ethereum mainnet chain 1";
const packageRoot = path.join(__dirname, "..");
const manifestPath = path.join(packageRoot, "deployments", "1.json");
const release = process.env.ARMOREUM_HOOK_FACTORY_RELEASE?.trim() || "V2";
if (!/^V[0-9]+$/.test(release)) throw new Error("HookFactory release must be a version such as V3.");
const contractName = `ArmoreumHookFactory${release}`;
const partialPath = path.join(packageRoot, "deployments", `1.${contractName}.partial.json`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

async function encodeFees(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Live Ethereum base fee is unavailable; refusing deployment.");
  }
  const gasPrice = (block.baseFeePerGas * 120n + 99n) / 100n;
  return { transactionFees: { gasPrice }, maximumGasPrice: gasPrice };
}

async function main() {
  const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== CHAIN_ID) {
    throw new Error("Refusing deployment outside Ethereum mainnet.");
  }
  if (fs.existsSync(partialPath)) throw new Error(`A previous ${contractName} deployment requires reconciliation.`);

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const ownerAddress = ethers.getAddress(new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address);
  if (signerAddress !== ownerAddress) throw new Error("Signer is not the canonical Ethereum platform owner.");

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || manifest.launchEnabled !== true) {
    throw new Error("Ethereum mainnet is not in the expected ready state.");
  }
  if (manifest.contracts.some((item) => item.name === contractName)) {
    throw new Error(`The manifest already records ${contractName}; reconcile it before retrying.`);
  }
  const seedRecord = manifest.contracts.find((item) => item.name === "JailSeed");
  const create2Record = manifest.externalIntegrations?.create2Deployer;
  if (!seedRecord || !create2Record) throw new Error("Ethereum manifest is missing JailSeed or CREATE2 deployment data.");
  const seedAddress = ethers.getAddress(seedRecord.address);
  const create2Address = ethers.getAddress(create2Record.address);
  if (create2Address !== ethers.getAddress(CREATE2_ADDRESS)) throw new Error("Manifest CREATE2 address is unexpected.");
  const create2Code = await provider.getCode(create2Address);
  if (
    create2Code === "0x" ||
    ethers.keccak256(create2Code).toLowerCase() !== String(create2Record.runtimeCodeHash).toLowerCase()
  ) throw new Error("Live Ethereum CREATE2 deployer does not match the manifest.");
  if (await provider.getCode(POOL_MANAGER) === "0x" || await provider.getCode(seedAddress) === "0x") {
    throw new Error("The Ethereum PoolManager or JailSeed is missing on mainnet.");
  }

  const factoryArtifact = await artifacts.readArtifact("ArmoreumHookFactory");
  const hookFactoryFactory = await ethers.getContractFactory("ArmoreumHookFactory", signer);
  const request = await hookFactoryFactory.getDeployTransaction(POOL_MANAGER, seedAddress);
  if (!request.data) throw new Error(`Could not build ${contractName} initialization code.`);
  const initCode = request.data;
  const initCodeHash = ethers.keccak256(initCode);
  const saltResult = await mineVanitySalt({
    deployer: create2Address,
    initCode,
    stateFile: path.join(packageRoot, "deployments", "1.vanity", `${contractName}-${initCodeHash.slice(2, 10)}.json`),
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const address = ethers.getAddress(ethers.getCreate2Address(create2Address, saltResult.salt, initCodeHash));
  if (address.toLowerCase() !== saltResult.address.toLowerCase() || !address.toLowerCase().startsWith(PREFIX)) {
    throw new Error(`${contractName} CREATE2 address does not satisfy the expected vanity prefix.`);
  }
  if (await provider.getCode(address) !== "0x") throw new Error(`Predicted ${contractName} address is already occupied.`);

  const deploymentData = encodeCreate2Deployment(saltResult.salt, initCode);
  const deploymentRequest = { from: signerAddress, to: create2Address, data: deploymentData };
  const estimatedGas = await provider.estimateGas(deploymentRequest);
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  await provider.call({ ...deploymentRequest, gasLimit });

  const factoryRecord = manifest.contracts.find((item) => item.name === "ArmoreumFactory-proxy");
  if (!factoryRecord) throw new Error("ArmoreumFactory proxy is missing from the manifest.");
  const armoreumFactory = new ethers.Contract(
    factoryRecord.address,
    [
      "function DEFAULT_ADMIN_ROLE() view returns(bytes32)",
      "function hasRole(bytes32,address) view returns(bool)",
      "function approvedTaxSources(address) view returns(bool)",
      "function setTaxSourceApproval(address,bool)",
    ],
    signer,
  );
  const adminRole = await armoreumFactory.DEFAULT_ADMIN_ROLE();
  if (!(await armoreumFactory.hasRole(adminRole, signerAddress))) {
    throw new Error("Signer does not hold ArmoreumFactory's default admin role.");
  }
  if (await armoreumFactory.approvedTaxSources(address)) {
    throw new Error(`Predicted ${contractName} is unexpectedly approved before deployment.`);
  }
  const approvalData = armoreumFactory.interface.encodeFunctionData("setTaxSourceApproval", [address, true]);
  const approvalRequest = { from: signerAddress, to: factoryRecord.address, data: approvalData };
  const codeOverride = { [address]: { code: "0x6000" } };
  await provider.send("eth_call", [approvalRequest, "latest", codeOverride]);
  const approvalGas = BigInt(await provider.send("eth_estimateGas", [
    approvalRequest,
    "latest",
    codeOverride,
  ]));
  const approvalGasLimit = (approvalGas * 120n + 99n) / 100n;

  const fees = await encodeFees(provider);
  const totalMaximumCost = gasLimit * fees.maximumGasPrice + approvalGasLimit * fees.maximumGasPrice;
  const balance = await provider.getBalance(signerAddress);
  if (balance < totalMaximumCost) throw new Error("Deployment signer cannot cover both planned transactions.");
  const report = {
    chainId: 1,
    network: "Ethereum mainnet",
    broadcast,
    contract: contractName,
    address,
    poolManager: POOL_MANAGER,
    jailSeed: seedAddress,
    salt: saltResult.salt,
    initCodeHash,
    estimatedGas: estimatedGas.toString(),
    gasLimit: gasLimit.toString(),
    approvalGas: approvalGas.toString(),
    approvalGasLimit: approvalGasLimit.toString(),
    maximumCostEth: ethers.formatEther(totalMaximumCost),
    signerBalanceEth: ethers.formatEther(balance),
    note: "Uses the existing fixed-supply JailSeed and fee routing. New hooks renounce admin to address(0) after binding the verified router, matching JailSeed seed preconditions.",
  };
  if (!broadcast) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (required("DEPLOY_ETHEREUM_MAINNET_CONFIRMATION") !== CONFIRMATION) {
    throw new Error("Explicit Ethereum mainnet deployment confirmation is required.");
  }

  const partial = { ...report, status: "prepared", deployments: [] };
  writeJsonAtomically(partialPath, partial);
  const deploymentTx = await signer.sendTransaction({
    to: create2Address,
    data: deploymentData,
    gasLimit,
    ...fees.transactionFees,
  });
  partial.status = "factory-deployment-broadcast";
  partial.deploymentTransactionHash = deploymentTx.hash;
  writeJsonAtomically(partialPath, partial);
  const deploymentReceipt = await deploymentTx.wait();
  if (!deploymentReceipt || deploymentReceipt.status !== 1) {
    throw new Error(`${contractName} deployment failed; partial record retained.`);
  }
  const runtimeCode = await provider.getCode(address);
  if (runtimeCode === "0x") throw new Error(`${contractName} has no runtime code after deployment.`);
  const liveFactory = new ethers.Contract(
    address,
    ["function poolManager() view returns(address)", "function jailSeed() view returns(address)"],
    provider,
  );
  if (
    ethers.getAddress(await liveFactory.poolManager()) !== ethers.getAddress(POOL_MANAGER) ||
    ethers.getAddress(await liveFactory.jailSeed()) !== seedAddress
  ) throw new Error(`${contractName} constructor configuration does not match preflight.`);

  const approvalTx = await armoreumFactory.setTaxSourceApproval(address, true, {
    gasLimit: approvalGasLimit,
    ...fees.transactionFees,
  });
  partial.status = "tax-source-approval-broadcast";
  partial.approvalTransactionHash = approvalTx.hash;
  writeJsonAtomically(partialPath, partial);
  const approvalReceipt = await approvalTx.wait();
  if (!approvalReceipt || approvalReceipt.status !== 1 || !(await armoreumFactory.approvedTaxSources(address))) {
    throw new Error(`${contractName} tax-source approval failed; partial record retained.`);
  }

  const contractRecord = {
    name: contractName,
    address,
    salt: saltResult.salt,
    deployer: create2Address,
    initCodeHash,
    runtimeCodeHash: ethers.keccak256(runtimeCode),
    transactionHash: deploymentReceipt.hash,
    blockNumber: deploymentReceipt.blockNumber,
    sourceVerification: "pending",
  };
  const nextManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  nextManifest.contracts.push(contractRecord);
  nextManifest.externalIntegrations.ethereumTaxRoutingSource = address;
  nextManifest.ethereumV4Infrastructure = {
    ...(nextManifest.ethereumV4Infrastructure || {}),
    poolManager: POOL_MANAGER,
    jailSeed: seedAddress,
    hookFactory: address,
    taxSourceApprovalTransactionHash: approvalReceipt.hash,
  };
  nextManifest.status = `${contractName} deployed and approved; source verification pending`;
  writeJsonAtomically(manifestPath, nextManifest);
  fs.rmSync(partialPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ...report,
    deploymentTransactionHash: deploymentReceipt.hash,
    deploymentBlockNumber: deploymentReceipt.blockNumber,
    approvalTransactionHash: approvalReceipt.hash,
    runtimeCodeHash: ethers.keccak256(runtimeCode),
    sourceVerification: "pending",
    status: "deployed and approved",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum HookFactory deployment failed"}\n`);
  process.exitCode = 1;
});
