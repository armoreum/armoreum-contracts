const fs = require("node:fs");
const path = require("node:path");
const {
  Contract,
  ZeroHash,
  getAddress,
  keccak256,
} = require("ethers");
const hre = require("hardhat");
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const manifestPath = path.join(__dirname, "../deployments/1.json");
const progressPath = path.join(__dirname, "../deployments/1.ethereum-future-tax-70.partial.json");
const searchPath = path.join(__dirname, "../deployments/1.vanity/ethereum-future-tax-70.json");
const create2Address = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const protectedHashRouter = getAddress("0x0cAA8Af1Cb8EB9057b5554C79c94d8699D85C90C");
const expectedOldBaseTaxBps = 100n;
const targetBaseTaxBps = 70n;
const UUPS_UUID = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EXECUTE_ENV = "ARMOREUM_EXECUTE_ETHEREUM_FUTURE_TAX_70";

const factoryAbi = [
  "function canonicalOwner() view returns(address)",
  "function vaultFactory() view returns(address)",
  "function vaultImplementation() view returns(address)",
  "function taxRouterImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function approveImplementations(address,address,uint256)",
];
const vaultFactoryAbi = [
  "function canonicalOwner() view returns(address)",
  "function creatorVaultImplementation() view returns(address)",
  "function feeVaultImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function setImplementations(address,address,uint256)",
];
const taxRouterAbi = [
  "function BASE_TAX_BPS() view returns(uint16)",
  "function proxiableUUID() view returns(bytes32)",
];

function saveJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function declarationName(node, wantedId) {
  if (!node || typeof node !== "object") return undefined;
  if (node.id === Number(wantedId) && node.nodeType === "VariableDeclaration") return node.name;
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

function compiledRuntimeAtAddress(build, address) {
  const output = build.output.contracts["contracts/TaxRouter.sol"].TaxRouter;
  let runtime = output.evm.deployedBytecode.object;
  for (const [variableId, references] of Object.entries(output.evm.deployedBytecode.immutableReferences ?? {})) {
    const name = Object.values(build.output.sources)
      .map((source) => declarationName(source.ast, variableId))
      .find(Boolean);
    if (name !== "__self") throw new Error(`Unexpected immutable in TaxRouter: ${name || variableId}`);
    const encoded = address.slice(2).toLowerCase().padStart(64, "0");
    for (const reference of references) {
      if (reference.length !== 32) throw new Error("Unexpected UUPS self-address width.");
      const start = reference.start * 2;
      runtime = runtime.slice(0, start) + encoded + runtime.slice(start + 64);
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
      ...(type.members ? {
        members: type.members.map((member) => ({
          label: member.label,
          slot: member.slot,
          offset: member.offset,
          type: shape(member.type),
        })),
      } : {}),
    };
  }
  return JSON.stringify(layout.storage.map((entry) => ({
    label: entry.label,
    slot: entry.slot,
    offset: entry.offset,
    type: shape(entry.type),
  })));
}

function paddedGas(gas) {
  return (gas * 120n + 99n) / 100n + 30_000n;
}

async function main() {
  const execute = process.env[EXECUTE_ENV] === "YES";
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1) throw new Error("Deployment manifest is not Ethereum mainnet.");

  const artifact = await hre.artifacts.readArtifact("TaxRouter");
  const build = await hre.artifacts.getBuildInfo("contracts/TaxRouter.sol:TaxRouter");
  if (!build) throw new Error("Current TaxRouter build information is missing; compile first.");
  for (const [sourceName, source] of Object.entries(build.input.sources)) {
    const localSource = path.join(__dirname, "..", sourceName);
    if (sourceName.startsWith("contracts/") && fs.existsSync(localSource) &&
        fs.readFileSync(localSource, "utf8") !== source.content) {
      throw new Error(`Compiled artifact is stale for ${sourceName}; no transaction was submitted.`);
    }
  }
  if (!/^0x[\da-f]+$/i.test(artifact.bytecode) || !/^0x[\da-f]+$/i.test(artifact.deployedBytecode)) {
    throw new Error("Compiled TaxRouter bytecode is unresolved.");
  }
  const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
  if (runtimeBytes > 24_576) throw new Error("TaxRouter exceeds the EVM runtime-size limit.");

  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) throw new Error("Configured provider is not Ethereum mainnet.");
  const [signer] = await hre.ethers.getSigners();
  const signerAddress = getAddress(await signer.getAddress());
  const factoryRecord = manifest.contracts.find((entry) => entry.name === "ArmoreumFactory-proxy");
  if (!factoryRecord) throw new Error("Ethereum ArmoreumFactory proxy is missing from the manifest.");
  const factoryAddress = getAddress(factoryRecord.address);
  const vaultFactoryAddress = getAddress(manifest.vaultFactory.address);
  const factory = new Contract(factoryAddress, factoryAbi, signer);
  const vaultFactory = new Contract(vaultFactoryAddress, vaultFactoryAbi, signer);

  const [
    factoryCode,
    vaultFactoryCode,
    factoryOwner,
    vaultOwner,
    factoryAdmin,
    vaultAdmin,
    factoryVaultFactory,
    factoryCreator,
    factoryTax,
    vaultCreator,
    vaultTax,
    factoryVersion,
    vaultVersion,
  ] = await Promise.all([
    provider.getCode(factoryAddress),
    provider.getCode(vaultFactoryAddress),
    factory.canonicalOwner(),
    vaultFactory.canonicalOwner(),
    factory.hasRole(ZeroHash, signerAddress),
    vaultFactory.hasRole(ZeroHash, signerAddress),
    factory.vaultFactory(),
    factory.vaultImplementation(),
    factory.taxRouterImplementation(),
    vaultFactory.creatorVaultImplementation(),
    vaultFactory.feeVaultImplementation(),
    factory.implementationVersion(),
    vaultFactory.implementationVersion(),
  ]);
  if (factoryCode === "0x" || vaultFactoryCode === "0x") throw new Error("Ethereum factory proxy code is missing.");
  if (
    getAddress(factoryOwner) !== signerAddress ||
    getAddress(vaultOwner) !== signerAddress ||
    !factoryAdmin ||
    !vaultAdmin
  ) throw new Error("Configured Ethereum deployer is not the canonical admin of both launch factories.");
  if (getAddress(factoryVaultFactory) !== vaultFactoryAddress) {
    throw new Error("ArmoreumFactory does not point to the manifest VaultFactory.");
  }
  if (getAddress(factoryCreator) !== getAddress(vaultCreator)) {
    throw new Error("Creator-vault implementation pointers already disagree.");
  }

  const hashRouter = new Contract(protectedHashRouter, taxRouterAbi, provider);
  const hashRouterBaseTax = BigInt(await hashRouter.BASE_TAX_BPS());
  if (hashRouterBaseTax !== expectedOldBaseTaxBps) {
    throw new Error("HASH router no longer has the expected 1% base tax; refusing to change any pointers.");
  }

  const taxImplementationArtifact = manifest.contracts.find((entry) => entry.name === "TaxRouter-implementation");
  const previousTaxImplementation = getAddress(
    taxImplementationArtifact?.address ?? vaultTax,
  );
  const currentFactoryTax = getAddress(factoryTax);
  const currentVaultTax = getAddress(vaultTax);
  const currentFactoryVersion = BigInt(factoryVersion);
  const currentVaultVersion = BigInt(vaultVersion);
  const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, "utf8")) : {};

  const create2Code = await provider.getCode(create2Address);
  const expectedCreate2Hash = manifest.externalIntegrations.create2Deployer.runtimeCodeHash.toLowerCase();
  if (!create2Code || create2Code === "0x" || keccak256(create2Code).toLowerCase() !== expectedCreate2Hash) {
    throw new Error("CREATE2 deployer code does not match the registered Ethereum mainnet address.");
  }

  const mined = await mineVanitySalt({
    deployer: create2Address,
    initCode: artifact.bytecode,
    stateFile: searchPath,
  });
  const target = getAddress(mined.address);
  const expectedRuntime = compiledRuntimeAtAddress(build, target);
  const expectedRuntimeHash = keccak256(expectedRuntime);
  const targetCode = await provider.getCode(target);
  if (targetCode !== "0x" && keccak256(targetCode).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error("Deterministic TaxRouter address is occupied by different bytecode.");
  }
  if (progress.targetImplementation && getAddress(progress.targetImplementation) !== target) {
    throw new Error("Saved partial upgrade targets different compiled bytecode.");
  }

  const implementation = new Contract(target, taxRouterAbi, provider);
  if (targetCode !== "0x" && BigInt(await implementation.BASE_TAX_BPS()) !== targetBaseTaxBps) {
    throw new Error("Existing deterministic TaxRouter implementation does not expose 0.7% base tax.");
  }

  if (
    currentFactoryTax === target &&
    currentVaultTax === target &&
    BigInt(await implementation.BASE_TAX_BPS()) === targetBaseTaxBps
  ) {
    if (hashRouterBaseTax !== expectedOldBaseTaxBps) throw new Error("Protected HASH router changed unexpectedly.");
    console.log(JSON.stringify({
      mode: "already configured",
      chainId: 1,
      futureLaunchTaxBps: String(targetBaseTaxBps),
      implementation: target,
      hashRouterBaseTaxBps: String(hashRouterBaseTax),
      factoryVersion: String(currentFactoryVersion),
      vaultFactoryVersion: String(currentVaultVersion),
    }, null, 2));
    return;
  }

  if (
    (currentFactoryTax !== previousTaxImplementation && currentFactoryTax !== target) ||
    (currentVaultTax !== previousTaxImplementation && currentVaultTax !== target)
  ) throw new Error("A live TaxRouter pointer is neither the known current implementation nor this target.");

  const desiredVersion = BigInt(progress.targetVersion ?? (Math.max(
    Number(currentFactoryVersion), Number(currentVaultVersion),
  ) + 1));
  for (const version of [currentFactoryVersion, currentVaultVersion]) {
    if (version !== desiredVersion && version + 1n !== desiredVersion) {
      throw new Error("Factory implementation versions do not match a safe resumable pointer update.");
    }
  }
  if (currentFactoryTax === target && currentFactoryVersion !== desiredVersion) {
    throw new Error("Factory pointer/version state is inconsistent with the saved upgrade.");
  }
  if (currentVaultTax === target && currentVaultVersion !== desiredVersion) {
    throw new Error("VaultFactory pointer/version state is inconsistent with the saved upgrade.");
  }
  if (currentFactoryTax !== target && currentFactoryVersion + 1n !== desiredVersion) {
    throw new Error("Factory version is not ready for the next implementation pointer.");
  }
  if (currentVaultTax !== target && currentVaultVersion + 1n !== desiredVersion) {
    throw new Error("VaultFactory version is not ready for the next implementation pointer.");
  }

  const latestBuildFiles = fs.readdirSync(path.join(__dirname, "../artifacts/build-info"))
    .filter((name) => name.endsWith(".json"));
  const activeCode = await provider.getCode(previousTaxImplementation);
  let previousBuild;
  for (const filename of latestBuildFiles) {
    const candidate = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/build-info", filename), "utf8"));
    if (!candidate.output?.contracts?.["contracts/TaxRouter.sol"]?.TaxRouter) continue;
    try {
      if (keccak256(compiledRuntimeAtAddress(candidate, previousTaxImplementation)).toLowerCase() ===
          keccak256(activeCode).toLowerCase()) {
        previousBuild = candidate;
        break;
      }
    } catch {}
  }
  if (!previousBuild) throw new Error("No compiler build matches the current Ethereum TaxRouter implementation.");
  const currentLayout = build.output.contracts["contracts/TaxRouter.sol"].TaxRouter.storageLayout;
  const previousLayout = previousBuild.output.contracts["contracts/TaxRouter.sol"].TaxRouter.storageLayout;
  if (!currentLayout || !previousLayout ||
      canonicalStorageLayout(currentLayout) !== canonicalStorageLayout(previousLayout)) {
    throw new Error("New TaxRouter storage layout differs from the current Ethereum implementation.");
  }

  const feeWei = BigInt(await provider.send("eth_gasPrice", []));
  const hash = keccak256(artifact.bytecode);
  if (mined.initCodeHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error("CREATE2 salt search does not match the compiled init code.");
  }
  const deployData = encodeCreate2Deployment(mined.salt, artifact.bytecode);
  const deployEstimate = targetCode === "0x"
    ? await provider.estimateGas({ from: signerAddress, to: create2Address, data: deployData, gasPrice: feeWei })
    : 0n;
  const currentCreator = getAddress(vaultCreator);
  const activeTaxForPreflight = getAddress(vaultTax);
  if (currentFactoryTax !== target) {
    await factory.approveImplementations.staticCall(currentCreator, activeTaxForPreflight, desiredVersion);
  }
  if (currentVaultTax !== target) {
    await vaultFactory.setImplementations.staticCall(currentCreator, activeTaxForPreflight, desiredVersion);
  }
  const factoryPointerEstimate = currentFactoryTax === target ? 0n
    : await factory.approveImplementations.estimateGas(currentCreator, activeTaxForPreflight, desiredVersion);
  const vaultPointerEstimate = currentVaultTax === target ? 0n
    : await vaultFactory.setImplementations.estimateGas(currentCreator, activeTaxForPreflight, desiredVersion);
  const estimatedGas = (targetCode === "0x" ? paddedGas(deployEstimate) : 0n) +
    (factoryPointerEstimate > 0n ? paddedGas(factoryPointerEstimate) : 0n) +
    (vaultPointerEstimate > 0n ? paddedGas(vaultPointerEstimate) : 0n);
  const requiredBalance = (estimatedGas * feeWei * 125n + 99n) / 100n;
  const balance = await provider.getBalance(signerAddress);
  const plan = {
    mode: execute ? "execute" : "read-only",
    chainId: 1,
    scope: "future Ethereum and Ethereum-side multichain TaxRouter instances only",
    protectedExistingLaunch: {
      token: "HASH",
      taxRouter: protectedHashRouter,
      currentBaseTaxBps: String(hashRouterBaseTax),
      willBeUpgraded: false,
    },
    previousImplementation: previousTaxImplementation,
    newImplementation: target,
    futureBaseTaxBps: String(targetBaseTaxBps),
    factory: factoryAddress,
    vaultFactory: vaultFactoryAddress,
    create2Deployer: create2Address,
    factoryVersion: String(currentFactoryVersion),
    vaultFactoryVersion: String(currentVaultVersion),
    targetVersion: String(desiredVersion),
    storageLayoutCompatible: true,
    deployedRuntimeBytes: runtimeBytes,
    expectedRuntimeHash,
    gasPriceWei: String(feeWei),
    deploymentGasEstimate: String(deployEstimate),
    armoreumFactoryPointerEstimate: String(factoryPointerEstimate),
    vaultFactoryPointerEstimate: String(vaultPointerEstimate),
    estimatedCostEth: hre.ethers.formatEther(estimatedGas * feeWei),
    requiredWith25PercentBufferEth: hre.ethers.formatEther(requiredBalance),
    deployerBalanceEth: hre.ethers.formatEther(balance),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (!execute) return;
  if (balance < requiredBalance) throw new Error("Deployer balance is below the preflight cost plus buffer.");

  const nextProgress = {
    ...progress,
    previousImplementation: previousTaxImplementation,
    targetImplementation: target,
    targetVersion: String(desiredVersion),
    salt: mined.salt,
    initCodeHash: mined.initCodeHash,
    expectedRuntimeHash,
  };
  saveJson(progressPath, nextProgress);

  if (targetCode === "0x") {
    const gasLimit = paddedGas(deployEstimate);
    const tx = await signer.sendTransaction({
      to: create2Address,
      data: deployData,
      gasPrice: feeWei,
      gasLimit,
    });
    nextProgress.deployment = { transactionHash: tx.hash };
    saveJson(progressPath, nextProgress);
    console.log(`Ethereum TaxRouter implementation deployed: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`TaxRouter implementation deployment failed: ${tx.hash}`);
    nextProgress.deployment.blockNumber = receipt.blockNumber;
    saveJson(progressPath, nextProgress);
  }
  if (keccak256(await provider.getCode(target)).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error("Deployed Ethereum TaxRouter runtime does not match the compiled artifact.");
  }
  if ((await implementation.proxiableUUID()).toLowerCase() !== UUPS_UUID) {
    throw new Error("New TaxRouter implementation is not a compatible UUPS target.");
  }
  if (BigInt(await implementation.BASE_TAX_BPS()) !== targetBaseTaxBps) {
    throw new Error("New TaxRouter implementation does not return 70 basis points.");
  }

  if (currentFactoryTax !== target) {
    await factory.approveImplementations.staticCall(currentCreator, target, desiredVersion);
    const gas = await factory.approveImplementations.estimateGas(currentCreator, target, desiredVersion);
    const tx = await factory.approveImplementations(currentCreator, target, desiredVersion, {
      gasPrice: BigInt(await provider.send("eth_gasPrice", [])),
      gasLimit: paddedGas(gas),
    });
    nextProgress.factoryPointer = { transactionHash: tx.hash };
    saveJson(progressPath, nextProgress);
    console.log(`ArmoreumFactory future TaxRouter pointer submitted: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`ArmoreumFactory pointer update failed: ${tx.hash}`);
    nextProgress.factoryPointer.blockNumber = receipt.blockNumber;
    saveJson(progressPath, nextProgress);
  }
  if (currentVaultTax !== target) {
    await vaultFactory.setImplementations.staticCall(currentCreator, target, desiredVersion);
    const gas = await vaultFactory.setImplementations.estimateGas(currentCreator, target, desiredVersion);
    const tx = await vaultFactory.setImplementations(currentCreator, target, desiredVersion, {
      gasPrice: BigInt(await provider.send("eth_gasPrice", [])),
      gasLimit: paddedGas(gas),
    });
    nextProgress.vaultFactoryPointer = { transactionHash: tx.hash };
    saveJson(progressPath, nextProgress);
    console.log(`VaultFactory future TaxRouter pointer submitted: ${tx.hash}`);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`VaultFactory pointer update failed: ${tx.hash}`);
    nextProgress.vaultFactoryPointer.blockNumber = receipt.blockNumber;
    saveJson(progressPath, nextProgress);
  }

  const [factoryTaxAfter, vaultTaxAfter, factoryVersionAfter, vaultVersionAfter, hashTaxAfter] = await Promise.all([
    factory.taxRouterImplementation(),
    vaultFactory.feeVaultImplementation(),
    factory.implementationVersion(),
    vaultFactory.implementationVersion(),
    hashRouter.BASE_TAX_BPS(),
  ]);
  if (
    getAddress(factoryTaxAfter) !== target ||
    getAddress(vaultTaxAfter) !== target ||
    BigInt(factoryVersionAfter) !== desiredVersion ||
    BigInt(vaultVersionAfter) !== desiredVersion ||
    BigInt(hashTaxAfter) !== expectedOldBaseTaxBps
  ) throw new Error("Final pointer or protected HASH-router verification failed.");

  const previousRecord = manifest.contracts.find((entry) => entry.name === "TaxRouter-implementation");
  if (previousRecord && getAddress(previousRecord.address) !== target) {
    previousRecord.name = "TaxRouter-implementation-before-future-base-70";
  }
  if (!manifest.contracts.some((entry) => entry.name === "TaxRouter-implementation" &&
      getAddress(entry.address) === target)) {
    manifest.contracts.push({
      name: "TaxRouter-implementation",
      address: target,
      salt: mined.salt,
      deployer: create2Address,
      initCodeHash: mined.initCodeHash,
      runtimeCodeHash: expectedRuntimeHash,
      transactionHash: nextProgress.deployment?.transactionHash,
      blockNumber: nextProgress.deployment?.blockNumber,
      sourceVerification: "pending",
      baseTaxBps: Number(targetBaseTaxBps),
    });
  }
  manifest.implementationVersion = Number(factoryVersionAfter);
  manifest.vaultFactory.feeVaultImplementation = target;
  manifest.vaultFactory.implementationVersion = Number(vaultVersionAfter);
  manifest.ethereumFutureLaunchTax = {
    baseTaxBps: Number(targetBaseTaxBps),
    implementation: target,
    implementationVersion: Number(factoryVersionAfter),
    transactionHashes: {
      deployment: nextProgress.deployment?.transactionHash ?? null,
      armoreumFactoryPointer: nextProgress.factoryPointer?.transactionHash ?? null,
      vaultFactoryPointer: nextProgress.vaultFactoryPointer?.transactionHash ?? null,
    },
    existingLaunchRoutersUpgraded: false,
    protectedHashRouter: protectedHashRouter,
  };
  manifest.status = "Future Ethereum launch TaxRouter configured for a 0.7% base tax; existing launch routers are unchanged.";
  saveJson(manifestPath, manifest);
  saveJson(progressPath, nextProgress);
  console.log(JSON.stringify({
    configured: true,
    chainId: 1,
    baseTaxBpsForFutureLaunches: String(targetBaseTaxBps),
    implementation: target,
    implementationVersion: String(factoryVersionAfter),
    hashRouterBaseTaxBps: String(hashTaxAfter),
    transactions: {
      deployment: nextProgress.deployment?.transactionHash ?? null,
      armoreumFactoryPointer: nextProgress.factoryPointer?.transactionHash ?? null,
      vaultFactoryPointer: nextProgress.vaultFactoryPointer?.transactionHash ?? null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
