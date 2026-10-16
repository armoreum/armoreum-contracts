const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  getCreate2Address,
  keccak256,
  toUtf8Bytes,
} = require("ethers");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CREATE2_ADDRESS = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const UUPS_UUID = IMPLEMENTATION_SLOT;
const MAX_RUNTIME_BYTES = 24_576;
const VERIFIED_LIVE_VAULT_FACTORY_RUNTIME_HASH =
  "0x4b50415b3364b04810d1e9374ced950103b439e77ec7824a7f88c7946df457c0";
const VERIFIED_LIVE_VAULT_FACTORY_SOURCE_SHA256 =
  "ee45e68a3bc5393e0080370f9b7c55d64bb58763b501ab92d3b6ce0e598922bc";
const VERIFIED_LIVE_VAULT_FACTORY_LAYOUT_HASH =
  "0xdc69d20971bbc79b56a8756e850d8b107a19bd8c738fb8d170ec95427e9775dd";
const MODE_LABELS = {
  0: "Ethereum-only",
  1: "Ethereum Multichain",
  2: "Robinhood Pons-only",
  3: "Robinhood Multichain Pons leg",
};

const FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function approvedTaxSources(address) view returns(bool)",
  "function multichainLaunchModule() view returns(address)",
];
const VAULT_FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function launchFactory() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function upgradeToAndCall(address,bytes)",
  "function taxSourceModePolicy() view returns(address)",
  "function setTaxSourceModePolicy(address)",
  "function taxSourceModePolicyVersion() view returns(uint256)",
];
const MODE_MODULE_ABI = [
  "function setTaxSourceModeApprovals(address,uint8[],address[],bool[])",
  "function isTaxSourceApprovedForMode(address,uint8,address) view returns(bool)",
];

