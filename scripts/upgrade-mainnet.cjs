const fs = require("node:fs");
const path = require("node:path");
const {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  concat,
  getAddress,
  getCreate2Address,
  id,
  isAddress,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
} = require("ethers");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const TARGET = process.env.ARMOREUM_DEPLOY_TARGET;
if (!["ethereum", "robinhood"].includes(TARGET)) {
  throw new Error("ARMOREUM_DEPLOY_TARGET must be ethereum or robinhood");
}

const CONFIG = TARGET === "ethereum"
  ? {
      chainId: 1n,
      label: "Ethereum Mainnet",
      rpcKey: "ALCHEMY_ETHEREUM_RPC_URL",
      create2AddressKey: "ETHEREUM_CREATE2_DEPLOYER_ADDRESS",
      create2HashKey: "ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH",
      confirmationKey: "DEPLOY_ETHEREUM_MAINNET_CONFIRMATION",
      confirmation: "I confirm deployment to Ethereum mainnet chain 1",
    }
  : {
      chainId: 4663n,
      label: "Robinhood Chain Mainnet",
      rpcKey: "ALCHEMY_ROBINHOOD_RPC_URL",
      create2AddressKey: "CREATE2_DEPLOYER_ADDRESS",
      create2HashKey: "CREATE2_DEPLOYER_RUNTIME_CODE_HASH",
      confirmationKey: "DEPLOY_MAINNET_CONFIRMATION",
      confirmation: "I confirm deployment to Robinhood Chain 4663",
    };

const PACKAGE_ROOT = path.join(__dirname, "..");
const DEPLOYMENTS_DIR = path.join(PACKAGE_ROOT, "deployments");
const PROXY_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.ARMOREUM_DEPLOY_DRY_RUN === "1";
const COMPILER_OUTPUT_CACHE = new Map();

function readArtifact(relativePath) {
  const artifact = JSON.parse(
    fs.readFileSync(path.join(PACKAGE_ROOT, "artifacts", relativePath), "utf8"),
  );
  artifact.__relativePath = relativePath;
  return artifact;
}

function compilerOutputForArtifact(artifact) {
  const relativePath = artifact.__relativePath;
  if (!relativePath) throw new Error("Artifact path metadata is missing");
  if (COMPILER_OUTPUT_CACHE.has(relativePath)) {
    return COMPILER_OUTPUT_CACHE.get(relativePath);
  }
  const match = relativePath.match(/^(.+\.sol)\/([^/]+)\.json$/);
  if (!match) throw new Error(`Cannot locate compiler source for ${relativePath}`);
  const [, sourceName, contractName] = match;
  const targetBytecode = artifact.deployedBytecode
    .replace(/^0x/, "")
    .toLowerCase();
  const buildInfoDirectory = path.join(PACKAGE_ROOT, "artifacts", "build-info");
  const buildInfoFiles = fs.readdirSync(buildInfoDirectory).filter((name) => name.endsWith(".json"));
  for (const fileName of buildInfoFiles) {
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(buildInfoDirectory, fileName), "utf8"),
    );
    const contractOutput = buildInfo.output?.contracts?.[sourceName]?.[contractName];
    const deployedBytecode = contractOutput?.evm?.deployedBytecode;
    if (
      deployedBytecode?.object?.replace(/^0x/, "").toLowerCase() === targetBytecode
    ) {
      COMPILER_OUTPUT_CACHE.set(relativePath, contractOutput);
      return contractOutput;
    }
  }
  throw new Error(`Compiler output not found for ${relativePath}`);
}

function immutableReferencesForArtifact(artifact) {
  return compilerOutputForArtifact(artifact).evm.deployedBytecode.immutableReferences || {};
}

function storageSlotForArtifact(artifact, label) {
  const entry = compilerOutputForArtifact(artifact).storageLayout?.storage?.find(
    (item) => item.label === label,
  );
  if (!entry) throw new Error(`Storage slot ${label} not found in ${artifact.__relativePath}`);
  return BigInt(entry.slot);
}

const ACCESS_CONTROL_STORAGE_SLOT =
  "0x02dd7bc7dec4dceedda775e58dd541e08a116c6c53815c0bd028192f7b626800";
const ABI_CODER = AbiCoder.defaultAbiCoder();

function storageKey(slot) {
  return zeroPadValue(toBeHex(slot), 32);
}

function storageValue(value) {
  return zeroPadValue(value, 32);
}

function defaultAdminMemberStorageKey(account) {
  const defaultAdminRole = `0x${"00".repeat(32)}`;
  const roleDataSlot = keccak256(
    ABI_CODER.encode(
      ["bytes32", "bytes32"],
      [defaultAdminRole, ACCESS_CONTROL_STORAGE_SLOT],
    ),
  );
  return keccak256(
    ABI_CODER.encode(["address", "bytes32"], [account, roleDataSlot]),
  );
}

function jailTokenFactoryProxyOverride(plan, owner, includeAdminRole) {
  const proxy = plan.deployments.find(
    (item) => item.label === "JailTokenFactory-proxy-v1",
  );
  const implementation = plan.deployments.find(
    (item) => item.label === "JailTokenFactory-implementation-v1",
  );
  const jailToken = plan.deployments.find(
    (item) => item.label === "JailToken-implementation",
  );
  const receipt = plan.deployments.find(
    (item) => item.label === "JailETHReceipt-implementation",
  );
  const stateDiff = {
    [PROXY_IMPLEMENTATION_SLOT]: storageValue(implementation.address),
    [storageKey(storageSlotForArtifact(
      plan.jailTokenFactoryArtifact,
      "jailTokenImplementation",
    ))]: storageValue(jailToken.address),
    [storageKey(storageSlotForArtifact(
      plan.jailTokenFactoryArtifact,
      "jailEthImplementation",
    ))]: storageValue(receipt.address),
  };
  if (includeAdminRole) {
    stateDiff[defaultAdminMemberStorageKey(owner)] = storageValue("0x01");
  }
  return {
    [proxy.address]: {
      code: plan.proxyArtifact.deployedBytecode,
      stateDiff,
    },
    [implementation.address]: {
      code: runtimeCodeAtAddress(implementation.artifact, implementation.address),
    },
  };
}

function vaultFactoryConfigurationOverride(plan, owner) {
  const vaultImplementation = plan.deployments.find(
    (item) => item.label === "VaultFactory-implementation-v2",
  );
  const jailSwapVault = plan.deployments.find(
    (item) => item.label === "JailSwapVault-implementation",
  );
  const jailToken = plan.deployments.find(
    (item) => item.label === "JailToken-implementation",
  );
  const receipt = plan.deployments.find(
    (item) => item.label === "JailETHReceipt-implementation",
  );
  const overrides = jailTokenFactoryProxyOverride(plan, owner, false);
  overrides[plan.currentVaultProxy.address] = {
    stateDiff: {
      [PROXY_IMPLEMENTATION_SLOT]: storageValue(vaultImplementation.address),
    },
  };
  overrides[vaultImplementation.address] = {
    code: runtimeCodeAtAddress(vaultImplementation.artifact, vaultImplementation.address),
  };
  overrides[jailToken.address] = {
    code: runtimeCodeAtAddress(jailToken.artifact, jailToken.address),
  };
  overrides[receipt.address] = {
    code: runtimeCodeAtAddress(receipt.artifact, receipt.address),
  };
  overrides[jailSwapVault.address] = {
    code: runtimeCodeAtAddress(jailSwapVault.artifact, jailSwapVault.address),
  };
  return overrides;
}

