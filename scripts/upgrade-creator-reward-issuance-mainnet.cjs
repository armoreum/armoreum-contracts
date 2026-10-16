const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const {
  Contract,
  JsonRpcProvider,
  Wallet,
  ZeroHash,
  getAddress,
  keccak256,
} = require("ethers");
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const ROOT = path.join(__dirname, "..");
const WORKSPACE_ROOT = path.resolve(ROOT, "../..");
const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const REWARD_SYSTEM_CREATED_ABI = [
  "event RewardSystemCreated(bytes32 indexed launchId,address indexed creator,address vaultProxy,address taxRouterProxy,address taxSource,uint16 additionalTaxBps,uint8 taxDistributionMode,address launchToken,address buybackExecutor,address bridgeVault,uint256 implementationVersion)",
];
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
const CHAIN_CONFIGS = [
  {
    chainId: 1,
    rpcEnv: "ALCHEMY_ETHEREUM_RPC_URL",
    factory: "0x69003a9C316E080855f04112D5E188A3329BA184",
    vaultFactory: "0x69009e23F4c3C75d8a0ba270f94E20faE6B4B48D",
    legacyImplementation: "0x69003863e010bcE73460D90cc245087BA95488BE",
    liveSourceCommit: "e0102ceb85fe7c44e074cf4ddbd4e9b1a0d841d0",
    manifest: path.join(ROOT, "deployments/1.json"),
    progress: "/tmp/armoreum-creator-reward-issuance-1.json",
  },
  {
    chainId: 4663,
    rpcEnv: "ALCHEMY_ROBINHOOD_RPC_URL",
    factory: "0x6900aA5440E51b0DF7781507A58Fc27227aA6d3b",
    vaultFactory: "0x6900dD2Dcf99363a83162E82c48D2c7822f1b409",
    legacyImplementation: "0x6900E06F8F2f1A65a3a0e331AD3A13eF39846F11",
    liveSourceCommit: "a8574cb9b905ebd7d792cce1f72677c3226f3563",
    manifest: path.join(ROOT, "deployments/4663.json"),
    progress: "/tmp/armoreum-creator-reward-issuance-4663.json",
  },
];

function saveJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filename);
}

function findAstDeclaration(node, wantedId) {
  if (!node || typeof node !== "object") return undefined;
  if (node.id === Number(wantedId) && node.nodeType === "VariableDeclaration") {
    return node.name;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findAstDeclaration(child, wantedId);
        if (found) return found;
      }
    } else if (value && typeof value === "object") {
      const found = findAstDeclaration(value, wantedId);
      if (found) return found;
    }
  }
  return undefined;
}

function compiledRuntimeAtAddress(build, address) {
  const contract =
    build.output.contracts["contracts/CreatorRewardVault.sol"].CreatorRewardVault;
  let runtime = contract.evm.deployedBytecode.object;
  for (const [variableId, references] of Object.entries(
    contract.evm.deployedBytecode.immutableReferences ?? {},
  )) {
    const name = Object.values(build.output.sources)
      .map((source) => findAstDeclaration(source.ast, variableId))
      .find(Boolean);
    if (name !== "__self") {
      throw new Error(`Unexpected Creator Vault immutable: ${name || variableId}`);
    }
    for (const reference of references) {
      if (reference.length !== 32) throw new Error("Unexpected UUPS immutable width.");
      const encoded = address.slice(2).toLowerCase().padStart(64, "0");
      const start = reference.start * 2;
      runtime = runtime.slice(0, start) + encoded + runtime.slice(start + 64);
    }
  }
  return `0x${runtime}`;
}

