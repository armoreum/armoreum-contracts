const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const TARGET = process.env.ARMOREUM_DEPLOY_TARGET || "robinhood";
if (!["ethereum", "robinhood"].includes(TARGET)) {
  throw new Error("ARMOREUM_DEPLOY_TARGET must be ethereum or robinhood");
}
const CHAIN_ID = TARGET === "ethereum" ? 1n : 4663n;
const NETWORK_NAME = TARGET === "ethereum" ? "Ethereum mainnet" : "Robinhood Chain";
const CONFIRMATION_VARIABLE =
  TARGET === "ethereum" ? "DEPLOY_ETHEREUM_MAINNET_CONFIRMATION" : "DEPLOY_MAINNET_CONFIRMATION";
const DEPLOYMENT_CONFIRMATION =
  TARGET === "ethereum"
    ? "I confirm deployment to Ethereum mainnet chain 1"
    : "I confirm deployment to Robinhood Chain 4663";
const coder = ethers.AbiCoder.defaultAbiCoder();
const stateDirectory = path.join(__dirname, "..", "deployments", `${CHAIN_ID}.vanity`);
const PONS_V2_HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const PONS_V2_HOOK_RUNTIME_HASH =
  "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db";
const PONS_V2_FEE_ESCROW = "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e";
const PONS_V2_FEE_ESCROW_RUNTIME_HASH =
  "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1";
const CANCUN_OPCODE_PROBES = [
  ["PUSH0", "0x5f60005260206000f3"],
  ["MCOPY", "0x5f5f5f5e00"],
  ["TSTORE", "0x5f5f5d00"],
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function addressSetting(name) {
  const value = required(name);
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address`);
  }
  return ethers.getAddress(value);
}

function secretWalletAddress(name) {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hexadecimal signing key`);
  }
  return new ethers.Wallet(value).address;
}

function requirePrefix(name, address) {
  if (!address.toLowerCase().startsWith(PREFIX)) {
    throw new Error(`${name} must start with ${PREFIX}`);
  }
}

function requiresCorePrefix() {
  // This initial deployment plan contains shared core implementations and
  // factories only. Per-token instances are created later by those factories.
  return true;
}

function writePartialDeployment(filePath, progress) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(progress, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function requireCode(name, address) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") throw new Error(`${name} has no deployed code on ${NETWORK_NAME}`);
  return code;
}

async function verifyRobinhoodEvmOpcodes() {
  for (const [name, data] of CANCUN_OPCODE_PROBES) {
    try {
      await ethers.provider.send("eth_call", [{ data }, "latest"]);
    } catch {
      throw new Error(`Robinhood Chain does not support required EVM opcode ${name}`);
    }
  }
}

async function verifyPonsFeeRoute(taxSource) {
  if (taxSource.toLowerCase() !== PONS_V2_HOOK.toLowerCase()) {
    throw new Error("Pons hook address does not match the verified Robinhood deployment");
  }
  const hookCode = await requireCode("Verified Pons tax-routing source", taxSource);
  if (ethers.keccak256(hookCode).toLowerCase() !== PONS_V2_HOOK_RUNTIME_HASH.toLowerCase()) {
    throw new Error("Pons hook runtime bytecode does not match the verified deployment");
  }

  const hook = new ethers.Contract(
    taxSource,
    [
      "function feeEscrow() view returns (address)",
      "function feeSweepOperator() view returns (address)",
    ],
    ethers.provider,
  );
  const [feeEscrow, feeSweepOperator] = await Promise.all([
    hook.feeEscrow(),
    hook.feeSweepOperator(),
  ]);
  if (feeEscrow.toLowerCase() !== PONS_V2_FEE_ESCROW.toLowerCase()) {
    throw new Error("Pons hook returned an unexpected fee escrow");
  }
  const escrowCode = await requireCode("Verified Pons fee escrow", feeEscrow);
  if (ethers.keccak256(escrowCode).toLowerCase() !== PONS_V2_FEE_ESCROW_RUNTIME_HASH.toLowerCase()) {
    throw new Error("Pons fee escrow runtime bytecode does not match the verified deployment");
  }
  const escrow = new ethers.Contract(
    feeEscrow,
    ["function balanceOf(address recipient) view returns (uint256)"],
    ethers.provider,
  );
  await escrow.balanceOf(ethers.ZeroAddress);
  return { feeEscrow, feeSweepOperator };
}

