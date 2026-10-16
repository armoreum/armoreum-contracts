const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");

const LOCAL_NETWORKS = new Map([
  [31337n, { name: "Local Ethereum", rpcUrl: "http://127.0.0.1:8545" }],
  [46630n, { name: "Local Robinhood-compatible EVM", rpcUrl: "http://127.0.0.1:8546" }],
]);

async function deploy(name, signer, ...args) {
  const factory = await ethers.getContractFactory(name, signer);
  const contract = await factory.deploy(...args);
  const transaction = contract.deploymentTransaction();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  return {
    contract,
    record: {
      name,
      address,
      transactionHash: transaction?.hash ?? null,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(address)),
    },
  };
}

async function vanitySalt(deployerAddress, initCodeHash) {
  for (let counter = 1n; counter < 2_000_000n; counter += 1n) {
    const salt = ethers.toBeHex(counter, 32);
    const predicted = ethers.getCreate2Address(deployerAddress, salt, initCodeHash);
    if (predicted.toLowerCase().startsWith("0x6900")) return { salt, predicted };
  }
  throw new Error("Local 0x6900 CREATE2 search exceeded its limit.");
}

async function deployVanity(name, signer, create2Deployer) {
  const factory = await ethers.getContractFactory(name, signer);
  const initCode = factory.bytecode;
  const initCodeHash = ethers.keccak256(initCode);
  const helperAddress = await create2Deployer.getAddress();
  const { salt, predicted } = await vanitySalt(helperAddress, initCodeHash);
  const transaction = await create2Deployer.deploy(salt, initCode);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1 || (await ethers.provider.getCode(predicted)) === "0x") {
    throw new Error(`Local vanity deployment failed for ${name}.`);
  }
  return {
    contract: factory.attach(predicted),
    record: {
      name,
      address: predicted,
      transactionHash: receipt.hash,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(predicted)),
    },
  };
}

