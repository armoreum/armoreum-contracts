const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  Contract,
  Interface,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  getCreate2Address,
  keccak256,
} = require("ethers");
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const FACTORY_ADDRESS = getAddress("0x6900aA5440E51b0DF7781507A58Fc27227aA6d3b");
const EXPECTED_VAULT_FACTORY = getAddress("0x6900dD2Dcf99363a83162E82c48D2c7822f1b409");
const LAUNCH_ID = "0x39962ec0ea9190a090a51ef7abd8e6540c0d0a04f1a44c07f7055307d43bf16d";
const EXPECTED_TOKEN = getAddress("0xfC3d2849e63F193e0608aC767910f3a3F5d3ADa2");
const EXPECTED_CREATOR = getAddress("0x2FB0A87FA4A748a370c7E126606Bbd09F9bD4d52");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CREATE2_DEPLOYER = getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const CREATE2_RUNTIME_HASH = "0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989";
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXIABLE_UUID = IMPLEMENTATION_SLOT;
const PROGRESS_PATH = "/tmp/armoreum-hit-unjail-upgrade.json";
const VANITY_STATE_PATH = "/tmp/armoreum-hit-unjail-vanity-0.8.28.json";

const FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function vaultFactory() view returns(address)",
  "function vaultImplementation() view returns(address)",
  "function taxRouterImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function approveImplementations(address,address,uint256)",
  "function rewardSystems(bytes32) view returns(address creator,address vault,address taxRouter,address taxSource,uint16 additionalTaxBps,uint256 implementationVersion,uint8 taxDistributionMode,address launchToken,address buybackExecutor,address bridgeVault)",
];
const VAULT_FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function creatorVaultImplementation() view returns(address)",
  "function feeVaultImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function setImplementations(address,address,uint256)",
];
const VAULT_ABI = [
  "function creator() view returns(address)",
  "function launchId() view returns(bytes32)",
  "function passwordAuthorizationMode() view returns(bool)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function UPGRADER_ROLE() view returns(bytes32)",
  "function upgradeToAndCall(address,bytes)",
];
const IMPLEMENTATION_ABI = ["function proxiableUUID() view returns(bytes32)"];

function fail(message) {
  throw new Error(message);
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_PATH, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
}

function compileCreatorVault() {
  const compilerCache = path.join(
    WORKSPACE_ROOT,
    ".cache/hardhat-nodejs/compilers-v2/linux-amd64",
  );
  const compilerName = fs
    .readdirSync(compilerCache)
    .find((name) => /^solc-linux-amd64-v0\.8\.28\+commit\./.test(name));
  if (!compilerName) fail("The exact Solidity 0.8.28 compiler used by the live implementation is unavailable.");
  const compilerPath = path.join(compilerCache, compilerName);
  const versionResult = spawnSync(compilerPath, ["--version"], { encoding: "utf8" });
  if (versionResult.status !== 0 || !versionResult.stdout.includes("0.8.28+commit.7893614a")) {
    fail("Could not verify the exact Solidity compiler version.");
  }
  const sourceName = "contracts/CreatorRewardVault.sol";
  const input = {
    language: "Solidity",
    sources: {
      [sourceName]: {
        content: fs.readFileSync(path.join(PACKAGE_ROOT, sourceName), "utf8"),
      },
    },
    settings: {
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: {
        "*": {
          "": ["ast"],
          "*": [
            "abi",
            "metadata",
            "storageLayout",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
          ],
        },
      },
    },
  };
  const compiled = spawnSync(
    compilerPath,
    [
      "--base-path",
      PACKAGE_ROOT,
      "--include-path",
      path.join(PACKAGE_ROOT, "node_modules"),
      "--allow-paths",
      `${path.join(PACKAGE_ROOT, "node_modules")},${path.join(WORKSPACE_ROOT, "node_modules/.pnpm")}`,
      "--standard-json",
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (compiled.error || compiled.status !== 0) fail("The exact-version Creator Vault compilation failed.");
  const outputStart = compiled.stdout.indexOf("{");
  if (outputStart < 0) fail("Solidity compiler did not return standard JSON output.");
  const output = JSON.parse(compiled.stdout.slice(outputStart));
  const errors = output.errors || [];
  for (const error of errors.filter((entry) => entry.severity === "error")) {
    process.stderr.write(`${error.formattedMessage}\n`);
  }
  if (errors.some((entry) => entry.severity === "error")) fail("Creator Vault compilation failed.");
  const contract = output.contracts?.[sourceName]?.CreatorRewardVault;
  if (!contract?.evm?.bytecode?.object || !contract?.evm?.deployedBytecode?.object) {
    fail("The compiler did not return complete Creator Vault bytecode.");
  }
  const initCode = `0x${contract.evm.bytecode.object}`;
  if (!contract.abi.some((entry) => entry.type === "function" && entry.name === "upgradeToAndCall")) {
    fail("Compiled Creator Vault ABI is missing UUPS upgrade support.");
  }
  const runtimeBytes = contract.evm.deployedBytecode.object.length / 2;
  if (runtimeBytes > 24_576) fail("Creator Vault runtime exceeds the EVM contract-size limit.");
  return {
    compilerVersion: "0.8.28+commit.7893614a",
    sourceName,
    output,
    contract,
    initCode,
    runtimeBytes,
  };
}

function findAstDeclaration(node, id) {
  if (!node || typeof node !== "object") return undefined;
  if (node.id === Number(id) && node.nodeType === "VariableDeclaration") return node.name;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findAstDeclaration(child, id);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findAstDeclaration(value, id);
      if (found) return found;
    }
  }
  return undefined;
}

