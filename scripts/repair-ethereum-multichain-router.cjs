const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers, artifacts } = hre;
const { mineVanitySalt } = require("./vanity.cjs");
const { encodeCreate2Deployment } = require("./create2-deployment.cjs");

// Changes future Ethereum enrollments only. Never upgrades an existing token's router.
const CREATE2 = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const FACTORY = "0x69003a9C316E080855f04112D5E188A3329BA184";
const ROOT = path.join(__dirname, "..");
const RECORD = path.join(ROOT, "deployments/1.multichain-router-repair.json");
const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PREVIOUS_FACTORY_IMPLEMENTATION = "0x6900932D0892882292E1Fe9E8b6BCC137640ED82";
const PREVIOUS_FACTORY_HASH = "0xe28d3f0e4b3cf5d8d2694cccdc1133a74f96916c0fa155fb06333422f266f5aa";
const FACTORY_ABI = [
  "function canonicalOwner() view returns(address)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function vaultFactory() view returns(address)",
  "function vaultImplementation() view returns(address)",
  "function taxRouterImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function approveImplementations(address,address,uint256)",
  "function upgradeToAndCall(address,bytes)",
];
const REGISTRY_ABI = [
  "function creatorVaultImplementation() view returns(address)",
  "function feeVaultImplementation() view returns(address)",
  "function implementationVersion() view returns(uint256)",
  "function launchFactory() view returns(address)",
  "function hasRole(bytes32,address) view returns(bool)",
  "function setImplementations(address,address,uint256)",
];

function save(value) {
  fs.writeFileSync(`${RECORD}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${RECORD}.tmp`, RECORD);
}