function runtimeCodeAtAddress(artifact, address) {
  const normalizedAddress = getAddress(address).slice(2).toLowerCase();
  let code = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const references = immutableReferencesForArtifact(artifact);
  for (const reference of Object.values(references).flat()) {
    const start = reference.start * 2;
    const length = reference.length * 2;
    const replacement = reference.length === 32
      ? normalizedAddress.padStart(length, "0")
      : reference.length === 20
        ? normalizedAddress
        : null;
    if (!replacement || start + length > code.length) {
      throw new Error(`Unsupported immutable reference in ${artifact.__relativePath}`);
    }
    code = `${code.slice(0, start)}${replacement}${code.slice(start + length)}`;
  }
  return `0x${code}`;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function safeError(error) {
  const message =
    error?.info?.error?.message ||
    error?.error?.message ||
    error?.shortMessage ||
    error?.reason ||
    error?.message ||
    error?.code ||
    error?.name ||
    "unknown error";
  return String(message)
    .replace(/https?:\/\/[^\s"'`]+/gi, "[RPC endpoint redacted]")
    .replace(/(api[-_]?key|token|secret)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/\b0x[a-f0-9]{64}\b/gi, "[hex value redacted]");
}

function extractRevertData(error) {
  const candidates = [
    error?.data,
    error?.error?.data,
    error?.info?.error?.data,
    error?.cause?.data,
    error?.cause?.error?.data,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate : candidate?.data;
    if (typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value) && value.length > 2) {
      return value;
    }
  }
  return null;
}

function decodeRevertData(data, artifact) {
  if (!data) return null;
  const interfaces = [
    new Interface(artifact.abi),
    new Interface([
      "error Error(string)",
      "error Panic(uint256)",
      "error ERC1967InvalidImplementation(address)",
      "error UUPSUnauthorizedCallContext()",
      "error UUPSUnsupportedProxiableUUID(bytes32)",
    ]),
  ];
  for (const contractInterface of interfaces) {
    try {
      const parsed = contractInterface.parseError(data);
      if (parsed) return `${parsed.name}(${parsed.args.map(String).join(", ")})`;
    } catch {
      // Try the next known ABI.
    }
  }
  return null;
}

function recordByName(manifest, name) {
  return manifest.contracts.find((record) => record.name === name);
}

function needsCorePrefix(label) {
  // Every deployment in this runner is a shared core contract or implementation.
  // Per-token vault and receipt instances are created by these contracts later.
  return true;
}

function assertCorePrefix(label, address) {
  if (needsCorePrefix(label) && !address.toLowerCase().startsWith(PREFIX)) {
    throw new Error(`${label} did not receive the required ${PREFIX} core address`);
  }
}

function deploymentRecord(label, deployment, receipt, runtimeCodeHash) {
  return {
    name: label,
    address: deployment.address,
    salt: deployment.salt,
    deployer: deployment.deployer,
    initCodeHash: deployment.initCodeHash,
    runtimeCodeHash,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    sourceVerification: "pending",
  };
}

async function prepareDeployment(label, initCode, create2Address) {
  const initCodeHash = keccak256(initCode);
  let salt;
  if (needsCorePrefix(label)) {
    const result = await mineVanitySalt({
      deployer: create2Address,
      initCode,
      stateFile: path.join(
        DEPLOYMENTS_DIR,
        `${CONFIG.chainId}.vanity`,
        `${label}-${initCodeHash.slice(2, 10)}.json`,
      ),
      maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
    });
    salt = result.salt;
  } else {
    salt = keccak256(
      toUtf8Bytes(`${CONFIG.chainId}:${label}:${initCodeHash}`),
    );
  }
  const address = getCreate2Address(create2Address, salt, initCodeHash);
  assertCorePrefix(label, address);
  return {
    label,
    address,
    salt,
    deployer: create2Address,
    initCode,
    initCodeHash,
    data: encodeCreate2Deployment(salt, initCode),
  };
}

async function verifyRecordCode(provider, record, label) {
  if (!record?.address || !record.runtimeCodeHash) {
    throw new Error(`${label} is missing from the deployment registry`);
  }
  const code = await provider.getCode(record.address);
  if (code === "0x" || keccak256(code).toLowerCase() !== record.runtimeCodeHash.toLowerCase()) {
    throw new Error(`${label} does not match its registered onchain bytecode`);
  }
  return code;
}

async function currentImplementation(provider, proxyAddress) {
  const word = await provider.getStorage(proxyAddress, PROXY_IMPLEMENTATION_SLOT);
  return getAddress(`0x${word.slice(-40)}`);
}

async function makePlan(provider, manifest, owner, emergencyOperator, create2Address, progress) {
  const currentFactoryProxy = recordByName(manifest, "ArmoreumFactory-proxy");
  const currentVaultProxy = recordByName(manifest, "VaultFactory-proxy");
  let currentFactoryImplementation = recordByName(
    manifest,
    "ArmoreumFactory-implementation",
  );
  let currentVaultImplementation = recordByName(
    manifest,
    "VaultFactory-implementation",
  );
  await Promise.all([
    verifyRecordCode(provider, currentFactoryProxy, "ArmoreumFactory proxy"),
    verifyRecordCode(provider, currentVaultProxy, "VaultFactory proxy"),
  ]);

  const [factoryProxyImplementation, vaultProxyImplementation] = await Promise.all([
    currentImplementation(provider, currentFactoryProxy.address),
    currentImplementation(provider, currentVaultProxy.address),
  ]);
  const reconcileConfirmedUpgrade = async (
    liveImplementation,
    registryImplementation,
    upgradeName,
    deploymentName,
    label,
  ) => {
    if (liveImplementation.toLowerCase() === registryImplementation.address.toLowerCase()) {
      return registryImplementation;
    }
    const savedUpgrade = progress.upgrades[upgradeName];
    const savedDeployment = progress.deployments[deploymentName];
    const receipt = savedUpgrade?.transactionHash
      ? await provider.getTransactionReceipt(savedUpgrade.transactionHash)
      : null;
    if (
      !savedUpgrade
      || !savedDeployment
      || !receipt
      || receipt.status !== 1
      || savedUpgrade.implementation?.toLowerCase() !== liveImplementation.toLowerCase()
      || savedDeployment.address?.toLowerCase() !== liveImplementation.toLowerCase()
    ) {
      throw new Error(`${label} proxy implementation differs from its verified deployment registry`);
    }
    await verifyRecordCode(provider, savedDeployment, `${label} upgraded implementation`);
    return savedDeployment;
  };
  currentFactoryImplementation = await reconcileConfirmedUpgrade(
    factoryProxyImplementation,
    currentFactoryImplementation,
    "ArmoreumFactory",
    "ArmoreumFactory-implementation-v2",
    "ArmoreumFactory",
  );
  currentVaultImplementation = await reconcileConfirmedUpgrade(
    vaultProxyImplementation,
    currentVaultImplementation,
    "VaultFactory",
    "VaultFactory-implementation-v2",
    "VaultFactory",
  );
  await Promise.all([
    verifyRecordCode(provider, currentFactoryImplementation, "ArmoreumFactory implementation"),
    verifyRecordCode(provider, currentVaultImplementation, "VaultFactory implementation"),
  ]);

  const factoryArtifact = readArtifact("contracts/ArmoreumFactory.sol/ArmoreumFactory.json");
  const vaultArtifact = readArtifact("contracts/VaultFactory.sol/VaultFactory.json");
  const factory = new Contract(currentFactoryProxy.address, factoryArtifact.abi, provider);
  const vaultFactory = new Contract(currentVaultProxy.address, vaultArtifact.abi, provider);
  for (const [label, contract] of [["ArmoreumFactory", factory], ["VaultFactory", vaultFactory]]) {
    if ((await contract.canonicalOwner()).toLowerCase() !== owner.toLowerCase()) {
      throw new Error(`${label} canonical owner differs from the approved deployer`);
    }
    const role = await contract.UPGRADER_ROLE();
    if (!(await contract.hasRole(role, owner))) {
      throw new Error(`${label} does not grant the deployer the upgrade role`);
    }
  }
  if ((await vaultFactory.emergencyOperator()).toLowerCase() !== emergencyOperator.toLowerCase()) {
    throw new Error("VaultFactory emergency operator differs from its deployment registry");
  }
  if ((await factory.vaultFactory()).toLowerCase() !== currentVaultProxy.address.toLowerCase()) {
    throw new Error("ArmoreumFactory is not connected to the registered VaultFactory proxy");
  }

  const deploymentSpecs = [
    {
      label: "ArmoreumFactory-implementation-v2",
      artifact: factoryArtifact,
      core: true,
    },
    {
      label: "VaultFactory-implementation-v2",
      artifact: vaultArtifact,
      core: true,
    },
    {
      label: "CreatorRewardVault-password-implementation-v1",
      artifact: readArtifact("contracts/CreatorRewardVault.sol/CreatorRewardVault.json"),
      core: true,
    },
    {
      label: "TaxRouter-implementation-v2",
      artifact: readArtifact("contracts/TaxRouter.sol/TaxRouter.json"),
      core: true,
    },
    {
      label: "JailToken-implementation",
      artifact: readArtifact("contracts/JailReceiptToken.sol/JailToken.json"),
      core: true,
    },
    {
      label: "JailETHReceipt-implementation",
      artifact: readArtifact("contracts/JailReceiptToken.sol/JailETHReceipt.json"),
      core: true,
    },
    {
      label: "JailTokenFactory-implementation-v1",
      artifact: readArtifact("contracts/JailTokenFactory.sol/JailTokenFactory.json"),
      core: true,
    },
    {
      label: "JailSwapVault-implementation",
      artifact: readArtifact("contracts/JailSwapVault.sol/JailSwapVault.json"),
      core: true,
    },
  ];
  const deployments = [];
  for (const spec of deploymentSpecs) {
    const deployment = await prepareDeployment(
      spec.label,
      spec.artifact.bytecode,
      create2Address,
    );
    if (spec.core !== needsCorePrefix(spec.label)) {
      throw new Error(`Core-prefix policy mismatch for ${spec.label}`);
    }
    deployments.push({ ...deployment, artifact: spec.artifact });
  }

  const byLabel = Object.fromEntries(deployments.map((item) => [item.label, item]));
  const jailTokenFactoryArtifact = deploymentSpecs.find(
    (item) => item.label === "JailTokenFactory-implementation-v1",
  ).artifact;
  const initializer = jailTokenFactoryArtifact.abi;
  const jailTokenFactory = new ContractFactory(initializer, jailTokenFactoryArtifact.bytecode);
  const jailTokenFactoryInterface = jailTokenFactory.interface;
  const initializeData = jailTokenFactoryInterface.encodeFunctionData(
    "initializeWithJailEth",
    [
      owner,
      owner,
      byLabel["JailToken-implementation"].address,
      byLabel["JailETHReceipt-implementation"].address,
    ],
  );
  const proxyArtifact = readArtifact(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json",
  );
  const proxyFactory = new ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode);
  const proxyInitCode = concat([
    proxyFactory.bytecode,
    require("ethers").AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes"],
      [byLabel["JailTokenFactory-implementation-v1"].address, initializeData],
    ),
  ]);
  const jailTokenFactoryProxy = await prepareDeployment(
    "JailTokenFactory-proxy-v1",
    proxyInitCode,
    create2Address,
  );
  deployments.push({
    ...jailTokenFactoryProxy,
    artifact: proxyArtifact,
    proxy: true,
    initializationData: initializeData,
    initializationSelector: initializeData.slice(0, 10),
    estimationStateOverride: {
      [byLabel["JailTokenFactory-implementation-v1"].address]: {
        code: runtimeCodeAtAddress(
          jailTokenFactoryArtifact,
          byLabel["JailTokenFactory-implementation-v1"].address,
        ),
      },
      [byLabel["JailToken-implementation"].address]: {
        code: runtimeCodeAtAddress(
          deploymentSpecs.find((item) => item.label === "JailToken-implementation").artifact,
          byLabel["JailToken-implementation"].address,
        ),
      },
      [byLabel["JailETHReceipt-implementation"].address]: {
        code: runtimeCodeAtAddress(
          deploymentSpecs.find((item) => item.label === "JailETHReceipt-implementation").artifact,
          byLabel["JailETHReceipt-implementation"].address,
        ),
      },
    },
    estimationProbeTargets: [
      {
        label: "JailToken-implementation",
        address: byLabel["JailToken-implementation"].address,
      },
      {
        label: "JailETHReceipt-implementation",
        address: byLabel["JailETHReceipt-implementation"].address,
      },
    ],
  });
  return {
    deployments,
    currentFactoryProxy,
    currentVaultProxy,
    currentFactoryImplementation,
    currentVaultImplementation,
    factoryArtifact,
    vaultArtifact,
    jailTokenFactoryArtifact,
    proxyArtifact,
  };
}

