const fs = require("node:fs");
const path = require("node:path");
const { ethers, run } = require("hardhat");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";
const release = process.env.ARMOREUM_HOOK_FACTORY_RELEASE?.trim() || "V2";
if (!/^V[0-9]+$/.test(release)) throw new Error("HookFactory release must be a version such as V3.");
const contractName = `ArmoreumHookFactory${release}`;

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error(`Refusing ${contractName} verification outside Ethereum mainnet.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const record = manifest.contracts.find((item) => item.name === contractName);
  const seed = manifest.contracts.find((item) => item.name === "JailSeed");
  if (!record || !seed) throw new Error(`${contractName} or JailSeed deployment record is missing.`);
  const code = await ethers.provider.getCode(record.address);
  if (code === "0x" || ethers.keccak256(code).toLowerCase() !== record.runtimeCodeHash.toLowerCase()) {
    throw new Error(`Live ${contractName} bytecode does not match the deployment record.`);
  }
  const live = new ethers.Contract(record.address, [
    "function poolManager() view returns(address)",
    "function jailSeed() view returns(address)",
  ], ethers.provider);
  if (
    ethers.getAddress(await live.poolManager()) !== ethers.getAddress(POOL_MANAGER) ||
    ethers.getAddress(await live.jailSeed()) !== ethers.getAddress(seed.address)
  ) throw new Error(`${contractName} constructor arguments do not match the manifest.`);

  await run("verify:verify", {
    address: record.address,
    contract: "contracts/v4/ArmoreumHookFactory.sol:ArmoreumHookFactory",
    constructorArguments: [POOL_MANAGER, seed.address],
  });
  const currentManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentRecord = currentManifest.contracts.find((item) =>
    item.name === contractName && item.address.toLowerCase() === record.address.toLowerCase(),
  );
  if (!currentRecord) throw new Error(`${contractName} manifest record changed during verification.`);
  currentRecord.sourceVerification = "verified";
  if (currentManifest.status?.includes(contractName) && currentManifest.status.includes("source verification pending")) {
    currentManifest.status = `${contractName} deployed, approved, and source verified`;
  }
  writeJsonAtomically(manifestPath, currentManifest);
  process.stdout.write(`${JSON.stringify({
    chainId: 1,
    address: record.address,
    sourceVerification: "verified",
    constructor: { poolManager: POOL_MANAGER, jailSeed: seed.address },
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum HookFactory source verification failed"}\n`);
  process.exitCode = 1;
});