function writeJsonAtomically(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function readPonsFactoryFromApiConfig(packageRoot) {
  const sourcePath = path.resolve(packageRoot, "../api-zod/src/network-config.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const block = source.match(
    /export const PONS_V2_CONTRACTS\s*=\s*\{([\s\S]*?)\n\}\s*(?:as const)?\s*;/,
  );
  const factory = block?.[1].match(/\bfactory:\s*["'](0x[\da-f]{40})["']/i)?.[1];
  if (!factory) throw new Error("Could not read the configured Pons V2 factory address.");
  return getAddress(factory);
}

function modePairsForNetwork(chainId, manifest, packageRoot) {
  if (chainId === 1) {
    const ethereumOnly = manifest.externalIntegrations?.ethereumTaxRoutingSource;
    const ethereumMultichain =
      manifest.externalIntegrations?.ethereumMultichainTaxRoutingSource;
    if (!ethereumOnly || !ethereumMultichain) {
      throw new Error("Ethereum manifest is missing its mode-specific HookFactory addresses.");
    }
    return [
      { mode: 0, source: getAddress(ethereumOnly), approved: true },
      { mode: 1, source: getAddress(ethereumMultichain), approved: true },
      { mode: 0, source: getAddress(ethereumMultichain), approved: false },
      { mode: 1, source: getAddress(ethereumOnly), approved: false },
    ];
  }

  const ponsFactory = readPonsFactoryFromApiConfig(packageRoot);
  const previousManifestSource = manifest.externalIntegrations?.ponsTaxRoutingSource;
  const pairs = [
    { mode: 2, source: ponsFactory, approved: true },
    { mode: 3, source: ponsFactory, approved: true },
  ];
  if (
    previousManifestSource &&
    getAddress(previousManifestSource) !== ponsFactory
  ) {
    pairs.push(
      { mode: 2, source: getAddress(previousManifestSource), approved: false },
      { mode: 3, source: getAddress(previousManifestSource), approved: false },
    );
  }
  return pairs;
}

function declarationName(node, wantedId) {
  if (!node || typeof node !== "object") return undefined;
  if (
    node.id === Number(wantedId) &&
    node.nodeType === "VariableDeclaration"
  ) {
    return node.name;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = declarationName(child, wantedId);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = declarationName(value, wantedId);
      if (found) return found;
    }
  }
  return undefined;
}

function compiledRuntimeAtAddress(build, sourceName, contractName, address) {
  const output = build.output.contracts?.[sourceName]?.[contractName];
  if (!output) throw new Error(`Build is missing ${sourceName}:${contractName}.`);
  let runtime = output.evm.deployedBytecode.object;
  for (const [variableId, references] of Object.entries(
    output.evm.deployedBytecode.immutableReferences ?? {},
  )) {
    const name = Object.values(build.output.sources)
      .map((source) => declarationName(source.ast, variableId))
      .find(Boolean);
    if (name !== "__self") {
      throw new Error(`Unexpected ${contractName} immutable: ${name || variableId}.`);
    }
    for (const reference of references) {
      if (reference.length !== 32) {
        throw new Error(`Unexpected ${contractName} immutable width.`);
      }
      const encodedAddress = address.slice(2).toLowerCase().padStart(64, "0");
      const start = reference.start * 2;
      runtime = runtime.slice(0, start) + encodedAddress + runtime.slice(start + 64);
    }
  }
  return `0x${runtime}`;
}

function canonicalStorageLayout(layout) {
  function shape(typeId) {
    const type = layout.types[typeId];
    return {
      label: type.label,
      encoding: type.encoding,
      bytes: type.numberOfBytes,
      ...(type.base ? { base: shape(type.base) } : {}),
      ...(type.key ? { key: shape(type.key) } : {}),
      ...(type.value ? { value: shape(type.value) } : {}),
      ...(type.members
        ? {
            members: type.members.map((member) => ({
              label: member.label,
              slot: member.slot,
              offset: member.offset,
              type: shape(member.type),
            })),
          }
        : {}),
    };
  }
  return JSON.stringify(
    layout.storage.map((entry) => ({
      label: entry.label,
      slot: entry.slot,
      offset: entry.offset,
      type: shape(entry.type),
    })),
  );
}

async function cappedGasPrice(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Mainnet base fee unavailable; refusing to submit.");
  }
  const cap = (block.baseFeePerGas * 120n + 99n) / 100n;
  const rpcQuote = BigInt(await provider.send("eth_gasPrice", []));
  if (rpcQuote > cap) {
    throw new Error("RPC gas quote exceeds base fee + 20%; retry when fees fall.");
  }
  return cap;
}

async function planCreate2({
  provider,
  signerAddress,
  artifact,
  runtimeAt,
  name,
  stateFile,
  manifest,
  create2Deployer,
}) {
  if (!/^0x[\da-f]+$/i.test(artifact.bytecode)) {
    throw new Error(`${name} init code is unresolved.`);
  }
  const initCode = artifact.bytecode;
  const initCodeHash = keccak256(initCode);
  const mined = await mineVanitySalt({
    deployer: create2Deployer,
    initCode,
    stateFile,
    maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
  });
  const address = getAddress(
    getCreate2Address(create2Deployer, mined.salt, initCodeHash),
  );
  if (
    address.toLowerCase() !== mined.address.toLowerCase() ||
    !address.toLowerCase().startsWith(PREFIX)
  ) {
    throw new Error(`${name} CREATE2 address did not match its saved vanity search.`);
  }

  const runtimeCode = runtimeAt(address);
  const runtimeBytes = (runtimeCode.length - 2) / 2;
  if (runtimeBytes > MAX_RUNTIME_BYTES) {
    throw new Error(`${name} runtime is ${runtimeBytes} bytes; the EVM limit is 24,576.`);
  }
  const expectedRuntimeHash = keccak256(runtimeCode);
  const existingCode = await provider.getCode(address);
  if (existingCode !== "0x") {
    if (keccak256(existingCode).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
      throw new Error(`${name} target address is occupied by different bytecode.`);
    }
    return {
      name,
      address,
      salt: mined.salt,
      initCodeHash,
      initCode,
      deployData: null,
      estimatedGas: 0n,
      gasLimit: 0n,
      expectedRuntimeHash,
      runtimeBytes,
      alreadyDeployed: true,
    };
  }

  const deployData = encodeCreate2Deployment(mined.salt, initCode);
  const fee = await cappedGasPrice(provider);
  const request = {
    from: signerAddress,
    to: create2Deployer,
    data: deployData,
    gasPrice: fee,
  };
  const estimatedGas = await provider.estimateGas(request);
  const gasLimit = (estimatedGas * 120n + 99n) / 100n;
  await provider.call({ ...request, gasLimit });
  const priorRecord = manifest.contracts.find(
    (item) => item.name === name && item.address.toLowerCase() === address.toLowerCase(),
  );
  if (priorRecord && priorRecord.runtimeCodeHash?.toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error(`${name} has a manifest record with a different runtime hash.`);
  }
  return {
    name,
    address,
    salt: mined.salt,
    initCodeHash,
    initCode,
    deployData,
    estimatedGas,
    gasLimit,
    expectedRuntimeHash,
    runtimeBytes,
    alreadyDeployed: false,
  };
}

async function sendCreate2Deployment(provider, signer, deployment) {
  if (deployment.alreadyDeployed) return null;
  const fee = await cappedGasPrice(provider);
  const gas = deployment.gasLimit;
  const tx = await signer.sendTransaction({
    to: CREATE2_ADDRESS,
    data: deployment.deployData,
    gasPrice: fee,
    gasLimit: gas,
  });
  console.log(`${deployment.name} deployment sent: ${tx.hash}`);
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${deployment.name} deployment failed: ${tx.hash}`);
  }
  const code = await provider.getCode(deployment.address);
  if (keccak256(code).toLowerCase() !== deployment.expectedRuntimeHash.toLowerCase()) {
    throw new Error(`${deployment.name} runtime does not match the compiled bytecode.`);
  }
  return { transactionHash: tx.hash, blockNumber: receipt.blockNumber };
}

async function sendMethod(provider, contract, methodName, args, name) {
  const method = contract.getFunction(methodName);
  await method.staticCall(...args);
  const estimate = await method.estimateGas(...args);
  const gasLimit = (estimate * 120n + 99n) / 100n;
  const tx = await method(...args, {
    gasPrice: await cappedGasPrice(provider),
    gasLimit,
  });
  console.log(`${name} sent: ${tx.hash}`);
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${name} failed: ${tx.hash}`);
  }
  return {
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
    estimatedGas: String(estimate),
    gasLimit: String(gasLimit),
  };
}

