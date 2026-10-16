const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { getAddress, getCreate2Address, keccak256 } = require("ethers");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const { ethers } = hre;
const NETWORK_IDS = { ethereum: 1, robinhood: 4663 };
const ADMIN_ROLE = ethers.ZeroHash;
const IMPLEMENTATION_ARTIFACT =
  "contracts/bridge/ArmoreumMultichainVault.sol/ArmoreumMultichainVault.json";

function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function main() {
  const chainId = NETWORK_IDS[hre.network.name];
  if (!chainId) throw new Error("Run only against ethereum or robinhood mainnet.");
  if (Number((await ethers.provider.getNetwork()).chainId) !== chainId) {
    throw new Error(`RPC chain ID does not match ${hre.network.name} mainnet.`);
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const manifestPath = path.join(deploymentsDir, `${chainId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const vaultFactoryAddress = manifest.multichainCore?.vaultFactoryProxy;
  if (!vaultFactoryAddress) throw new Error("The live VaultFactory proxy is not in the deployment record.");

  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const create2EnvName = chainId === 1
    ? "ETHEREUM_CREATE2_DEPLOYER_ADDRESS"
    : "CREATE2_DEPLOYER_ADDRESS";
  const create2HashEnvName = chainId === 1
    ? "ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH"
    : "CREATE2_DEPLOYER_RUNTIME_CODE_HASH";
  const create2Address = getAddress(process.env[create2EnvName] || "");
  const expectedCreate2Hash = process.env[create2HashEnvName] || "";
  if (!/^0x[0-9a-f]{64}$/i.test(expectedCreate2Hash)) {
    throw new Error("The verified CREATE2 runtime hash is not configured.");
  }
  const create2Code = await provider.getCode(create2Address);
  if (create2Code === "0x" ||
    keccak256(create2Code).toLowerCase() !== expectedCreate2Hash.toLowerCase() ||
    manifest.externalIntegrations?.create2Deployer?.address?.toLowerCase() !== create2Address.toLowerCase()) {
    throw new Error("Live CREATE2 deployer differs from the verified deployment record.");
  }
  const vaultFactory = await ethers.getContractAt("VaultFactory", vaultFactoryAddress, signer);
  if (!(await vaultFactory.hasRole(ADMIN_ROLE, signer.address))) {
    throw new Error("The deployment signer does not hold VaultFactory DEFAULT_ADMIN_ROLE.");
  }

  const currentImplementation = await vaultFactory.multichainVaultImplementation();
  const currentVersion = BigInt(await vaultFactory.multichainVaultImplementationVersion());
  const recordedCandidate = manifest.multichainBridgeProvisioning?.vaultImplementation;
  const recordedCandidateHasCode = recordedCandidate &&
    recordedCandidate.toLowerCase().startsWith(PREFIX.toLowerCase()) &&
    await provider.getCode(recordedCandidate) !== "0x";
  const alreadyApplied = recordedCandidateHasCode &&
    currentImplementation.toLowerCase() === recordedCandidate.toLowerCase();

  const block = await provider.getBlock("latest");
  if (!block?.baseFeePerGas || block.baseFeePerGas <= 0n) {
    throw new Error("Live base fee is unavailable; refusing to price an implementation update.");
  }
  const gasPrice = (block.baseFeePerGas * 120n + 99n) / 100n;
  const [feeQuote, rpcGasPrice] = await Promise.all([
    provider.getFeeData().then((fees) => fees.gasPrice ?? 0n),
    provider.send("eth_gasPrice", []),
  ]);
  if ([feeQuote, BigInt(rpcGasPrice)].some((quote) => quote > gasPrice)) {
    throw new Error("Current RPC fee quote exceeds the live base fee +20% policy.");
  }

  const broadcast = process.env.ARMOREUM_DEPLOY_BROADCAST === "YES";
  if (broadcast && process.env.ARMOREUM_MAINNET_CONFIRMATION !==
    `I confirm Multichain vault bridge authorization on chain ${chainId}`) {
    throw new Error("Explicit chain-specific mainnet confirmation is required.");
  }

  const artifactPath = path.join(__dirname, "..", "artifacts", IMPLEMENTATION_ARTIFACT);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!/^0x[0-9a-f]+$/i.test(artifact.bytecode)) {
    throw new Error("The compiled Multichain vault implementation bytecode is unavailable.");
  }
  const initCode = artifact.bytecode;
  const initCodeHash = keccak256(initCode);
  const saltFile = path.join(
    __dirname,
    "..",
    "deployments",
    "multichain-vault-bridge-authorization.vanity.json",
  );
  const minedSalt = await mineVanitySalt({
    deployer: create2Address,
    initCode,
    stateFile: saltFile,
    maxAttempts: 2_000_000,
  });
  const expectedImplementation = getAddress(
    getCreate2Address(create2Address, minedSalt.salt, initCodeHash),
  );
  if (expectedImplementation.toLowerCase() !== minedSalt.address.toLowerCase() ||
    !expectedImplementation.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    throw new Error("CREATE2 vanity implementation address did not satisfy the required 0x6900 prefix.");
  }

  let implementationAddress = recordedCandidateHasCode &&
    recordedCandidate.toLowerCase() === expectedImplementation.toLowerCase()
    ? recordedCandidate
    : expectedImplementation;
  let deploymentTransaction = null;
  const existingImplementationCode = await provider.getCode(implementationAddress);
  if (existingImplementationCode === "0x" && !alreadyApplied) {
    const deploymentData = encodeCreate2Deployment(minedSalt.salt, initCode);
    const deploymentRequest = {
      from: signer.address,
      to: create2Address,
      data: deploymentData,
      gasPrice,
    };
    const deploymentEstimate = await provider.estimateGas(deploymentRequest);
    const deploymentGasLimit = (deploymentEstimate * 120n + 99n) / 100n;
    await provider.call({ ...deploymentRequest, gasLimit: deploymentGasLimit });
    const deploymentBalance = await provider.getBalance(signer.address);
    if (deploymentBalance < deploymentGasLimit * gasPrice) {
      throw new Error("Deployment signer balance is insufficient for the CREATE2 transaction.");
    }
    console.log(JSON.stringify({
      network: hre.network.name,
      chainId,
      signer: signer.address,
      create2Address,
      implementationAddress,
      salt: minedSalt.salt,
      initCodeHash,
      action: "deploy ArmoreumMultichainVault implementation",
      gasEstimate: deploymentEstimate.toString(),
      gasLimit: deploymentGasLimit.toString(),
      gasPriceWei: gasPrice.toString(),
      broadcast,
    }, null, 2));
    if (!broadcast) return;

    const transaction = await signer.sendTransaction({
      to: create2Address,
      data: deploymentData,
      gasLimit: deploymentGasLimit,
      gasPrice,
    });
    const receipt = await transaction.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("Multichain vault implementation deployment was not confirmed.");
    }
    const codeAfterDeployment = await provider.getCode(implementationAddress);
    if (codeAfterDeployment === "0x") {
      throw new Error("CREATE2 transaction confirmed but implementation bytecode is absent.");
    }
    deploymentTransaction = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      salt: minedSalt.salt,
      initCodeHash,
      deployer: create2Address,
    };
    manifest.multichainBridgeProvisioning = {
      ...(manifest.multichainBridgeProvisioning ?? {}),
      vaultImplementation: implementationAddress,
      vaultImplementationDeployment: deploymentTransaction,
      status: "implementation-deployed",
    };
    atomicJson(manifestPath, manifest);
  }

  if (alreadyApplied) {
    console.log(JSON.stringify({
      network: hre.network.name,
      chainId,
      vaultFactory: vaultFactoryAddress,
      implementation: currentImplementation,
      version: currentVersion.toString(),
      status: "already-applied",
    }, null, 2));
    return;
  }
  const nextVersion = currentVersion + 1n;
  await vaultFactory.setMultichainVaultImplementation.staticCall(
    implementationAddress,
    nextVersion,
  );
  const configurationData = vaultFactory.interface.encodeFunctionData(
    "setMultichainVaultImplementation",
    [implementationAddress, nextVersion],
  );
  const configurationEstimate = await provider.estimateGas({
    from: signer.address,
    to: vaultFactoryAddress,
    data: configurationData,
  });
  const configurationGasLimit = (configurationEstimate * 120n + 99n) / 100n;
  const balance = await provider.getBalance(signer.address);
  const totalMaximumFee = configurationGasLimit * gasPrice;
  if (balance < totalMaximumFee) {
    throw new Error("Deployment signer balance is insufficient for the VaultFactory configuration transaction.");
  }
  console.log(JSON.stringify({
    network: hre.network.name,
    chainId,
    vaultFactory: vaultFactoryAddress,
    previousImplementation: currentImplementation,
    nextImplementation: implementationAddress,
    previousVersion: currentVersion.toString(),
    nextVersion: nextVersion.toString(),
    configurationGasEstimate: configurationEstimate.toString(),
    configurationGasLimit: configurationGasLimit.toString(),
    gasPriceWei: gasPrice.toString(),
    maximumConfigurationFeeWei: totalMaximumFee.toString(),
    broadcast,
  }, null, 2));
  if (!broadcast) return;

  const transaction = await signer.sendTransaction({
    to: vaultFactoryAddress,
    data: configurationData,
    gasLimit: configurationGasLimit,
    gasPrice,
  });
  const receipt = await transaction.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error("VaultFactory implementation pointer update was not confirmed.");
  }
  const appliedImplementation = await vaultFactory.multichainVaultImplementation();
  const appliedVersion = BigInt(await vaultFactory.multichainVaultImplementationVersion());
  if (appliedImplementation.toLowerCase() !== implementationAddress.toLowerCase() ||
    appliedVersion !== nextVersion) {
    throw new Error("On-chain VaultFactory implementation pointer did not match the requested version.");
  }

  manifest.multichainCore = {
    ...manifest.multichainCore,
    multichainVaultImplementation: implementationAddress,
  };
  manifest.multichainStaging = {
    ...manifest.multichainStaging,
    status: "bridge-authorized vault implementation active for new launches",
    implementations: {
      ...manifest.multichainStaging?.implementations,
      multichainVault: implementationAddress,
    },
  };
  manifest.multichainBridgeProvisioning = {
    ...(manifest.multichainBridgeProvisioning ?? {}),
    vaultImplementation: implementationAddress,
    vaultImplementationDeployment: deploymentTransaction ??
      manifest.multichainBridgeProvisioning?.vaultImplementationDeployment,
    vaultFactoryConfiguration: {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      previousImplementation: currentImplementation,
      version: nextVersion.toString(),
    },
    status: "new-launch-vaults-can-fund-paired-bridge-apps",
  };
  atomicJson(manifestPath, manifest);
  console.log(JSON.stringify({
    network: hre.network.name,
    chainId,
    implementation: appliedImplementation,
    version: appliedVersion.toString(),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: "verified-on-chain",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