async function prepareDeployment(label, initCode, create2Address) {
  const initCodeHash = ethers.keccak256(initCode);
  const result = requiresCorePrefix(label)
    ? await mineVanitySalt({
        deployer: create2Address,
        initCode,
        stateFile: path.join(
          stateDirectory,
          `${label}-${initCodeHash.slice(2, 10)}.json`,
        ),
        maxAttempts: Number(process.env.MAX_VANITY_ATTEMPTS || 2_000_000),
      })
    : (() => {
        const salt = ethers.keccak256(
          ethers.toUtf8Bytes(`${CHAIN_ID}:${label}:${initCodeHash}`),
        );
        return {
          salt,
          address: ethers.getCreate2Address(create2Address, salt, initCodeHash),
        };
      })();
  const expectedAddress = ethers.getCreate2Address(
    create2Address,
    result.salt,
    initCodeHash,
  );
  if (expectedAddress.toLowerCase() !== result.address.toLowerCase()) {
    throw new Error(`CREATE2 prediction mismatch while preparing ${label}`);
  }
  if (requiresCorePrefix(label)) requirePrefix(label, expectedAddress);
  return {
    label,
    initCode,
    salt: result.salt,
    deployer: create2Address,
    initCodeHash,
    expectedAddress,
  };
}

async function preflightPreparedDeployment(signer, deployment) {
  if ((await ethers.provider.getCode(deployment.expectedAddress)) !== "0x") {
    throw new Error(`${deployment.label} predicted address already has code`);
  }
  const predictedAgain = ethers.getCreate2Address(
    deployment.deployer,
    deployment.salt,
    deployment.initCodeHash,
  );
  if (predictedAgain.toLowerCase() !== deployment.expectedAddress.toLowerCase()) {
    throw new Error(`CREATE2 prediction changed before broadcasting ${deployment.label}`);
  }
  requirePrefix(deployment.label, predictedAgain);

  const data = encodeCreate2Deployment(deployment.salt, deployment.initCode);
  const call = {
    from: await signer.getAddress(),
    to: deployment.deployer,
    data,
  };
  let gasEstimate;
  try {
    gasEstimate = await ethers.provider.estimateGas(call);
  } catch (error) {
    throw new Error(`${deployment.label} CREATE2 gas estimation failed: ${error.shortMessage || error.message}`);
  }
  try {
    const simulationResult = await ethers.provider.call(call);
    if (simulationResult !== "0x" && ethers.isAddress(simulationResult)) {
      if (simulationResult.toLowerCase() !== deployment.expectedAddress.toLowerCase()) {
        throw new Error("simulated CREATE2 address did not match the prediction");
      }
    }
  } catch (error) {
    throw new Error(`${deployment.label} CREATE2 simulation failed: ${error.shortMessage || error.message}`);
  }
  return { deployment, data, gasLimit: (gasEstimate * 120n) / 100n };
}

