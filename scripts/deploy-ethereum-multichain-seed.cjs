const fs = require("node:fs");
const path = require("node:path");
const { ethers, run } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CHAIN_ID = 1n;
const CONFIRMATION = "I confirm deployment to Ethereum mainnet chain 1";
const CREATE2_ADDRESS = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const SEED_NAME = "JailMultiSeed";
const HOOK_FACTORY_NAME = "ArmoreumMultichainHookFactory";
const packageRoot = path.join(__dirname, "..");
const manifestPath = path.join(packageRoot, "deployments", "1.json");
const partialPath = path.join(packageRoot, "deployments", "1.ethereum-multichain-seed.partial.json");

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

function getManifestContract(manifest, name) {
  const record = manifest.contracts.find((item) => item.name === name);
  if (!record) throw new Error(`Ethereum manifest is missing ${name}.`);
  return record;
}

async function getFees(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Ethereum base fee is unavailable; refusing mainnet deployment.");
  }
  const gasPrice = (block.baseFeePerGas * 120n + 99n) / 100n;
  return { transactionFees: { gasPrice }, maximumGasPrice: gasPrice };
}

async function planCreate2Deployment({
  provider,
  signerAddress,
  deployer,
  contractFactory,
  args,
  name,
  stateFile,
  constructorStateOverride,
  manifest,
}) {
  const request = await contractFactory.getDeployTransaction(...args);
  if (!request.data) throw new Error(`Could not build ${name} initialization code.`);
  const initCode = request.data;
  const initCodeHash = ethers.keccak256(initCode);
  const mined = await mineVanitySalt({
    deployer,
    initCode,
    stateFile,
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const address = ethers.getAddress(ethers.getCreate2Address(deployer, mined.salt, initCodeHash));
  if (address.toLowerCase() !== mined.address.toLowerCase() || !address.toLowerCase().startsWith(PREFIX)) {
    throw new Error(`${name} CREATE2 prediction did not match its saved vanity search.`);
  }

  const existingCode = await provider.getCode(address);
  const existingRecord = manifest.contracts.find((item) => item.name === name);
  if (existingCode !== "0x") {
    if (
      !existingRecord ||
      existingRecord.address.toLowerCase() !== address.toLowerCase() ||
      existingRecord.initCodeHash?.toLowerCase() !== initCodeHash.toLowerCase() ||
      ethers.keccak256(existingCode).toLowerCase() !== existingRecord.runtimeCodeHash?.toLowerCase()
    ) {
      throw new Error(`${name} predicted address is occupied without a matching verified manifest record.`);
    }
    return {
      name,
      address,
      salt: mined.salt,
      initCodeHash,
      initCode,
      data: null,
      gasLimit: 0n,
      maximumCost: 0n,
      alreadyDeployed: true,
      manifestRecord: existingRecord,
    };
  }
  if (existingRecord) throw new Error(`${name} is recorded in the manifest but has no live bytecode.`);

  const data = encodeCreate2Deployment(mined.salt, initCode);
  const txRequest = { from: signerAddress, to: deployer, data };
  const useOverride = Boolean(constructorStateOverride);
  const estimatedGas = useOverride
    ? BigInt(await provider.send("eth_estimateGas", [
        txRequest,
        "latest",
        constructorStateOverride,
      ]))
    : await provider.estimateGas(txRequest);
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  if (useOverride) {
    await provider.send("eth_call", [
      { ...txRequest, gas: ethers.toQuantity(gasLimit) },
      "latest",
      constructorStateOverride,
    ]);
  } else {
    await provider.call({ ...txRequest, gasLimit });
  }
  return {
    name,
    address,
    salt: mined.salt,
    initCodeHash,
    initCode,
    data,
    estimatedGas,
    gasLimit,
    maximumCost: 0n,
    alreadyDeployed: false,
  };
}

async function recordDeployment(manifest, deployment, receipt, provider) {
  const runtimeCode = await provider.getCode(deployment.address);
  if (runtimeCode === "0x") throw new Error(`${deployment.name} has no runtime code after deployment.`);
  const record = {
    name: deployment.name,
    address: deployment.address,
    salt: deployment.salt,
    deployer: CREATE2_ADDRESS,
    initCodeHash: deployment.initCodeHash,
    runtimeCodeHash: ethers.keccak256(runtimeCode),
    transactionHash: receipt?.hash ?? null,
    blockNumber: receipt?.blockNumber ?? null,
    sourceVerification: "pending",
  };
  const prior = manifest.contracts.findIndex((item) => item.name === deployment.name);
  if (prior >= 0) manifest.contracts[prior] = record;
  else manifest.contracts.push(record);
  writeJsonAtomically(manifestPath, manifest);
  return record;
}

async function verifySources(manifest, seedAddress, hookFactoryAddress) {
  const targets = [
    {
      name: SEED_NAME,
      address: seedAddress,
      contract: "contracts/v4/JailMultiSeed.sol:JailMultiSeed",
      constructorArguments: [POOL_MANAGER],
    },
    {
      name: HOOK_FACTORY_NAME,
      address: hookFactoryAddress,
      contract: "contracts/v4/ArmoreumMultichainHookFactory.sol:ArmoreumMultichainHookFactory",
      constructorArguments: [POOL_MANAGER, seedAddress],
    },
  ];
  for (const target of targets) {
    const record = manifest.contracts.find((item) => item.name === target.name);
    try {
      await run("verify:verify", {
        address: target.address,
        contract: target.contract,
        constructorArguments: target.constructorArguments,
      });
      if (record) record.sourceVerification = "verified";
      process.stdout.write(`${target.name} source verified on Etherscan.\n`);
    } catch {
      if (record) record.sourceVerification = "pending";
      process.stdout.write(`${target.name} source verification remains pending; deployment is recorded.\n`);
    }
    writeJsonAtomically(manifestPath, manifest);
  }
}

async function main() {
  const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== CHAIN_ID) {
    throw new Error("Refusing Multichain infrastructure deployment outside Ethereum mainnet.");
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || !manifest.launchEnabled) {
    throw new Error("Ethereum launch infrastructure is not in its expected active state.");
  }
  const oldSeed = getManifestContract(manifest, "JailSeed");
  const oldHookFactoryAddress = manifest.ethereumV4Infrastructure?.hookFactory;
  const create2Record = manifest.externalIntegrations?.create2Deployer;
  if (!oldHookFactoryAddress || !create2Record) {
    throw new Error("Ethereum manifest is missing the current V4 hook factory or CREATE2 deployment data.");
  }

  const create2Deployer = ethers.getAddress(create2Record.address);
  if (create2Deployer !== ethers.getAddress(CREATE2_ADDRESS)) {
    throw new Error("Manifest CREATE2 deployer address is not the expected deployment contract.");
  }
  const [create2Code, poolManagerCode, oldSeedCode, oldHookCode] = await Promise.all([
    provider.getCode(create2Deployer),
    provider.getCode(POOL_MANAGER),
    provider.getCode(oldSeed.address),
    provider.getCode(oldHookFactoryAddress),
  ]);
  if (
    create2Code === "0x" ||
    ethers.keccak256(create2Code).toLowerCase() !== String(create2Record.runtimeCodeHash).toLowerCase()
  ) throw new Error("Live CREATE2 deployer bytecode does not match the verified manifest.");
  if (poolManagerCode === "0x" || oldSeedCode === "0x" || oldHookCode === "0x") {
    throw new Error("Ethereum PoolManager or current launch infrastructure is missing deployed code.");
  }

  const oldSeedInterface = new ethers.Interface([
    "function seeds(address) view returns(address creator,address hook,uint128 liquidity,uint256 roundingDust)",
  ]);
  const legacyRecord = await provider.call({
    to: oldSeed.address,
    data: oldSeedInterface.encodeFunctionData("seeds", [ethers.ZeroAddress]),
  });
  if (legacyRecord.length !== 2 + 4 * 32 * 2) {
    throw new Error("Current JailSeed does not return the expected four-field legacy record; stop and reconcile.");
  }
  const oldFactory = new ethers.Contract(oldHookFactoryAddress, [
    "function poolManager() view returns(address)",
    "function jailSeed() view returns(address)",
  ], provider);
  if (
    ethers.getAddress(await oldFactory.poolManager()) !== ethers.getAddress(POOL_MANAGER) ||
    ethers.getAddress(await oldFactory.jailSeed()) !== ethers.getAddress(oldSeed.address)
  ) throw new Error("Current Ethereum-only HookFactory does not match the manifest's JailSeed.");

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const canonicalOwner = ethers.getAddress(manifest.authorities?.canonicalPlatformOwner);
  const keyOwner = ethers.getAddress(new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address);
  if (signerAddress !== canonicalOwner || signerAddress !== keyOwner) {
    throw new Error("Configured signer is not the canonical Ethereum platform owner.");
  }

  const factoryRecord = getManifestContract(manifest, "ArmoreumFactory-proxy");
  const factory = new ethers.Contract(factoryRecord.address, [
    "function DEFAULT_ADMIN_ROLE() view returns(bytes32)",
    "function hasRole(bytes32,address) view returns(bool)",
    "function approvedTaxSources(address) view returns(bool)",
    "function setTaxSourceApproval(address,bool)",
  ], signer);
  const adminRole = await factory.DEFAULT_ADMIN_ROLE();
  if (!(await factory.hasRole(adminRole, signerAddress))) {
    throw new Error("Canonical signer no longer holds the ArmoreumFactory admin role.");
  }

  const seedFactory = await ethers.getContractFactory(SEED_NAME, signer);
  const seedPlan = await planCreate2Deployment({
    provider,
    signerAddress,
    deployer: create2Deployer,
    contractFactory: seedFactory,
    args: [POOL_MANAGER],
    name: SEED_NAME,
    stateFile: path.join(packageRoot, "deployments", "1.vanity", `${SEED_NAME}.json`),
    manifest,
  });
  const multiHookFactory = await ethers.getContractFactory(HOOK_FACTORY_NAME, signer);
  const hookPlan = await planCreate2Deployment({
    provider,
    signerAddress,
    deployer: create2Deployer,
    contractFactory: multiHookFactory,
    args: [POOL_MANAGER, seedPlan.address],
    name: HOOK_FACTORY_NAME,
    stateFile: path.join(packageRoot, "deployments", "1.vanity", `${HOOK_FACTORY_NAME}.json`),
    constructorStateOverride: {
      [seedPlan.address]: { code: "0x6000" },
    },
    manifest,
  });

  const sourceAlreadyApproved = await factory.approvedTaxSources(hookPlan.address);
  let approvalGasLimit = 0n;
  if (!sourceAlreadyApproved) {
    const approvalRequest = {
      from: signerAddress,
      to: factoryRecord.address,
      data: factory.interface.encodeFunctionData("setTaxSourceApproval", [hookPlan.address, true]),
    };
    const hookCode = await provider.getCode(hookPlan.address);
    const override = hookCode === "0x" ? { [hookPlan.address]: { code: "0x6000" } } : undefined;
    if (override) {
      await provider.send("eth_call", [approvalRequest, "latest", override]);
    } else {
      await provider.call(approvalRequest);
    }
    const approvalGas = override
      ? BigInt(await provider.send("eth_estimateGas", [approvalRequest, "latest", override]))
      : await provider.estimateGas(approvalRequest);
    approvalGasLimit = (approvalGas * 120n + 99n) / 100n;
  }

  const fees = await getFees(provider);
  seedPlan.maximumCost = seedPlan.gasLimit * fees.maximumGasPrice;
  hookPlan.maximumCost = hookPlan.gasLimit * fees.maximumGasPrice;
  const approvalMaximumCost = approvalGasLimit * fees.maximumGasPrice;
  const totalMaximumCost = seedPlan.maximumCost + hookPlan.maximumCost + approvalMaximumCost;
  const balance = await provider.getBalance(signerAddress);
  if (balance < totalMaximumCost) {
    throw new Error(`Canonical signer cannot cover the simulated maximum (${ethers.formatEther(totalMaximumCost)} ETH).`);
  }
  const report = {
    network: "Ethereum mainnet",
    chainId: 1,
    broadcast,
    currentEthereumOnly: {
      jailSeed: ethers.getAddress(oldSeed.address),
      hookFactory: ethers.getAddress(oldHookFactoryAddress),
      legacySeedRecordBytes: (legacyRecord.length - 2) / 2,
    },
    newMultichainOnly: {
      jailMultiSeed: seedPlan.address,
      multichainHookFactory: hookPlan.address,
      poolManager: POOL_MANAGER,
    },
    signer: signerAddress,
    signerBalanceEth: ethers.formatEther(balance),
    estimatedTransactions: [
      ...(seedPlan.alreadyDeployed ? [] : [{
        label: `Deploy ${SEED_NAME}`,
        gasLimit: seedPlan.gasLimit.toString(),
        maximumCostEth: ethers.formatEther(seedPlan.maximumCost),
      }]),
      ...(hookPlan.alreadyDeployed ? [] : [{
        label: `Deploy ${HOOK_FACTORY_NAME}`,
        gasLimit: hookPlan.gasLimit.toString(),
        maximumCostEth: ethers.formatEther(hookPlan.maximumCost),
      }]),
      ...(!sourceAlreadyApproved ? [{
        label: "Approve Multichain HookFactory as Armoreum tax source",
        gasLimit: approvalGasLimit.toString(),
        maximumCostEth: ethers.formatEther(approvalMaximumCost),
      }] : []),
    ],
    totalMaximumCostEth: ethers.formatEther(totalMaximumCost),
    note: "Ethereum-only JailSeed and HookFactory remain unchanged. This installs distinct Multichain contracts; it does not launch a token.",
  };

  if (!broadcast) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (required("DEPLOY_ETHEREUM_MAINNET_CONFIRMATION") !== CONFIRMATION) {
    throw new Error("Explicit Ethereum mainnet repair confirmation is required.");
  }
  if (fs.existsSync(partialPath)) {
    throw new Error(`A previous Multichain deployment needs reconciliation: ${partialPath}`);
  }

  const partial = {
    chainId: 1,
    signer: signerAddress,
    status: "prepared",
    seed: { address: seedPlan.address, initCodeHash: seedPlan.initCodeHash, status: seedPlan.alreadyDeployed ? "confirmed" : "prepared" },
    hookFactory: { address: hookPlan.address, initCodeHash: hookPlan.initCodeHash, status: hookPlan.alreadyDeployed ? "confirmed" : "prepared" },
  };
  writeJsonAtomically(partialPath, partial);

  async function deployIfNeeded(deployment, constructorCheck) {
    if (deployment.alreadyDeployed) return deployment.manifestRecord;
    const tx = await signer.sendTransaction({
      to: create2Deployer,
      data: deployment.data,
      gasLimit: deployment.gasLimit,
      ...fees.transactionFees,
    });
    partial.status = `deploying-${deployment.name}`;
    partial[deployment.name === SEED_NAME ? "seed" : "hookFactory"] = {
      address: deployment.address,
      initCodeHash: deployment.initCodeHash,
      status: "broadcast",
      transactionHash: tx.hash,
    };
    writeJsonAtomically(partialPath, partial);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error(`${deployment.name} failed; partial record retained.`);
    await constructorCheck();
    return recordDeployment(manifest, deployment, receipt, provider);
  }

  const seedRecord = await deployIfNeeded(seedPlan, async () => {
    const liveSeed = new ethers.Contract(seedPlan.address, [
      "function poolManager() view returns(address)",
      "function seeds(address) view returns(address creator,address hook,uint128 liquidity,uint256 roundingDust,uint256 tokenInventory,uint256 bridgeReserve)",
    ], provider);
    if (ethers.getAddress(await liveSeed.poolManager()) !== ethers.getAddress(POOL_MANAGER)) {
      throw new Error("JailMultiSeed constructor does not point to the canonical Uniswap V4 PoolManager.");
    }
    const result = await provider.call({
      to: seedPlan.address,
      data: liveSeed.interface.encodeFunctionData("seeds", [ethers.ZeroAddress]),
    });
    if (result.length !== 2 + 6 * 32 * 2) throw new Error("JailMultiSeed did not expose its six-field Multichain inventory record.");
  });
  partial.seed = { address: seedPlan.address, initCodeHash: seedPlan.initCodeHash, status: "confirmed" };
  partial.status = "deploying-hook-factory";
  writeJsonAtomically(partialPath, partial);

  const hookRecord = await deployIfNeeded(hookPlan, async () => {
    const liveFactory = new ethers.Contract(hookPlan.address, [
      "function poolManager() view returns(address)",
      "function jailSeed() view returns(address)",
    ], provider);
    if (
      ethers.getAddress(await liveFactory.poolManager()) !== ethers.getAddress(POOL_MANAGER) ||
      ethers.getAddress(await liveFactory.jailSeed()) !== seedPlan.address
    ) throw new Error("Multichain HookFactory constructor does not point to JailMultiSeed.");
  });

  if (!(await factory.approvedTaxSources(hookPlan.address))) {
    const tx = await factory.setTaxSourceApproval(hookPlan.address, true, {
      gasLimit: approvalGasLimit,
      ...fees.transactionFees,
    });
    partial.status = "approving-multichain-tax-source";
    partial.approvalTransactionHash = tx.hash;
    writeJsonAtomically(partialPath, partial);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1 || !(await factory.approvedTaxSources(hookPlan.address))) {
      throw new Error("Multichain HookFactory approval failed; partial record retained.");
    }
    manifest.externalIntegrations.ethereumMultichainTaxRoutingSource = hookPlan.address;
    manifest.ethereumV4MultichainInfrastructure = {
      poolManager: POOL_MANAGER,
      jailMultiSeed: seedPlan.address,
      hookFactory: hookPlan.address,
      taxSourceApprovalTransactionHash: receipt.hash,
    };
  } else {
    manifest.externalIntegrations.ethereumMultichainTaxRoutingSource = hookPlan.address;
    manifest.ethereumV4MultichainInfrastructure = {
      poolManager: POOL_MANAGER,
      jailMultiSeed: seedPlan.address,
      hookFactory: hookPlan.address,
      taxSourceApprovalTransactionHash:
        manifest.ethereumV4MultichainInfrastructure?.taxSourceApprovalTransactionHash ?? null,
    };
  }
  manifest.status = "Separate Ethereum-only and Multichain V4 seed infrastructure deployed; source verification pending";
  writeJsonAtomically(manifestPath, manifest);
  partial.status = "deployed-awaiting-source-verification";
  partial.seed = { address: seedPlan.address, initCodeHash: seedPlan.initCodeHash, status: "confirmed", runtimeCodeHash: seedRecord.runtimeCodeHash };
  partial.hookFactory = { address: hookPlan.address, initCodeHash: hookPlan.initCodeHash, status: "confirmed", runtimeCodeHash: hookRecord.runtimeCodeHash };
  writeJsonAtomically(partialPath, partial);

  await verifySources(manifest, seedPlan.address, hookPlan.address);
  if (
    manifest.contracts.find((item) => item.name === SEED_NAME)?.sourceVerification === "verified" &&
    manifest.contracts.find((item) => item.name === HOOK_FACTORY_NAME)?.sourceVerification === "verified"
  ) {
    manifest.status = "Separate Ethereum-only and Multichain V4 infrastructure deployed and source verified";
    writeJsonAtomically(manifestPath, manifest);
  }
  fs.rmSync(partialPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ...report,
    status: "deployed",
    sourceVerification: {
      jailMultiSeed: manifest.contracts.find((item) => item.name === SEED_NAME)?.sourceVerification,
      multichainHookFactory: manifest.contracts.find((item) => item.name === HOOK_FACTORY_NAME)?.sourceVerification,
    },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum Multichain infrastructure deployment failed"}\n`);
  process.exitCode = 1;
});