async function estimateDeployment(provider, signerAddress, deployment, progress) {
  const code = await provider.getCode(deployment.address);
  if (code !== "0x") {
    const saved = progress.deployments[deployment.label];
    if (!saved || keccak256(code).toLowerCase() !== saved.runtimeCodeHash.toLowerCase()) {
      throw new Error(`${deployment.label} predicted address has unregistered or mismatched code`);
    }
    return { gasEstimate: 0n, gasLimit: 0n, alreadyDeployed: true };
  }
  if (process.env.ARMOREUM_TRACE_DEPLOY_CALLS === "1") {
    try {
      await provider.estimateGas({
        from: signerAddress,
        to: deployment.deployer,
        data: deployment.data,
      });
    } catch (error) {
      const revertData = extractRevertData(error);
      const detail = {
        chainId: CONFIG.chainId.toString(),
        targetAddress: deployment.deployer,
        target: "CREATE2 deployment helper",
        functionSelector: "none; raw salt || initCode payload",
        deploymentLabel: deployment.label,
        innerConstructor: deployment.proxy ? "ERC1967Proxy" : null,
        initializationFunctionSelector: deployment.initializationSelector || null,
        predictedImplementationAddress: deployment.proxy
          ? Object.keys(deployment.estimationStateOverride || {})[0] || null
          : null,
        error: safeError(error),
        revertData: revertData || "not returned by RPC",
        decodedRevert: decodeRevertData(revertData, deployment.artifact) || "unavailable",
      };
      process.stderr.write(`${JSON.stringify({ failedSimulationCall: detail }, null, 2)}\n`);
      throw new Error(`${deployment.label} traced CREATE2 simulation reverted`);
    }
  }
  let estimate;
  try {
    const tx = {
      from: signerAddress,
      to: deployment.deployer,
      data: deployment.data,
    };
    estimate = deployment.estimationStateOverride
      ? BigInt(await provider.send("eth_estimateGas", [
          tx,
          "latest",
          deployment.estimationStateOverride,
        ]))
      : await provider.estimateGas(tx);
  } catch (error) {
    if (deployment.estimationStateOverride) {
      const implementationAddress = Object.keys(deployment.estimationStateOverride)[0];
      let overrideProbe = "not attempted";
      try {
        overrideProbe = await provider.send("eth_call", [
          {
            to: implementationAddress,
            data: id("jailTokenImplementation()").slice(0, 10),
          },
          "latest",
          deployment.estimationStateOverride,
        ]);
      } catch (probeError) {
        overrideProbe = `failed: ${safeError(probeError)}`;
      }
      const dependencyProbes = [];
      for (const dependency of deployment.estimationProbeTargets || []) {
        try {
          dependencyProbes.push({
            label: dependency.label,
            address: dependency.address,
            proxiableUUID: await provider.send("eth_call", [
              {
                to: dependency.address,
                data: id("proxiableUUID()").slice(0, 10),
              },
              "latest",
              deployment.estimationStateOverride,
            ]),
          });
        } catch (probeError) {
          dependencyProbes.push({
            label: dependency.label,
            address: dependency.address,
            error: safeError(probeError),
            revertData: extractRevertData(probeError) || "not returned by RPC",
          });
        }
      }
      const revertData = extractRevertData(error);
      process.stderr.write(`${JSON.stringify({
        failedSimulationCall: {
          chainId: CONFIG.chainId.toString(),
          targetAddress: deployment.deployer,
          target: "CREATE2 deployment helper",
          functionSelector: "none; raw salt || initCode payload",
          deploymentLabel: deployment.label,
          innerConstructor: "ERC1967Proxy",
          initializationFunctionSelector: deployment.initializationSelector,
          codeOverrides: Object.entries(deployment.estimationStateOverride).map(
            ([address, value]) => ({
              address,
              runtimeHash: keccak256(value.code),
              runtimeBytes: Math.max(0, (value.code.length - 2) / 2),
            }),
          ),
          implementationGetterProbe: overrideProbe,
          dependencyProbes,
          error: safeError(error),
          revertData: revertData || "not returned by RPC",
          decodedRevert: decodeRevertData(revertData, deployment.artifact) || "unavailable",
        },
      }, null, 2)}\n`);
    }
    throw new Error(
      `${deployment.label} gas estimate failed (${safeError(error)})`,
    );
  }
  const padded = (estimate * 120n) / 100n + (deployment.proxy ? 600_000n : 0n);
  return { gasEstimate: estimate, gasLimit: padded, alreadyDeployed: false };
}