async function deployPrepared(signer, preflight) {
  const { deployment, data, gasLimit } = preflight;
  const transaction = await signer.sendTransaction({
    to: deployment.deployer,
    data,
    gasLimit,
  });
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${deployment.label} CREATE2 transaction did not succeed`);
  }

  const actualAddress = deployment.expectedAddress;
  requirePrefix(`${deployment.label} actual address`, actualAddress);
  const runtimeCode = await ethers.provider.getCode(actualAddress);
  if (runtimeCode === "0x") {
    throw new Error(`${deployment.label} has no runtime code after deployment`);
  }
  return {
    name: deployment.label,
    address: actualAddress,
    salt: deployment.salt,
    deployer: deployment.deployer,
    initCodeHash: deployment.initCodeHash,
    runtimeCodeHash: ethers.keccak256(runtimeCode),
    transactionHash: receipt.hash,
    sourceVerification: "pending",
  };
}

async function main() {
  if (required(CONFIRMATION_VARIABLE) !== DEPLOYMENT_CONFIRMATION) {
    throw new Error(`Explicit ${NETWORK_NAME} deployment confirmation is required`);
  }
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== CHAIN_ID) {
    throw new Error(`Refusing deployment on chain ${network.chainId}; expected ${CHAIN_ID} (${NETWORK_NAME})`);
  }
  if (TARGET === "robinhood") await verifyRobinhoodEvmOpcodes();
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("A deployment signer is not configured");

  const owner = secretWalletAddress("DEPLOYER_PRIVATE_KEY");
  const emergencyOperator = secretWalletAddress("PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY");
  const deployerAddress = await deployer.getAddress();
  if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
    throw new Error(
      "The one-shot factory configuration requires the deployer signer to be the canonical platform owner; no contracts were deployed.",
    );
  }
  if (emergencyOperator.toLowerCase() === owner.toLowerCase()) {
    throw new Error("The emergency operator must be distinct from the canonical owner.");
  }
  let taxSource = ethers.ZeroAddress;
  let ponsRoute = null;
  let ponsFeeProcessor = ethers.ZeroAddress;
  if (TARGET === "robinhood") {
    taxSource = addressSetting("PONS_TAX_ROUTING_SOURCE_ADDRESS");
    const ponsFeeProcessorKey = required("PONS_FEE_PROCESSOR_PRIVATE_KEY");
    ponsFeeProcessor = new ethers.Wallet(ponsFeeProcessorKey).address;
    if (ponsFeeProcessor.toLowerCase() === deployerAddress.toLowerCase()) {
      throw new Error("Use a dedicated Pons fee processor signer, separate from the deployer");
    }
    if (ponsFeeProcessor.toLowerCase() === emergencyOperator.toLowerCase()) {
      throw new Error("Use a Pons fee processor signer separate from the emergency operator");
    }
    ponsRoute = await verifyPonsFeeRoute(taxSource);
  }
  const foundationRecipient = secretWalletAddress("WALLET_FNDN_KEY");

  const rpIdHash = required("PASSKEY_RP_ID_HASH");
  if (!/^0x[0-9a-fA-F]{64}$/.test(rpIdHash)) {
    throw new Error("PASSKEY_RP_ID_HASH must be a 32-byte hex value");
  }

  const create2Address = addressSetting("CREATE2_DEPLOYER_ADDRESS");
  const expectedCreate2RuntimeHash = required("CREATE2_DEPLOYER_RUNTIME_CODE_HASH");
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedCreate2RuntimeHash)) {
    throw new Error("CREATE2_DEPLOYER_RUNTIME_CODE_HASH must be a 32-byte hex value");
  }
  const create2Runtime = await requireCode("Verified CREATE2 deployer", create2Address);
  if (ethers.keccak256(create2Runtime).toLowerCase() !== expectedCreate2RuntimeHash.toLowerCase()) {
    throw new Error("CREATE2 deployer runtime code hash does not match the verified value");
  }

  const verifierFactory = await ethers.getContractFactory("ArmoreumPasskeyVerifier");
  const vaultFactory = await ethers.getContractFactory("CreatorRewardVault");
  const routerFactory = await ethers.getContractFactory("TaxRouter");
  const factoryFactory = await ethers.getContractFactory("ArmoreumFactory");
  const vaultRegistryFactory = await ethers.getContractFactory("VaultFactory");
  const jailTokenFactory = await ethers.getContractFactory("JailTokenFactory");
  const verifier = await prepareDeployment("ArmoreumPasskeyVerifier", verifierFactory.bytecode, create2Address);
  const vault = await prepareDeployment("CreatorRewardVault-implementation", vaultFactory.bytecode, create2Address);
  const router = await prepareDeployment("TaxRouter-implementation", routerFactory.bytecode, create2Address);
  const factoryImplementation = await prepareDeployment("ArmoreumFactory-implementation", factoryFactory.bytecode, create2Address);
  const jailToken = await prepareDeployment(
    "JailToken-implementation",
    (await ethers.getContractFactory("JailToken")).bytecode,
    create2Address,
  );
  const jailEthReceipt = await prepareDeployment(
    "JailETHReceipt-implementation",
    (await ethers.getContractFactory("JailETHReceipt")).bytecode,
    create2Address,
  );
  const jailTokenFactoryImplementation = await prepareDeployment(
    "JailTokenFactory-implementation",
    jailTokenFactory.bytecode,
    create2Address,
  );
  const jailSwapVaultImplementation = await prepareDeployment(
    "JailSwapVault-implementation",
    (await ethers.getContractFactory("JailSwapVault")).bytecode,
    create2Address,
  );
  const vaultRegistryImplementation = await prepareDeployment(
    "VaultFactory-implementation",
    vaultRegistryFactory.bytecode,
    create2Address,
  );

  const factoryInitialization = factoryFactory.interface.encodeFunctionData(
    "initializeWithEmergencyOperator",
    [
    owner,
    verifier.expectedAddress,
    rpIdHash,
    vault.expectedAddress,
    router.expectedAddress,
    taxSource,
    1,
    foundationRecipient,
    emergencyOperator,
    ponsFeeProcessor,
    ],
  );
  const proxyArtifact = await artifacts.readArtifact("ERC1967Proxy");
  const factoryProxyInitCode = ethers.concat([
    proxyArtifact.bytecode,
    coder.encode(
      ["address", "bytes"],
      [factoryImplementation.expectedAddress, factoryInitialization],
    ),
  ]);
  const factoryProxy = await prepareDeployment(
    "ArmoreumFactory-proxy",
    factoryProxyInitCode,
    create2Address,
  );

  const vaultRegistryInitialization = vaultRegistryFactory.interface.encodeFunctionData(
    "initialize",
    [owner, emergencyOperator, factoryProxy.expectedAddress],
  );
  const vaultRegistryProxyInitCode = ethers.concat([
    proxyArtifact.bytecode,
    coder.encode(
      ["address", "bytes"],
      [vaultRegistryImplementation.expectedAddress, vaultRegistryInitialization],
    ),
  ]);
  const vaultRegistryProxy = await prepareDeployment(
    "VaultFactory-proxy",
    vaultRegistryProxyInitCode,
    create2Address,
  );
  const jailTokenFactoryInitialization = jailTokenFactory.interface.encodeFunctionData(
    "initializeWithJailEth",
    [
      owner,
      owner,
      jailToken.expectedAddress,
      jailEthReceipt.expectedAddress,
    ],
  );
  const jailTokenFactoryProxyInitCode = ethers.concat([
    proxyArtifact.bytecode,
    coder.encode(
      ["address", "bytes"],
      [jailTokenFactoryImplementation.expectedAddress, jailTokenFactoryInitialization],
    ),
  ]);
  const jailTokenFactoryProxy = await prepareDeployment(
    "JailTokenFactory-proxy",
    jailTokenFactoryProxyInitCode,
    create2Address,
  );

  const planned = [
    verifier,
    vault,
    router,
    factoryImplementation,
    factoryProxy,
    vaultRegistryImplementation,
    vaultRegistryProxy,
    jailToken,
    jailEthReceipt,
    jailTokenFactoryImplementation,
    jailTokenFactoryProxy,
    jailSwapVaultImplementation,
  ];
  for (const entry of planned) {
    if (requiresCorePrefix(entry.label)) {
      requirePrefix(entry.label, entry.expectedAddress);
    }
  }

  const output = path.join(__dirname, "..", "deployments", `${CHAIN_ID}.json`);
  const progressFile = path.join(__dirname, "..", "deployments", `${CHAIN_ID}.partial.json`);
  if (fs.existsSync(output)) {
    throw new Error(`A deployment manifest already exists at ${output}; reconcile it before broadcasting.`);
  }
  let progress = { chainId: Number(CHAIN_ID), network: NETWORK_NAME, contracts: [], configuration: {} };
  if (fs.existsSync(progressFile)) {
    progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
    if (progress.chainId !== Number(CHAIN_ID) || progress.network !== NETWORK_NAME) {
      throw new Error(`Partial deployment record ${progressFile} belongs to a different network.`);
    }
    if (!Array.isArray(progress.contracts) || !progress.configuration) {
      throw new Error(`Partial deployment record ${progressFile} is invalid.`);
    }
  }
  const priorRecords = new Map(
    progress.contracts.map((record) => [record.address.toLowerCase(), record]),
  );
  for (const entry of planned) {
    const code = await ethers.provider.getCode(entry.expectedAddress);
    const priorRecord = priorRecords.get(entry.expectedAddress.toLowerCase());
    if (code !== "0x") {
      if (!priorRecord || ethers.keccak256(code).toLowerCase() !== priorRecord.runtimeCodeHash.toLowerCase()) {
        throw new Error(`${entry.label} address has unregistered or mismatched code; no new contracts were broadcast.`);
      }
    } else if (priorRecord) {
      throw new Error(`${entry.label} is recorded as deployed but has no on-chain code.`);
    }
  }
  if (process.env.ARMOREUM_DEPLOY_DRY_RUN === "1") {
    const next = planned.find((entry) => !priorRecords.has(entry.expectedAddress.toLowerCase()));
    if (!next) {
      process.stdout.write(`${JSON.stringify({
        chainId: Number(CHAIN_ID),
        network: NETWORK_NAME,
        dryRun: true,
        deployments: [],
        note: "All planned contracts already match the partial deployment record.",
      }, null, 2)}\n`);
      return;
    }
    const { deployment, gasLimit } = await preflightPreparedDeployment(deployer, next);
    process.stdout.write(`${JSON.stringify({
      chainId: Number(CHAIN_ID),
      network: NETWORK_NAME,
      dryRun: true,
      deployments: [{
        name: deployment.label,
        address: deployment.expectedAddress,
        estimatedGasLimit: gasLimit.toString(),
      }],
      note: "Only the first standalone deployment is simulated; dependent proxies require earlier deployments to exist.",
    }, null, 2)}\n`);
    return;
  }

  const contracts = [];
  for (const entry of planned) {
    const priorRecord = priorRecords.get(entry.expectedAddress.toLowerCase());
    if (priorRecord) {
      contracts.push(priorRecord);
      continue;
    }
    const preflight = await preflightPreparedDeployment(deployer, entry);
    const record = await deployPrepared(deployer, preflight);
    contracts.push(record);
    progress.contracts = contracts;
    writePartialDeployment(progressFile, progress);
  }

  const deployedVaultRegistry = vaultRegistryFactory.attach(vaultRegistryProxy.expectedAddress);
  const implementationRegistration = await deployedVaultRegistry.setImplementations(
    vault.expectedAddress,
    router.expectedAddress,
    1,
  );
  const implementationRegistrationReceipt = await implementationRegistration.wait();
  if (!implementationRegistrationReceipt || implementationRegistrationReceipt.status !== 1) {
    throw new Error("VaultFactory UUPS implementations were not registered.");
  }

  const deployedJailTokenFactory = jailTokenFactory.attach(
    jailTokenFactoryProxy.expectedAddress,
  );
  let jailTokenFactoryPermissionHash =
    progress.configuration.jailTokenFactoryPermissionHash;
  const launchFactoryRole = await deployedJailTokenFactory.LAUNCH_FACTORY_ROLE();
  if (await deployedJailTokenFactory.hasRole(
    launchFactoryRole,
    vaultRegistryProxy.expectedAddress,
  )) {
    if (!jailTokenFactoryPermissionHash) {
      const logs = await deployedJailTokenFactory.queryFilter(
        deployedJailTokenFactory.filters.LaunchFactoryPermissionChanged(
          vaultRegistryProxy.expectedAddress,
          true,
        ),
        0,
        "latest",
      );
      jailTokenFactoryPermissionHash = logs.at(-1)?.transactionHash;
    }
  } else {
    const permission = await deployedJailTokenFactory.setLaunchFactory(
      vaultRegistryProxy.expectedAddress,
      true,
    );
    const receipt = await permission.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("VaultFactory did not receive JailTokenFactory launch permission.");
    }
    jailTokenFactoryPermissionHash = receipt.hash;
  }
  if (!jailTokenFactoryPermissionHash) {
    throw new Error("JailTokenFactory permission transaction hash could not be recovered.");
  }

  let jailSwapImplementationRegistrationHash =
    progress.configuration.jailSwapImplementationRegistrationHash;
  const jailSwapVersion = await deployedVaultRegistry.jailSwapImplementationVersion();
  if (jailSwapVersion === 1n) {
    if (
      (await deployedVaultRegistry.jailSwapVaultImplementation()).toLowerCase()
        !== jailSwapVaultImplementation.expectedAddress.toLowerCase()
      || (await deployedVaultRegistry.jailTokenFactory()).toLowerCase()
        !== jailTokenFactoryProxy.expectedAddress.toLowerCase()
    ) {
      throw new Error("VaultFactory has conflicting JailSwap implementation configuration.");
    }
    if (!jailSwapImplementationRegistrationHash) {
      const logs = await deployedVaultRegistry.queryFilter(
        deployedVaultRegistry.filters.JailSwapImplementationsChanged(
          jailSwapVaultImplementation.expectedAddress,
          jailTokenFactoryProxy.expectedAddress,
          1,
        ),
        0,
        "latest",
      );
      jailSwapImplementationRegistrationHash = logs.at(-1)?.transactionHash;
    }
  } else if (jailSwapVersion === 0n) {
    const registration = await deployedVaultRegistry.setJailSwapImplementations(
      jailSwapVaultImplementation.expectedAddress,
      jailTokenFactoryProxy.expectedAddress,
      1,
    );
    const receipt = await registration.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("VaultFactory JailSwap implementation registration failed.");
    }
    jailSwapImplementationRegistrationHash = receipt.hash;
  } else {
    throw new Error(`Unexpected VaultFactory JailSwap implementation version ${jailSwapVersion}.`);
  }
  if (!jailSwapImplementationRegistrationHash) {
    throw new Error("VaultFactory JailSwap registration transaction hash could not be recovered.");
  }
  progress.contracts = contracts;
  progress.configuration.jailTokenFactoryPermissionHash =
    jailTokenFactoryPermissionHash;
  progress.configuration.jailSwapImplementationRegistrationHash =
    jailSwapImplementationRegistrationHash;
  writePartialDeployment(progressFile, progress);

  const deployedArmoreumFactory = factoryFactory.attach(factoryProxy.expectedAddress);
  const registryRegistration = await deployedArmoreumFactory.setVaultFactory(
    vaultRegistryProxy.expectedAddress,
  );
  const registryRegistrationReceipt = await registryRegistration.wait();
  if (!registryRegistrationReceipt || registryRegistrationReceipt.status !== 1) {
    throw new Error("ArmoreumFactory was not connected to VaultFactory.");
  }
  if (
    (await deployedArmoreumFactory.vaultFactory()).toLowerCase()
      !== vaultRegistryProxy.expectedAddress.toLowerCase()
  ) {
    throw new Error("ArmoreumFactory VaultFactory address verification failed.");
  }

  const manifest = {
    chainId: Number(CHAIN_ID),
    network: NETWORK_NAME,
    status: "core factories deployed; launch remains disabled pending verified transaction integrations",
    addressPrefix: { requiredFor: "core Armoreum contracts only", value: PREFIX },
    contracts,
    authorities: {
      canonicalPlatformOwner: owner,
      emergencyOperator,
      emergencyRoleSeparatedFromUpgradeAuthority:
        emergencyOperator.toLowerCase() !== owner.toLowerCase(),
    },
    externalIntegrations: {
      ...(TARGET === "robinhood"
        ? {
            ponsTaxRoutingSource: taxSource,
            ponsFeeEscrow: ponsRoute.feeEscrow,
            ponsFeeSweepOperator: ponsRoute.feeSweepOperator,
          }
        : {
            ethereumTaxRoutingSource: "not-configured; Ethereum launch remains disabled",
          }),
      create2Deployer: {
        address: create2Address,
        runtimeCodeHash: ethers.keccak256(create2Runtime),
        externalThirdPartyInfrastructure: true,
      },
    },
    implementationVersion: 1,
    vaultFactory: {
      address: vaultRegistryProxy.expectedAddress,
      implementation: vaultRegistryImplementation.expectedAddress,
      creatorVaultImplementation: vault.expectedAddress,
      feeVaultImplementation: router.expectedAddress,
      configurationTransactionHashes: [
        implementationRegistrationReceipt.hash,
        registryRegistrationReceipt.hash,
      ],
    },
    launchEnabled: false,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Deployment failed"}\n`);
  process.exitCode = 1;
});