function runtimeAtAddress(build, sourceName, contractName, address) {
  const compiled = build.output.contracts?.[sourceName]?.[contractName];
  if (!compiled) return null;
  let runtime = compiled.evm.deployedBytecode.object;
  for (const [variableId, references] of Object.entries(
    compiled.evm.deployedBytecode.immutableReferences || {},
  )) {
    const name = Object.values(build.output.sources || {})
      .map((source) => findAstDeclaration(source.ast, variableId))
      .find(Boolean);
    if (name !== "__self") return null;
    for (const reference of references) {
      if (reference.length !== 32) return null;
      const encoded = address.slice(2).toLowerCase().padStart(64, "0");
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

function matchLiveStorageLayout(creatorVault, liveRuntime, newLayout) {
  const buildInfoDir = path.join(PACKAGE_ROOT, "artifacts/build-info");
  for (const filename of fs.readdirSync(buildInfoDir).filter((name) => name.endsWith(".json"))) {
    const candidate = JSON.parse(fs.readFileSync(path.join(buildInfoDir, filename), "utf8"));
    const sourceName = "contracts/CreatorRewardVault.sol";
    const prior = candidate.output?.contracts?.[sourceName]?.CreatorRewardVault;
    if (!prior?.storageLayout) continue;
    const deployedRuntime = runtimeAtAddress(
      candidate,
      sourceName,
      "CreatorRewardVault",
      creatorVault,
    );
    if (deployedRuntime && keccak256(deployedRuntime) === keccak256(liveRuntime)) {
      if (canonicalStorageLayout(prior.storageLayout) !== canonicalStorageLayout(newLayout)) {
        fail("The new Creator Vault storage layout differs from the live implementation.");
      }
      return candidate.solcLongVersion || candidate.solcVersion;
    }
  }
  fail("Could not match the live Creator Vault bytecode to a recorded compiler storage layout.");
}

function cappedGasPrice(provider, ethersApi) {
  return (async () => {
    const block = await provider.getBlock("latest");
    if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
      fail("Robinhood Chain base fee is unavailable.");
    }
    const cap = (block.baseFeePerGas * 120n + 99n) / 100n;
    const rpcPrice = BigInt(await provider.send("eth_gasPrice", []));
    if (rpcPrice > cap) fail("Current Robinhood gas quote exceeds base fee + 20%; no transaction sent.");
    return ethersApi.toBeHex(cap);
  })();
}

async function estimateTransaction(contract, method, args, options) {
  await contract.getFunction(method).staticCall(...args);
  const gas = await contract.getFunction(method).estimateGas(...args);
  return {
    gas,
    gasLimit: (gas * 120n + 99n) / 100n,
    target: await contract.getAddress(),
    method,
    args,
    options,
  };
}

async function sendTransaction(name, signer, provider, transaction, progress, gasPrice) {
  const tx = await signer.sendTransaction({
    to: transaction.target,
    data: transaction.data,
    gasPrice,
    gasLimit: transaction.gasLimit,
  });
  progress[name] = { hash: tx.hash, target: transaction.target };
  saveProgress(progress);
  process.stdout.write(`${name} sent: ${tx.hash}\n`);
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) fail(`${name} failed on-chain: ${tx.hash}`);
  progress[name].blockNumber = receipt.blockNumber;
  saveProgress(progress);
}

async function main() {
  const execute = process.argv.includes("--execute");
  const rpcUrl = process.env.ALCHEMY_ROBINHOOD_RPC_URL;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) fail("Robinhood RPC or deployer secret is not configured.");

    const { toBeHex } = require("ethers");
  const build = compileCreatorVault();
  const signerAddress = new Wallet(privateKey).address;
  const provider = new JsonRpcProvider(rpcUrl, 4663, { staticNetwork: true });
  try {
    const network = await provider.getNetwork();
    if (network.chainId !== 4663n) fail("RPC is not connected to Robinhood Chain.");
    const signer = new Wallet(privateKey, provider);
    const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, signer);
    const vaultFactoryAddress = getAddress(await factory.vaultFactory());
    if (vaultFactoryAddress !== EXPECTED_VAULT_FACTORY) {
      fail("The live ArmoreumFactory points to an unexpected VaultFactory.");
    }
    const vaultFactory = new Contract(vaultFactoryAddress, VAULT_FACTORY_ABI, signer);
    const reward = await factory.rewardSystems(LAUNCH_ID);
    const vaultAddress = getAddress(reward.vault);
    const expectedCreatorVault = getAddress(reward.creator);
    if (
      getAddress(reward.launchToken) !== EXPECTED_TOKEN ||
      expectedCreatorVault !== EXPECTED_CREATOR ||
      vaultAddress === ZERO_ADDRESS
    ) {
      fail("The live reward-system mapping does not match the expected HIT launch.");
    }
    const vault = new Contract(vaultAddress, VAULT_ABI, signer);
    const [factoryOwner, vaultFactoryOwner, factoryImpl, factoryRouterImpl, vaultFactoryImpl, feeImpl] =
      await Promise.all([
        factory.canonicalOwner(),
        vaultFactory.canonicalOwner(),
        factory.vaultImplementation(),
        factory.taxRouterImplementation(),
        vaultFactory.creatorVaultImplementation(),
        vaultFactory.feeVaultImplementation(),
      ]);
    const [vaultLaunchId, vaultCreator, passwordMode, upgraderRole] = await Promise.all([
      vault.launchId(),
      vault.creator(),
      vault.passwordAuthorizationMode(),
      vault.UPGRADER_ROLE(),
    ]);
    if (
      getAddress(factoryOwner) !== signerAddress ||
      getAddress(vaultFactoryOwner) !== signerAddress ||
      !(await factory.hasRole(ZeroHash, signerAddress)) ||
      !(await vaultFactory.hasRole(ZeroHash, signerAddress)) ||
      !(await vault.hasRole(upgraderRole, signerAddress))
    ) {
      fail("The configured signer lacks the required factory or HIT-vault upgrade authority.");
    }
    if (
      getAddress(factoryImpl) !== getAddress(vaultFactoryImpl) ||
      getAddress(factoryRouterImpl) !== getAddress(feeImpl)
    ) {
      fail("Live factory implementation pointers disagree; refusing to upgrade.");
    }
    if (
      vaultLaunchId.toLowerCase() !== LAUNCH_ID.toLowerCase() ||
      getAddress(vaultCreator) !== EXPECTED_CREATOR ||
      !passwordMode
    ) {
      fail("The selected proxy is not the expected password-authorized HIT Creator Vault.");
    }

    const liveImplementationWord = await provider.getStorage(vaultAddress, IMPLEMENTATION_SLOT);
    const liveImplementation = getAddress(`0x${liveImplementationWord.slice(-40)}`);
    const liveRuntime = await provider.getCode(liveImplementation);
    if (liveRuntime === "0x") fail("The active HIT-vault implementation has no deployed code.");
    const liveBuild = matchLiveStorageLayout(
      liveImplementation,
      liveRuntime,
      build.contract.storageLayout,
    );

    const create2Code = await provider.getCode(CREATE2_DEPLOYER);
    if (
      create2Code === "0x" ||
      keccak256(create2Code).toLowerCase() !== CREATE2_RUNTIME_HASH.toLowerCase()
    ) {
      fail("The registered CREATE2 deployer has unexpected code.");
    }
    const { salt } = await mineVanitySalt({
      deployer: CREATE2_DEPLOYER,
      initCode: build.initCode,
      stateFile: VANITY_STATE_PATH,
    });
    const target = getAddress(getCreate2Address(CREATE2_DEPLOYER, salt, keccak256(build.initCode)));
    if (!target.toLowerCase().startsWith("0x6900")) fail("CREATE2 address-prefix verification failed.");

    const runtimeReferences = build.contract.evm.deployedBytecode.immutableReferences || {};
    let expectedRuntime = build.contract.evm.deployedBytecode.object;
    for (const [variableId, references] of Object.entries(runtimeReferences)) {
      const name = Object.values(build.output.sources || {})
        .map((source) => findAstDeclaration(source.ast, variableId))
        .find(Boolean);
      if (name !== "__self") fail("Unexpected immutable in the compiled Creator Vault.");
      for (const reference of references) {
        if (reference.length !== 32) fail("Unexpected UUPS immutable width.");
        const encoded = target.slice(2).toLowerCase().padStart(64, "0");
        const start = reference.start * 2;
        expectedRuntime = expectedRuntime.slice(0, start) + encoded + expectedRuntime.slice(start + 64);
      }
    }
    const expectedRuntimeHash = keccak256(`0x${expectedRuntime}`);
    const existingTargetCode = await provider.getCode(target);
    if (existingTargetCode !== "0x" && keccak256(existingTargetCode) !== expectedRuntimeHash) {
      fail("The deterministic implementation address already contains different bytecode.");
    }

    const implementation = new Contract(target, IMPLEMENTATION_ABI, provider);
    const currentFactoryVersion = BigInt(await factory.implementationVersion());
    const currentVaultFactoryVersion = BigInt(await vaultFactory.implementationVersion());
    const newFactoryVersion = currentFactoryVersion + 1n;
    const newVaultFactoryVersion = currentVaultFactoryVersion + 1n;
    const factoryAlreadyPointsToTarget = getAddress(factoryImpl) === target;
    const vaultFactoryAlreadyPointsToTarget = getAddress(vaultFactoryImpl) === target;
    const vaultAlreadyPointsToTarget = liveImplementation === target;
    if (factoryAlreadyPointsToTarget && vaultFactoryAlreadyPointsToTarget && vaultAlreadyPointsToTarget) {
      process.stdout.write(
        `${JSON.stringify({
          mode: execute ? "execute" : "read-only",
          alreadyApplied: true,
          launchId: LAUNCH_ID,
          creatorVault: vaultAddress,
          implementation: target,
          armoreumFactoryVersion: String(currentFactoryVersion),
          vaultFactoryVersion: String(currentVaultFactoryVersion),
        }, null, 2)}\n`,
      );
      return;
    }
    if (factoryAlreadyPointsToTarget || vaultFactoryAlreadyPointsToTarget || vaultAlreadyPointsToTarget) {
      fail("Only part of this upgrade is active on-chain; refusing to repeat or extend it automatically.");
    }
    const factoryUpgrade = new Interface(FACTORY_ABI).encodeFunctionData("approveImplementations", [
      target,
      getAddress(factoryRouterImpl),
      newFactoryVersion,
    ]);
    const vaultFactoryUpgrade = new Interface(VAULT_FACTORY_ABI).encodeFunctionData("setImplementations", [
      target,
      getAddress(feeImpl),
      newVaultFactoryVersion,
    ]);
    const vaultUpgrade = new Interface(VAULT_ABI).encodeFunctionData("upgradeToAndCall", [target, "0x"]);

    const gasPrice = await cappedGasPrice(provider, { toBeHex });
    const deployData = encodeCreate2Deployment(salt, build.initCode);
    const deployEstimate = existingTargetCode === "0x"
      ? await provider.estimateGas({
          from: signerAddress,
          to: CREATE2_DEPLOYER,
          data: deployData,
          gasPrice,
        })
      : 0n;
    const expectedCodeHash = expectedRuntimeHash;
    const deployedCodeIsExpected = existingTargetCode !== "0x";
    if (deployedCodeIsExpected && (await implementation.proxiableUUID()).toLowerCase() !== PROXIABLE_UUID) {
      fail("Existing implementation at the CREATE2 address is not UUPS-compatible.");
    }

    let estimates = [];
    if (deployedCodeIsExpected) {
      await vault.upgradeToAndCall.staticCall(target, "0x");
      await factory.approveImplementations.staticCall(
        target,
        getAddress(factoryRouterImpl),
        newFactoryVersion,
      );
      await vaultFactory.setImplementations.staticCall(
        target,
        getAddress(feeImpl),
        newVaultFactoryVersion,
      );
      estimates = await Promise.all([
        estimateTransaction(vault, "upgradeToAndCall", [target, "0x"]),
        estimateTransaction(factory, "approveImplementations", [
          target,
          getAddress(factoryRouterImpl),
          newFactoryVersion,
        ]),
        estimateTransaction(vaultFactory, "setImplementations", [
          target,
          getAddress(feeImpl),
          newVaultFactoryVersion,
        ]),
      ]);
    }

    const deployGasLimit = deployEstimate === 0n ? 0n : (deployEstimate * 120n + 99n) / 100n;
    const totalGasLimit =
      deployGasLimit + estimates.reduce((sum, estimate) => sum + estimate.gasLimit, 0n);
    const balance = await provider.getBalance(signerAddress);
    const maxCost = (totalGasLimit * BigInt(gasPrice) * 125n + 99n) / 100n;
    const plan = {
      mode: execute ? "execute" : "read-only",
      chainId: 4663,
      launchId: LAUNCH_ID,
      token: EXPECTED_TOKEN,
      creatorVault: vaultAddress,
      signer: signerAddress,
      signerAuthorized: true,
      currentImplementation: liveImplementation,
      newImplementation: target,
      implementationAlreadyDeployed: deployedCodeIsExpected,
      previousCompilerForLiveImplementation: liveBuild,
      compilerForNewImplementation: build.compilerVersion,
      storageLayoutCompatible: true,
      runtimeBytes: build.runtimeBytes,
      expectedRuntimeHash,
      factoryVersions: {
        armoreumFactory: `${currentFactoryVersion} -> ${newFactoryVersion}`,
        vaultFactory: `${currentVaultFactoryVersion} -> ${newVaultFactoryVersion}`,
      },
      preservedTaxRouterImplementation: getAddress(factoryRouterImpl),
      preservedFeeVaultImplementation: getAddress(feeImpl),
      gasPriceWei: gasPrice,
      deployGasEstimate: String(deployEstimate),
      actionGasEstimates: estimates.map((estimate) => ({
        target: estimate.target,
        method: estimate.method,
        estimate: String(estimate.gas),
        limit: String(estimate.gasLimit),
      })),
      deployerBalanceWei: String(balance),
      maxTotalCostWei: String(maxCost),
      allCallSimulationsPassed: deployedCodeIsExpected,
    };
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    if (!execute) return;
    if (balance < maxCost) fail("Deployer balance is below the capped maximum transaction budget.");

    const progress = fs.existsSync(PROGRESS_PATH)
      ? JSON.parse(fs.readFileSync(PROGRESS_PATH, "utf8"))
      : {};
    if (progress.target && progress.target.toLowerCase() !== target.toLowerCase()) {
      fail("A saved partial upgrade refers to a different implementation.");
    }
    progress.target = target;
    progress.vault = vaultAddress;
    progress.launchId = LAUNCH_ID;
    saveProgress(progress);

    if (!deployedCodeIsExpected) {
      const tx = await signer.sendTransaction({
        to: CREATE2_DEPLOYER,
        data: deployData,
        gasPrice,
        gasLimit: deployGasLimit,
      });
      progress.deployment = { hash: tx.hash };
      saveProgress(progress);
      process.stdout.write(`creator implementation deployment sent: ${tx.hash}\n`);
      const receipt = await tx.wait(2);
      if (!receipt || receipt.status !== 1) fail(`Creator Vault implementation deployment failed: ${tx.hash}`);
      progress.deployment.blockNumber = receipt.blockNumber;
      saveProgress(progress);
    }
    if (keccak256(await provider.getCode(target)) !== expectedCodeHash) {
      fail("Deployed implementation runtime does not match the compiled source.");
    }
    if ((await implementation.proxiableUUID()).toLowerCase() !== PROXIABLE_UUID) {
      fail("Deployed implementation has an unexpected UUPS UUID.");
    }

    await vault.upgradeToAndCall.staticCall(target, "0x");
    await factory.approveImplementations.staticCall(
      target,
      getAddress(factoryRouterImpl),
      newFactoryVersion,
    );
    await vaultFactory.setImplementations.staticCall(
      target,
      getAddress(feeImpl),
      newVaultFactoryVersion,
    );
    const confirmedEstimates = await Promise.all([
      estimateTransaction(vault, "upgradeToAndCall", [target, "0x"]),
      estimateTransaction(factory, "approveImplementations", [
        target,
        getAddress(factoryRouterImpl),
        newFactoryVersion,
      ]),
      estimateTransaction(vaultFactory, "setImplementations", [
        target,
        getAddress(feeImpl),
        newVaultFactoryVersion,
      ]),
    ]);
    for (const estimate of confirmedEstimates) {
      const txData = estimateTransactionData(estimate);
      await sendTransaction(
        `${estimate.target.toLowerCase() === vaultAddress.toLowerCase() ? "hitVaultUpgrade" : estimate.target.toLowerCase() === FACTORY_ADDRESS.toLowerCase() ? "armoreumFactoryPointer" : "vaultFactoryPointer"}`,
        signer,
        provider,
        { ...estimate, data: txData },
        progress,
        gasPrice,
      );
    }

    const [vaultWordAfter, factoryImplAfter, vaultFactoryImplAfter, routerImplAfter, feeImplAfter] =
      await Promise.all([
        provider.getStorage(vaultAddress, IMPLEMENTATION_SLOT),
        factory.vaultImplementation(),
        vaultFactory.creatorVaultImplementation(),
        factory.taxRouterImplementation(),
        vaultFactory.feeVaultImplementation(),
      ]);
    if (
      getAddress(`0x${vaultWordAfter.slice(-40)}`) !== target ||
      getAddress(factoryImplAfter) !== target ||
      getAddress(vaultFactoryImplAfter) !== target ||
      getAddress(routerImplAfter) !== getAddress(factoryRouterImpl) ||
      getAddress(feeImplAfter) !== getAddress(feeImpl)
    ) {
      fail("On-chain post-upgrade pointer verification failed.");
    }
    progress.verified = {
      hitVaultImplementation: target,
      armoreumFactoryCreatorImplementation: target,
      vaultFactoryCreatorImplementation: target,
      taxRouterImplementationPreserved: getAddress(routerImplAfter),
      feeVaultImplementationPreserved: getAddress(feeImplAfter),
    };
    saveProgress(progress);
    process.stdout.write(`${JSON.stringify({ verified: true, progress }, null, 2)}\n`);
  } finally {
    await provider.destroy();
  }
}

function estimateTransactionData(estimate) {
  const args = estimate.args;
  const iface = estimate.target.toLowerCase() === FACTORY_ADDRESS.toLowerCase()
    ? new Interface(FACTORY_ABI)
    : estimate.target.toLowerCase() === EXPECTED_VAULT_FACTORY.toLowerCase()
      ? new Interface(VAULT_FACTORY_ABI)
      : new Interface(VAULT_ABI);
  return iface.encodeFunctionData(estimate.method, args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Mainnet upgrade failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