async function simulateAndEstimateCall(provider, signerAddress, call, gasPrice) {
  const tx = {
    from: signerAddress,
    to: call.targetAddress,
    data: call.data,
  };
  try {
    if (call.stateOverride) {
      await provider.send("eth_call", [tx, "latest", call.stateOverride]);
    } else {
      await provider.call(tx);
    }
    const estimate = call.stateOverride
      ? BigInt(await provider.send("eth_estimateGas", [
          tx,
          "latest",
          call.stateOverride,
        ]))
      : BigInt(await provider.send("eth_estimateGas", [tx]));
    const gasLimit = (estimate * 120n + 99n) / 100n;
    return {
      name: call.name,
      targetAddress: call.targetAddress,
      functionSelector: call.data.slice(0, 10),
      gasEstimate: estimate.toString(),
      gasLimit: gasLimit.toString(),
      expectedFeeWei: (estimate * gasPrice).toString(),
      maximumFeeAtGasLimitWei: (gasLimit * gasPrice).toString(),
    };
  } catch (error) {
    const revertData = extractRevertData(error);
    const diagnostic = {
      chainId: CONFIG.chainId.toString(),
      transaction: call.name,
      targetAddress: call.targetAddress,
      functionSelector: call.data.slice(0, 10),
      error: safeError(error),
      revertData: revertData || "not returned by RPC",
      decodedRevert: decodeRevertData(revertData, { abi: call.abi }) || "unavailable",
    };
    process.stderr.write(`${JSON.stringify({ failedSimulationCall: diagnostic }, null, 2)}\n`);
    throw new Error(`${call.name} preflight simulation failed (${safeError(error)})`);
  }
}

async function estimateRemainingProtocolCalls(
  provider,
  signerAddress,
  plan,
  progress,
  gasPrice,
) {
  const deployments = Object.fromEntries(plan.deployments.map((item) => [item.label, item]));
  const protocolTransactions = [];
  const upgrades = [
    {
      name: "VaultFactory upgrade",
      proxy: plan.currentVaultProxy,
      previous: plan.currentVaultImplementation,
      next: deployments["VaultFactory-implementation-v2"],
      artifact: plan.vaultArtifact,
    },
    {
      name: "ArmoreumFactory upgrade",
      proxy: plan.currentFactoryProxy,
      previous: plan.currentFactoryImplementation,
      next: deployments["ArmoreumFactory-implementation-v2"],
      artifact: plan.factoryArtifact,
    },
  ];
  for (const upgrade of upgrades) {
    const activeImplementation = await currentImplementation(provider, upgrade.proxy.address);
    const saved = progress.upgrades[upgrade.name.replace(" upgrade", "")];
    if (activeImplementation.toLowerCase() === upgrade.next.address.toLowerCase()) {
      if (!saved?.transactionHash) {
        throw new Error(`${upgrade.name} is live but has no persisted confirmed receipt`);
      }
      continue;
    }
    if (activeImplementation.toLowerCase() !== upgrade.previous.address.toLowerCase()) {
      throw new Error(`${upgrade.name} proxy implementation changed unexpectedly`);
    }
    if (saved?.transactionHash) {
      throw new Error(`${upgrade.name} partial record conflicts with its live proxy implementation`);
    }
    const contractInterface = new Interface(upgrade.artifact.abi);
    const data = contractInterface.encodeFunctionData("upgradeToAndCall", [
      upgrade.next.address,
      "0x",
    ]);
    protocolTransactions.push(await simulateAndEstimateCall(
      provider,
      signerAddress,
      {
        name: upgrade.name,
        targetAddress: upgrade.proxy.address,
        data,
        abi: upgrade.artifact.abi,
        stateOverride: {
          [upgrade.next.address]: {
            code: runtimeCodeAtAddress(upgrade.artifact, upgrade.next.address),
          },
        },
      },
      gasPrice,
    ));
  }

  const factory = new Contract(
    plan.currentFactoryProxy.address,
    plan.factoryArtifact.abi,
    provider,
  );
  const vaultFactory = new Contract(
    plan.currentVaultProxy.address,
    plan.vaultArtifact.abi,
    provider,
  );
  const taxRouterImplementation = deployments["TaxRouter-implementation-v2"];
  const creatorVaultImplementation =
    deployments["CreatorRewardVault-password-implementation-v1"];
  const currentFactoryVaultImplementation = await factory.vaultImplementation();
  const currentFactoryTaxRouterImplementation = await factory.taxRouterImplementation();
  const needsFactoryImplementationApproval =
    currentFactoryVaultImplementation.toLowerCase()
      !== creatorVaultImplementation.address.toLowerCase()
    || currentFactoryTaxRouterImplementation.toLowerCase()
      !== taxRouterImplementation.address.toLowerCase();
  const savedFactoryApproval =
    progress.configuration["ArmoreumFactory-approve-Pons-TaxRouter-v2"];
  if (needsFactoryImplementationApproval && savedFactoryApproval?.transactionHash) {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(savedFactoryApproval.transactionHash),
      provider.getTransactionReceipt(savedFactoryApproval.transactionHash),
    ]);
    const contractInterface = new Interface(plan.factoryArtifact.abi);
    let parsed;
    try {
      parsed = transaction && contractInterface.parseTransaction({
        data: transaction.data,
        value: transaction.value,
      });
    } catch {
      parsed = null;
    }
    const currentFactoryVersion = await factory.implementationVersion();
    const savedConfigurationVersion =
      parsed?.name === "approveImplementations" ? BigInt(parsed.args[2]) : null;
    const savedPointersMatchLive = parsed?.name === "approveImplementations"
      && getAddress(parsed.args[0]).toLowerCase()
        === currentFactoryVaultImplementation.toLowerCase()
      && getAddress(parsed.args[1]).toLowerCase()
        === currentFactoryTaxRouterImplementation.toLowerCase();
    if (
      !transaction
      || !receipt
      || receipt.status !== 1
      || transaction.to?.toLowerCase() !== plan.currentFactoryProxy.address.toLowerCase()
      || parsed?.name !== "approveImplementations"
      || (!savedPointersMatchLive
        && (savedConfigurationVersion === null || savedConfigurationVersion >= currentFactoryVersion))
    ) {
      throw new Error("Saved ArmoreumFactory implementation receipt does not match the active onchain configuration");
    }
    progress.completedPreviousConfigurations ??= {};
    progress.completedPreviousConfigurations.ArmoreumFactoryImplementationApprovalPrevious = {
      ...savedFactoryApproval,
      previousVaultImplementation: currentFactoryVaultImplementation,
      previousTaxRouterImplementation: currentFactoryTaxRouterImplementation,
      previousVersion: currentFactoryVersion.toString(),
      supersededConfigurationVersion: savedConfigurationVersion?.toString(),
    };
    delete progress.configuration["ArmoreumFactory-approve-Pons-TaxRouter-v2"];
  }
  if (needsFactoryImplementationApproval) {
    const args = [
      creatorVaultImplementation.address,
      taxRouterImplementation.address,
      (await factory.implementationVersion()) + 1n,
    ];
    const data = new Interface(plan.factoryArtifact.abi).encodeFunctionData(
      "approveImplementations",
      args,
    );
    protocolTransactions.push(await simulateAndEstimateCall(
      provider,
      signerAddress,
      {
        name: "ArmoreumFactory approve Pons TaxRouter v2",
        targetAddress: plan.currentFactoryProxy.address,
        data,
        abi: plan.factoryArtifact.abi,
        stateOverride: {
          [creatorVaultImplementation.address]: {
            code: runtimeCodeAtAddress(
              creatorVaultImplementation.artifact,
              creatorVaultImplementation.address,
            ),
          },
          [taxRouterImplementation.address]: {
            code: runtimeCodeAtAddress(
              taxRouterImplementation.artifact,
              taxRouterImplementation.address,
            ),
          },
        },
      },
      gasPrice,
    ));
  }

  const currentCreatorVaultImplementation = await vaultFactory.creatorVaultImplementation();
  const currentFeeVaultImplementation = await vaultFactory.feeVaultImplementation();
  if (
    currentCreatorVaultImplementation.toLowerCase()
      !== creatorVaultImplementation.address.toLowerCase()
    || currentFeeVaultImplementation.toLowerCase()
      !== taxRouterImplementation.address.toLowerCase()
  ) {
    const data = new Interface(plan.vaultArtifact.abi).encodeFunctionData(
      "setImplementations",
      [
        creatorVaultImplementation.address,
        taxRouterImplementation.address,
        (await vaultFactory.implementationVersion()) + 1n,
      ],
    );
    protocolTransactions.push(await simulateAndEstimateCall(
      provider,
      signerAddress,
      {
        name: "VaultFactory register password Creator Vault implementation",
        targetAddress: plan.currentVaultProxy.address,
        data,
        abi: plan.vaultArtifact.abi,
        stateOverride: {
          [creatorVaultImplementation.address]: {
            code: runtimeCodeAtAddress(
              creatorVaultImplementation.artifact,
              creatorVaultImplementation.address,
            ),
          },
          [taxRouterImplementation.address]: {
            code: runtimeCodeAtAddress(
              taxRouterImplementation.artifact,
              taxRouterImplementation.address,
            ),
          },
        },
      },
      gasPrice,
    ));
  }

  const jailTokenFactoryProxy = deployments["JailTokenFactory-proxy-v1"];
  const jailTokenFactoryImplementation =
    deployments["JailTokenFactory-implementation-v1"];
  const jailTokenFactory = new Contract(
    jailTokenFactoryProxy.address,
    plan.jailTokenFactoryArtifact.abi,
    provider,
  );
  let needsLaunchFactoryPermission = true;
  const existingJailTokenFactoryCode = await provider.getCode(jailTokenFactoryProxy.address);
  if (existingJailTokenFactoryCode !== "0x") {
    const activeImplementation = await currentImplementation(
      provider,
      jailTokenFactoryProxy.address,
    );
    if (activeImplementation.toLowerCase() !== jailTokenFactoryImplementation.address.toLowerCase()) {
      throw new Error("Registered JailTokenFactory proxy uses an unexpected implementation");
    }
    if (
      (await jailTokenFactory.jailTokenImplementation()).toLowerCase()
        !== deployments["JailToken-implementation"].address.toLowerCase()
      || (await jailTokenFactory.jailEthImplementation()).toLowerCase()
        !== deployments["JailETHReceipt-implementation"].address.toLowerCase()
    ) {
      throw new Error("Registered JailTokenFactory proxy has unexpected receipt implementations");
    }
    const defaultAdminRole = `0x${"00".repeat(32)}`;
    if (!(await jailTokenFactory.hasRole(defaultAdminRole, signerAddress))) {
      throw new Error("Registered JailTokenFactory proxy does not grant the deployer admin role");
    }
    const launchFactoryRole = await jailTokenFactory.LAUNCH_FACTORY_ROLE();
    needsLaunchFactoryPermission = !(await jailTokenFactory.hasRole(
      launchFactoryRole,
      plan.currentVaultProxy.address,
    ));
  }
  if (needsLaunchFactoryPermission) {
    if (progress.configuration.vaultFactoryPermission?.transactionHash) {
      throw new Error("JailTokenFactory permission receipt is registered but permission is absent");
    }
    const contractInterface = new Interface(plan.jailTokenFactoryArtifact.abi);
    protocolTransactions.push(await simulateAndEstimateCall(
      provider,
      signerAddress,
      {
        name: "JailTokenFactory setLaunchFactory permission",
        targetAddress: jailTokenFactoryProxy.address,
        data: contractInterface.encodeFunctionData("setLaunchFactory", [
          plan.currentVaultProxy.address,
          true,
        ]),
        abi: plan.jailTokenFactoryArtifact.abi,
        stateOverride: jailTokenFactoryProxyOverride(plan, signerAddress, true),
      },
      gasPrice,
    ));
  }

  const vaultImplementation = deployments["VaultFactory-implementation-v2"];
  const activeVaultImplementation = await currentImplementation(
    provider,
    plan.currentVaultProxy.address,
  );
  if (
    activeVaultImplementation.toLowerCase() !== vaultImplementation.address.toLowerCase()
    && activeVaultImplementation.toLowerCase()
      !== plan.currentVaultImplementation.address.toLowerCase()
  ) {
    throw new Error("VaultFactory proxy implementation changed unexpectedly");
  }
  const configuredJailSwapVersion = await vaultFactory.jailSwapImplementationVersion();
  const configuredJailSwapVault = await vaultFactory.jailSwapVaultImplementation();
  const configuredJailTokenFactory = await vaultFactory.jailTokenFactory();
  const targetJailSwapVault = deployments["JailSwapVault-implementation"].address;
  const targetJailTokenFactory = jailTokenFactoryProxy.address;
  let needsJailSwapConfiguration =
    configuredJailSwapVersion === 0n
    || configuredJailSwapVault.toLowerCase() !== targetJailSwapVault.toLowerCase()
    || configuredJailTokenFactory.toLowerCase() !== targetJailTokenFactory.toLowerCase();
  if (needsJailSwapConfiguration) {
    const saved = progress.configuration.jailSwapImplementations;
    if (saved?.transactionHash) {
      const [transaction, receipt] = await Promise.all([
        provider.getTransaction(saved.transactionHash),
        provider.getTransactionReceipt(saved.transactionHash),
      ]);
      const contractInterface = new Interface(plan.vaultArtifact.abi);
      let parsed;
      try {
        parsed = transaction && contractInterface.parseTransaction({
          data: transaction.data,
          value: transaction.value,
        });
      } catch {
        parsed = null;
      }
      if (
        !transaction
        || !receipt
        || receipt.status !== 1
        || transaction.to?.toLowerCase() !== plan.currentVaultProxy.address.toLowerCase()
        || parsed?.name !== "setJailSwapImplementations"
        || configuredJailSwapVersion === 0n
        || BigInt(parsed.args[2]) !== configuredJailSwapVersion
        || getAddress(parsed.args[0]).toLowerCase()
          !== configuredJailSwapVault.toLowerCase()
        || getAddress(parsed.args[1]).toLowerCase()
          !== configuredJailTokenFactory.toLowerCase()
      ) {
        throw new Error("Saved JailSwap configuration receipt does not match the active onchain configuration");
      }
      progress.completedPreviousConfigurations ??= {};
      progress.completedPreviousConfigurations[
        `jailSwapImplementations-v${configuredJailSwapVersion}`
      ] = {
        ...saved,
        previousJailSwapVaultImplementation: configuredJailSwapVault,
        previousJailTokenFactory: configuredJailTokenFactory,
        previousVersion: configuredJailSwapVersion.toString(),
      };
      delete progress.configuration.jailSwapImplementations;
    }
    const contractInterface = new Interface(plan.vaultArtifact.abi);
    protocolTransactions.push(await simulateAndEstimateCall(
      provider,
      signerAddress,
      {
        name: "VaultFactory setJailSwapImplementations",
        targetAddress: plan.currentVaultProxy.address,
        data: contractInterface.encodeFunctionData("setJailSwapImplementations", [
          targetJailSwapVault,
          targetJailTokenFactory,
          configuredJailSwapVersion + 1n,
        ]),
        abi: plan.vaultArtifact.abi,
        stateOverride: vaultFactoryConfigurationOverride(
          plan,
          signerAddress,
        ),
      },
      gasPrice,
    ));
  }
  return protocolTransactions;
}

