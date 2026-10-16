const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt, PREFIX } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const CHAIN_ID = 1n;
const CREATE2_ADDRESS = ethers.getAddress("0x4e59b44847b379578588920cA78FbF26c0B4956C");
const HASH_ROUTER = ethers.getAddress("0x0cAA8Af1Cb8EB9057b5554C79c94d8699D85C90C");
const CONTROL_SINK = ethers.getAddress("0x000000000000000000000000000000000000dEaD");
const CONFIRMATION = "I confirm deployment to Ethereum mainnet chain 1";
const EXECUTE_ENV = "ARMOREUM_EXECUTE_ETHEREUM_TAX_ROUTER_V4";
const packageRoot = path.join(__dirname, "..");
const manifestPath = path.join(packageRoot, "deployments", "1.json");
const partialPath = path.join(packageRoot, "deployments", "1.ethereum-tax-router-lockdown-v4.partial.json");
const saltPath = path.join(packageRoot, "deployments", "1.vanity", "ethereum-tax-router-lockdown-v4.json");

const FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function vaultImplementation() view returns(address)",
  "function taxRouterImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function approveImplementations(address,address,uint256)",
];
const ROUTER_ABI = [
  "function BASE_TAX_BPS() view returns(uint16)",
  "function MAX_ADDITIONAL_TAX_BPS() view returns(uint16)",
  "function PERMANENT_CONTROL_SINK() view returns(address)",
  "function DEFAULT_ADMIN_ROLE() view returns(bytes32)",
  "function UPGRADER_ROLE() view returns(bytes32)",
  "function PAUSER_ROLE() view returns(bytes32)",
  "function TREASURY_ROLE() view returns(bytes32)",
  "function EMERGENCY_WITHDRAWER_ROLE() view returns(bytes32)",
  "function proxiableUUID() view returns(bytes32)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function additionalTaxBps() view returns(uint16)",
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
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

function encodeFees(feeData) {
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (maxFeePerGas == null) throw new Error("Ethereum RPC did not return usable gas-fee data.");
  return feeData.maxPriorityFeePerGas != null && feeData.maxFeePerGas != null
    ? { transactionFees: { maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }, maximumGasPrice: maxFeePerGas }
    : { transactionFees: { gasPrice: maxFeePerGas }, maximumGasPrice: maxFeePerGas };
}

async function main() {
  const execute = process.env[EXECUTE_ENV] === "YES";
  const provider = ethers.provider;
  if ((await provider.getNetwork()).chainId !== CHAIN_ID) {
    throw new Error("Refusing TaxRouter V4 deployment outside Ethereum mainnet.");
  }
  if (fs.existsSync(partialPath)) throw new Error("A previous TaxRouter V4 deployment requires reconciliation.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.chainId !== 1 || manifest.launchEnabled !== true) {
    throw new Error("Ethereum mainnet is not in the expected launch-ready state.");
  }
  const create2Record = manifest.externalIntegrations?.create2Deployer;
  const factoryRecord = manifest.contracts.find((item) => item.name === "ArmoreumFactory-proxy");
  if (!create2Record || !factoryRecord) throw new Error("Ethereum manifest is missing CREATE2 or ArmoreumFactory data.");
  const create2Code = await provider.getCode(CREATE2_ADDRESS);
  if (
    ethers.getAddress(create2Record.address) !== CREATE2_ADDRESS ||
    create2Code === "0x" ||
    ethers.keccak256(create2Code).toLowerCase() !== String(create2Record.runtimeCodeHash).toLowerCase()
  ) throw new Error("Live Ethereum CREATE2 deployer does not match the manifest.");

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No Ethereum deployment signer is configured.");
  const signerAddress = ethers.getAddress(await signer.getAddress());
  const configuredOwner = ethers.getAddress(new ethers.Wallet(required("DEPLOYER_PRIVATE_KEY")).address);
  if (signerAddress !== configuredOwner) throw new Error("Configured signer is not the Ethereum deployment owner.");

  const factory = new ethers.Contract(factoryRecord.address, FACTORY_ABI, signer);
  const [
    canonicalOwner,
    factoryAdmin,
    vaultImplementation,
    currentImplementation,
    currentVersion,
  ] = await Promise.all([
    factory.canonicalOwner(),
    factory.hasRole(ethers.ZeroHash, signerAddress),
    factory.vaultImplementation(),
    factory.taxRouterImplementation(),
    factory.implementationVersion(),
  ]);
  if (ethers.getAddress(canonicalOwner) !== signerAddress || !factoryAdmin) {
    throw new Error("Configured signer is not the ArmoreumFactory canonical admin.");
  }
  if (!vaultImplementation || ethers.getAddress(vaultImplementation) === ethers.ZeroAddress) {
    throw new Error("ArmoreumFactory's Creator Vault implementation is not configured.");
  }
  const currentImplementationContract = new ethers.Contract(currentImplementation, ROUTER_ABI, provider);
  if (BigInt(await currentImplementationContract.BASE_TAX_BPS()) !== 70n) {
    throw new Error("ArmoreumFactory's current future-launch router is not configured for 0.7% base tax.");
  }
  const hashRouter = new ethers.Contract(HASH_ROUTER, ROUTER_ABI, provider);
  if (
    BigInt(await hashRouter.BASE_TAX_BPS()) !== 100n ||
    BigInt(await hashRouter.additionalTaxBps()) !== 100n
  ) throw new Error("Live HASH tax settings changed; refusing to proceed.");

  const artifact = await artifacts.readArtifact("TaxRouter");
  const build = await artifacts.getBuildInfo("contracts/TaxRouter.sol:TaxRouter");
  if (!build) throw new Error("TaxRouter build information is missing; compile first.");
  for (const [sourceName, source] of Object.entries(build.input.sources)) {
    const localSource = path.join(packageRoot, sourceName);
    if (sourceName.startsWith("contracts/") && fs.existsSync(localSource) &&
        fs.readFileSync(localSource, "utf8") !== source.content) {
      throw new Error(`Compiled artifact is stale for ${sourceName}; no transaction was submitted.`);
    }
  }
  if (!/^0x[\da-f]+$/i.test(artifact.bytecode) || !/^0x[\da-f]+$/i.test(artifact.deployedBytecode)) {
    throw new Error("Compiled TaxRouter bytecode is unresolved.");
  }
  if ((artifact.deployedBytecode.length - 2) / 2 > 24_576) {
    throw new Error("TaxRouter exceeds the EVM runtime-size limit.");
  }
  const mined = await mineVanitySalt({
    deployer: CREATE2_ADDRESS,
    initCode: artifact.bytecode,
    stateFile: saltPath,
  });
  const target = ethers.getAddress(mined.address);
  if (!target.toLowerCase().startsWith(PREFIX)) throw new Error("TaxRouter V4 address misses the required prefix.");
  const expectedRuntime = compiledRuntimeAtAddress(build, target);
  const expectedRuntimeHash = ethers.keccak256(expectedRuntime);
  const targetCode = await provider.getCode(target);
  if (targetCode !== "0x" && ethers.keccak256(targetCode).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error("Deterministic TaxRouter V4 address contains different bytecode.");
  }
  const sourceTax = 70n;
  const maxAdditionalTaxBps = 1000n;
  if (BigInt(currentVersion) < 1n) throw new Error("ArmoreumFactory implementation version is invalid.");
  if (targetCode !== "0x") {
    const deployedImplementation = new ethers.Contract(target, ROUTER_ABI, provider);
    if (
      BigInt(await deployedImplementation.BASE_TAX_BPS()) !== sourceTax ||
      BigInt(await deployedImplementation.MAX_ADDITIONAL_TAX_BPS()) !== maxAdditionalTaxBps ||
      ethers.getAddress(await deployedImplementation.PERMANENT_CONTROL_SINK()) !== CONTROL_SINK
    ) throw new Error("Existing TaxRouter V4 code does not match the selected 0.7%/10% policy.");
  }

  const initCodeHash = ethers.keccak256(artifact.bytecode);
  const deploymentData = encodeCreate2Deployment(mined.salt, artifact.bytecode);
  const deploymentRequest = { from: signerAddress, to: CREATE2_ADDRESS, data: deploymentData };
  let deploymentGas = 0n;
  if (targetCode === "0x") {
    deploymentGas = await provider.estimateGas(deploymentRequest);
    await provider.call({ ...deploymentRequest, gasLimit: deploymentGas * 120n / 100n });
  }
  const approvalData = factory.interface.encodeFunctionData("approveImplementations", [
    vaultImplementation,
    target,
    BigInt(currentVersion) + 1n,
  ]);
  const approvalRequest = { from: signerAddress, to: factoryRecord.address, data: approvalData };
  const stateOverride = { [target]: { code: expectedRuntime } };
  await provider.send("eth_call", [approvalRequest, "latest", stateOverride]);
  const approvalGas = BigInt(await provider.send("eth_estimateGas", [
    approvalRequest,
    "latest",
    stateOverride,
  ]));
  const deploymentGasLimit = deploymentGas === 0n ? 0n : (deploymentGas * 120n + 99n) / 100n;
  const approvalGasLimit = (approvalGas * 120n + 99n) / 100n;
  const fees = encodeFees(await provider.getFeeData());
  const maximumCost = deploymentGasLimit * fees.maximumGasPrice + approvalGasLimit * fees.maximumGasPrice;
  const balance = await provider.getBalance(signerAddress);
  if (balance < maximumCost) throw new Error("Deployment signer cannot cover the preflight maximum cost.");

  const report = {
    network: "Ethereum mainnet",
    chainId: 1,
    execute,
    implementation: target,
    factory: ethers.getAddress(factoryRecord.address),
    factoryVersionBefore: String(currentVersion),
    factoryVersionAfter: String(BigInt(currentVersion) + 1n),
    baseTaxBps: String(sourceTax),
    maximumAdditionalTaxBps: String(maxAdditionalTaxBps),
    permanentControlSink: CONTROL_SINK,
    HASHRouter: {
      address: HASH_ROUTER,
      baseTaxBps: String(await hashRouter.BASE_TAX_BPS()),
      additionalTaxBps: String(await hashRouter.additionalTaxBps()),
    },
    deploymentGas: deploymentGas.toString(),
    deploymentGasLimit: deploymentGasLimit.toString(),
    approvalGas: approvalGas.toString(),
    approvalGasLimit: approvalGasLimit.toString(),
    maximumCostEth: ethers.formatEther(maximumCost),
    signerBalanceEth: ethers.formatEther(balance),
    note: "Only ArmoreumFactory's future TaxRouter pointer changes. Existing HASH and VaultFactory/Pons pointers are untouched; fee splits and configured limits are preserved.",
  };
  if (!execute) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (process.env[EXECUTE_ENV] !== "YES" || required("DEPLOY_ETHEREUM_MAINNET_CONFIRMATION") !== CONFIRMATION) {
    throw new Error("Explicit Ethereum mainnet confirmation is required.");
  }

  const partial = { ...report, status: "prepared", transactions: {} };
  writeJsonAtomically(partialPath, partial);
  if (targetCode === "0x") {
    const deployTx = await signer.sendTransaction({
      to: CREATE2_ADDRESS,
      data: deploymentData,
      gasLimit: deploymentGasLimit,
      ...fees.transactionFees,
    });
    partial.status = "implementation-broadcast";
    partial.transactions.implementation = deployTx.hash;
    writeJsonAtomically(partialPath, partial);
    const deployReceipt = await deployTx.wait();
    if (!deployReceipt || deployReceipt.status !== 1) throw new Error("TaxRouter V4 deployment failed; partial record retained.");
  }

  const liveCode = await provider.getCode(target);
  if (liveCode === "0x" || ethers.keccak256(liveCode).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    throw new Error("TaxRouter V4 runtime bytecode did not match the compiled implementation.");
  }
  const verifiedImplementation = new ethers.Contract(target, ROUTER_ABI, provider);
  if (
    BigInt(await verifiedImplementation.BASE_TAX_BPS()) !== 70n ||
    BigInt(await verifiedImplementation.MAX_ADDITIONAL_TAX_BPS()) !== 1000n ||
    ethers.getAddress(await verifiedImplementation.PERMANENT_CONTROL_SINK()) !== CONTROL_SINK
  ) throw new Error("Live TaxRouter V4 does not match the selected future-launch policy.");

  if (ethers.getAddress(await factory.taxRouterImplementation()) === target) {
    process.stdout.write(`${JSON.stringify({
      ...report,
      execute: true,
      implementationRuntimeCodeHash: expectedRuntimeHash,
      status: "TaxRouter V4 is already active; no transaction sent",
    }, null, 2)}\n`);
    return;
  }

  const updateTx = await factory.approveImplementations(
    vaultImplementation,
    target,
    BigInt(currentVersion) + 1n,
    { gasLimit: approvalGasLimit, ...fees.transactionFees },
  );
  partial.status = "factory-pointer-broadcast";
  partial.transactions.factoryPointer = updateTx.hash;
  writeJsonAtomically(partialPath, partial);
  const updateReceipt = await updateTx.wait();
  if (!updateReceipt || updateReceipt.status !== 1) throw new Error("ArmoreumFactory TaxRouter pointer update failed; partial retained.");
  if (
    ethers.getAddress(await factory.taxRouterImplementation()) !== target ||
    BigInt(await factory.implementationVersion()) !== BigInt(currentVersion) + 1n
  ) throw new Error("ArmoreumFactory did not persist the TaxRouter V4 pointer.");
  if (
    BigInt(await hashRouter.BASE_TAX_BPS()) !== 100n ||
    BigInt(await hashRouter.additionalTaxBps()) !== 100n
  ) throw new Error("HASH tax values changed unexpectedly.");

  const nextManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentRecord = nextManifest.contracts.find((item) => item.name === "TaxRouter-implementation");
  if (currentRecord) currentRecord.name = "TaxRouter-implementation-v3";
  nextManifest.contracts.push({
    name: "TaxRouter-implementation",
    address: target,
    salt: mined.salt,
    deployer: CREATE2_ADDRESS,
    initCodeHash,
    runtimeCodeHash: expectedRuntimeHash,
    transactionHash: partial.transactions.implementation || null,
    pointerTransactionHash: updateReceipt.hash,
    blockNumber: updateReceipt.blockNumber,
    baseTaxBps: 70,
    maxAdditionalTaxBps: 1000,
    implementationVersion: Number(BigInt(currentVersion) + 1n),
    sourceVerification: "pending",
  });
  nextManifest.status = "Ethereum future TaxRouter V4 active; HASH and VaultFactory/Pons pointers preserved; source verification pending";
  nextManifest.ethereumTaxRouterLockdown = {
    address: target,
    baseTaxBps: 70,
    maxAdditionalTaxBps: 1000,
    permanentControlSink: CONTROL_SINK,
    armoreumFactoryVersion: Number(BigInt(currentVersion) + 1n),
    pointerTransactionHash: updateReceipt.hash,
  };
  writeJsonAtomically(manifestPath, nextManifest);
  fs.rmSync(partialPath, { force: true });
  process.stdout.write(`${JSON.stringify({
    ...report,
    execute: true,
    implementationRuntimeCodeHash: expectedRuntimeHash,
    pointerTransactionHash: updateReceipt.hash,
    status: "TaxRouter V4 deployed and active for future ArmoreumFactory launches",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum TaxRouter V4 setup failed"}\n`);
  process.exitCode = 1;
});
