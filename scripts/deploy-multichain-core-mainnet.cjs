const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  getAddress,
  getCreate2Address,
  keccak256,
} = require("ethers");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const target = process.env.ARMOREUM_DEPLOY_TARGET;
if (!["ethereum", "robinhood"].includes(target)) {
  throw new Error("ARMOREUM_DEPLOY_TARGET must be ethereum or robinhood");
}

const isEthereum = target === "ethereum";
const chainId = isEthereum ? 1n : 4663n;
const rpcKey = isEthereum ? "ALCHEMY_ETHEREUM_RPC_URL" : "ALCHEMY_ROBINHOOD_RPC_URL";
const create2AddressKey = isEthereum
  ? "ETHEREUM_CREATE2_DEPLOYER_ADDRESS"
  : "CREATE2_DEPLOYER_ADDRESS";
const create2HashKey = isEthereum
  ? "ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH"
  : "CREATE2_DEPLOYER_RUNTIME_CODE_HASH";
const confirmationKey = isEthereum
  ? "DEPLOY_ETHEREUM_MAINNET_CONFIRMATION"
  : "DEPLOY_MAINNET_CONFIRMATION";
const confirmationValue = isEthereum
  ? "I confirm deployment to Ethereum mainnet chain 1"
  : "I confirm deployment to Robinhood Chain 4663";