async function sendDeployment(provider, signer, deployment, progress, progressFile) {
  const saved = progress.deployments[deployment.label];
  const code = await provider.getCode(deployment.address);
  if (code !== "0x") {
    if (!saved || keccak256(code).toLowerCase() !== saved.runtimeCodeHash.toLowerCase()) {
      throw new Error(`${deployment.label} has unregistered code; refusing to adopt it`);
    }
    return saved;
  }

  const trace = process.env.ARMOREUM_TRACE_DEPLOY_SUBMISSION === "1";
  if (trace) {
    process.stderr.write(`${JSON.stringify({
      preparingDeployment: {
        chainId: CONFIG.chainId.toString(),
        deployment: deployment.label,
        create2Deployer: deployment.deployer,
        predictedAddress: deployment.address,
        gasLimit: deployment.gasLimit.toString(),
        gasPrice: deployment.gasPrice.toString(),
      },
    })}\n`);
  }
  let tx;
  try {
    tx = await signer.sendTransaction({
      to: deployment.deployer,
      data: deployment.data,
      gasLimit: deployment.gasLimit,
      gasPrice: deployment.gasPrice,
    });
  } catch (error) {
    if (trace) {
      const rpcError = error?.info?.error || error?.error || null;
      process.stderr.write(`${JSON.stringify({
        failedDeploymentSubmission: {
          chainId: CONFIG.chainId.toString(),
          deployment: deployment.label,
          create2Deployer: deployment.deployer,
          predictedAddress: deployment.address,
          code: error?.code || null,
          error: safeError(error),
          rpcMethod: error?.info?.payload?.method || error?.info?.request?.method || null,
          rpcCode: rpcError?.code || null,
          rpcError: rpcError ? safeError(rpcError) : null,
        },
      }, null, 2)}\n`);
    }
    throw error;
  }
  if (trace) {
    process.stdout.write(`${JSON.stringify({
      submittedDeployment: deployment.label,
      chainId: CONFIG.chainId.toString(),
      transactionHash: tx.hash,
    })}\n`);
  }
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${deployment.label} deployment transaction failed`);
  }
  const runtimeCode = await provider.getCode(deployment.address);
  if (runtimeCode === "0x") {
    throw new Error(`${deployment.label} has no code after its successful receipt`);
  }
  const record = deploymentRecord(
    deployment.label,
    deployment,
    receipt,
    keccak256(runtimeCode),
  );
  progress.deployments[deployment.label] = record;
  writeJsonAtomic(progressFile, progress);
  process.stdout.write(`${JSON.stringify({
    confirmedDeployment: deployment.label,
    chainId: CONFIG.chainId.toString(),
    address: record.address,
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber,
  })}\n`);
  return record;
}

async function sendUpgrade(provider, signer, contract, name, oldImplementation, newImplementation, progress, progressFile, gasPrice) {
  const proxy = await contract.getAddress();
  const current = await currentImplementation(provider, proxy);
  const saved = progress.upgrades[name];
  if (current.toLowerCase() === newImplementation.toLowerCase()) {
    if (!saved?.transactionHash) {
      throw new Error(`${name} is already upgraded but its transaction receipt is not registered`);
    }
    return saved;
  }
  if (current.toLowerCase() !== oldImplementation.toLowerCase()) {
    throw new Error(`${name} proxy implementation changed unexpectedly`);
  }
  await contract.upgradeToAndCall.staticCall(newImplementation, "0x");
  const estimate = await contract.upgradeToAndCall.estimateGas(newImplementation, "0x");
  const tx = await contract.upgradeToAndCall(newImplementation, "0x", {
    gasLimit: (estimate * 120n) / 100n,
    gasPrice,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${name} upgrade transaction failed`);
  const verified = await currentImplementation(provider, proxy);
  if (verified.toLowerCase() !== newImplementation.toLowerCase()) {
    throw new Error(`${name} proxy did not retain the new implementation`);
  }
  const record = {
    previousImplementation: oldImplementation,
    implementation: newImplementation,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
  progress.upgrades[name] = record;
  writeJsonAtomic(progressFile, progress);
  process.stdout.write(`${JSON.stringify({
    confirmedUpgrade: name,
    chainId: CONFIG.chainId.toString(),
    proxy,
    implementation: newImplementation,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  })}\n`);
  return record;
}

