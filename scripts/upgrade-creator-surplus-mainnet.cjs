const fs = require("node:fs");
const path = require("node:path");
const {
  Contract, JsonRpcProvider, Wallet, ZeroHash, getAddress,
  keccak256,
} = require("ethers");
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const factoryAddress = getAddress("0x6900aA5440E51b0DF7781507A58Fc27227aA6d3b");
const manifestPath = path.join(__dirname, "../deployments/4663.json");
const progressPath = path.join(__dirname, "../deployments/4663.creator-surplus.partial.json");
const searchPath = path.join(__dirname, "../deployments/4663.vanity/creator-surplus.json");
const artifactPath = path.join(__dirname, "../artifacts/contracts/CreatorRewardVault.sol/CreatorRewardVault.json");
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

function saveJson(file, content) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function compiledRuntimeAtAddress(build, address) {
  const output = build.output.contracts["contracts/CreatorRewardVault.sol"].CreatorRewardVault;
  let runtime = output.evm.deployedBytecode.object;
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
  for (const [variableId, references] of Object.entries(output.evm.deployedBytecode.immutableReferences ?? {})) {
    const name = Object.values(build.output.sources)
      .map((source) => declarationName(source.ast, variableId)).find(Boolean);
    if (name !== "__self") throw new Error(`Unexpected immutable field in Creator Vault: ${name || variableId}`);
    for (const reference of references) {
      if (reference.length !== 32) throw new Error("Unexpected UUPS self-address width.");
      const encoded = address.slice(2).toLowerCase().padStart(64, "0");
      const start = reference.start * 2;
      runtime = runtime.slice(0, start) + encoded + runtime.slice(start + 64);
    }
  }
  return `0x${runtime}`;
}

function canonicalStorageLayout(layout) {
  function typeShape(typeId) {
    const type = layout.types[typeId];
    return {
      label: type.label, encoding: type.encoding, bytes: type.numberOfBytes,
      ...(type.base ? { base: typeShape(type.base) } : {}),
      ...(type.key ? { key: typeShape(type.key) } : {}),
      ...(type.value ? { value: typeShape(type.value) } : {}),
      ...(type.members ? {
        members: type.members.map((member) => ({
          label: member.label, slot: member.slot, offset: member.offset, type: typeShape(member.type),
        })),
      } : {}),
    };
  }
  return JSON.stringify(layout.storage.map((entry) => ({
    label: entry.label, slot: entry.slot, offset: entry.offset, type: typeShape(entry.type),
  })));
}

async function cappedGasPrice(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) throw new Error("Mainnet base fee unavailable.");
  const cap = (block.baseFeePerGas * 120n + 99n) / 100n;
  const rpcPrice = BigInt(await provider.send("eth_gasPrice", []));
  if (rpcPrice > cap) throw new Error("Robinhood gas quote exceeds base fee + 20%; retry later.");
  return cap;
}

