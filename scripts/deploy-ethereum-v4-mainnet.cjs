const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CHAIN_ID = 1n;
const CONFIRMATION = "I confirm deployment to Ethereum mainnet chain 1";
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const packageRoot = path.join(__dirname, "..");
const manifestPath = path.join(packageRoot, "deployments", "1.json");
const partialPath = path.join(packageRoot, "deployments", "1.ethereum-v4.partial.json");
const create2Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const deploymentNames = ["JailSeed", "ArmoreumHookFactory"];
let currentStage = "setup";

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

function getManifestContract(manifest, name) {
  const record = manifest.contracts.find((item) => item.name === name);
  if (!record) throw new Error(`Ethereum manifest is missing ${name}.`);
  return record;
}

function encodeFees(feeData) {
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maxFeePerGas == null) throw new Error("Ethereum RPC did not return usable gas-fee data.");
  if (feeData.maxPriorityFeePerGas != null && feeData.maxFeePerGas != null) {
    return {
      transactionFees: {
        maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      },
      maximumGasPrice: maxFeePerGas,
    };
  }
  return { transactionFees: { gasPrice: maxFeePerGas }, maximumGasPrice: maxFeePerGas };
}

async function main() {
  const dryRun = process.env.ARMOREUM_DEPLOY_DRY_RUN === "1";
  currentStage = "network preflight";
  if (fs.existsSync(partialPath)) {
    throw new Error(`A prior Ethereum V4 deployment needs reconciliation: ${partialPath}`);
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Refusing deployment on chain ${network.chainId}; expected Ethereum chain 1.`);
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const ownerAddress = new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address;
  const signerAddress = await signer.getAddress();
  if (ownerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error("The configured signer is not the canonical Ethereum platform owner.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || manifest.launchEnabled !== false) {
    throw new Error("Ethereum manifest is not in the expected launch-disabled state.");
  }
  const create2Record = manifest.externalIntegrations?.create2Deployer;
  const create2Code = await ethers.provider.getCode(create2Address);
  if (
    create2Record?.address?.toLowerCase() !== create2Address.toLowerCase()
      || create2Code === "0x"
      || ethers.keccak256(create2Code).toLowerCase()
        !== create2Record.runtimeCodeHash?.toLowerCase()
  ) {
    throw new Error("The Ethereum CREATE2 deployer does not match the verified manifest.");
  }
  const managerCode = await ethers.provider.getCode(POOL_MANAGER);
  if (managerCode === "0x") {
    throw new Error("The canonical Uniswap V4 PoolManager has no code on Ethereum mainnet.");
  }

  const seedFactory = await ethers.getContractFactory("JailSeed", signer);
  currentStage = "JailSeed init-code planning";
  const seedRequest = await seedFactory.getDeployTransaction(POOL_MANAGER);
  if (!seedRequest.data) throw new Error("Could not build JailSeed initialization code.");
  const seedInitCode = seedRequest.data;
  const seedInitCodeHash = ethers.keccak256(seedInitCode);
  const seedSalt = await mineVanitySalt({
    deployer: create2Address,
    initCode: seedInitCode,
    stateFile: path.join(packageRoot, "deployments", "1.vanity", `JailSeed-${seedInitCodeHash.slice(2, 10)}.json`),
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const seedAddress = ethers.getAddress(seedSalt.address);
  if (!seedAddress.toLowerCase().startsWith(PREFIX)) {
    throw new Error("JailSeed did not satisfy the core-contract address prefix.");
  }

  const hookFactory = await ethers.getContractFactory("ArmoreumHookFactory", signer);
  currentStage = "HookFactory init-code planning";
  const hookRequest = await hookFactory.getDeployTransaction(POOL_MANAGER, seedAddress);
  if (!hookRequest.data) throw new Error("Could not build ArmoreumHookFactory initialization code.");
  const hookInitCode = hookRequest.data;
  const hookInitCodeHash = ethers.keccak256(hookInitCode);
  const hookSalt = await mineVanitySalt({
    deployer: create2Address,
    initCode: hookInitCode,
    stateFile: path.join(
      packageRoot,
      "deployments",
      "1.vanity",
      `ArmoreumHookFactory-${hookInitCodeHash.slice(2, 10)}.json`,
    ),
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const hookFactoryAddress = ethers.getAddress(hookSalt.address);
  if (!hookFactoryAddress.toLowerCase().startsWith(PREFIX)) {
    throw new Error("ArmoreumHookFactory did not satisfy the core-contract address prefix.");
  }

  const factoryAddress = getManifestContract(manifest, "ArmoreumFactory-proxy").address;
  const armoreumFactory = new ethers.Contract(
    factoryAddress,
    [
      "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
      "function approvedTaxSources(address) view returns (bool)",
      "function setTaxSourceApproval(address,bool)",
    ],
    signer,
  );
  currentStage = "Factory authorization preflight";
  const defaultAdminRole = await armoreumFactory.DEFAULT_ADMIN_ROLE();
  if (!(await armoreumFactory.hasRole(defaultAdminRole, signerAddress))) {
    throw new Error("Configured signer does not hold the ArmoreumFactory admin role.");
  }

  const deployments = [
    {
      name: deploymentNames[0],
      address: seedAddress,
      salt: seedSalt.salt,
      initCode: seedInitCode,
      initCodeHash: seedInitCodeHash,
    },
    {
      name: deploymentNames[1],
      address: hookFactoryAddress,
      salt: hookSalt.salt,
      initCode: hookInitCode,
      initCodeHash: hookInitCodeHash,
    },
  ];
  const feeData = await ethers.provider.getFeeData();
  const fees = encodeFees(feeData);
  const plannedTransactions = [];
  for (const deployment of deployments) {
    const existing = manifest.contracts.find((item) => item.name === deployment.name);
    const deployedCode = await ethers.provider.getCode(deployment.address);
    if (existing) {
      if (
        existing.address.toLowerCase() !== deployment.address.toLowerCase()
          || existing.initCodeHash?.toLowerCase() !== deployment.initCodeHash.toLowerCase()
          || deployedCode === "0x"
          || ethers.keccak256(deployedCode).toLowerCase() !== existing.runtimeCodeHash?.toLowerCase()
      ) {
        throw new Error(`Manifest or runtime mismatch for ${deployment.name}.`);
      }
      deployment.alreadyDeployed = true;
      continue;
    }
    if (deployedCode !== "0x") {
      throw new Error(`Predicted ${deployment.name} address already has unregistered code.`);
    }

    const data = encodeCreate2Deployment(deployment.salt, deployment.initCode);
    const request = { from: signerAddress, to: create2Address, data };
    currentStage = `${deployment.name} mainnet gas estimation`;
    const seedHasCode = await ethers.provider.getCode(seedAddress) !== "0x";
    const estimatedGas = deployment.name === "ArmoreumHookFactory" && !seedHasCode
      ? BigInt(await ethers.provider.send("eth_estimateGas", [
          request,
          "latest",
          { [seedAddress]: { code: "0x6000" } },
        ]))
      : await ethers.provider.estimateGas(request);
    const gasLimit = (estimatedGas * 120n + 99n) / 100n;
    if (deployment.name === "ArmoreumHookFactory" && !seedHasCode) {
      await ethers.provider.send("eth_call", [
        { ...request, gas: ethers.toQuantity(gasLimit) },
        "latest",
        { [seedAddress]: { code: "0x6000" } },
      ]);
    } else {
      await ethers.provider.call({ ...request, gasLimit });
    }
    Object.assign(deployment, { data, estimatedGas, gasLimit });
    plannedTransactions.push({
      label: deployment.name,
      gasLimit,
      maximumCost: gasLimit * fees.maximumGasPrice,
    });
  }

  const sourceAlreadyApproved = await armoreumFactory.approvedTaxSources(hookFactoryAddress);
  let approvalPlan = null;
  if (!sourceAlreadyApproved) {
    currentStage = "tax-source approval preflight";
    const approvalRequest = {
      from: signerAddress,
      to: factoryAddress,
      data: armoreumFactory.interface.encodeFunctionData(
        "setTaxSourceApproval",
        [hookFactoryAddress, true],
      ),
    };
    let approvalGas;
    if (await ethers.provider.getCode(hookFactoryAddress) === "0x") {
      const codeOverride = { [hookFactoryAddress]: { code: "0x6000" } };
      await ethers.provider.send("eth_call", [
        approvalRequest,
        "latest",
        codeOverride,
      ]);
      approvalGas = BigInt(await ethers.provider.send("eth_estimateGas", [
        approvalRequest,
        "latest",
        codeOverride,
      ]));
    } else {
      await ethers.provider.call(approvalRequest);
      approvalGas = await armoreumFactory.setTaxSourceApproval.estimateGas(
        hookFactoryAddress,
        true,
      );
    }
    const approvalGasLimit = (approvalGas * 120n + 99n) / 100n;
    approvalPlan = {
      label: "Approve immutable ArmoreumHookFactory as Ethereum tax source",
      gasLimit: approvalGasLimit,
      maximumCost: approvalGasLimit * fees.maximumGasPrice,
    };
    plannedTransactions.push(approvalPlan);
  }

  const balance = await ethers.provider.getBalance(signerAddress);
  const totalMaximumCost = plannedTransactions.reduce((sum, item) => sum + item.maximumCost, 0n);
  const report = {
    network: "Ethereum mainnet",
    chainId: 1,
    dryRun,
    poolManager: POOL_MANAGER,
    jailSeed: {
      address: seedAddress,
      salt: seedSalt.salt,
      initCodeHash: seedInitCodeHash,
      alreadyDeployed: Boolean(deployments[0].alreadyDeployed),
    },
    hookFactory: {
      address: hookFactoryAddress,
      salt: hookSalt.salt,
      initCodeHash: hookInitCodeHash,
      alreadyDeployed: Boolean(deployments[1].alreadyDeployed),
      taxSourceApproved: sourceAlreadyApproved,
    },
    signer: signerAddress,
    signerBalanceEth: ethers.formatEther(balance),
    estimatedTransactions: plannedTransactions.map((item) => ({
      label: item.label,
      gasLimit: item.gasLimit.toString(),
      maximumCostEth: ethers.formatEther(item.maximumCost),
    })),
    totalMaximumCostEth: ethers.formatEther(totalMaximumCost),
    launchEnabledAfterRun: false,
    note: "This installs shared Ethereum V4 infrastructure and approves its immutable tax relay. It does not create a token or enable launches.",
  };
  if (balance < totalMaximumCost) {
    throw new Error(`Deployment signer cannot cover the preflight maximum cost (${report.totalMaximumCostEth} ETH).`);
  }
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (required("DEPLOY_ETHEREUM_MAINNET_CONFIRMATION") !== CONFIRMATION) {
    throw new Error("Explicit Ethereum mainnet confirmation is required.");
  }

  const partial = { chainId: 1, status: "prepared", signer: signerAddress, deployments: [] };
  writeJsonAtomically(partialPath, partial);
  for (const deployment of deployments) {
    if (deployment.alreadyDeployed) continue;
    currentStage = `${deployment.name} deployment`;
    partial.deployments.push({
      name: deployment.name,
      address: deployment.address,
      salt: deployment.salt,
      initCodeHash: deployment.initCodeHash,
      status: "prepared",
    });
    writeJsonAtomically(partialPath, partial);
    const tx = await signer.sendTransaction({
      to: create2Address,
      data: deployment.data,
      gasLimit: deployment.gasLimit,
      ...fees.transactionFees,
    });
    const pending = partial.deployments.find((item) => item.name === deployment.name);
    pending.status = "broadcast";
    pending.transactionHash = tx.hash;
    writeJsonAtomically(partialPath, partial);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${deployment.name} deployment failed; partial record retained.`);
    }
    const runtimeCode = await ethers.provider.getCode(deployment.address);
    if (runtimeCode === "0x") throw new Error(`${deployment.name} has no runtime code after deployment.`);
    const record = {
      name: deployment.name,
      address: deployment.address,
      salt: deployment.salt,
      deployer: create2Address,
      initCodeHash: deployment.initCodeHash,
      runtimeCodeHash: ethers.keccak256(runtimeCode),
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      sourceVerification: "pending",
    };
    manifest.contracts.push(record);
    writeJsonAtomically(manifestPath, manifest);
    pending.status = "confirmed";
    pending.runtimeCodeHash = record.runtimeCodeHash;
    partial.status = "deploying";
    writeJsonAtomically(partialPath, partial);
  }

  const liveSeed = new ethers.Contract(
    seedAddress,
    ["function poolManager() view returns(address)"],
    ethers.provider,
  );
  currentStage = "deployed constructor verification";
  const liveHookFactory = new ethers.Contract(
    hookFactoryAddress,
    [
      "function poolManager() view returns(address)",
      "function jailSeed() view returns(address)",
    ],
    ethers.provider,
  );
  if (
    (await liveSeed.poolManager()).toLowerCase() !== POOL_MANAGER.toLowerCase()
      || (await liveHookFactory.poolManager()).toLowerCase() !== POOL_MANAGER.toLowerCase()
      || (await liveHookFactory.jailSeed()).toLowerCase() !== seedAddress.toLowerCase()
  ) {
    throw new Error("Ethereum V4 infrastructure constructor values do not match the preflight.");
  }

  if (!(await armoreumFactory.approvedTaxSources(hookFactoryAddress))) {
    currentStage = "tax-source approval transaction";
    const gasLimit = approvalPlan.gasLimit;
    const tx = await armoreumFactory.setTaxSourceApproval(hookFactoryAddress, true, {
      gasLimit,
      ...fees.transactionFees,
    });
    partial.status = "approving-tax-source";
    partial.approvalTransactionHash = tx.hash;
    writeJsonAtomically(partialPath, partial);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("HookFactory tax-source approval failed; partial record retained.");
    }
    if (!(await armoreumFactory.approvedTaxSources(hookFactoryAddress))) {
      throw new Error("Tax-source approval was not persisted on-chain.");
    }
    manifest.externalIntegrations.ethereumTaxRoutingSource = hookFactoryAddress;
    manifest.ethereumV4Infrastructure = {
      poolManager: POOL_MANAGER,
      jailSeed: seedAddress,
      hookFactory: hookFactoryAddress,
      taxSourceApprovalTransactionHash: receipt.hash,
    };
  } else {
    manifest.externalIntegrations.ethereumTaxRoutingSource = hookFactoryAddress;
    manifest.ethereumV4Infrastructure = {
      poolManager: POOL_MANAGER,
      jailSeed: seedAddress,
      hookFactory: hookFactoryAddress,
      taxSourceApprovalTransactionHash: manifest.ethereumV4Infrastructure?.taxSourceApprovalTransactionHash ?? null,
    };
  }
  manifest.launchEnabled = false;
  manifest.status = "Ethereum V4 infrastructure installed; launches remain disabled until full UI/API preflight passes";
  writeJsonAtomically(manifestPath, manifest);
  fs.rmSync(partialPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ...report,
    launchedToken: null,
    launchEnabled: false,
    deploymentRecords: deploymentNames.map((name) => getManifestContract(manifest, name)),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${currentStage}: ${error instanceof Error ? error.shortMessage || error.message : String(error)}\n`);
  process.exitCode = 1;
});