function canonicalStorageLayout(layout) {
  function typeShape(typeId, seen = new Set()) {
    if (seen.has(typeId)) return { reference: layout.types[typeId].label };
    const nextSeen = new Set(seen);
    nextSeen.add(typeId);
    const type = layout.types[typeId];
    return {
      label: type.label,
      encoding: type.encoding,
      bytes: type.numberOfBytes,
      ...(type.base ? { base: typeShape(type.base, nextSeen) } : {}),
      ...(type.key ? { key: typeShape(type.key, nextSeen) } : {}),
      ...(type.value ? { value: typeShape(type.value, nextSeen) } : {}),
      ...(type.members
        ? {
            members: type.members.map((member) => ({
              label: member.label,
              slot: member.slot,
              offset: member.offset,
              type: typeShape(member.type, nextSeen),
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
      type: typeShape(entry.type),
    })),
  );
}

function compileCreatorVault(sourceContent) {
  const compilerDirectory = path.join(
    WORKSPACE_ROOT,
    ".cache/hardhat-nodejs/compilers-v2/linux-amd64",
  );
  const compilerName = fs
    .readdirSync(compilerDirectory)
    .find((name) => /^solc-linux-amd64-v0\.8\.28\+commit\./.test(name));
  if (!compilerName) throw new Error("The pinned Solidity 0.8.28 compiler is unavailable.");
  const compilerPath = path.join(compilerDirectory, compilerName);
  const compilerVersion = spawnSync(compilerPath, ["--version"], {
    encoding: "utf8",
  });
  if (
    compilerVersion.status !== 0 ||
    !compilerVersion.stdout.includes("0.8.28+commit.7893614a")
  ) {
    throw new Error("Could not confirm the pinned Solidity compiler version.");
  }
  const input = {
    language: "Solidity",
    sources: {
      "contracts/CreatorRewardVault.sol": { content: sourceContent },
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
  const result = spawnSync(
    compilerPath,
    [
      "--base-path",
      ROOT,
      "--include-path",
      path.join(ROOT, "node_modules"),
      "--allow-paths",
      `${path.join(ROOT, "node_modules")},${path.join(WORKSPACE_ROOT, "node_modules/.pnpm")}`,
      "--standard-json",
    ],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Pinned Creator Vault compilation failed.");
  }
  const outputStart = result.stdout.indexOf("{");
  if (outputStart < 0) throw new Error("Solidity compiler returned no JSON output.");
  const output = JSON.parse(result.stdout.slice(outputStart));
  if (output.errors?.some((entry) => entry.severity === "error")) {
    throw new Error("Pinned Creator Vault compilation reported a Solidity error.");
  }
  const contract =
    output.contracts?.["contracts/CreatorRewardVault.sol"]?.CreatorRewardVault;
  if (!contract?.evm?.bytecode?.object || !contract?.evm?.deployedBytecode?.object) {
    throw new Error("Pinned compiler did not return Creator Vault bytecode.");
  }
  return {
    output,
    contract,
    artifact: {
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    },
  };
}

function loadCompiledBuild() {
  const currentSource = fs.readFileSync(
    path.join(ROOT, "contracts/CreatorRewardVault.sol"),
    "utf8",
  );
  const compiled = compileCreatorVault(currentSource);
  if (
    !compiled.contract.abi.some(
      (item) =>
        item.type === "function" &&
        item.name === "migrateAccruedRewardsToJailETH",
    )
  ) {
    throw new Error("Compiled Creator Vault lacks the accrued-reward migration.");
  }
  if ((compiled.artifact.deployedBytecode.length - 2) / 2 > 24576) {
    throw new Error("Creator Vault exceeds the EVM runtime size limit.");
  }
  return { artifact: compiled.artifact, build: { output: compiled.output } };
}

async function cappedGasPrice(provider) {
  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Mainnet base fee is unavailable.");
  }
  const cap = (block.baseFeePerGas * 120n + 99n) / 100n;
  const rpcQuote = BigInt(await provider.send("eth_gasPrice", []));
  if (rpcQuote > cap) {
    throw new Error("RPC gas quote exceeds the base-fee + 20% policy; no transaction sent.");
  }
  return cap;
}

async function factoryCreationBlock(provider, manifest, factoryAddress, latest) {
  const record = manifest.contracts?.find(
    (entry) =>
      entry.address?.toLowerCase() === factoryAddress.toLowerCase() &&
      entry.name === "ArmoreumFactory-proxy",
  );
  if (!record?.transactionHash) {
    throw new Error("Factory deployment transaction is missing from its manifest.");
  }
  const receipt = await provider.getTransactionReceipt(record.transactionHash);
  if (!receipt || receipt.status !== 1 || receipt.blockNumber > latest) {
    throw new Error("Could not verify the live factory deployment receipt.");
  }
  return receipt.blockNumber;
}

async function assertStorageCompatibility(
  chainConfig,
  manifest,
  build,
  provider,
  liveImplementation,
  liveRuntime,
) {
  const liveRecord = manifest.contracts.find(
    (entry) =>
      entry.address?.toLowerCase() === liveImplementation.toLowerCase() &&
      entry.name.startsWith("CreatorRewardVault-implementation"),
  );
  const legacyRecord = manifest.contracts.find(
    (entry) =>
      entry.address?.toLowerCase() ===
      chainConfig.legacyImplementation.toLowerCase(),
  );
  if (!liveRecord?.initCodeHash || !legacyRecord?.initCodeHash) {
    throw new Error(`Manifest lacks Creator Vault implementation hashes on ${chainConfig.chainId}.`);
  }
  let historicalSource;
  try {
    historicalSource = execFileSync(
      "git",
      [
        "show",
        `${chainConfig.liveSourceCommit}:lib/armoreum-contracts/contracts/CreatorRewardVault.sol`,
      ],
      { cwd: WORKSPACE_ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    throw new Error(`Recorded deployed source is unavailable on chain ${chainConfig.chainId}.`);
  }
  const priorBuild = compileCreatorVault(historicalSource);
  if (
    keccak256(priorBuild.artifact.bytecode).toLowerCase() !==
      legacyRecord.initCodeHash.toLowerCase() ||
    keccak256(
      compiledRuntimeAtAddress(
        { output: priorBuild.output },
        chainConfig.legacyImplementation,
      ),
    ).toLowerCase() !==
      keccak256(
        await provider.getCode(chainConfig.legacyImplementation),
      ).toLowerCase()
  ) {
    throw new Error(`Historical source does not match live bytecode on chain ${chainConfig.chainId}.`);
  }
  if (liveImplementation === getAddress(chainConfig.legacyImplementation)) {
    if (
      keccak256(liveRuntime).toLowerCase() !==
      keccak256(
        compiledRuntimeAtAddress(
          { output: priorBuild.output },
          liveImplementation,
        ),
      ).toLowerCase()
    ) {
      throw new Error(`Legacy implementation bytecode mismatch on chain ${chainConfig.chainId}.`);
    }
  } else {
    const currentContract =
      build.output.contracts["contracts/CreatorRewardVault.sol"]
        .CreatorRewardVault;
    const currentInitCodeHash = keccak256(
      `0x${currentContract.evm.bytecode.object}`,
    );
    if (
      currentInitCodeHash.toLowerCase() !== liveRecord.initCodeHash.toLowerCase() ||
      keccak256(
        compiledRuntimeAtAddress({ output: build.output }, liveImplementation),
      ).toLowerCase() !== keccak256(liveRuntime).toLowerCase()
    ) {
      throw new Error(`Active implementation is not the compiled Creator Vault on chain ${chainConfig.chainId}.`);
    }
  }
  const liveLayout =
    priorBuild.output.contracts["contracts/CreatorRewardVault.sol"]
      .CreatorRewardVault.storageLayout;
  const newLayout =
    build.output.contracts["contracts/CreatorRewardVault.sol"].CreatorRewardVault
      .storageLayout;
  if (
    !liveLayout ||
    !newLayout ||
    canonicalStorageLayout(liveLayout) !== canonicalStorageLayout(newLayout)
  ) {
    throw new Error(`Storage layout differs from the live Creator Vault on chain ${chainConfig.chainId}.`);
  }
}

async function prepareChain(config, build, artifact, signer) {
  const rpc = process.env[config.rpcEnv];
  if (!rpc) throw new Error(`Configured RPC for chain ${config.chainId} is unavailable.`);
  const provider = new JsonRpcProvider(rpc, config.chainId, {
    staticNetwork: true,
  });
  const manifest = JSON.parse(fs.readFileSync(config.manifest, "utf8"));
  const configuredFactory = getAddress(
    manifest.contracts.find((entry) => entry.name === "ArmoreumFactory-proxy")
      ?.address,
  );
  const configuredVaultFactory = getAddress(manifest.vaultFactory?.address);
  if (
    configuredFactory !== getAddress(config.factory) ||
    configuredVaultFactory !== getAddress(config.vaultFactory)
  ) {
    await provider.destroy();
    throw new Error(`Deployment manifest addresses disagree on chain ${config.chainId}.`);
  }

  const factory = new Contract(config.factory, FACTORY_ABI, signer.connect(provider));
  const vaultFactory = new Contract(
    config.vaultFactory,
    VAULT_FACTORY_ABI,
    signer.connect(provider),
  );
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    await provider.destroy();
    throw new Error(`RPC returned the wrong chain ID for ${config.chainId}.`);
  }
  const latest = await provider.getBlockNumber();
  const [
    factoryOwner,
    vaultFactoryOwner,
    factoryRole,
    vaultFactoryRole,
    currentFactoryImplementation,
    currentVaultImplementation,
    routerImplementation,
    feeImplementation,
    factoryVersion,
    vaultFactoryVersion,
    vaultFactoryFromFactory,
  ] = await Promise.all([
    factory.canonicalOwner(),
    vaultFactory.canonicalOwner(),
    factory.hasRole(ZeroHash, signer.address),
    vaultFactory.hasRole(ZeroHash, signer.address),
    factory.vaultImplementation(),
    vaultFactory.creatorVaultImplementation(),
    factory.taxRouterImplementation(),
    vaultFactory.feeVaultImplementation(),
    factory.implementationVersion(),
    vaultFactory.implementationVersion(),
    factory.vaultFactory(),
  ]);
  if (
    getAddress(factoryOwner) !== signer.address ||
    getAddress(vaultFactoryOwner) !== signer.address ||
    !factoryRole ||
    !vaultFactoryRole
  ) {
    await provider.destroy();
    throw new Error(`Configured signer is not factory admin on chain ${config.chainId}.`);
  }
  if (
    getAddress(vaultFactoryFromFactory) !== getAddress(config.vaultFactory) ||
    getAddress(currentFactoryImplementation) !==
      getAddress(currentVaultImplementation) ||
    getAddress(routerImplementation) !== getAddress(feeImplementation) ||
    BigInt(factoryVersion) !== BigInt(vaultFactoryVersion)
  ) {
    await provider.destroy();
    throw new Error(`Live factory pointers disagree on chain ${config.chainId}.`);
  }

  const create2 = getAddress(
    manifest.externalIntegrations?.create2Deployer?.address,
  );
  const create2Code = await provider.getCode(create2);
  const expectedCreate2Hash =
    manifest.externalIntegrations?.create2Deployer?.runtimeCodeHash;
  if (
    create2Code === "0x" ||
    !expectedCreate2Hash ||
    keccak256(create2Code).toLowerCase() !== expectedCreate2Hash.toLowerCase()
  ) {
    await provider.destroy();
    throw new Error(`Registered CREATE2 deployer mismatch on chain ${config.chainId}.`);
  }

  const startBlock = await factoryCreationBlock(
    provider,
    manifest,
    config.factory,
    latest,
  );
  const eventInterface = new (require("ethers").Interface)(
    REWARD_SYSTEM_CREATED_ABI,
  );
  const logs = await provider.getLogs({
    address: config.factory,
    fromBlock: startBlock,
    toBlock: latest,
    topics: [eventInterface.getEvent("RewardSystemCreated").topicHash],
  });
  const seenVaults = new Set();
  const vaults = [];
  for (const log of logs) {
    const event = eventInterface.parseLog(log);
    const active = await factory.rewardSystems(event.args.launchId);
    const vaultAddress = getAddress(event.args.vaultProxy);
    if (
      getAddress(active.vault) !== vaultAddress ||
      getAddress(active.creator) !== getAddress(event.args.creator) ||
      seenVaults.has(vaultAddress.toLowerCase())
    ) {
      throw new Error(
        `Factory reward-system event does not match active system on chain ${config.chainId}.`,
      );
    }
    seenVaults.add(vaultAddress.toLowerCase());
    const vault = new Contract(vaultAddress, artifact.abi, signer.connect(provider));
    const [
      vaultLaunchId,
      vaultCreator,
      upgraderRole,
      accrued,
      creatorBalance,
      totalSupply,
      issuancePaused,
      accrualPaused,
      implementationWord,
    ] = await Promise.all([
      vault.launchId(),
      vault.creator(),
      vault.UPGRADER_ROLE(),
      vault.accruedRewards(),
      vault.balanceOf(event.args.creator),
      vault.totalSupply(),
      vault.issuancePaused(),
      vault.accrualPaused(),
      provider.getStorage(vaultAddress, IMPLEMENTATION_SLOT),
    ]);
    const hasUpgrader = await vault.hasRole(upgraderRole, signer.address);
    if (
      vaultLaunchId.toLowerCase() !== event.args.launchId.toLowerCase() ||
      getAddress(vaultCreator) !== getAddress(event.args.creator) ||
      !hasUpgrader
    ) {
      throw new Error(`Creator Vault identity/upgrade role check failed on chain ${config.chainId}.`);
    }
    if (issuancePaused) {
      throw new Error(`Creator Vault issuance is paused on chain ${config.chainId}.`);
    }
    const liveImplementation = getAddress(`0x${implementationWord.slice(-40)}`);
    const liveRuntime = await provider.getCode(liveImplementation);
    if (liveRuntime === "0x") {
      throw new Error(`Live Creator Vault implementation has no code on chain ${config.chainId}.`);
    }
    await assertStorageCompatibility(
      config,
      manifest,
      build,
      provider,
      liveImplementation,
      liveRuntime,
    );
    vaults.push({
      launchId: event.args.launchId,
      creator: getAddress(event.args.creator),
      address: vaultAddress,
      implementation: liveImplementation,
      accrued,
      creatorBalance,
      totalSupply,
      lifetimeAutoIssued: await vault.lifetimeAutoIssued(),
      issuancePaused,
      accrualPaused,
      vault,
    });
  }
  if (vaults.length === 0) {
    await provider.destroy();
    throw new Error(`No active reward systems found on chain ${config.chainId}.`);
  }

  return {
    config,
    provider,
    manifest,
    factory,
    vaultFactory,
    create2,
    vaults,
    latest,
    currentFactoryImplementation: getAddress(currentFactoryImplementation),
    currentVaultImplementation: getAddress(currentVaultImplementation),
    routerImplementation: getAddress(routerImplementation),
    feeImplementation: getAddress(feeImplementation),
    factoryVersion: BigInt(factoryVersion),
    vaultFactoryVersion: BigInt(vaultFactoryVersion),
  };
}

async function simulateAndEstimate(chain, target, migrationData) {
  const fee = await cappedGasPrice(chain.provider);
  const operations = [];
  if (chain.currentFactoryImplementation !== target) {
    operations.push({
      label: "factory implementation pointer",
      contract: chain.factory,
      method: "approveImplementations",
      args: [target, chain.routerImplementation, chain.factoryVersion + 1n],
    });
  }
  if (chain.currentVaultImplementation !== target) {
    operations.push({
      label: "VaultFactory creator implementation pointer",
      contract: chain.vaultFactory,
      method: "setImplementations",
      args: [target, chain.feeImplementation, chain.vaultFactoryVersion + 1n],
    });
  }
  for (const record of chain.vaults) {
    if (record.implementation !== target) {
      operations.push({
        label: `Creator Vault upgrade + reward backfill ${record.launchId}`,
        contract: record.vault,
        method: "upgradeToAndCall",
        args: [target, migrationData],
        expectedMint: record.accrued,
        vaultRecord: record,
      });
    } else if (record.accrued > 0n) {
      operations.push({
        label: `Creator Vault reward backfill ${record.launchId}`,
        contract: record.vault,
        method: "migrateAccruedRewardsToJailETH",
        args: [],
        expectedMint: record.accrued,
        vaultRecord: record,
      });
    }
  }

  const estimates = [];
  let totalGas = 0n;
  for (const operation of operations) {
    await operation.contract.getFunction(operation.method).staticCall(
      ...operation.args,
    );
    const gas = await operation.contract
      .getFunction(operation.method)
      .estimateGas(...operation.args);
    totalGas += gas;
    estimates.push({
      label: operation.label,
      method: operation.method,
      gasEstimate: gas.toString(),
      expectedMintWei: operation.expectedMint?.toString() ?? "0",
      vault: operation.vaultRecord?.address,
    });
  }
  const balance = await chain.provider.getBalance(chain.factory.runner.address);
  const bufferedGas = (totalGas * 125n + 99n) / 100n;
  const requiredWei = bufferedGas * fee;
  if (requiredWei > balance) {
    throw new Error(
      `Signer balance is insufficient for the approved upgrade on chain ${chain.config.chainId}.`,
    );
  }
  return {
    fee,
    balance,
    requiredWei,
    estimates,
    operations,
  };
}

async function sendOperation(chain, operation, progress) {
  const fee = await cappedGasPrice(chain.provider);
  const gas = await operation.contract
    .getFunction(operation.method)
    .estimateGas(...operation.args);
  const gasLimit = (gas * 120n + 99n) / 100n;
  const balance = await chain.provider.getBalance(chain.factory.runner.address);
  if (balance < gasLimit * fee) {
    throw new Error(`Signer balance is insufficient for ${operation.label} on chain ${chain.config.chainId}.`);
  }
  const tx = await operation.contract.getFunction(operation.method)(
    ...operation.args,
    {
      gasPrice: fee,
      gasLimit,
    },
  );
  progress.transactions ??= [];
  progress.transactions.push({
    label: operation.label,
    transactionHash: tx.hash,
  });
  saveJson(chain.config.progress, progress);
  console.log(
    JSON.stringify({
      chainId: chain.config.chainId,
      step: operation.label,
      transactionHash: tx.hash,
    }),
  );
  const receipt = await tx.wait(2);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${operation.label} failed on chain ${chain.config.chainId}.`);
  }
  return receipt;
}

async function run() {
  const deployOnly = process.argv.includes("--deploy-implementation");
  const execute = process.argv.includes("--execute");
  if (deployOnly && execute) {
    throw new Error("Choose --deploy-implementation or --execute, not both.");
  }
  const { artifact, build } = loadCompiledBuild();
  const key = process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Authorized deployer is unavailable.");
  const signer = new Wallet(key);
  const initCodeHash = keccak256(artifact.bytecode);
  const chains = [];
  try {
    for (const config of CHAIN_CONFIGS) {
      chains.push(await prepareChain(config, build, artifact, signer));
    }
    const referenceCreate2 = chains[0].create2;
    if (chains.some((chain) => chain.create2 !== referenceCreate2)) {
      throw new Error("The registered CREATE2 deployers differ across chains.");
    }
    const mined = await mineVanitySalt({
      deployer: referenceCreate2,
      initCode: artifact.bytecode,
      stateFile: `/tmp/armoreum-creator-reward-issuance-${initCodeHash.slice(2, 14)}.json`,
    });
    const target = getAddress(mined.address);
    if (!target.toLowerCase().startsWith("0x6900")) {
      throw new Error("CREATE2 implementation address does not match the registered prefix.");
    }
    const expectedRuntimeHash = keccak256(
      compiledRuntimeAtAddress(build, target),
    );
    const deployData = encodeCreate2Deployment(mined.salt, artifact.bytecode);
    const migrationData = artifact.abi
      .filter((item) => item.type === "function")
      .length
      ? new Contract(target, artifact.abi).interface.encodeFunctionData(
          "migrateAccruedRewardsToJailETH",
        )
      : "0x";
    const plans = [];
    for (const chain of chains) {
      const targetCode = await chain.provider.getCode(target);
      if (
        targetCode !== "0x" &&
        keccak256(targetCode).toLowerCase() !== expectedRuntimeHash.toLowerCase()
      ) {
        throw new Error(`Deterministic target has different code on ${chain.config.chainId}.`);
      }
      const fee = await cappedGasPrice(chain.provider);
      const deploymentGas = targetCode === "0x"
        ? await chain.provider.estimateGas({
            from: signer.address,
            to: chain.create2,
            data: deployData,
            gasPrice: fee,
          })
        : 0n;
      const balance = await chain.provider.getBalance(signer.address);
      const deploymentRequired =
        ((deploymentGas * 125n + 99n) / 100n) * fee;
      plans.push({
        chain,
        targetCode,
        fee,
        deploymentGas,
        balance,
        deploymentRequired,
      });
    }

    const output = plans.map((plan) => ({
      chainId: plan.chain.config.chainId,
      mode: deployOnly ? "deploy implementation only" : execute ? "execute upgrade" : "read-only plan",
      factory: plan.chain.config.factory,
      vaultFactory: plan.chain.config.vaultFactory,
      activeRewardVaults: plan.chain.vaults.map((vault) => ({
        launchId: vault.launchId,
        address: vault.address,
        implementation: vault.implementation,
        accruedRewardsWei: vault.accrued.toString(),
        creatorJailETHWei: vault.creatorBalance.toString(),
        totalSupplyWei: vault.totalSupply.toString(),
        issuancePaused: vault.issuancePaused,
        accrualPaused: vault.accrualPaused,
      })),
      previousImplementation: plan.chain.currentVaultImplementation,
      newImplementation: target,
      preservedTaxRouterAndFeeImplementation: plan.chain.routerImplementation,
      factoryVersion: plan.chain.factoryVersion.toString(),
      vaultFactoryVersion: plan.chain.vaultFactoryVersion.toString(),
      implementationAlreadyDeployed: plan.targetCode !== "0x",
      deploymentGasEstimate: plan.deploymentGas.toString(),
      gasPriceWei: plan.fee.toString(),
      signerBalanceWei: plan.balance.toString(),
      deploymentBudgetWei: plan.deploymentRequired.toString(),
    }));
    console.log(JSON.stringify(output, null, 2));

    if (deployOnly) {
      for (const plan of plans) {
        if (plan.targetCode !== "0x") continue;
        if (plan.deploymentRequired > plan.balance) {
          throw new Error(`Insufficient deployment balance on chain ${plan.chain.config.chainId}.`);
        }
        const progress = fs.existsSync(plan.chain.config.progress)
          ? JSON.parse(fs.readFileSync(plan.chain.config.progress, "utf8"))
          : {};
        const tx = await signer.connect(plan.chain.provider).sendTransaction({
          to: plan.chain.create2,
          data: deployData,
          gasPrice: await cappedGasPrice(plan.chain.provider),
          gasLimit: (plan.deploymentGas * 120n + 99n) / 100n,
        });
        progress.target = target;
        progress.deployment = { transactionHash: tx.hash };
        saveJson(plan.chain.config.progress, progress);
        console.log(
          JSON.stringify({
            chainId: plan.chain.config.chainId,
            step: "deploy CreatorRewardVault implementation",
            transactionHash: tx.hash,
          }),
        );
        const receipt = await tx.wait(2);
        if (!receipt || receipt.status !== 1) {
          throw new Error(`Implementation deployment failed on chain ${plan.chain.config.chainId}.`);
        }
        progress.deployment.blockNumber = receipt.blockNumber;
        saveJson(plan.chain.config.progress, progress);
        const runtime = await plan.chain.provider.getCode(target);
        if (keccak256(runtime).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
          throw new Error(`Deployed implementation bytecode mismatch on chain ${plan.chain.config.chainId}.`);
        }
      }
      console.log("Implementation deployed; rerun without flags for live call simulations before upgrading proxies.");
      return;
    }

    if (plans.some((plan) => plan.targetCode === "0x") && !execute) return;
    if (plans.some((plan) => plan.targetCode === "0x")) {
      throw new Error("Implementation must be deployed on both chains before --execute.");
    }

    const simulations = [];
    for (const chain of chains) {
      const simulation = await simulateAndEstimate(chain, target, migrationData);
      simulations.push({ chain, ...simulation });
    }
    console.log(
      JSON.stringify(
        simulations.map((simulation) => ({
          chainId: simulation.chain.config.chainId,
          gasPriceCapWei: simulation.fee.toString(),
          signerBalanceWei: simulation.balance.toString(),
          requiredBudgetWei: simulation.requiredWei.toString(),
          operations: simulation.estimates,
        })),
        null,
        2,
      ),
    );
    if (!execute) return;

    const implementation = new Contract(
      target,
      ["function proxiableUUID() view returns(bytes32)"],
      chains[0].provider,
    );
    if (
      (await implementation.proxiableUUID()).toLowerCase() !==
      IMPLEMENTATION_SLOT.toLowerCase()
    ) {
      throw new Error("New implementation does not expose the expected UUPS UUID.");
    }

    for (const simulation of simulations) {
      const chain = simulation.chain;
      const progress = fs.existsSync(chain.config.progress)
        ? JSON.parse(fs.readFileSync(chain.config.progress, "utf8"))
        : {};
      progress.target = target;
      for (const operation of simulation.operations) {
        await sendOperation(chain, operation, progress);
      }
      if (
        getAddress(await chain.factory.vaultImplementation()) !== target ||
        getAddress(await chain.vaultFactory.creatorVaultImplementation()) !== target ||
        getAddress(await chain.factory.taxRouterImplementation()) !==
          chain.routerImplementation ||
        getAddress(await chain.vaultFactory.feeVaultImplementation()) !==
          chain.feeImplementation ||
        BigInt(await chain.factory.implementationVersion()) !==
          BigInt(await chain.vaultFactory.implementationVersion())
      ) {
        throw new Error(`Factory pointer post-check failed on chain ${chain.config.chainId}.`);
      }
      for (const record of chain.vaults) {
        const implementationWord = await chain.provider.getStorage(
          record.address,
          IMPLEMENTATION_SLOT,
        );
        const activeImplementation = getAddress(`0x${implementationWord.slice(-40)}`);
        const [accrued, balance, supply, lifetimeAutoIssued, vaultEth] =
          await Promise.all([
          record.vault.accruedRewards(),
          record.vault.balanceOf(record.creator),
          record.vault.totalSupply(),
          record.vault.lifetimeAutoIssued(),
          chain.provider.getBalance(record.address),
          ]);
        if (
          activeImplementation !== target ||
          accrued !== 0n ||
          balance !== record.creatorBalance + record.accrued ||
          supply !== record.totalSupply + record.accrued ||
          lifetimeAutoIssued !== record.lifetimeAutoIssued + record.accrued ||
          vaultEth < supply
        ) {
          throw new Error(
            `Creator Vault post-upgrade backing/issuance check failed for ${record.address}.`,
          );
        }
      }

      const prepared = chain.manifest.contracts.find(
        (entry) =>
          entry.name === "CreatorRewardVault-implementation-prepared" &&
          entry.address.toLowerCase() === target.toLowerCase(),
      );
      const oldRecord = chain.manifest.contracts.find(
        (entry) => entry.name === "CreatorRewardVault-implementation",
      );
      if (oldRecord && oldRecord.address.toLowerCase() !== target.toLowerCase()) {
        oldRecord.name = "CreatorRewardVault-implementation-before-any-credit-issuance";
      }
      if (prepared) prepared.name = "CreatorRewardVault-implementation";
      else if (
        !chain.manifest.contracts.some(
          (entry) =>
            entry.name === "CreatorRewardVault-implementation" &&
            entry.address.toLowerCase() === target.toLowerCase(),
        )
      ) {
        chain.manifest.contracts.push({
          name: "CreatorRewardVault-implementation",
          address: target,
          salt: mined.salt,
          deployer: chain.create2,
          initCodeHash,
          runtimeCodeHash: expectedRuntimeHash,
          transactionHash: progress.deployment?.transactionHash,
          blockNumber: progress.deployment?.blockNumber,
          sourceVerification: "pending",
        });
      }
      chain.manifest.implementationVersion = Number(
        await chain.factory.implementationVersion(),
      );
      chain.manifest.vaultFactory.creatorVaultImplementation = target;
      chain.manifest.vaultFactory.feeVaultImplementation =
        chain.feeImplementation;
      chain.manifest.vaultFactory.implementationVersion = Number(
        await chain.vaultFactory.implementationVersion(),
      );
      saveJson(chain.config.manifest, chain.manifest);
      console.log(
        JSON.stringify({
          chainId: chain.config.chainId,
          verified: true,
          creatorVaultImplementation: target,
          preservedFeeImplementation: chain.feeImplementation,
          vaultsBackedAndIssued: chain.vaults.map((record) => ({
            launchId: record.launchId,
            vault: record.address,
            accruedRewardsWei: "0",
            creatorJailETHWei: (
              record.creatorBalance + record.accrued
            ).toString(),
          })),
        }),
      );
    }
  } finally {
    await Promise.all(chains.map((chain) => chain.provider.destroy()));
  }
}

run().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Mainnet upgrade failed.";
  console.error(message.replace(/https?:\/\/\S+/g, "<RPC endpoint redacted>"));
  process.exitCode = 1;
});