async function main() {
  const networkInfo = await ethers.provider.getNetwork();
  const local = LOCAL_NETWORKS.get(networkInfo.chainId);
  if (!local) {
    throw new Error(
      `Refusing local deployment on chain ${networkInfo.chainId}; use chain ID 31337 or 46630.`,
    );
  }

  const localProvider = new ethers.JsonRpcProvider(local.rpcUrl);
  const deployer = await localProvider.getSigner(0);
  const deployerAddress = await deployer.getAddress();

  const deployed = [];
  const tokenDeployer = await deploy("ArmoreumTokenDeployer", deployer);
  deployed.push(tokenDeployer.record);

  const taxSource = await deploy("LocalTaxSource", deployer);
  deployed.push(taxSource.record);

  const bridgeAdapter = await deploy("LocalBridgeAdapter", deployer, deployerAddress);
  deployed.push(bridgeAdapter.record);

  const vanityDeployer = await deploy("TestCreate2Deployer", deployer);
  deployed.push(vanityDeployer.record);

  const verifier = await deployVanity(
    "ArmoreumPasskeyVerifier",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(verifier.record);

  const vaultImplementation = await deploy("CreatorRewardVault", deployer);
  deployed.push(vaultImplementation.record);

  const routerImplementation = await deploy("TaxRouter", deployer);
  deployed.push(routerImplementation.record);

  const factoryImplementation = await deploy("ArmoreumFactory", deployer);
  deployed.push(factoryImplementation.record);

  const factoryArtifact = await ethers.getContractFactory("ArmoreumFactory", deployer);
  const initialization = factoryArtifact.interface.encodeFunctionData("initialize", [
    deployerAddress,
    verifier.record.address,
    ethers.keccak256(ethers.toUtf8Bytes("localhost")),
    vaultImplementation.record.address,
    routerImplementation.record.address,
    taxSource.record.address,
    1,
    deployerAddress,
    ethers.ZeroAddress,
  ]);
  const proxyInitCode = await vanityDeployer.contract.proxyInitCode(
    factoryImplementation.record.address,
    initialization,
  );
  const proxyInitCodeHash = ethers.keccak256(proxyInitCode);
  const vanityDeployerAddress = await vanityDeployer.contract.getAddress();
  const { salt: factoryProxySalt, predicted: factoryProxyAddress } =
    await vanitySalt(vanityDeployerAddress, proxyInitCodeHash);
  const proxyTransaction = await vanityDeployer.contract.deploy(
    factoryProxySalt,
    proxyInitCode,
  );
  const proxyReceipt = await proxyTransaction.wait();
  if (!proxyReceipt || proxyReceipt.status !== 1 ||
      (await ethers.provider.getCode(factoryProxyAddress)) === "0x") {
    throw new Error("Local ArmoreumFactory proxy deployment failed.");
  }
  deployed.push({
    name: "ArmoreumFactoryProxy",
    address: factoryProxyAddress,
    transactionHash: proxyReceipt.hash,
    runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(factoryProxyAddress)),
  });

  const vaultFactoryImplementation = await deployVanity(
    "VaultFactory",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(vaultFactoryImplementation.record);
  const vaultFactoryArtifact = await ethers.getContractFactory("VaultFactory", deployer);
  const vaultFactoryInitialization = vaultFactoryArtifact.interface.encodeFunctionData(
    "initialize",
    [deployerAddress, deployerAddress, factoryProxyAddress],
  );
  const vaultFactoryProxyInitCode = await vanityDeployer.contract.proxyInitCode(
    vaultFactoryImplementation.record.address,
    vaultFactoryInitialization,
  );
  const vaultFactoryProxyInitCodeHash = ethers.keccak256(vaultFactoryProxyInitCode);
  const { salt: vaultFactoryProxySalt, predicted: vaultFactoryProxyAddress } =
    await vanitySalt(vanityDeployerAddress, vaultFactoryProxyInitCodeHash);
  const vaultFactoryProxyTransaction = await vanityDeployer.contract.deploy(
    vaultFactoryProxySalt,
    vaultFactoryProxyInitCode,
  );
  const vaultFactoryProxyReceipt = await vaultFactoryProxyTransaction.wait();
  if (
    !vaultFactoryProxyReceipt ||
    vaultFactoryProxyReceipt.status !== 1 ||
    (await ethers.provider.getCode(vaultFactoryProxyAddress)) === "0x"
  ) {
    throw new Error("Local VaultFactory proxy deployment failed.");
  }
  deployed.push({
    name: "VaultFactoryProxy",
    address: vaultFactoryProxyAddress,
    transactionHash: vaultFactoryProxyReceipt.hash,
    runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(vaultFactoryProxyAddress)),
  });
  const vaultFactory = vaultFactoryArtifact.attach(vaultFactoryProxyAddress);
  const setVaultImplementations = await vaultFactory.setImplementations(
    vaultImplementation.record.address,
    routerImplementation.record.address,
    1,
  );
  const setVaultImplementationsReceipt = await setVaultImplementations.wait();
  if (!setVaultImplementationsReceipt || setVaultImplementationsReceipt.status !== 1) {
    throw new Error("Local VaultFactory implementation registration failed.");
  }

  const jailTokenImplementation = await deployVanity(
    "JailToken",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(jailTokenImplementation.record);
  const jailEthImplementation = await deployVanity(
    "JailETHReceipt",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(jailEthImplementation.record);
  const jailTokenFactoryImplementation = await deployVanity(
    "JailTokenFactory",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(jailTokenFactoryImplementation.record);
  const jailSwapVaultImplementation = await deployVanity(
    "JailSwapVault",
    deployer,
    vanityDeployer.contract,
  );
  deployed.push(jailSwapVaultImplementation.record);

  const jailTokenFactoryArtifact = await ethers.getContractFactory(
    "JailTokenFactory",
    deployer,
  );
  const jailTokenFactoryInitialization =
    jailTokenFactoryArtifact.interface.encodeFunctionData(
      "initializeWithJailEth",
      [
        deployerAddress,
        deployerAddress,
        jailTokenImplementation.record.address,
        jailEthImplementation.record.address,
      ],
    );
  const jailTokenFactoryProxyInitCode = await vanityDeployer.contract.proxyInitCode(
    jailTokenFactoryImplementation.record.address,
    jailTokenFactoryInitialization,
  );
  const jailTokenFactoryProxyInitCodeHash = ethers.keccak256(
    jailTokenFactoryProxyInitCode,
  );
  const { salt: jailTokenFactoryProxySalt, predicted: jailTokenFactoryProxyAddress } =
    await vanitySalt(vanityDeployerAddress, jailTokenFactoryProxyInitCodeHash);
  const jailTokenFactoryProxyTransaction = await vanityDeployer.contract.deploy(
    jailTokenFactoryProxySalt,
    jailTokenFactoryProxyInitCode,
  );
  const jailTokenFactoryProxyReceipt = await jailTokenFactoryProxyTransaction.wait();
  if (
    !jailTokenFactoryProxyReceipt ||
    jailTokenFactoryProxyReceipt.status !== 1 ||
    (await ethers.provider.getCode(jailTokenFactoryProxyAddress)) === "0x"
  ) {
    throw new Error("Local JailTokenFactory proxy deployment failed.");
  }
  deployed.push({
    name: "JailTokenFactoryProxy",
    address: jailTokenFactoryProxyAddress,
    transactionHash: jailTokenFactoryProxyReceipt.hash,
    runtimeCodeHash: ethers.keccak256(
      await ethers.provider.getCode(jailTokenFactoryProxyAddress),
    ),
  });
  const jailTokenFactory = jailTokenFactoryArtifact.attach(
    jailTokenFactoryProxyAddress,
  );
  const grantVaultFactory = await jailTokenFactory.setLaunchFactory(
    vaultFactoryProxyAddress,
    true,
  );
  const grantVaultFactoryReceipt = await grantVaultFactory.wait();
  if (!grantVaultFactoryReceipt || grantVaultFactoryReceipt.status !== 1) {
    throw new Error("Local JailTokenFactory did not authorize VaultFactory.");
  }
  const setJailSwapImplementations = await vaultFactory.setJailSwapImplementations(
    jailSwapVaultImplementation.record.address,
    jailTokenFactoryProxyAddress,
    1,
  );
  const setJailSwapImplementationsReceipt =
    await setJailSwapImplementations.wait();
  if (
    !setJailSwapImplementationsReceipt ||
    setJailSwapImplementationsReceipt.status !== 1
  ) {
    throw new Error("Local VaultFactory JailSwap implementation registration failed.");
  }

  const configureVaultFactory = await factoryArtifact.attach(factoryProxyAddress).setVaultFactory(
    vaultFactoryProxyAddress,
  );
  const configureVaultFactoryReceipt = await configureVaultFactory.wait();
  if (!configureVaultFactoryReceipt || configureVaultFactoryReceipt.status !== 1) {
    throw new Error("Local ArmoreumFactory to VaultFactory registration failed.");
  }

  const integrations = {
    ponsV2: {
      status: "not-integrated",
      note: "The official Pons V2 deployment is not used by the local stack.",
    },
    uniswapV4: { status: "not-deployed" },
    bridge: {
      status: "local-lock-release-adapter-deployed",
      note: "Local operator relay releases only prefunded inventory; this is not a trustless or live bridge.",
    },
  };

  if (networkInfo.chainId === 46630n) {
    const ponsAdapter = await deploy(
      "LocalPonsV2Adapter",
      deployer,
      deployerAddress,
      tokenDeployer.record.address,
    );
    deployed.push(ponsAdapter.record);
    integrations.ponsV2 = {
      status: "local-compatible-token-only",
      adapter: ponsAdapter.record.address,
      note: "Not the official Pons V2 deployment; pool, fees, and trading are not included.",
    };
  }

  if (
    networkInfo.chainId === 31337n &&
    process.env.LOCAL_DEPLOY_UNISWAP_V4_POOL_MANAGER === "true"
  ) {
    const managerDeployer = await deploy("LocalPoolManagerDeployer", deployer);
    deployed.push(managerDeployer.record);
    const managerTransaction = await managerDeployer.contract.deploy(deployerAddress);
    const managerReceipt = await managerTransaction.wait();
    if (!managerReceipt || managerReceipt.status !== 1) {
      throw new Error("The upstream Uniswap V4 PoolManager deployment failed.");
    }
    const poolManagerAddress = await managerDeployer.contract.poolManager();
    deployed.push({
      name: "UniswapV4PoolManager",
      address: poolManagerAddress,
      transactionHash: managerReceipt.hash,
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(poolManagerAddress)),
    });
    integrations.uniswapV4 = {
      status: "core-pool-manager-deployed; hook, position manager, and liquidity setup pending",
      poolManager: poolManagerAddress,
    };
  } else if (networkInfo.chainId === 31337n) {
    integrations.uniswapV4 = {
      status: "not-deployed",
      note: "PoolManager integration tests run on an isolated Hardhat chain; no hook or liquidity is enabled in this persistent launch EVM.",
    };
  }

  const metadata = await ethers.provider.send("hardhat_metadata", []);
  if (Number(metadata.chainId) !== Number(networkInfo.chainId) ||
      !/^0x[0-9a-f]{64}$/i.test(metadata.instanceId || "")) {
    throw new Error("Local deployment did not report a valid Hardhat instance identity.");
  }
  const manifest = {
    environment: "local-only",
    network: local.name,
    hardhatNetworkName: network.name,
    chainId: Number(networkInfo.chainId),
    hardhatInstanceId: metadata.instanceId,
    rpcUrl: local.rpcUrl,
    createdAt: new Date().toISOString(),
    deployer: deployerAddress,
    addressPrefix: {
      requiredForCoreContractsOnly: "0x6900",
      enforcedForThisLocalDeployment: false,
    },
    contracts: deployed,
    integrations,
    launchEnabled: false,
  };
  const output = path.join(__dirname, "..", "deployments", "local", `${networkInfo.chainId}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Local deployment failed"}\n`);
  process.exitCode = 1;
});