function recordContract(manifest, name, deployment, transaction) {
  const previous = manifest.contracts.find(
    (item) =>
      item.name === name &&
      item.address.toLowerCase() === deployment.address.toLowerCase(),
  );
  const record = {
    name,
    address: deployment.address,
    salt: deployment.salt,
    deployer: CREATE2_ADDRESS,
    initCodeHash: deployment.initCodeHash,
    runtimeCodeHash: deployment.expectedRuntimeHash,
    transactionHash: transaction?.transactionHash ?? previous?.transactionHash ?? null,
    blockNumber: transaction?.blockNumber ?? previous?.blockNumber ?? null,
    sourceVerification: "pending",
  };
  const existingIndex = manifest.contracts.findIndex(
    (item) => item.name === name && item.address.toLowerCase() === deployment.address.toLowerCase(),
  );
  if (existingIndex >= 0) manifest.contracts[existingIndex] = record;
  else manifest.contracts.push(record);
  return record;
}

async function verifySource(address, contract, manifest, recordName) {
  const record = manifest.contracts.find(
    (item) => item.name === recordName && item.address.toLowerCase() === address.toLowerCase(),
  );
  if (!record) return;
  try {
    await hre.run("verify:verify", {
      address,
      contract,
      constructorArguments: [],
    });
    record.sourceVerification = "verified";
  } catch (error) {
    record.sourceVerification = "pending";
    record.sourceVerificationNote =
      error instanceof Error ? error.message.slice(0, 500) : "Explorer verification failed.";
    console.warn(`${recordName} source verification remains pending.`);
  }
}

