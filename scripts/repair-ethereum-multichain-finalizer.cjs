const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts } = require("hardhat");
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

const ROOT = path.join(__dirname, "..");
const RECORD = path.join(ROOT, "deployments/1.multichain-finalizer-repair.json");
const CREATE2 = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const FACTORY = "0x69003a9C316E080855f04112D5E188A3329BA184";
const OLD_IMPLEMENTATION = "0x6900ea82AA8BAF6799bacc5b91FE59067c076dFD";
const OLD_MODULE = "0x6900E75917d8C2d10c4330dBD31cFA3Cf37ab447";
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function save(report) {
  fs.writeFileSync(`${RECORD}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  fs.renameSync(`${RECORD}.tmp`, RECORD);
}

async function runtime(name, address) {
  const a = await artifacts.readArtifact(name);
  const b = await artifacts.getBuildInfo(`${a.sourceName}:${a.contractName}`);
  const output = b.output.contracts[a.sourceName][a.contractName];
  let code = a.deployedBytecode.slice(2);
  for (const references of Object.values(output.evm.deployedBytecode.immutableReferences ?? {})) {
    for (const reference of references) {
      if (reference.length !== 32) throw new Error("Unexpected immutable width.");
      const start = reference.start * 2;
      code = code.slice(0, start) + address.slice(2).toLowerCase().padStart(64, "0") +
        code.slice(start + 64);
    }
  }
  return `0x${code}`;
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) throw new Error("Ethereum mainnet required.");
  const broadcast = process.env.ARMOREUM_REPAIR_MULTICHAIN_FINALIZER === "YES";
  const [signer] = await ethers.getSigners();
  const owner = await signer.getAddress();
  const a = await artifacts.readArtifact("ArmoreumFactory");
  const m = await artifacts.readArtifact("ArmoreumMultichainLaunchModule");
  const factory = new ethers.Contract(FACTORY, a.abi, signer);
  if (
    ethers.getAddress(await factory.canonicalOwner()) !== owner ||
    !(await factory.hasRole(ethers.ZeroHash, owner))
  ) throw new Error("The signer is not the authorized Ethereum factory administrator.");
  if ((a.deployedBytecode.length - 2) / 2 > 24576) throw new Error("Factory exceeds EIP-170.");

  // Verify that the factory diff changes only the module setter, not storage,
  // enrollment, tax distribution, launch prediction, or user authorization.
  const url = new URL("https://api.etherscan.io/v2/api");
  for (const [key, value] of Object.entries({
    chainid: "1", module: "contract", action: "getsourcecode",
    address: OLD_IMPLEMENTATION, apikey: process.env.ETHERSCAN_APIKEY,
  })) url.searchParams.set(key, value);
  const response = await (await fetch(url)).json();
  const raw = response.result?.[0]?.SourceCode;
  if (!raw) throw new Error("Verified baseline factory source is unavailable.");
  const input = JSON.parse(raw.startsWith("{{") ? raw.slice(1, -1) : raw);
  const oldSource = Object.entries(input.sources)
    .find(([file]) => file.endsWith("/ArmoreumFactory.sol"))?.[1]?.content;
  function outsideSetter(source) {
    const start = source.indexOf("    function setMultichainLaunchModule(");
    const end = source.indexOf("    /// @notice Predicts the staged Multichain vault", start);
    if (start < 0 || end < 0) throw new Error("Cannot identify factory setter boundaries.");
    return source.slice(0, start) + source.slice(end);
  }
  if (!oldSource || outsideSetter(oldSource) !== outsideSetter(
    fs.readFileSync(path.join(ROOT, "contracts/ArmoreumFactory.sol"), "utf8"),
  )) throw new Error("Unexpected changes outside the migration setter.");

  const moduleSalt = await mineVanitySalt({
    deployer: CREATE2, initCodeHash: ethers.keccak256(m.bytecode),
    stateFile: path.join(ROOT, "deployments/1.vanity/multichain-finalizer-module.json"),
  });
  const factorySalt = await mineVanitySalt({
    deployer: CREATE2, initCodeHash: ethers.keccak256(a.bytecode),
    stateFile: path.join(ROOT, "deployments/1.vanity/multichain-finalizer-factory.json"),
  });
  const moduleAddress = moduleSalt.address;
  const implementation = factorySalt.address;
  const activeImplementation = ethers.getAddress(ethers.dataSlice(
    await ethers.provider.getStorage(FACTORY, SLOT), 12,
  ));
  const activeModule = ethers.getAddress(await factory.multichainLaunchModule());
  if (
    ![OLD_IMPLEMENTATION, implementation].includes(activeImplementation) ||
    ![OLD_MODULE, moduleAddress].includes(activeModule)
  ) throw new Error("Live factory/module state changed; reconcile before sending.");
  const moduleCode = await runtime("ArmoreumMultichainLaunchModule", moduleAddress);
  const factoryCode = await runtime("ArmoreumFactory", implementation);
  const overrides = {
    [moduleAddress]: { code: moduleCode },
    [implementation]: { code: factoryCode },
  };
  const moduleConfig = factory.interface.encodeFunctionData("setMultichainLaunchModule", [moduleAddress]);
  const upgradeData = factory.interface.encodeFunctionData("upgradeToAndCall", [implementation, moduleConfig]);
  if (activeModule !== moduleAddress) {
    await ethers.provider.send("eth_call", [
      { from: owner, to: FACTORY, data: upgradeData }, "latest", overrides,
    ]);
  }
  console.log(JSON.stringify({
    mode: broadcast ? "broadcast" : "dry-run", implementation, moduleAddress,
    factoryRuntimeBytes: (factoryCode.length - 2) / 2, upgradeSimulation: "passed",
  }));
  if (!broadcast) return;

  let report = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, "utf8")) : {
    chainId: 1, factory: FACTORY, previousImplementation: OLD_IMPLEMENTATION,
    previousModule: OLD_MODULE, implementation, moduleAddress,
    transactions: {}, status: "prepared",
  };
  if (report.implementation !== implementation || report.moduleAddress !== moduleAddress) {
    throw new Error("A previous repair uses different bytecode.");
  }
  save(report);
  async function send(label, transaction) {
    const latest = await ethers.provider.getBlock("latest");
    if (!latest.baseFeePerGas) throw new Error("Ethereum base fee unavailable.");
    const cap = (latest.baseFeePerGas * 120n + 99n) / 100n;
    const gas = await signer.estimateGas(transaction);
    const tx = await signer.sendTransaction({
      ...transaction, gasLimit: (gas * 120n + 99n) / 100n,
      maxFeePerGas: cap, maxPriorityFeePerGas: cap - latest.baseFeePerGas,
    });
    report.transactions[label] = tx.hash;
    report.status = `${label}-submitted`;
    save(report);
    const receipt = await tx.wait(2);
    if (!receipt || receipt.status !== 1) throw new Error(`${label} failed; progress retained.`);
    console.log(JSON.stringify({ step: label, transactionHash: tx.hash, blockNumber: receipt.blockNumber }));
  }
  for (const [label, address, salt, artifact, expectedCode] of [
    ["moduleDeployment", moduleAddress, moduleSalt.salt, m, moduleCode],
    ["factoryDeployment", implementation, factorySalt.salt, a, factoryCode],
  ]) {
    if (await ethers.provider.getCode(address) === "0x") {
      await send(label, { to: CREATE2, data: encodeCreate2Deployment(salt, artifact.bytecode) });
    }
    if (ethers.keccak256(await ethers.provider.getCode(address)) !== ethers.keccak256(expectedCode)) {
      throw new Error(`${label} runtime does not match compiled code.`);
    }
  }
  const nextFactory = new ethers.Contract(implementation, a.abi, ethers.provider);
  if (await nextFactory.proxiableUUID() !== SLOT) throw new Error("Invalid UUPS implementation.");
  if (ethers.getAddress(await factory.multichainLaunchModule()) !== moduleAddress) {
    await factory.upgradeToAndCall.staticCall(implementation, moduleConfig);
    await send("upgradeAndConfigureModule", { to: FACTORY, data: upgradeData });
  }
  const finalImplementation = ethers.getAddress(ethers.dataSlice(
    await ethers.provider.getStorage(FACTORY, SLOT), 12,
  ));
  const finalModule = ethers.getAddress(await factory.multichainLaunchModule());
  const module = new ethers.Contract(moduleAddress, m.abi, ethers.provider);
  if (
    finalImplementation !== implementation || finalModule !== moduleAddress ||
    await module.MULTICHAIN_MODE_POLICY_VERSION() !== 1n
  ) throw new Error("Live factory/module verification failed.");
  const lockedAgain = await factory.setMultichainLaunchModule.staticCall(OLD_MODULE)
    .then(() => false, () => true);
  if (!lockedAgain) throw new Error("Module setter did not lock after migration.");
  report.status = "active";
  report.moduleRuntimeCodeHash = ethers.keccak256(await ethers.provider.getCode(moduleAddress));
  report.factoryRuntimeCodeHash = ethers.keccak256(await ethers.provider.getCode(implementation));
  save(report);
  const manifestPath = path.join(ROOT, "deployments/1.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.multichainFinalizerRepair = report;
  if (manifest.multichainCore) manifest.multichainCore.launchModule = moduleAddress;
  if (manifest.multichainStaging?.implementations) {
    manifest.multichainStaging.implementations.factory = implementation;
    manifest.multichainStaging.implementations.launchModule = moduleAddress;
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ status: "active", implementation, moduleAddress, moduleSetterLocked: true }));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("Ethereum finalizer repair stopped:", error.shortMessage ?? error.message);
  process.exit(1);
});