async function main() {
  const broadcast = process.env.ARMOREUM_REPAIR_MULTICHAIN_ROUTER === "YES";
  if ((await ethers.provider.getNetwork()).chainId !== 1n) throw new Error("Ethereum mainnet required.");
  const [signer] = await ethers.getSigners();
  const owner = await signer.getAddress();
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, signer);
  const registry = new ethers.Contract(await factory.vaultFactory(), REGISTRY_ABI, signer);
  if (
    ethers.getAddress(await factory.canonicalOwner()) !== owner ||
    !(await factory.hasRole(ethers.ZeroHash, owner)) ||
    !(await registry.hasRole(ethers.ZeroHash, owner)) ||
    ethers.getAddress(await registry.launchFactory()) !== FACTORY
  ) throw new Error("Factory/registry ownership or network linkage does not match.");

  const artifact = await artifacts.readArtifact("TaxRouter");
  const factoryArtifact = await artifacts.readArtifact("ArmoreumFactory");
  if ((artifact.deployedBytecode.length - 2) / 2 > 24576) throw new Error("TaxRouter exceeds EIP-170.");
  if ((factoryArtifact.deployedBytecode.length - 2) / 2 > 24576) throw new Error("Factory exceeds EIP-170.");
  if (ethers.keccak256(await ethers.provider.getCode(PREVIOUS_FACTORY_IMPLEMENTATION)) !== PREVIOUS_FACTORY_HASH) {
    throw new Error("Unexpected baseline factory runtime.");
  }
  // Compare against explorer-verified live source. The only permitted factory
  // changes are inside the enrollment routine; storage and all other code stay exact.
  const url = new URL("https://api.etherscan.io/v2/api");
  for (const [key, value] of Object.entries({
    chainid: "1", module: "contract", action: "getsourcecode",
    address: PREVIOUS_FACTORY_IMPLEMENTATION, apikey: process.env.ETHERSCAN_APIKEY,
  })) url.searchParams.set(key, value);
  const response = await (await fetch(url)).json();
  const sourceCode = response.result?.[0]?.SourceCode;
  if (!sourceCode) throw new Error("Verified factory source unavailable.");
  const input = JSON.parse(sourceCode.startsWith("{{") ? sourceCode.slice(1, -1) : sourceCode);
  const oldSource = Object.entries(input.sources).find(([p]) => p.endsWith("/ArmoreumFactory.sol"))?.[1]?.content;
  const newSource = fs.readFileSync(path.join(ROOT, "contracts/ArmoreumFactory.sol"), "utf8");
  function outsideEnrollment(source) {
    const start = source.indexOf("    function _createRewardSystem(");
    const end = source.indexOf("    function completePonsLaunch(", start);
    if (start < 0 || end < 0) throw new Error("Missing enrollment source boundaries.");
    return source.slice(0, start) + source.slice(end);
  }
  if (!oldSource || outsideEnrollment(oldSource) !== outsideEnrollment(newSource)) {
    throw new Error("Factory changes outside enrollment require a separate storage review.");
  }
  const initHash = ethers.keccak256(artifact.bytecode);
  const mined = await mineVanitySalt({
    deployer: CREATE2,
    initCodeHash: initHash,
    stateFile: path.join(ROOT, "deployments/1.vanity/multichain-router-repair.json"),
  });
  const target = ethers.getCreate2Address(CREATE2, mined.salt, initHash);
  const factoryMined = await mineVanitySalt({
    deployer: CREATE2, initCodeHash: ethers.keccak256(factoryArtifact.bytecode),
    stateFile: path.join(ROOT, "deployments/1.vanity/multichain-factory-repair.json"),
  });
  const factoryTarget = factoryMined.address;
  const activeFactory = ethers.getAddress(ethers.dataSlice(await ethers.provider.getStorage(FACTORY, SLOT), 12));
  if (![PREVIOUS_FACTORY_IMPLEMENTATION, factoryTarget].includes(activeFactory)) {
    throw new Error("Factory implementation changed unexpectedly.");
  }
  const previous = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, "utf8")) : null;
  if (previous && (previous.target !== target || previous.factoryTarget !== factoryTarget)) throw new Error("Previous repair has different bytecode; reconcile before continuing.");
  const report = previous ?? {
    chainId: 1, target, factoryTarget, initCodeHash: initHash, salt: mined.salt,
    factory: FACTORY, registry: await registry.getAddress(),
    previousFactoryRouter: await factory.taxRouterImplementation(),
    previousRegistryRouter: await registry.feeVaultImplementation(),
    transactions: {}, status: "prepared",
  };
  const block = await ethers.provider.getBlock("latest");
  const base = block.baseFeePerGas;
  if (!base) throw new Error("Missing live Ethereum base fee.");
  const maxFeePerGas = (base * 120n + 99n) / 100n;
  const fees = { maxFeePerGas, maxPriorityFeePerGas: maxFeePerGas - base };
  const balance = await ethers.provider.getBalance(owner);
  const code = await ethers.provider.getCode(target);
  const deploy = {
    to: CREATE2,
    data: encodeCreate2Deployment(mined.salt, artifact.bytecode),
    ...fees,
  };
  const deployGas = code === "0x" ? await signer.estimateGas(deploy) : 0n;
  const factoryDeploy = {
    to: CREATE2, data: encodeCreate2Deployment(factoryMined.salt, factoryArtifact.bytecode),
  };
  const factoryCode = await ethers.provider.getCode(factoryTarget);
  const factoryGas = factoryCode === "0x" ? await signer.estimateGas(factoryDeploy) : 0n;
  if (balance < (deployGas + factoryGas + 1000000n) * maxFeePerGas) throw new Error("Owner lacks approved gas funding.");
  console.log(JSON.stringify({
    chainId: 1, broadcast, target, previousFactoryRouter: report.previousFactoryRouter,
    previousRegistryRouter: report.previousRegistryRouter,
    factoryTarget, factoryBytes: (factoryArtifact.deployedBytecode.length - 2) / 2,
    deploymentGas: String(deployGas + factoryGas), maximumGasPriceWei: String(maxFeePerGas),
    existingTokenRoutersUnchanged: true,
  }));
  if (!broadcast) return;
  save(report);
  async function send(label, transaction) {
    const latest = await ethers.provider.getBlock("latest");
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
    console.log(JSON.stringify({step: label, transactionHash: tx.hash, blockNumber: receipt.blockNumber}));
  }
  if (code === "0x") await send("implementation", deploy);
  if (factoryCode === "0x") await send("factoryImplementation", factoryDeploy);
  async function verifyRuntime(name, address) {
    const a = await artifacts.readArtifact(name);
    const build = await artifacts.getBuildInfo(`${a.sourceName}:${a.contractName}`);
    const output = build.output.contracts[a.sourceName][a.contractName];
    let runtime = a.deployedBytecode.slice(2);
    for (const references of Object.values(output.evm.deployedBytecode.immutableReferences ?? {})) {
      for (const reference of references) {
        if (reference.length !== 32) throw new Error("Unexpected immutable width.");
        const offset = reference.start * 2;
        runtime = runtime.slice(0, offset) + address.slice(2).toLowerCase().padStart(64, "0") + runtime.slice(offset + 64);
      }
    }
    if (ethers.keccak256(await ethers.provider.getCode(address)) !== ethers.keccak256(`0x${runtime}`)) {
      throw new Error("Deployed runtime does not match compiled code.");
    }
  }
  await verifyRuntime("TaxRouter", target);
  await verifyRuntime("ArmoreumFactory", factoryTarget);
  const live = new ethers.Contract(target, [
    "function proxiableUUID() view returns(bytes32)",
    "function BASE_TAX_BPS() view returns(uint16)",
    "function MAX_ADDITIONAL_TAX_BPS() view returns(uint16)",
  ], ethers.provider);
  if (
    (await live.proxiableUUID()) !== SLOT ||
    BigInt(await live.BASE_TAX_BPS()) !== 70n ||
    BigInt(await live.MAX_ADDITIONAL_TAX_BPS()) !== 1000n
  ) throw new Error("New implementation policy check failed.");
  // This registry actually deploys the proxies, so its future pointer must agree
  // with ArmoreumFactory. Existing proxies remain bound to their own implementation.
  if (ethers.getAddress(await registry.feeVaultImplementation()) !== target) {
    const tx = await registry.setImplementations.populateTransaction(
      await registry.creatorVaultImplementation(), target,
      BigInt(await registry.implementationVersion()) + 1n,
    );
    await send("registryPointer", tx);
  }
  if (ethers.getAddress(await factory.taxRouterImplementation()) !== target) {
    const tx = await factory.approveImplementations.populateTransaction(
      await factory.vaultImplementation(), target, BigInt(await factory.implementationVersion()) + 1n,
    );
    await send("factoryPointer", tx);
  }
  if (activeFactory !== factoryTarget) {
    await factory.upgradeToAndCall.staticCall(factoryTarget, "0x");
    await send("factoryUpgrade", await factory.upgradeToAndCall.populateTransaction(factoryTarget, "0x"));
  }
  if (
    ethers.getAddress(await factory.taxRouterImplementation()) !== target ||
    ethers.getAddress(await registry.feeVaultImplementation()) !== target ||
    ethers.getAddress(ethers.dataSlice(await ethers.provider.getStorage(FACTORY, SLOT), 12)) !== factoryTarget
  ) throw new Error("Live future-enrollment pointers did not agree after repair.");
  report.runtimeCodeHash = ethers.keccak256(await ethers.provider.getCode(target));
  report.status = "active";
  save(report);
  const manifestPath = path.join(ROOT, "deployments/1.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const old = manifest.contracts.find(c => c.name === "TaxRouter-implementation");
  if (old && ethers.getAddress(old.address) !== target) old.name = "TaxRouter-implementation-before-multichain-repair";
  if (!manifest.contracts.some(c => c.address.toLowerCase() === target.toLowerCase())) {
    manifest.contracts.push({
      name: "TaxRouter-implementation", address: target, salt: mined.salt,
      deployer: CREATE2, initCodeHash: initHash, runtimeCodeHash: report.runtimeCodeHash,
      transactionHash: report.transactions.implementation, baseTaxBps: 70,
      implementationVersion: Number(await factory.implementationVersion()),
      sourceVerification: "pending",
    });
  }
  const oldFactory = manifest.contracts.find(c => c.name === "ArmoreumFactory-implementation");
  if (oldFactory && ethers.getAddress(oldFactory.address) !== factoryTarget) oldFactory.name = "ArmoreumFactory-implementation-before-enrollment-repair";
  if (!manifest.contracts.some(c => c.address.toLowerCase() === factoryTarget.toLowerCase())) {
    manifest.contracts.push({
      name: "ArmoreumFactory-implementation", address: factoryTarget, salt: factoryMined.salt,
      deployer: CREATE2, initCodeHash: ethers.keccak256(factoryArtifact.bytecode),
      runtimeCodeHash: ethers.keccak256(await ethers.provider.getCode(factoryTarget)),
      transactionHash: report.transactions.factoryImplementation, sourceVerification: "pending",
    });
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().catch((error) => {
  // RPC errors may contain credential-bearing URLs or authorization calldata.
  console.error("Multichain router repair stopped:", error.shortMessage ?? (
    error.code ? error.code : String(error.message).split(" (")[0]
  ));
  process.exitCode = 1;
});