async function sendConfiguration(provider, signer, contract, key, method, args, progress, progressFile, gasPrice) {
  const saved = progress.configuration[key];
  if (saved?.transactionHash) return saved;
  const estimate = await contract[method].estimateGas(...args);
  const tx = await contract[method](...args, {
    gasLimit: (estimate * 120n) / 100n,
    gasPrice,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${key} configuration transaction failed`);
  const record = { transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
  progress.configuration[key] = record;
  writeJsonAtomic(progressFile, progress);
  process.stdout.write(`${JSON.stringify({
    confirmedConfiguration: key,
    chainId: CONFIG.chainId.toString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  })}\n`);
  return record;
}

async function main() {
  if (!DRY_RUN && process.env[CONFIG.confirmationKey] !== CONFIG.confirmation) {
    throw new Error(`Explicit ${CONFIG.label} deployment confirmation is required`);
  }

  const rpcUrl = process.env[CONFIG.rpcKey];
  const ownerKey = process.env.DEPLOYER_PRIVATE_KEY;
  const emergencyKey = process.env.PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY;
  if (!rpcUrl || !ownerKey || !emergencyKey) {
    throw new Error("A target RPC, deployer signer, and emergency signer are required");
  }
  const provider = new JsonRpcProvider(rpcUrl, CONFIG.chainId, { staticNetwork: true });
  const signer = new Wallet(ownerKey, provider);
  const emergencyOperator = new Wallet(emergencyKey).address;
  if (signer.address.toLowerCase() === emergencyOperator.toLowerCase()) {
    throw new Error("The emergency operator must be distinct from the deployment owner");
  }
  if (BigInt((await provider.getNetwork()).chainId) !== CONFIG.chainId) {
    throw new Error(`RPC chain ID does not match ${CONFIG.label}`);
  }

  const manifestFile = path.join(DEPLOYMENTS_DIR, `${CONFIG.chainId}.json`);
  const progressFile = path.join(DEPLOYMENTS_DIR, `${CONFIG.chainId}.upgrade.partial.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (BigInt(manifest.chainId) !== CONFIG.chainId) {
    throw new Error("Deployment registry chain ID does not match the selected target");
  }
  if (manifest.authorities?.canonicalPlatformOwner?.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Deployer signer is not the registered canonical platform owner");
  }
  if (manifest.authorities?.emergencyOperator?.toLowerCase() !== emergencyOperator.toLowerCase()) {
    throw new Error("Emergency signer is not the registered emergency operator");
  }

  const create2Address = getAddress(process.env[CONFIG.create2AddressKey] || "");
  if (!isAddress(create2Address)) throw new Error("CREATE2 deployer address is invalid");
  const expectedCreate2Hash = process.env[CONFIG.create2HashKey];
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedCreate2Hash || "")) {
    throw new Error("CREATE2 deployer runtime hash is invalid");
  }
  const create2Code = await provider.getCode(create2Address);
  if (create2Code === "0x" || keccak256(create2Code).toLowerCase() !== expectedCreate2Hash.toLowerCase()) {
    throw new Error("CREATE2 deployer bytecode does not match its verified runtime hash");
  }
  if (manifest.externalIntegrations?.create2Deployer?.address?.toLowerCase() !== create2Address.toLowerCase()) {
    throw new Error("CREATE2 deployer address differs from the deployment registry");
  }

  const progress = fs.existsSync(progressFile)
    ? JSON.parse(fs.readFileSync(progressFile, "utf8"))
    : {
        chainId: Number(CONFIG.chainId),
        network: CONFIG.label,
        deployments: {},
        upgrades: {},
        configuration: {},
      };
  if (progress.chainId !== Number(CONFIG.chainId)) {
    throw new Error("Partial upgrade record belongs to a different chain");
  }
  progress.completedPreviousUpgrades ??= {};
  progress.completedPreviousDeployments ??= {};
  const plan = await makePlan(
    provider,
    manifest,
    signer.address,
    emergencyOperator,
    create2Address,
  );
  const plannedJailTokenFactoryProxy = plan.deployments.find(
    (deployment) => deployment.label === "JailTokenFactory-proxy-v1",
  );
  if (!plannedJailTokenFactoryProxy) {
    throw new Error("Planned JailTokenFactory proxy is missing from the upgrade plan");
  }
  const registeredJailTokenFactoryProxy = recordByName(manifest, "JailTokenFactory-proxy");
  const priorPermission = progress.configuration?.vaultFactoryPermission;
  if (
    priorPermission?.transactionHash &&
    registeredJailTokenFactoryProxy &&
    registeredJailTokenFactoryProxy.address.toLowerCase()
      !== plannedJailTokenFactoryProxy.address.toLowerCase()
  ) {
    const [priorTransaction, priorReceipt] = await Promise.all([
      provider.getTransaction(priorPermission.transactionHash),
      provider.getTransactionReceipt(priorPermission.transactionHash),
    ]);
    if (
      !priorTransaction ||
      !priorReceipt ||
      priorReceipt.status !== 1 ||
      priorTransaction.to?.toLowerCase()
        !== registeredJailTokenFactoryProxy.address.toLowerCase()
    ) {
      throw new Error("Recorded JailTokenFactory permission transaction does not match the registered prior proxy");
    }
    progress.completedPreviousConfigurations ??= {};
    progress.completedPreviousConfigurations.vaultFactoryPermission = {
      ...priorPermission,
      targetAddress: registeredJailTokenFactoryProxy.address,
    };
    delete progress.configuration.vaultFactoryPermission;
  }
  const plannedDeployments = new Map(
    plan.deployments.map((deployment) => [deployment.label, deployment]),
  );
  for (const [label, saved] of Object.entries(progress.deployments ?? {})) {
    const planned = plannedDeployments.get(label);
    if (!planned || planned.address.toLowerCase() === saved.address.toLowerCase()) continue;
    const savedCode = await provider.getCode(saved.address);
    const registeredInManifest = manifest.contracts.some(
      (record) => record.address.toLowerCase() === saved.address.toLowerCase(),
    );
    if (
      savedCode === "0x"
      || keccak256(savedCode).toLowerCase() !== saved.runtimeCodeHash?.toLowerCase()
      || !registeredInManifest
    ) {
      throw new Error(`${label} partial deployment record conflicts with its registered onchain code`);
    }
    progress.completedPreviousDeployments[label] = saved;
    delete progress.deployments[label];
  }
  for (const name of ["ArmoreumFactory", "VaultFactory"]) {
    const saved =
      progress.upgrades?.[name] ?? progress.completedPreviousUpgrades?.[name];
    if (!saved?.transactionHash) continue;
    const proxyRecord = recordByName(manifest, `${name}-proxy`);
    const implementationRecord = recordByName(manifest, `${name}-implementation`);
    const planned = plannedDeployments.get(`${name}-implementation-v2`);
    if (!proxyRecord || !implementationRecord) continue;
    const active = await currentImplementation(provider, proxyRecord.address);
    if (
      active.toLowerCase() !== saved.implementation.toLowerCase()
      || implementationRecord.address.toLowerCase() !== saved.implementation.toLowerCase()
    ) continue;
    if (planned?.address.toLowerCase() === active.toLowerCase()) {
      progress.upgrades[name] = saved;
      delete progress.completedPreviousUpgrades[name];
    } else {
      progress.completedPreviousUpgrades[name] = saved;
      delete progress.upgrades[name];
    }
  }
  writeJsonAtomic(progressFile, progress);
  const feeData = await provider.getFeeData();
  const liveGasPrice = BigInt(await provider.send("eth_gasPrice", []));
  const latestBlock = await provider.getBlock("latest");
  const baseFee = latestBlock?.baseFeePerGas;
  if (baseFee === null || baseFee === undefined || baseFee <= 0n) {
    throw new Error("Live base fee is unavailable; no mainnet upgrade transaction can be priced safely.");
  }
  const gasPriceCap = (baseFee * 120n + 99n) / 100n;
  const highestRpcQuote = [feeData.gasPrice ?? 0n, liveGasPrice]
    .reduce((highest, candidate) => candidate > highest ? candidate : highest, 0n);
  if (highestRpcQuote > gasPriceCap) {
    throw new Error("Current RPC fee quote exceeds the 20% base-fee cap; retry when the live quote is within policy.");
  }
  const gasPrice = gasPriceCap;
  const balance = await provider.getBalance(signer.address);
  const estimates = [];
  let plannedGas = 0n;
  for (const deployment of plan.deployments) {
    const estimate = await estimateDeployment(
      provider,
      signer.address,
      deployment,
      progress,
    );
    deployment.gasLimit = estimate.gasLimit;
    deployment.gasPrice = gasPrice;
    plannedGas += estimate.gasLimit;
    estimates.push({
      name: deployment.label,
      address: deployment.address,
      gasEstimate: estimate.gasEstimate.toString(),
      gasLimit: estimate.gasLimit.toString(),
      alreadyDeployed: estimate.alreadyDeployed,
    });
  }
  const protocolTransactions = await estimateRemainingProtocolCalls(
    provider,
    signer.address,
    plan,
    progress,
    gasPrice,
  );
  for (const transaction of protocolTransactions) {
    plannedGas += BigInt(transaction.gasLimit);
  }
  const deploymentTransactions = plan.deployments.map((deployment, index) => {
    const estimate = estimates[index];
    return {
      name: estimate.name,
      targetAddress: deployment.deployer,
      deploymentAddress: deployment.address,
      functionSelector: "none; raw salt || initCode payload",
      gasEstimate: estimate.gasEstimate,
      gasLimit: estimate.gasLimit,
      expectedFeeWei: (BigInt(estimate.gasEstimate) * gasPrice).toString(),
      maximumFeeAtGasLimitWei: (BigInt(estimate.gasLimit) * gasPrice).toString(),
      alreadyDeployed: estimate.alreadyDeployed,
    };
  });
  const transactions = [...deploymentTransactions, ...protocolTransactions];
  const expectedFeesWei = transactions
    .reduce((sum, transaction) => sum + BigInt(transaction.expectedFeeWei), 0n);
  const maximumFeesAtGasLimitWei = transactions
    .reduce((sum, transaction) => sum + BigInt(transaction.maximumFeeAtGasLimitWei), 0n);
  const requiredBalance = (maximumFeesAtGasLimitWei * 125n + 99n) / 100n;
  const fundingShortfall = requiredBalance > balance ? requiredBalance - balance : 0n;
  const summary = {
    chainId: CONFIG.chainId.toString(),
    network: CONFIG.label,
    owner: signer.address,
    balanceWei: balance.toString(),
    gasPriceWei: gasPrice.toString(),
    estimatedGasWithPerTransactionMargin: plannedGas.toString(),
    expectedFeesWei: expectedFeesWei.toString(),
    maximumFeesAtGasLimitWei: maximumFeesAtGasLimitWei.toString(),
    requiredBalanceWith25PercentMarginWei: requiredBalance.toString(),
    fundingShortfallWei: fundingShortfall.toString(),
    deployments: estimates,
    protocolTransactions,
    transactions,
    dryRun: DRY_RUN,
    launchEnabledAfterUpgrade: false,
  };
  if (DRY_RUN) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    await provider.destroy();
    return;
  }
  if (fundingShortfall > 0n) {
    throw new Error(
      `Insufficient deployer balance: fund at least ${fundingShortfall} additional wei (total required ${requiredBalance} wei, available ${balance} wei). No transaction was sent.`,
    );
  }

  for (const deployment of plan.deployments) {
    await sendDeployment(provider, signer, deployment, progress, progressFile);
  }

  const factoryImpl = progress.deployments["ArmoreumFactory-implementation-v2"];
  const vaultImpl = progress.deployments["VaultFactory-implementation-v2"];
  const creatorVaultImpl =
    progress.deployments["CreatorRewardVault-password-implementation-v1"];
  const taxRouterImpl = progress.deployments["TaxRouter-implementation-v2"];
  const jailTokenImpl = progress.deployments["JailToken-implementation"];
  const receiptImpl = progress.deployments["JailETHReceipt-implementation"];
  const jailTokenFactoryImpl = progress.deployments["JailTokenFactory-implementation-v1"];
  const jailTokenFactoryProxy = progress.deployments["JailTokenFactory-proxy-v1"];
  const jailSwapVaultImpl = progress.deployments["JailSwapVault-implementation"];
  for (const record of Object.values(progress.deployments)) {
    await verifyRecordCode(provider, record, record.name);
  }

  const factory = new Contract(
    plan.currentFactoryProxy.address,
    plan.factoryArtifact.abi,
    signer,
  );
  const vaultFactory = new Contract(
    plan.currentVaultProxy.address,
    plan.vaultArtifact.abi,
    signer,
  );
  await sendUpgrade(
    provider,
    signer,
    vaultFactory,
    "VaultFactory",
    plan.currentVaultImplementation.address,
    vaultImpl.address,
    progress,
    progressFile,
    gasPrice,
  );
  if (
    (await vaultFactory.creatorVaultImplementation()).toLowerCase()
      !== creatorVaultImpl.address.toLowerCase()
    || (await vaultFactory.feeVaultImplementation()).toLowerCase()
      !== taxRouterImpl.address.toLowerCase()
  ) {
    await sendConfiguration(
      provider,
      signer,
      vaultFactory,
      "VaultFactory-password-CreatorVault-implementation",
      "setImplementations",
      [
        creatorVaultImpl.address,
        taxRouterImpl.address,
        (await vaultFactory.implementationVersion()) + 1n,
      ],
      progress,
      progressFile,
      gasPrice,
    );
  }
  await sendUpgrade(
    provider,
    signer,
    factory,
    "ArmoreumFactory",
    plan.currentFactoryImplementation.address,
    factoryImpl.address,
    progress,
    progressFile,
    gasPrice,
  );
  if (
    (await factory.vaultImplementation()).toLowerCase()
      !== creatorVaultImpl.address.toLowerCase()
    || (await factory.taxRouterImplementation()).toLowerCase()
      !== taxRouterImpl.address.toLowerCase()
  ) {
    const nextVersion = (await factory.implementationVersion()) + 1n;
    await sendConfiguration(
      provider,
      signer,
      factory,
      "ArmoreumFactory-approve-Pons-TaxRouter-v2",
      "approveImplementations",
      [creatorVaultImpl.address, taxRouterImpl.address, nextVersion],
      progress,
      progressFile,
      gasPrice,
    );
  }

  const jailFactoryArtifact = plan.jailTokenFactoryArtifact;
  const jailTokenFactory = new Contract(
    jailTokenFactoryProxy.address,
    jailFactoryArtifact.abi,
    signer,
  );
  const launchFactoryRole = await jailTokenFactory.LAUNCH_FACTORY_ROLE();
  if (!(await jailTokenFactory.hasRole(launchFactoryRole, plan.currentVaultProxy.address))) {
    await sendConfiguration(
      provider,
      signer,
      jailTokenFactory,
      "vaultFactoryPermission",
      "setLaunchFactory",
      [plan.currentVaultProxy.address, true],
      progress,
      progressFile,
      gasPrice,
    );
  }

  const configuredVersion = await vaultFactory.jailSwapImplementationVersion();
  if (
    configuredVersion === 0n
    || (await vaultFactory.jailSwapVaultImplementation()).toLowerCase()
      !== jailSwapVaultImpl.address.toLowerCase()
    || (await vaultFactory.jailTokenFactory()).toLowerCase()
      !== jailTokenFactoryProxy.address.toLowerCase()
  ) {
    await sendConfiguration(
      provider,
      signer,
      vaultFactory,
      "jailSwapImplementations",
      "setJailSwapImplementations",
      [
        jailSwapVaultImpl.address,
        jailTokenFactoryProxy.address,
        configuredVersion + 1n,
      ],
      progress,
      progressFile,
      gasPrice,
    );
  } else if (
    configuredVersion !== 1n
    || (await vaultFactory.jailSwapVaultImplementation()).toLowerCase() !== jailSwapVaultImpl.address.toLowerCase()
    || (await vaultFactory.jailTokenFactory()).toLowerCase() !== jailTokenFactoryProxy.address.toLowerCase()
  ) {
    throw new Error("VaultFactory has conflicting JailSwap implementation configuration");
  }

  const verifiedFactoryImplementation = await currentImplementation(
    provider,
    plan.currentFactoryProxy.address,
  );
  const verifiedVaultImplementation = await currentImplementation(
    provider,
    plan.currentVaultProxy.address,
  );
  if (
    verifiedFactoryImplementation.toLowerCase() !== factoryImpl.address.toLowerCase()
    || verifiedVaultImplementation.toLowerCase() !== vaultImpl.address.toLowerCase()
  ) {
    throw new Error("Post-upgrade proxy implementation verification failed");
  }
  if (
    (await factory.canonicalOwner()).toLowerCase() !== signer.address.toLowerCase()
    || (await vaultFactory.canonicalOwner()).toLowerCase() !== signer.address.toLowerCase()
    || (await vaultFactory.emergencyOperator()).toLowerCase() !== emergencyOperator.toLowerCase()
  ) {
    throw new Error("Post-upgrade owner or emergency-role verification failed");
  }
  if (
    (await jailTokenFactory.hasRole(launchFactoryRole, plan.currentVaultProxy.address)) !== true
    || (await vaultFactory.jailTokenFactory()).toLowerCase() !== jailTokenFactoryProxy.address.toLowerCase()
  ) {
    throw new Error("Post-upgrade JailSwap factory permission verification failed");
  }
  const defaultAdminRole = `0x${"00".repeat(32)}`;
  const factoryUpgraderRole = await factory.UPGRADER_ROLE();
  const vaultUpgraderRole = await vaultFactory.UPGRADER_ROLE();
  const jailTokenFactoryUpgraderRole = await jailTokenFactory.UPGRADER_ROLE();
  if (
    !(await factory.hasRole(factoryUpgraderRole, signer.address))
    || !(await vaultFactory.hasRole(vaultUpgraderRole, signer.address))
    || !(await jailTokenFactory.hasRole(jailTokenFactoryUpgraderRole, signer.address))
    || !(await jailTokenFactory.hasRole(defaultAdminRole, signer.address))
  ) {
    throw new Error("Post-upgrade deployer role verification failed");
  }
  if (
    (await factory.vaultFactory()).toLowerCase() !== plan.currentVaultProxy.address.toLowerCase()
    || (await factory.vaultImplementation()).toLowerCase()
      !== creatorVaultImpl.address.toLowerCase()
    || (await factory.taxRouterImplementation()).toLowerCase() !== taxRouterImpl.address.toLowerCase()
    || (await vaultFactory.creatorVaultImplementation()).toLowerCase()
      !== creatorVaultImpl.address.toLowerCase()
    || (await vaultFactory.jailSwapImplementationVersion()) === 0n
    || (await vaultFactory.jailSwapVaultImplementation()).toLowerCase()
      !== jailSwapVaultImpl.address.toLowerCase()
    || (await jailTokenFactory.jailTokenImplementation()).toLowerCase()
      !== jailTokenImpl.address.toLowerCase()
    || (await jailTokenFactory.jailEthImplementation()).toLowerCase()
      !== receiptImpl.address.toLowerCase()
  ) {
    throw new Error("Post-upgrade factory mappings or implementation configuration verification failed");
  }

  const recordMappings = [
    ["ArmoreumFactory-implementation-v2", "ArmoreumFactory-implementation"],
    ["VaultFactory-implementation-v2", "VaultFactory-implementation"],
    ["CreatorRewardVault-password-implementation-v1", "CreatorRewardVault-implementation"],
    ["TaxRouter-implementation-v2", "TaxRouter-implementation"],
    ["JailToken-implementation", "JailToken-implementation"],
    ["JailETHReceipt-implementation", "JailETHReceipt-implementation"],
    ["JailTokenFactory-implementation-v1", "JailTokenFactory-implementation"],
    ["JailSwapVault-implementation", "JailSwapVault-implementation"],
    ["JailTokenFactory-proxy-v1", "JailTokenFactory-proxy"],
  ];
  for (const [progressName, canonicalName] of recordMappings) {
    const newRecord = { ...progress.deployments[progressName], name: canonicalName };
    const existing = recordByName(manifest, canonicalName);
    if (existing && existing.address.toLowerCase() !== newRecord.address.toLowerCase()) {
      existing.name = `${canonicalName}-previous`;
    }
    if (!manifest.contracts.some((item) => item.address.toLowerCase() === newRecord.address.toLowerCase())) {
      manifest.contracts.push(newRecord);
    } else {
      const record = manifest.contracts.find((item) => item.address.toLowerCase() === newRecord.address.toLowerCase());
      Object.assign(record, newRecord);
    }
  }
  manifest.implementationVersion = Number(await factory.implementationVersion());
  manifest.status = "core factories upgraded; launch remains disabled pending verified transaction integrations";
  manifest.launchEnabled = false;
  manifest.factoryUpgrades = {
    ArmoreumFactory: progress.upgrades.ArmoreumFactory,
    VaultFactory: progress.upgrades.VaultFactory,
  };
  manifest.vaultFactory = {
    ...manifest.vaultFactory,
    address: plan.currentVaultProxy.address,
    implementation: vaultImpl.address,
    creatorVaultImplementation: creatorVaultImpl.address,
    feeVaultImplementation: await vaultFactory.feeVaultImplementation(),
    implementationVersion: Number(await vaultFactory.implementationVersion()),
    jailTokenFactory: jailTokenFactoryProxy.address,
    jailTokenFactoryImplementation: jailTokenFactoryImpl.address,
    jailTokenImplementation: jailTokenImpl.address,
    jailEthReceiptImplementation: receiptImpl.address,
    jailSwapVaultImplementation: jailSwapVaultImpl.address,
    configurationTransactionHashes: [
      ...(manifest.vaultFactory?.configurationTransactionHashes || []),
      progress.configuration.vaultFactoryPermission?.transactionHash,
      progress.configuration.jailSwapImplementations?.transactionHash,
    ].filter(Boolean),
  };
  manifest.jailTokenFactory = {
    address: jailTokenFactoryProxy.address,
    implementation: jailTokenFactoryImpl.address,
    launchFactory: plan.currentVaultProxy.address,
    launchFactoryPermissionTransactionHash:
      progress.configuration.vaultFactoryPermission?.transactionHash || null,
  };
  writeJsonAtomic(manifestFile, manifest);
  process.stdout.write(`${JSON.stringify({
    chainId: CONFIG.chainId.toString(),
    network: CONFIG.label,
    launchEnabled: false,
    deployments: Object.values(progress.deployments),
    upgrades: progress.upgrades,
    configuration: progress.configuration,
    registryUpdated: true,
  }, null, 2)}\n`);
  await provider.destroy();
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