async function main() {
  const chainId = Number(hre.network.config.chainId);
  if (chainId !== 1 && chainId !== 4663) {
    throw new Error("Run this script only with --network ethereum or --network robinhood.");
  }
  const networkName = chainId === 1 ? "ethereum" : "robinhood";
  const confirmation = `I confirm Armoreum launch-mode policy setup on ${networkName} mainnet chain ${chainId}`;
  const execute =
    process.argv.includes("--execute") ||
    process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  if (
    execute &&
    (
      process.env.ARMOREUM_DEPLOY_BROADCAST !== "YES" ||
      process.env.ARMOREUM_MODE_POLICY_CONFIRMATION !== confirmation
    )
  ) {
    throw new Error(`Broadcast requires the exact confirmation: ${confirmation}`);
  }

  const packageRoot = path.join(__dirname, "..");
  const manifestPath = path.join(packageRoot, "deployments", `${chainId}.json`);
  const progressPath = path.join(
    packageRoot,
    "deployments",
    `${chainId}.launch-mode-policy.partial.json`,
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rpcUrl = chainId === 1
    ? process.env.ALCHEMY_ETHEREUM_RPC_URL
    : process.env.ALCHEMY_ROBINHOOD_RPC_URL;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    throw new Error("Configured mainnet RPC or authorized deployer is missing.");
  }

  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  try {
    if ((await provider.getNetwork()).chainId !== BigInt(chainId)) {
      throw new Error("RPC chain ID does not match the selected mainnet.");
    }
    const signer = new Wallet(privateKey, provider);
    const factoryAddress = getAddress(manifest.multichainCore?.factoryProxy);
    const vaultFactoryAddress = getAddress(manifest.multichainCore?.vaultFactoryProxy);
    const create2Deployer = getAddress(manifest.externalIntegrations?.create2Deployer?.address);
    if (
      !factoryAddress || !vaultFactoryAddress || !create2Deployer ||
      create2Deployer !== CREATE2_ADDRESS
    ) {
      throw new Error("Deployment manifest is missing the registered mainnet core addresses.");
    }
    const create2Code = await provider.getCode(create2Deployer);
    if (
      create2Code === "0x" ||
      keccak256(create2Code).toLowerCase() !==
        manifest.externalIntegrations.create2Deployer.runtimeCodeHash.toLowerCase()
    ) {
      throw new Error("CREATE2 deployer code does not match the registered mainnet contract.");
    }

    const factory = new Contract(factoryAddress, FACTORY_ABI, signer);
    const vaultFactory = new Contract(vaultFactoryAddress, VAULT_FACTORY_ABI, signer);
    const [canonicalOwner, factoryAdmin, vaultFactoryOwner, vaultFactoryLink, upgraderRole] =
      await Promise.all([
        factory.canonicalOwner(),
        factory.hasRole(ZeroHash, signer.address),
        vaultFactory.canonicalOwner(),
        vaultFactory.launchFactory(),
        keccak256(toUtf8Bytes("UPGRADER_ROLE")),
      ]);
    if (
      getAddress(canonicalOwner) !== signer.address ||
      getAddress(vaultFactoryOwner) !== signer.address ||
      getAddress(vaultFactoryLink) !== factoryAddress ||
      !factoryAdmin ||
      !(await vaultFactory.hasRole(upgraderRole, signer.address))
    ) {
      throw new Error("Configured deployer does not hold the required factory and VaultFactory roles.");
    }

    const sourcePairs = modePairsForNetwork(chainId, manifest, packageRoot);
    for (const pair of sourcePairs.filter((item) => item.approved)) {
      const [sourceCode, sourceApproved] = await Promise.all([
        provider.getCode(pair.source),
        factory.approvedTaxSources(pair.source),
      ]);
      if (sourceCode === "0x" || !sourceApproved) {
        throw new Error(
          `${MODE_LABELS[pair.mode]} tax source ${pair.source} is not deployed and globally approved.`,
        );
      }
    }

    const moduleArtifact = await hre.artifacts.readArtifact("ArmoreumLaunchModeModule");
    const vaultFactoryArtifact = await hre.artifacts.readArtifact("VaultFactory");
    const moduleBuild = await hre.artifacts.getBuildInfo(
      `${moduleArtifact.sourceName}:${moduleArtifact.contractName}`,
    );
    const vaultFactoryBuild = await hre.artifacts.getBuildInfo(
      `${vaultFactoryArtifact.sourceName}:${vaultFactoryArtifact.contractName}`,
    );
    if (!moduleBuild || !vaultFactoryBuild) throw new Error("Current compiler build information is missing.");
    for (const [sourceName, source] of Object.entries(vaultFactoryBuild.input.sources)) {
      if (!sourceName.startsWith("contracts/")) continue;
      const localPath = path.join(packageRoot, sourceName);
      if (fs.existsSync(localPath) && fs.readFileSync(localPath, "utf8") !== source.content) {
        throw new Error(`Compiled VaultFactory artifact is stale for ${sourceName}.`);
      }
    }

    const moduleRuntime = `0x${moduleBuild.output.contracts[moduleArtifact.sourceName][moduleArtifact.contractName].evm.deployedBytecode.object}`;
    const moduleDeployment = await planCreate2({
      provider,
      signerAddress: signer.address,
      artifact: moduleArtifact,
      runtimeAt: () => moduleRuntime,
      name: "ArmoreumLaunchModeModule",
      stateFile: path.join(packageRoot, "deployments", "launch-mode-module.vanity.json"),
      manifest,
      create2Deployer,
    });

    const activeVaultFactoryImplementationWord = await provider.getStorage(
      vaultFactoryAddress,
      IMPLEMENTATION_SLOT,
    );
    const activeVaultFactoryImplementation = getAddress(
      `0x${activeVaultFactoryImplementationWord.slice(-40)}`,
    );
    const activeVaultFactoryCode = await provider.getCode(activeVaultFactoryImplementation);
    if (activeVaultFactoryCode === "0x") {
      throw new Error("The live VaultFactory implementation has no runtime code.");
    }

    let activeBuild;
    for (const file of fs.readdirSync(path.join(packageRoot, "artifacts", "build-info"))) {
      if (!file.endsWith(".json")) continue;
      const candidate = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "artifacts", "build-info", file), "utf8"),
      );
      const candidateOutput =
        candidate.output?.contracts?.[vaultFactoryArtifact.sourceName]?.[vaultFactoryArtifact.contractName];
      if (!candidateOutput?.storageLayout) continue;
      const candidateRuntime = compiledRuntimeAtAddress(
        candidate,
        vaultFactoryArtifact.sourceName,
        vaultFactoryArtifact.contractName,
        activeVaultFactoryImplementation,
      );
      if (keccak256(candidateRuntime).toLowerCase() === keccak256(activeVaultFactoryCode).toLowerCase()) {
        activeBuild = candidate;
        break;
      }
    }
    const currentLayout =
      vaultFactoryBuild.output.contracts[vaultFactoryArtifact.sourceName][vaultFactoryArtifact.contractName].storageLayout;
    if (!currentLayout) throw new Error("Current VaultFactory storage layout is missing.");
    const compatibleStoragePrefix = {
      types: currentLayout.types,
      storage: currentLayout.storage.slice(0, 24),
    };
    const currentStoragePrefixHash = keccak256(
      toUtf8Bytes(canonicalStorageLayout(compatibleStoragePrefix)),
    );
    if (
      currentLayout.storage.length !== 25 ||
      currentLayout.storage[24]?.label !== "taxSourceModePolicy" ||
      currentStoragePrefixHash.toLowerCase() !==
        VERIFIED_LIVE_VAULT_FACTORY_LAYOUT_HASH.toLowerCase()
    ) {
      throw new Error("VaultFactory changes must append only the authorized policy pointer slot.");
    }
    let storageLayoutCompatible = false;
    if (activeBuild) {
      const activeLayout =
        activeBuild.output.contracts[vaultFactoryArtifact.sourceName][vaultFactoryArtifact.contractName].storageLayout;
      storageLayoutCompatible = Boolean(
        activeLayout &&
        canonicalStorageLayout(compatibleStoragePrefix) === canonicalStorageLayout(activeLayout),
      );
    } else {
      const activeRecord = manifest.contracts.find(
        (item) =>
          item.name === "VaultFactory-implementation" &&
          item.address.toLowerCase() === activeVaultFactoryImplementation.toLowerCase(),
      );
      const liveRuntimeHash = keccak256(activeVaultFactoryCode);
      storageLayoutCompatible =
        liveRuntimeHash.toLowerCase() === VERIFIED_LIVE_VAULT_FACTORY_RUNTIME_HASH.toLowerCase() &&
        activeRecord?.runtimeCodeHash?.toLowerCase() === liveRuntimeHash.toLowerCase() &&
        activeRecord?.verifiedSourceSha256 === VERIFIED_LIVE_VAULT_FACTORY_SOURCE_SHA256 &&
        activeRecord?.storageLayoutHash?.toLowerCase() === VERIFIED_LIVE_VAULT_FACTORY_LAYOUT_HASH.toLowerCase() &&
        Number(activeRecord?.sourceAttestationChainId) === 1 &&
        currentStoragePrefixHash.toLowerCase() === VERIFIED_LIVE_VAULT_FACTORY_LAYOUT_HASH.toLowerCase();
    }
    if (!storageLayoutCompatible) {
      throw new Error("New VaultFactory storage layout differs from the live implementation.");
    }

    const implementationRuntimeAt = (address) =>
      compiledRuntimeAtAddress(
        vaultFactoryBuild,
        vaultFactoryArtifact.sourceName,
        vaultFactoryArtifact.contractName,
        address,
      );
    const vaultFactoryImplementationDeployment = await planCreate2({
      provider,
      signerAddress: signer.address,
      artifact: vaultFactoryArtifact,
      runtimeAt: implementationRuntimeAt,
      name: "VaultFactory-mode-policy-implementation",
      stateFile: path.join(packageRoot, "deployments", "vaultfactory-tax-policy.vanity.json"),
      manifest,
      create2Deployer,
    });

    const baseFee = await cappedGasPrice(provider);
    const conservativeGasBudget =
      moduleDeployment.gasLimit +
      vaultFactoryImplementationDeployment.gasLimit +
      1_500_000n;
    const requiredBalance =
      (conservativeGasBudget * baseFee * 125n + 99n) / 100n;
    const signerBalance = await provider.getBalance(signer.address);
    const currentModule = getAddress(await factory.multichainLaunchModule());
    const currentPolicy = await vaultFactory
      .taxSourceModePolicy()
      .catch(() => "0x0000000000000000000000000000000000000000");
    const currentPolicyVersion = await vaultFactory
      .taxSourceModePolicyVersion()
      .catch(() => 0n);

    console.log(JSON.stringify({
      network: networkName,
      chainId,
      mode: execute ? "execute" : "read-only preflight",
      signer: signer.address,
      factory: factoryAddress,
      vaultFactory: vaultFactoryAddress,
      currentFactoryModule: currentModule,
      currentTaxSourceModePolicy: currentPolicy,
      newPolicyModule: moduleDeployment.address,
      activeVaultFactoryImplementation,
      newVaultFactoryImplementation: vaultFactoryImplementationDeployment.address,
      storageLayoutCompatible: true,
      currentPolicyVersion: String(currentPolicyVersion),
      modePairs: sourcePairs.map((pair) => ({
        mode: pair.mode,
        label: MODE_LABELS[pair.mode],
        source: pair.source,
        approved: pair.approved,
      })),
      deploymentGas: {
        policyModule: String(moduleDeployment.estimatedGas),
        vaultFactoryImplementation: String(vaultFactoryImplementationDeployment.estimatedGas),
        gasPriceCapWei: String(baseFee),
        signerBalanceWei: String(signerBalance),
        conservativeRequiredBalanceWei: String(requiredBalance),
      },
      alreadyDeployed: {
        policyModule: moduleDeployment.alreadyDeployed,
        vaultFactoryImplementation: vaultFactoryImplementationDeployment.alreadyDeployed,
      },
    }, null, 2));

    if (!execute) return;
    if (signerBalance < requiredBalance) {
      throw new Error("Deployer balance is below the conservative transaction budget.");
    }

    const progress = fs.existsSync(progressPath)
      ? JSON.parse(fs.readFileSync(progressPath, "utf8"))
      : {};
    const moduleDeploymentTx = await sendCreate2Deployment(
      provider,
      signer,
      moduleDeployment,
    );
    const moduleTransaction = moduleDeploymentTx ?? progress.policyModule ?? null;
    recordContract(manifest, "ArmoreumLaunchModeModule", moduleDeployment, moduleTransaction);
    progress.policyModule = moduleTransaction;
    writeJsonAtomically(progressPath, progress);

    const modeModule = new Contract(moduleDeployment.address, MODE_MODULE_ABI, signer);
    const pairStates = await Promise.all(sourcePairs.map(async (pair) => ({
      ...pair,
      current: await modeModule.isTaxSourceApprovedForMode(
        factoryAddress,
        pair.mode,
        pair.source,
      ),
    })));
    const pairsToSet = pairStates.filter((pair) => pair.current !== pair.approved);
    if (pairsToSet.length) {
      const result = await sendMethod(
        provider,
        modeModule,
        "setTaxSourceModeApprovals",
        [
          factoryAddress,
          pairsToSet.map((pair) => pair.mode),
          pairsToSet.map((pair) => pair.source),
          pairsToSet.map((pair) => pair.approved),
        ],
        "Mode/source policy configuration",
      );
      progress.modePolicy = result;
      writeJsonAtomically(progressPath, progress);
    }
    for (const pair of sourcePairs) {
      const current = await modeModule.isTaxSourceApprovedForMode(
        factoryAddress,
        pair.mode,
        pair.source,
      );
      if (current !== pair.approved) {
        throw new Error(`Mode/source policy verification failed for mode ${pair.mode}.`);
      }
    }

    if (getAddress(await factory.multichainLaunchModule()) !== currentModule) {
      throw new Error("The existing Multichain launch-module pointer changed unexpectedly.");
    }

    const implementationDeploymentTx = await sendCreate2Deployment(
      provider,
      signer,
      vaultFactoryImplementationDeployment,
    );
    const implementationTransaction =
      implementationDeploymentTx ?? progress.vaultFactoryImplementation ?? null;
    const implementationAddress = vaultFactoryImplementationDeployment.address;
    const implementationCode = await provider.getCode(implementationAddress);
    if (
      keccak256(implementationCode).toLowerCase() !==
      vaultFactoryImplementationDeployment.expectedRuntimeHash.toLowerCase()
    ) {
      throw new Error("New VaultFactory implementation runtime hash is incorrect.");
    }
    const implementation = new Contract(
      implementationAddress,
      ["function proxiableUUID() view returns(bytes32)"],
      provider,
    );
    if ((await implementation.proxiableUUID()).toLowerCase() !== UUPS_UUID.toLowerCase()) {
      throw new Error("New VaultFactory implementation is not a compatible UUPS target.");
    }
    recordContract(
      manifest,
      "VaultFactory-mode-policy-implementation",
      vaultFactoryImplementationDeployment,
      implementationTransaction,
    );
    progress.vaultFactoryImplementation = implementationTransaction;
    writeJsonAtomically(progressPath, progress);

    const liveImplementationWord = await provider.getStorage(
      vaultFactoryAddress,
      IMPLEMENTATION_SLOT,
    );
    const liveImplementation = getAddress(`0x${liveImplementationWord.slice(-40)}`);
    if (liveImplementation !== implementationAddress) {
      const setPolicyCallData = vaultFactory.interface.encodeFunctionData(
        "setTaxSourceModePolicy",
        [moduleDeployment.address],
      );
      const upgrade = await sendMethod(
        provider,
        vaultFactory,
        "upgradeToAndCall",
        [implementationAddress, setPolicyCallData],
        "VaultFactory UUPS upgrade and one-time policy binding",
      );
      progress.vaultFactoryUpgrade = upgrade;
      writeJsonAtomically(progressPath, progress);
    }

    const [
      finalImplementationWord,
      policyVersion,
      finalFactoryLink,
      finalModulePointer,
      finalPolicyAddress,
      finalPairs,
    ] = await Promise.all([
      provider.getStorage(vaultFactoryAddress, IMPLEMENTATION_SLOT),
      vaultFactory.taxSourceModePolicyVersion(),
      vaultFactory.launchFactory(),
      factory.multichainLaunchModule(),
      vaultFactory.taxSourceModePolicy(),
      Promise.all(sourcePairs.map((pair) =>
        modeModule.isTaxSourceApprovedForMode(factoryAddress, pair.mode, pair.source),
      )),
    ]);
    if (
      getAddress(`0x${finalImplementationWord.slice(-40)}`) !== implementationAddress ||
      BigInt(policyVersion) !== 1n ||
      getAddress(finalFactoryLink) !== factoryAddress ||
      getAddress(finalModulePointer) !== currentModule ||
      getAddress(finalPolicyAddress) !== moduleDeployment.address ||
      finalPairs.some((value, index) => value !== sourcePairs[index].approved)
    ) {
      throw new Error("Post-upgrade live state verification failed.");
    }

    const priorImplementation = manifest.contracts.find(
      (item) =>
        item.name === "VaultFactory-implementation" &&
        item.address.toLowerCase() !== implementationAddress.toLowerCase(),
    );
    if (priorImplementation) priorImplementation.name = "VaultFactory-implementation-before-mode-policy";
    recordContract(
      manifest,
      "ArmoreumLaunchModeModule",
      moduleDeployment,
      moduleTransaction,
    );
    manifest.vaultFactory.implementation = implementationAddress;
    manifest.launchModePolicy = {
      version: 1,
      enforcedBy: "VaultFactory",
      module: moduleDeployment.address,
      sources: Object.fromEntries(
        sourcePairs.filter((pair) => pair.approved)
          .map((pair) => [String(pair.mode), pair.source]),
      ),
      configuredAtBlock: (await provider.getBlockNumber()),
    };
    if (chainId === 4663) {
      manifest.externalIntegrations.ponsV2LaunchTaxSource =
        readPonsFactoryFromApiConfig(packageRoot);
    }
    await verifySource(
      moduleDeployment.address,
      "contracts/bridge/ArmoreumLaunchModeModule.sol:ArmoreumLaunchModeModule",
      manifest,
      "ArmoreumLaunchModeModule",
    );
    await verifySource(
      implementationAddress,
      "contracts/VaultFactory.sol:VaultFactory",
      manifest,
      "VaultFactory-mode-policy-implementation",
    );
    writeJsonAtomically(manifestPath, manifest);
    progress.complete = true;
    writeJsonAtomically(progressPath, progress);
    console.log(JSON.stringify({
      verified: true,
      network: networkName,
      chainId,
      policyModule: moduleDeployment.address,
      vaultFactoryImplementation: implementationAddress,
      policyVersion: String(policyVersion),
      sourceVerification: {
        modeModule: manifest.contracts.find((item) => item.name === "ArmoreumLaunchModeModule")?.sourceVerification,
        vaultFactory: manifest.contracts.find((item) => item.name === "VaultFactory-mode-policy-implementation")?.sourceVerification,
      },
      bridgeTransportActivated: manifest.multichainCore?.bridgeActivated === true,
      transactions: progress,
    }, null, 2));
  } finally {
    await provider.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