const packageRoot = path.join(__dirname, "..");
const deploymentsDir = path.join(packageRoot, "deployments");
const manifestPath = path.join(deploymentsDir, `${chainId}.json`);
const progressPath = path.join(deploymentsDir, `${chainId}.multichain-core.partial.json`);
const dryRun = process.argv.includes("--dry-run");
const deployOnly = process.argv.includes("--deploy-only");
const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const artifacts = {
  factory: "contracts/ArmoreumFactory.sol/ArmoreumFactory.json",
  vaultFactory: "contracts/VaultFactory.sol/VaultFactory.json",
  taxRouter: "contracts/TaxRouter.sol/TaxRouter.json",
  multichainVault: "contracts/bridge/ArmoreumMultichainVault.sol/ArmoreumMultichainVault.json",
  launchModule:
    "contracts/bridge/ArmoreumMultichainLaunchModule.sol/ArmoreumMultichainLaunchModule.json",
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Required secret/environment variable ${name} is missing`);
  return value;
}

function readArtifact(relativePath) {
  const artifact = JSON.parse(fs.readFileSync(path.join(packageRoot, "artifacts", relativePath), "utf8"));
  artifact.__relativePath = relativePath;
  return artifact;
}

function compilerOutputForArtifact(artifact) {
  const match = artifact.__relativePath.match(/^(.+\.sol)\/([^/]+)\.json$/);
  if (!match) throw new Error(`Cannot find compiler output for ${artifact.__relativePath}`);
  const [, sourceName, contractName] = match;
  const targetBytecode = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const buildInfoDirectory = path.join(packageRoot, "artifacts", "build-info");
  for (const fileName of fs.readdirSync(buildInfoDirectory).filter((name) => name.endsWith(".json"))) {
    const buildInfo = JSON.parse(fs.readFileSync(path.join(buildInfoDirectory, fileName), "utf8"));
    const contractOutput = buildInfo.output?.contracts?.[sourceName]?.[contractName];
    if (
      contractOutput?.evm?.deployedBytecode?.object?.replace(/^0x/, "").toLowerCase()
        === targetBytecode
    ) return contractOutput;
  }
  throw new Error(`Compiler build info is missing for ${artifact.__relativePath}`);
}

function runtimeCodeAtAddress(artifact, address) {
  const normalizedAddress = getAddress(address).slice(2).toLowerCase();
  let code = artifact.deployedBytecode.replace(/^0x/, "").toLowerCase();
  const references = compilerOutputForArtifact(artifact).evm.deployedBytecode.immutableReferences || {};
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

function readJson(filePath, fallback) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : fallback;
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

function recordByName(manifest, name) {
  const record = manifest.contracts.find((entry) => entry.name === name);
  if (!record?.address) throw new Error(`Deployment manifest is missing ${name}`);
  return record;
}

async function liveImplementation(provider, proxy) {
  const word = await provider.getStorage(proxy, implementationSlot);
  return getAddress(`0x${word.slice(-40)}`);
}

function artifactInitCode(artifact) {
  const constructor = artifact.abi.find((item) => item.type === "constructor");
  if (constructor?.inputs?.length) {
    throw new Error(`Expected ${artifact.contractName} to have no constructor arguments`);
  }
  if (!/^0x[0-9a-fA-F]+$/.test(artifact.bytecode)) {
    throw new Error(`${artifact.contractName} bytecode is missing or linked`);
  }
  return artifact.bytecode;
}

async function transactionFees(provider) {
  const [block, feeData] = await Promise.all([
    provider.getBlock("latest"),
    provider.getFeeData(),
  ]);
  const baseFee = block?.baseFeePerGas ?? feeData.gasPrice ?? 0n;
  if (baseFee <= 0n) throw new Error("Could not read a usable current base fee");
  if (isEthereum) {
    return feeData.gasPrice && feeData.gasPrice > 0n
      ? feeData.gasPrice
      : (baseFee * 120n) / 100n;
  }
  const robinhoodCap = (baseFee * 120n) / 100n;
  return robinhoodCap;
}

async function sendTransaction(provider, signer, to, data, feePrice, label) {
  const from = await signer.getAddress();
  const request = { from, to, data, gasPrice: feePrice };
  const estimate = await provider.estimateGas(request);
  const gasLimit = (estimate * 120n) / 100n;
  await provider.call({ ...request, gasLimit });
  const balance = await provider.getBalance(from);
  if (balance < gasLimit * feePrice) {
    throw new Error(`${label} cannot be funded at the live gas estimate`);
  }
  if (!broadcast) {
    return {
      simulated: true,
      from,
      to,
      gasLimit: gasLimit.toString(),
      gasPrice: feePrice.toString(),
    };
  }
  const tx = await signer.sendTransaction({ to, data, gasLimit, gasPrice: feePrice });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} transaction failed`);
  process.stdout.write(`${JSON.stringify({
    confirmed: label,
    chainId: chainId.toString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  })}\n`);
  return {
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function deployImplementation(provider, signer, create2Address, feePrice, progress, name, artifactPath) {
  const artifact = readArtifact(artifactPath);
  const initCode = artifactInitCode(artifact);
  const initCodeHash = keccak256(initCode);
  const saltFile = path.join(
    deploymentsDir,
    `${chainId}.vanity`,
    `multichain-${name.toLowerCase()}.json`,
  );
  const mined = await mineVanitySalt({
    deployer: create2Address,
    initCode,
    stateFile: saltFile,
    maxAttempts: 2_000_000,
  });
  const address = getAddress(getCreate2Address(create2Address, mined.salt, initCodeHash));
  if (address.toLowerCase() !== mined.address.toLowerCase() || !address.startsWith(PREFIX)) {
    throw new Error(`${name} vanity address derivation failed`);
  }

  const existingCode = await provider.getCode(address);
  if (existingCode !== "0x") {
    const actualHash = keccak256(existingCode);
    const expectedHash = keccak256(runtimeCodeAtAddress(artifact, address));
    if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(`${name} predicted address already contains unexpected bytecode`);
    }
    const recovered = {
      label: name,
      address,
      salt: mined.salt,
      initCodeHash,
      runtimeCodeHash: actualHash,
      alreadyDeployed: true,
      ...(progress.deployments[name] || {}),
    };
    if (progress.deployments[name]?.transactionHash) {
      const receipt = await provider.getTransactionReceipt(progress.deployments[name].transactionHash);
      if (
        receipt?.status !== 1
          || progress.deployments[name].address?.toLowerCase() !== address.toLowerCase()
      ) throw new Error(`${name} saved deployment receipt does not match live bytecode`);
    }
    return recovered;
  }

  const data = encodeCreate2Deployment(mined.salt, initCode);
  const simulation = await sendTransaction(
    provider,
    signer,
    create2Address,
    data,
    feePrice,
    `deploy-${name}`,
  );
  if (broadcast) {
    const runtimeCode = await provider.getCode(address);
    const runtimeCodeHash = keccak256(runtimeCode);
    const expectedRuntimeHash = keccak256(runtimeCodeAtAddress(artifact, address));
    if (runtimeCode === "0x" || runtimeCodeHash.toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
      throw new Error(`${name} deployed runtime does not match compiled bytecode`);
    }
    const record = {
      label: name,
      address,
      salt: mined.salt,
      deployer: create2Address,
      initCodeHash,
      runtimeCodeHash,
      transactionHash: simulation.transactionHash,
      blockNumber: simulation.blockNumber,
    };
    progress.deployments[name] = record;
    writeJsonAtomic(progressPath, progress);
    return record;
  }
  return {
    label: name,
    address,
    salt: mined.salt,
    initCodeHash,
    runtimeCodeHash: keccak256(artifact.deployedBytecode),
    ...simulation,
  };
}