async function sendStep(name, signer, provider, contract, method, args, progress) {
  const wanted = args[0];
  const fee = await cappedGasPrice(provider);
  await contract.getFunction(method).staticCall(...args);
  const gas = await contract.getFunction(method).estimateGas(...args);
  const tx = await contract.getFunction(method)(...args, {
    gasPrice: fee,
    gasLimit: (gas * 120n + 99n) / 100n,
  });
  progress[name] = { transactionHash: tx.hash, target: await contract.getAddress(), newCreatorImplementation: wanted };
  saveJson(progressPath, progress);
  console.log(`${name} sent: ${tx.hash}`);
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) throw new Error(`${name} transaction failed: ${tx.hash}`);
  progress[name].blockNumber = receipt.blockNumber;
  saveJson(progressPath, progress);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const debug = JSON.parse(fs.readFileSync(artifactPath.replace(/\.json$/, ".dbg.json"), "utf8"));
  const build = JSON.parse(fs.readFileSync(path.resolve(path.dirname(artifactPath), debug.buildInfo), "utf8"));
  for (const [sourceName, source] of Object.entries(build.input.sources)) {
    const localSource = path.join(__dirname, "..", sourceName);
    if (sourceName.startsWith("contracts/") && fs.existsSync(localSource) &&
      fs.readFileSync(localSource, "utf8") !== source.content) {
      throw new Error(`Compiled artifact is stale for ${sourceName}; nothing was submitted.`);
    }
  }
  if (!artifact.abi.some((item) => item.type === "function" && item.name === "depositCreatorSurplus")) {
    throw new Error("Compiled Creator Vault lacks the surplus method.");
  }
  if (!/^0x[\da-f]+$/i.test(artifact.bytecode) || !/^0x[\da-f]+$/i.test(artifact.deployedBytecode)) {
    throw new Error("Compiled Creator Vault bytecode is unresolved.");
  }
  const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
  if (runtimeBytes > 24576) throw new Error("Creator Vault exceeds the EVM runtime size limit.");
  const rpc = process.env.ALCHEMY_ROBINHOOD_RPC_URL;
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpc || !key) throw new Error("Configured mainnet RPC or authorized deployer is missing.");
  const provider = new JsonRpcProvider(rpc, 4663, { staticNetwork: true });
  try {
    if ((await provider.getNetwork()).chainId !== 4663n) throw new Error("Wrong chain.");
    const signer = new Wallet(key, provider);
    const factory = new Contract(factoryAddress, factoryAbi, signer);
    const vaultFactoryAddress = getAddress(await factory.vaultFactory());
    const vaultFactory = new Contract(vaultFactoryAddress, vaultFactoryAbi, signer);
    if (
      getAddress(await factory.canonicalOwner()) !== signer.address ||
      getAddress(await vaultFactory.canonicalOwner()) !== signer.address ||
      !(await factory.hasRole(ZeroHash, signer.address)) ||
      !(await vaultFactory.hasRole(ZeroHash, signer.address))
    ) throw new Error("The configured deployer does not own both mainnet factories.");
    const currentCreator = getAddress(await vaultFactory.creatorVaultImplementation());
    const currentFactoryCreator = getAddress(await factory.vaultImplementation());
    const feeImplementation = getAddress(await vaultFactory.feeVaultImplementation());
    const taxRouterImplementation = getAddress(await factory.taxRouterImplementation());
    if (feeImplementation !== taxRouterImplementation) {
      throw new Error("Existing factory pointers disagree. Nothing was changed.");
    }
    const activeCreatorCode = await provider.getCode(currentCreator);
    if (activeCreatorCode === "0x") throw new Error("Active Creator Vault code missing.");
    let previousBuild;
    for (const filename of fs.readdirSync(path.join(__dirname, "../artifacts/build-info")).filter((name) => name.endsWith(".json"))) {
      const candidate = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/build-info", filename), "utf8"));
      if (!candidate.output?.contracts?.["contracts/CreatorRewardVault.sol"]?.CreatorRewardVault) continue;
      if (keccak256(compiledRuntimeAtAddress(candidate, currentCreator)) === keccak256(activeCreatorCode)) {
        previousBuild = candidate;
        break;
      }
    }
    if (!previousBuild) throw new Error("No compiler storage layout matches the active mainnet implementation.");
    const currentLayout = build.output.contracts["contracts/CreatorRewardVault.sol"].CreatorRewardVault.storageLayout;
    const previousLayout = previousBuild.output.contracts["contracts/CreatorRewardVault.sol"].CreatorRewardVault.storageLayout;
    if (!currentLayout || !previousLayout ||
      canonicalStorageLayout(currentLayout) !== canonicalStorageLayout(previousLayout)) {
      throw new Error("New Creator Vault storage layout does not match the active mainnet implementation.");
    }
    const create2Deployer = getAddress(manifest.externalIntegrations.create2Deployer.address);
    const deployedDeployerCode = await provider.getCode(create2Deployer);
    if (
      deployedDeployerCode === "0x" ||
      keccak256(deployedDeployerCode).toLowerCase() !==
        manifest.externalIntegrations.create2Deployer.runtimeCodeHash.toLowerCase()
    ) throw new Error("CREATE2 deployer does not match the registered mainnet code.");
    const mined = await mineVanitySalt({
      deployer: create2Deployer,
      initCode: artifact.bytecode,
      stateFile: searchPath,
    });
    const target = getAddress(mined.address);
    if (currentCreator !== currentFactoryCreator && currentCreator !== target && currentFactoryCreator !== target) {
      throw new Error("Creator implementation pointers disagree with this resumable upgrade.");
    }
    const expectedRuntimeHash = keccak256(compiledRuntimeAtAddress(build, target));
    const targetCode = await provider.getCode(target);
    if (targetCode !== "0x" && keccak256(targetCode) !== expectedRuntimeHash) {
      throw new Error("The deterministic target is occupied by different bytecode.");
    }
    const fee = await cappedGasPrice(provider);
    const deployData = encodeCreate2Deployment(mined.salt, artifact.bytecode);
    const deployEstimate = targetCode === "0x"
      ? await provider.estimateGas({ from: signer.address, to: create2Deployer, data: deployData, gasPrice: fee })
      : 0n;
    const gasBudget = ((deployEstimate * 120n + 99n) / 100n) + 500_000n;
    const balance = await provider.getBalance(signer.address);
    const required = (gasBudget * fee * 125n + 99n) / 100n;
    const plan = {
      chainId: 4663, mode: execute ? "execute" : "read-only",
      oldCreatorImplementation: currentCreator, newCreatorImplementation: target,
      preservedFeeImplementation: feeImplementation,
      factory: factoryAddress, vaultFactory: vaultFactoryAddress,
      create2Deployer, artifactRuntimeBytes: runtimeBytes, expectedRuntimeHash,
      storageLayoutCompatible: true,
      factoryVersion: String(await factory.implementationVersion()),
      vaultFactoryVersion: String(await vaultFactory.implementationVersion()),
      deployGasEstimate: String(deployEstimate), gasPriceCapWei: String(fee),
      signerBalanceWei: String(balance), minimumBudgetWei: String(required),
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!execute) return;
    if (required > balance) throw new Error("Deployer has insufficient ETH for the narrow upgrade.");
    const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, "utf8")) : {};
    if (progress.newCreatorImplementation && progress.newCreatorImplementation !== target) {
      throw new Error("Saved partial deployment does not match this bytecode.");
    }
    progress.newCreatorImplementation = target;
    progress.previousCreatorImplementation ??= currentCreator;
    if (targetCode === "0x") {
      const tx = await signer.sendTransaction({
        to: create2Deployer,
        data: deployData,
        gasPrice: await cappedGasPrice(provider),
        gasLimit: (deployEstimate * 120n + 99n) / 100n,
      });
      progress.deployment = { transactionHash: tx.hash };
      saveJson(progressPath, progress);
      console.log(`Creator Vault implementation deployment sent: ${tx.hash}`);
      const receipt = await tx.wait(2);
      if (!receipt || receipt.status !== 1) throw new Error(`Deployment transaction failed: ${tx.hash}`);
      progress.deployment.blockNumber = receipt.blockNumber;
      saveJson(progressPath, progress);
    }
    if (keccak256(await provider.getCode(target)) !== expectedRuntimeHash) {
      throw new Error("Deployed mainnet Creator Vault runtime does not match the compiled artifact.");
    }
    const implementation = new Contract(target, [
      "function proxiableUUID() view returns(bytes32)",
    ], provider);
    if ((await implementation.proxiableUUID()).toLowerCase() !==
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc") {
      throw new Error("New implementation is not a compatible UUPS target.");
    }
    if (getAddress(await factory.vaultImplementation()) !== target) {
      await sendStep("factoryApproval", signer, provider, factory, "approveImplementations", [
        target, taxRouterImplementation, (await factory.implementationVersion()) + 1n,
      ], progress);
    }
    if (getAddress(await vaultFactory.creatorVaultImplementation()) !== target) {
      await sendStep("vaultFactoryPointer", signer, provider, vaultFactory, "setImplementations", [
        target, feeImplementation, (await vaultFactory.implementationVersion()) + 1n,
      ], progress);
    }
    if (
      getAddress(await factory.vaultImplementation()) !== target ||
      getAddress(await vaultFactory.creatorVaultImplementation()) !== target ||
      getAddress(await factory.taxRouterImplementation()) !== taxRouterImplementation ||
      getAddress(await vaultFactory.feeVaultImplementation()) !== feeImplementation
    ) throw new Error("Final factory pointer check failed.");
    const oldRecord = manifest.contracts.find((entry) => entry.name === "CreatorRewardVault-implementation");
    if (oldRecord && oldRecord.address.toLowerCase() !== target.toLowerCase()) {
      oldRecord.name = "CreatorRewardVault-implementation-before-surplus";
    }
    if (!manifest.contracts.some((entry) => entry.name === "CreatorRewardVault-implementation" && entry.address.toLowerCase() === target.toLowerCase())) {
      manifest.contracts.push({
        name: "CreatorRewardVault-implementation", address: target, salt: mined.salt,
        deployer: create2Deployer, initCodeHash: mined.initCodeHash,
        runtimeCodeHash: expectedRuntimeHash,
        transactionHash: progress.deployment?.transactionHash,
        blockNumber: progress.deployment?.blockNumber,
        sourceVerification: "pending",
      });
    }
    manifest.implementationVersion = Number(await factory.implementationVersion());
    manifest.vaultFactory.creatorVaultImplementation = target;
    manifest.vaultFactory.feeVaultImplementation = feeImplementation;
    manifest.vaultFactory.implementationVersion = Number(await vaultFactory.implementationVersion());
    saveJson(manifestPath, manifest);
    console.log(JSON.stringify({ verified: true, creatorVaultImplementation: target, transactions: progress }, null, 2));
  } finally {
    await provider.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
