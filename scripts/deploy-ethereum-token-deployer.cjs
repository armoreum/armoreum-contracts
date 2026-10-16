const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CHAIN_ID = 1n;
const CONFIRMATION = "I confirm deployment to Ethereum mainnet chain 1";
const manifestPath = path.join(__dirname, "..", "deployments", "1.json");
const partialPath = path.join(
  __dirname,
  "..",
  "deployments",
  "1.ArmoreumTokenDeployer.partial.json",
);

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
  const dryRun = process.env.ARMOREUM_DEPLOY_DRY_RUN === "1";
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Refusing deployment on chain ${network.chainId}; expected Ethereum mainnet chain 1.`);
  }

  const signer = (await ethers.getSigners())[0];
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const canonicalOwner = new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address;
  if ((await signer.getAddress()).toLowerCase() !== canonicalOwner.toLowerCase()) {
    throw new Error("The Ethereum signer does not match the configured funded deployment owner.");
  }

  const create2Address = ethers.getAddress(required("ETHEREUM_CREATE2_DEPLOYER_ADDRESS"));
  const expectedCreate2Hash = required("ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH");
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedCreate2Hash)) {
    throw new Error("ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH must be a 32-byte hash.");
  }
  const create2Code = await ethers.provider.getCode(create2Address);
  if (
    create2Code === "0x" ||
    ethers.keccak256(create2Code).toLowerCase() !== expectedCreate2Hash.toLowerCase()
  ) {
    throw new Error("Ethereum CREATE2 deployer code does not match its verified runtime hash.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || manifest.launchEnabled !== false) {
    throw new Error("Ethereum manifest is not the expected chain-1 launch-disabled manifest.");
  }
  if (!Array.isArray(manifest.contracts)) {
    throw new Error("Ethereum deployment manifest has no contracts list.");
  }

  const artifact = await artifacts.readArtifact("ArmoreumTokenDeployer");
  const initCode = artifact.bytecode;
  const initCodeHash = ethers.keccak256(initCode);
  const stateFile = path.join(
    __dirname,
    "..",
    "deployments",
    "1.vanity",
    `ArmoreumTokenDeployer-${initCodeHash.slice(2, 10)}.json`,
  );
  const saltResult = await mineVanitySalt({
    deployer: create2Address,
    initCode,
    stateFile,
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const predictedAddress = ethers.getCreate2Address(
    create2Address,
    saltResult.salt,
    initCodeHash,
  );
  if (
    predictedAddress.toLowerCase() !== saltResult.address.toLowerCase() ||
    !predictedAddress.toLowerCase().startsWith(PREFIX)
  ) {
    throw new Error("The saved CREATE2 result does not match the required core-contract address prefix.");
  }

  const existingRecord = manifest.contracts.find(
    (record) => record.name === "ArmoreumTokenDeployer",
  );
  const deployedCode = await ethers.provider.getCode(predictedAddress);
  if (existingRecord) {
    if (
      existingRecord.address.toLowerCase() !== predictedAddress.toLowerCase() ||
      deployedCode === "0x" ||
      typeof existingRecord.runtimeCodeHash !== "string" ||
      ethers.keccak256(deployedCode).toLowerCase() !== existingRecord.runtimeCodeHash.toLowerCase()
    ) {
      throw new Error("Manifest has a conflicting ArmoreumTokenDeployer record; refusing to deploy.");
    }
    if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true });
    process.stdout.write(`${JSON.stringify({
      chainId: 1,
      network: "Ethereum mainnet",
      alreadyDeployed: true,
      address: predictedAddress,
      transactionHash: existingRecord.transactionHash,
      sourceVerification: existingRecord.sourceVerification,
    }, null, 2)}\n`);
    return;
  }
  if (fs.existsSync(partialPath)) {
    throw new Error(`A prior token-deployer deployment record needs reconciliation: ${partialPath}`);
  }
  if (deployedCode !== "0x") {
    throw new Error("Predicted address already has code but is not registered; refusing duplicate deployment.");
  }

  const data = encodeCreate2Deployment(saltResult.salt, initCode);
  const request = {
    from: await signer.getAddress(),
    to: create2Address,
    data,
  };
  const estimatedGas = await ethers.provider.estimateGas(request);
  const gasLimit = (estimatedGas * 120n) / 100n;
  const simulation = await ethers.provider.call({ ...request, gasLimit });
  if (simulation !== "0x") {
    let simulatedAddress;
    if (ethers.isAddress(simulation)) {
      simulatedAddress = ethers.getAddress(simulation);
    } else if (/^0x0{24}[0-9a-fA-F]{40}$/.test(simulation)) {
      simulatedAddress = ethers.getAddress(`0x${simulation.slice(-40)}`);
    } else {
      throw new Error("CREATE2 deployment simulation returned an unrecognized address value.");
    }
    if (simulatedAddress.toLowerCase() !== predictedAddress.toLowerCase()) {
      throw new Error("CREATE2 deployment simulation returned an address different from the prediction.");
    }
  }

  const feeData = await ethers.provider.getFeeData();
  const maximumGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maximumGasPrice == null) throw new Error("Ethereum RPC did not return usable gas-fee data.");
  const maximumCost = gasLimit * maximumGasPrice;
  const balance = await ethers.provider.getBalance(await signer.getAddress());
  if (balance < maximumCost) throw new Error("Deployment signer balance is below the simulated maximum gas cost.");

  const report = {
    chainId: 1,
    network: "Ethereum mainnet",
    dryRun,
    contract: "ArmoreumTokenDeployer",
    address: predictedAddress,
    create2Deployer: create2Address,
    salt: saltResult.salt,
    initCodeHash,
    estimatedGas: estimatedGas.toString(),
    gasLimit: gasLimit.toString(),
    maximumGasPriceWei: maximumGasPrice.toString(),
    maximumCostWei: maximumCost.toString(),
    maximumCostEth: ethers.formatEther(maximumCost),
    deployerBalanceEth: ethers.formatEther(balance),
    sourceVerification: "pending",
    note: "This deployer creates ownerless fixed-supply tokens only; it does not create pools or configure tax, vault, or bridge routes.",
  };
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (required("DEPLOY_ETHEREUM_MAINNET_CONFIRMATION") !== CONFIRMATION) {
    throw new Error("Explicit Ethereum mainnet deployment confirmation is required.");
  }

  writeJsonAtomically(partialPath, {
    ...report,
    status: "prepared",
    deployer: await signer.getAddress(),
    createdAt: new Date().toISOString(),
  });

  const transaction = await signer.sendTransaction({
    to: create2Address,
    data,
    gasLimit,
  });
  writeJsonAtomically(partialPath, {
    ...report,
    status: "broadcast",
    transactionHash: transaction.hash,
  });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error("Ethereum CREATE2 deployment transaction failed; partial record retained.");
  }

  const runtimeCode = await ethers.provider.getCode(predictedAddress);
  const expectedRuntimeHash = ethers.keccak256(artifact.deployedBytecode);
  const runtimeCodeHash = ethers.keccak256(runtimeCode);
  if (runtimeCode === "0x" || runtimeCodeHash.toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error("Onchain runtime does not match the compiled ArmoreumTokenDeployer; partial record retained.");
  }

  const record = {
    name: "ArmoreumTokenDeployer",
    address: predictedAddress,
    salt: saltResult.salt,
    deployer: create2Address,
    initCodeHash,
    runtimeCodeHash,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    sourceVerification: "pending",
  };
  const updatedManifest = {
    ...manifest,
    status: "core factories upgraded; ArmoreumTokenDeployer deployed; launch remains disabled pending verified transaction integrations",
    contracts: [...manifest.contracts, record],
    tokenDeployer: {
      address: predictedAddress,
      transactionHash: receipt.hash,
      sourceVerification: "pending",
      standaloneFactoryOnly: true,
    },
  };
  writeJsonAtomically(manifestPath, updatedManifest);
  fs.rmSync(partialPath, { force: true });

  process.stdout.write(`${JSON.stringify({
    ...report,
    dryRun: false,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash,
    status: "deployed; manifest updated; source verification pending",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum token deployer deployment failed"}\n`);
  process.exitCode = 1;
});