async function upgradeProxy(provider, signer, proxyAddress, newImplementation, artifact, feePrice, progress, name) {
  const current = await liveImplementation(provider, proxyAddress);
  if (current.toLowerCase() === newImplementation.toLowerCase()) return { alreadyUpgraded: true };
  const contract = new Contract(proxyAddress, artifact.abi, signer);
  const data = contract.interface.encodeFunctionData("upgradeToAndCall", [
    newImplementation,
    "0x",
  ]);
  const result = await sendTransaction(
    provider,
    signer,
    proxyAddress,
    data,
    feePrice,
    `upgrade-${name}`,
  );
  if (!broadcast) return result;
  const next = await liveImplementation(provider, proxyAddress);
  if (next.toLowerCase() !== newImplementation.toLowerCase()) {
    throw new Error(`${name} proxy implementation slot did not update`);
  }
  const record = { implementation: next, ...result };
  progress.upgrades[name] = record;
  writeJsonAtomic(progressPath, progress);
  return record;
}

async function main() {
  if (broadcast && process.env[confirmationKey] !== confirmationValue) {
    throw new Error(`Explicit ${confirmationValue} confirmation is required`);
  }
  if (dryRun && broadcast) throw new Error("Dry-run and broadcast cannot be enabled together");
  if (!dryRun && !broadcast) {
    throw new Error("Use --dry-run for simulation or ARMOREUM_DEPLOY_BROADCAST=YES to broadcast");
  }
  const rpcUrl = requiredEnv(rpcKey);
  const deployerKey = requiredEnv("DEPLOYER_PRIVATE_KEY");
  const emergencyKey = requiredEnv("PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY");
  const create2Address = getAddress(requiredEnv(create2AddressKey));
  const expectedCreate2Hash = requiredEnv(create2HashKey);
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedCreate2Hash)) {
    throw new Error("Configured CREATE2 runtime hash is invalid");
  }
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const signer = new Wallet(deployerKey, provider);
  const emergency = new Wallet(emergencyKey).address;
  const manifest = readJson(manifestPath, null);
  if (!manifest || BigInt(manifest.chainId) !== chainId) {
    throw new Error("Deployment manifest chain ID does not match target");
  }
  if (manifest.authorities?.canonicalPlatformOwner?.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not the registered canonical platform owner");
  }
  if (
    manifest.authorities?.emergencyOperator?.toLowerCase() !== emergency.toLowerCase()
      || emergency.toLowerCase() === signer.address.toLowerCase()
  ) throw new Error("Emergency signer does not match the manifest or is not separated");
  if (BigInt((await provider.getNetwork()).chainId) !== chainId) {
    throw new Error(`RPC chain ID does not match ${chainId}`);
  }
  const create2Code = await provider.getCode(create2Address);
  if (
    create2Code === "0x"
      || keccak256(create2Code).toLowerCase() !== expectedCreate2Hash.toLowerCase()
      || manifest.externalIntegrations?.create2Deployer?.address?.toLowerCase()
        !== create2Address.toLowerCase()
  ) throw new Error("Live CREATE2 deployer does not match the verified manifest");

  const progress = readJson(progressPath, {
    chainId: Number(chainId),
    network: isEthereum ? "Ethereum Mainnet" : "Robinhood Chain Mainnet",
    deployments: {},
    upgrades: {},
    configuration: {},
  });
  if (progress.chainId !== Number(chainId)) throw new Error("Progress file belongs to another chain");
  const factoryProxy = recordByName(manifest, "ArmoreumFactory-proxy");
  const vaultFactoryProxy = recordByName(manifest, "VaultFactory-proxy");
  const expectedFactoryImplementation = recordByName(manifest, "ArmoreumFactory-implementation");
  const expectedVaultImplementation = recordByName(manifest, "VaultFactory-implementation");
  const [factoryImpl, vaultImpl] = await Promise.all([
    liveImplementation(provider, factoryProxy.address),
    liveImplementation(provider, vaultFactoryProxy.address),
  ]);
  const factoryUpgradeRecord = progress.upgrades.ArmoreumFactory;
  const vaultUpgradeRecord = progress.upgrades.VaultFactory;
  const factoryReceipt = factoryUpgradeRecord?.transactionHash
    ? await provider.getTransactionReceipt(factoryUpgradeRecord.transactionHash)
    : null;
  const vaultReceipt = vaultUpgradeRecord?.transactionHash
    ? await provider.getTransactionReceipt(vaultUpgradeRecord.transactionHash)
    : null;
  const factoryMatchesProgress = factoryReceipt?.status === 1
    && factoryUpgradeRecord.implementation?.toLowerCase() === factoryImpl.toLowerCase();
  const vaultMatchesProgress = vaultReceipt?.status === 1
    && vaultUpgradeRecord.implementation?.toLowerCase() === vaultImpl.toLowerCase();
  if (
    factoryImpl.toLowerCase() !== expectedFactoryImplementation.address.toLowerCase()
      && !factoryMatchesProgress
  ) {
    throw new Error("Live ArmoreumFactory implementation differs from the manifest");
  }
  if (
    vaultImpl.toLowerCase() !== expectedVaultImplementation.address.toLowerCase()
      && !vaultMatchesProgress
  ) {
    throw new Error("Live VaultFactory implementation differs from the manifest");
  }
  for (const [record, label] of [
    [factoryProxy, "ArmoreumFactory proxy"],
    [vaultFactoryProxy, "VaultFactory proxy"],
    [expectedFactoryImplementation, "ArmoreumFactory implementation"],
    [expectedVaultImplementation, "VaultFactory implementation"],
  ]) {
    const code = await provider.getCode(record.address);
    if (code === "0x" || keccak256(code).toLowerCase() !== record.runtimeCodeHash.toLowerCase()) {
      throw new Error(`${label} live code differs from the deployment manifest`);
    }
  }

  const feePrice = await transactionFees(provider);
  const deployPlan = [];
  for (const [name, artifactPath] of Object.entries(artifacts)) {
    deployPlan.push(
      await deployImplementation(
        provider,
        signer,
        create2Address,
        feePrice,
        progress,
        name,
        artifactPath,
      ),
    );
  }
  const next = Object.fromEntries(deployPlan.map((entry) => [entry.label, entry.address]));
  if (deployOnly) {
    if (!broadcast) throw new Error("--deploy-only requires ARMOREUM_DEPLOY_BROADCAST=YES");
    manifest.multichainStaging = {
      status: "inert implementation contracts deployed; proxy upgrades not yet applied",
      chainId: chainId.toString(),
      implementations: next,
    };
    for (const [deploymentKey, contractName] of [
      ["factory", "ArmoreumFactory-implementation-multichain-candidate"],
      ["vaultFactory", "VaultFactory-implementation-multichain-candidate"],
      ["taxRouter", "TaxRouter-implementation-multichain-candidate"],
      ["multichainVault", "ArmoreumMultichainVault-implementation"],
      ["launchModule", "ArmoreumMultichainLaunchModule"],
    ]) {
      const deployment = progress.deployments[deploymentKey] || deployPlan.find((entry) => entry.label === deploymentKey);
      if (!manifest.contracts.some((entry) => entry.name === contractName && entry.address.toLowerCase() === deployment.address.toLowerCase())) {
        manifest.contracts.push({
          name: contractName,
          address: deployment.address,
          runtimeCodeHash: deployment.runtimeCodeHash,
          transactionHash: deployment.transactionHash || null,
          blockNumber: deployment.blockNumber || null,
          sourceVerification: "pending",
        });
      }
    }
    writeJsonAtomic(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify({
      state: "inert-mainnet-implementations-deployed",
      chainId: chainId.toString(),
      deployments: deployPlan,
      note: "Existing proxies and launch behavior were not changed in this phase.",
    }, null, 2)}\n`);
    return;
  }
  if (dryRun) {
    const [factory, vaultFactory] = await Promise.all([
      new Contract(factoryProxy.address, readArtifact(artifacts.factory).abi, signer),
      new Contract(vaultFactoryProxy.address, readArtifact(artifacts.vaultFactory).abi, signer),
    ]);
    const [owner, vaultFactoryAddress, factoryVersion, vaultVersion, factoryRouter, registryRouter, creatorVault] = await Promise.all([
      factory.canonicalOwner(),
      factory.vaultFactory(),
      factory.implementationVersion(),
      vaultFactory.implementationVersion(),
      factory.taxRouterImplementation(),
      vaultFactory.feeVaultImplementation(),
      factory.vaultImplementation(),
    ]);
    if (owner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error("Live ArmoreumFactory owner differs from the signer");
    }
    if (vaultFactoryAddress.toLowerCase() !== vaultFactoryProxy.address.toLowerCase()) {
      throw new Error("ArmoreumFactory does not point to the manifest VaultFactory");
    }
    if (await provider.getCode(next.factory) !== "0x" && factoryImpl.toLowerCase() !== next.factory.toLowerCase()) {
      await factory.upgradeToAndCall.staticCall(next.factory, "0x");
      await factory.upgradeToAndCall.estimateGas(next.factory, "0x");
    }
    if (await provider.getCode(next.vaultFactory) !== "0x" && vaultImpl.toLowerCase() !== next.vaultFactory.toLowerCase()) {
      await vaultFactory.upgradeToAndCall.staticCall(next.vaultFactory, "0x");
      await vaultFactory.upgradeToAndCall.estimateGas(next.vaultFactory, "0x");
    }
    if (
      factoryRouter.toLowerCase() !== next.taxRouter.toLowerCase()
        || registryRouter.toLowerCase() !== next.taxRouter.toLowerCase()
    ) {
      const version = [BigInt(factoryVersion), BigInt(vaultVersion)]
        .reduce((max, value) => (value > max ? value : max), 0n) + 1n;
      if (await provider.getCode(next.taxRouter) !== "0x") {
        await factory.approveImplementations.staticCall(creatorVault, next.taxRouter, version);
        await vaultFactory.setImplementations.staticCall(creatorVault, next.taxRouter, version);
      }
    }
    process.stdout.write(`${JSON.stringify({
      state: "simulated-only",
      chainId: chainId.toString(),
      signer: signer.address,
      feePrice: feePrice.toString(),
      deployments: deployPlan,
      upgrades: {
        ArmoreumFactory: { proxy: factoryProxy.address, from: factoryImpl, to: next.factory },
        VaultFactory: { proxy: vaultFactoryProxy.address, from: vaultImpl, to: next.vaultFactory },
      },
      configuration: {
        multichainVaultImplementation: next.multichainVault,
        launchModule: next.launchModule,
        taxRouterImplementation: next.taxRouter,
      },
      implementationVersions: {
        factory: factoryVersion.toString(),
        vaultFactory: vaultVersion.toString(),
      },
      staticSimulations: [
        "CREATE2 deployment calls",
        "UUPS and TaxRouter pointer calls only when their candidate code is already deployed",
      ],
    }, null, 2)}\n`);
    return;
  }

  const factoryArtifact = readArtifact(artifacts.factory);
  const vaultFactoryArtifact = readArtifact(artifacts.vaultFactory);
  const factory = new Contract(factoryProxy.address, factoryArtifact.abi, signer);
  const vaultFactory = new Contract(vaultFactoryProxy.address, vaultFactoryArtifact.abi, signer);

  const creatorVaultBeforeUpgrade = await factory.vaultImplementation();
  const preflightVersion = BigInt(
    progress.configuration.taxRouterVersion
      || ([BigInt(await factory.implementationVersion()), BigInt(await vaultFactory.implementationVersion())]
        .reduce((max, value) => (value > max ? value : max), 0n) + 1n).toString(),
  );
  for (const [contract, method, args, getter] of [
    [factory, "approveImplementations", [creatorVaultBeforeUpgrade, next.taxRouter, preflightVersion], "taxRouterImplementation"],
    [vaultFactory, "setImplementations", [creatorVaultBeforeUpgrade, next.taxRouter, preflightVersion], "feeVaultImplementation"],
  ]) {
    if ((await contract[getter]()).toLowerCase() !== next.taxRouter.toLowerCase()) {
      await contract[method].staticCall(...args);
    }
  }
  progress.configuration.taxRouterVersion = preflightVersion.toString();
  writeJsonAtomic(progressPath, progress);
  for (const [contract, implementation, name] of [
    [vaultFactory, next.vaultFactory, "VaultFactory"],
    [factory, next.factory, "ArmoreumFactory"],
  ]) {
    if ((await liveImplementation(provider, await contract.getAddress())).toLowerCase() !== implementation.toLowerCase()) {
      await contract.upgradeToAndCall.staticCall(implementation, "0x");
      await contract.upgradeToAndCall.estimateGas(implementation, "0x");
    }
  }

  for (const [label, proxy, implementation, artifact] of [
    ["VaultFactory", vaultFactoryProxy.address, next.vaultFactory, vaultFactoryArtifact],
    ["ArmoreumFactory", factoryProxy.address, next.factory, factoryArtifact],
  ]) {
    await upgradeProxy(provider, signer, proxy, implementation, artifact, feePrice, progress, label);
  }

  const [factoryOwner, registryOwner] = await Promise.all([
    factory.canonicalOwner(),
    vaultFactory.canonicalOwner(),
  ]);
  if (
    factoryOwner.toLowerCase() !== signer.address.toLowerCase()
      || registryOwner.toLowerCase() !== signer.address.toLowerCase()
  ) throw new Error("Canonical owner changed during the upgrades");

  const creatorVaultImplementation = await factory.vaultImplementation();
  const version = BigInt(progress.configuration.taxRouterVersion);
  const pointerUpdates = [
    {
      contract: factory,
      method: "approveImplementations",
      args: [creatorVaultImplementation, next.taxRouter, version],
      getter: "taxRouterImplementation",
      key: "factory-tax-router",
    },
    {
      contract: vaultFactory,
      method: "setImplementations",
      args: [creatorVaultImplementation, next.taxRouter, version],
      getter: "feeVaultImplementation",
      key: "vault-factory-tax-router",
    },
  ];
  for (const { contract, method, args, getter, key } of pointerUpdates) {
    if ((await contract[getter]()).toLowerCase() === next.taxRouter.toLowerCase()) continue;
    await contract[method].staticCall(...args);
    const data = contract.interface.encodeFunctionData(method, args);
    const result = await sendTransaction(
      provider, signer, await contract.getAddress(), data, feePrice, `configure-${key}`,
    );
    if (broadcast) {
      progress.configuration[key] = result;
      writeJsonAtomic(progressPath, progress);
    }
  }

  let registeredModule = await factory.multichainLaunchModule();
  if (registeredModule === "0x0000000000000000000000000000000000000000") {
    await factory.setMultichainLaunchModule.staticCall(next.launchModule);
    const data = factory.interface.encodeFunctionData("setMultichainLaunchModule", [next.launchModule]);
    const result = await sendTransaction(
      provider, signer, factoryProxy.address, data, feePrice, "configure-launch-module",
    );
    if (broadcast) {
      progress.configuration.launchModule = result;
      writeJsonAtomic(progressPath, progress);
    }
    registeredModule = await factory.multichainLaunchModule();
  }
  if (registeredModule.toLowerCase() !== next.launchModule.toLowerCase()) {
    throw new Error("ArmoreumFactory Multichain module pointer differs from deployment plan");
  }

  const configuredVaultImplementation = await vaultFactory.multichainVaultImplementation();
  if (configuredVaultImplementation.toLowerCase() !== next.multichainVault.toLowerCase()) {
    const currentVersion = BigInt(await vaultFactory.multichainVaultImplementationVersion());
    const data = vaultFactory.interface.encodeFunctionData(
      "setMultichainVaultImplementation",
      [next.multichainVault, currentVersion + 1n],
    );
    await vaultFactory.setMultichainVaultImplementation.staticCall(
      next.multichainVault, currentVersion + 1n,
    );
    const result = await sendTransaction(
      provider, signer, vaultFactoryProxy.address, data, feePrice, "configure-multichain-vault",
    );
    if (broadcast) {
      progress.configuration.multichainVault = result;
      writeJsonAtomic(progressPath, progress);
    }
  }

  const verifiedPointers = {
    factoryImplementation: await liveImplementation(provider, factoryProxy.address),
    vaultFactoryImplementation: await liveImplementation(provider, vaultFactoryProxy.address),
    launchModule: await factory.multichainLaunchModule(),
    multichainVaultImplementation: await vaultFactory.multichainVaultImplementation(),
    taxRouterFactory: await factory.taxRouterImplementation(),
    taxRouterRegistry: await vaultFactory.feeVaultImplementation(),
  };
  if (
    verifiedPointers.factoryImplementation.toLowerCase() !== next.factory.toLowerCase()
      || verifiedPointers.vaultFactoryImplementation.toLowerCase() !== next.vaultFactory.toLowerCase()
      || verifiedPointers.launchModule.toLowerCase() !== next.launchModule.toLowerCase()
      || verifiedPointers.multichainVaultImplementation.toLowerCase() !== next.multichainVault.toLowerCase()
      || verifiedPointers.taxRouterFactory.toLowerCase() !== next.taxRouter.toLowerCase()
      || verifiedPointers.taxRouterRegistry.toLowerCase() !== next.taxRouter.toLowerCase()
  ) throw new Error("A configured Multichain mainnet pointer failed read-back verification");

  const activeContracts = [
    ["factory", "ArmoreumFactory-implementation"],
    ["vaultFactory", "VaultFactory-implementation"],
    ["taxRouter", "TaxRouter-implementation"],
  ];
  for (const [deploymentKey, activeName] of activeContracts) {
    const deployment = deployPlan.find((entry) => entry.label === deploymentKey);
    const recorded = progress.deployments[deploymentKey] || deployment;
    const previous = manifest.contracts.find((entry) => entry.name === activeName);
    if (previous && previous.address.toLowerCase() !== recorded.address.toLowerCase()) {
      previous.name = `${activeName}-before-multichain-${previous.runtimeCodeHash.slice(2, 10)}`;
    }
    if (previous?.address.toLowerCase() !== recorded.address.toLowerCase()) {
      manifest.contracts.push({
        name: activeName,
        address: recorded.address,
        runtimeCodeHash: recorded.runtimeCodeHash,
        transactionHash: recorded.transactionHash || null,
        blockNumber: recorded.blockNumber || null,
        sourceVerification: "pending",
      });
    }
  }
  for (const [deploymentKey, contractName] of [
    ["multichainVault", "ArmoreumMultichainVault-implementation"],
    ["launchModule", "ArmoreumMultichainLaunchModule"],
  ]) {
    const deployment = progress.deployments[deploymentKey] || deployPlan.find((entry) => entry.label === deploymentKey);
    if (!manifest.contracts.some((entry) => entry.name === contractName && entry.address.toLowerCase() === deployment.address.toLowerCase())) {
      manifest.contracts.push({
        name: contractName,
        address: deployment.address,
        runtimeCodeHash: deployment.runtimeCodeHash,
        transactionHash: deployment.transactionHash || null,
        blockNumber: deployment.blockNumber || null,
        sourceVerification: "pending",
      });
    }
  }
  manifest.multichainCore = {
    status: "core deployed and configured; bridge transport not activated",
    factoryProxy: factoryProxy.address,
    vaultFactoryProxy: vaultFactoryProxy.address,
    launchModule: verifiedPointers.launchModule,
    multichainVaultImplementation: verifiedPointers.multichainVaultImplementation,
    taxRouterImplementation: verifiedPointers.taxRouterFactory,
    bridgeActivated: false,
  };
  writeJsonAtomic(manifestPath, manifest);

  process.stdout.write(`${JSON.stringify({
    state: "mainnet-core-configured",
    chainId: chainId.toString(),
    signer: signer.address,
    deployments: deployPlan,
    pointers: verifiedPointers,
    note: "No OApp pair is activated by this script; outbound and inbound bridge remain disabled.",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
