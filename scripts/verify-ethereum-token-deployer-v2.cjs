const fs = require("node:fs");
const path = require("node:path");
const { artifacts, ethers, run } = require("hardhat");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing source verification outside Ethereum mainnet.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const record = manifest.contracts.find((item) => item.name === "ArmoreumTokenDeployerV2");
  if (!record) throw new Error("The Ethereum manifest has no TokenDeployer V2 record.");
  const artifact = await artifacts.readArtifact("ArmoreumTokenDeployerV2");
  const code = await ethers.provider.getCode(record.address);
  const runtimeHash = code === "0x" ? "" : ethers.keccak256(code);
  if (
    runtimeHash.toLowerCase() !== String(record.runtimeCodeHash).toLowerCase() ||
    runtimeHash.toLowerCase() !== ethers.keccak256(artifact.deployedBytecode).toLowerCase()
  ) {
    throw new Error("Live TokenDeployer V2 bytecode does not match its compiled source.");
  }
  await run("verify:verify", { address: record.address, constructorArguments: [] });
  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const updatedRecord = updatedManifest.contracts.find((item) => item.name === "ArmoreumTokenDeployerV2");
  if (!updatedRecord || updatedRecord.address.toLowerCase() !== record.address.toLowerCase()) {
    throw new Error("The V2 manifest record changed during verification.");
  }
  updatedRecord.sourceVerification = "verified";
  if (updatedManifest.tokenDeployerV2?.address?.toLowerCase() === record.address.toLowerCase()) {
    updatedManifest.tokenDeployerV2.sourceVerification = "verified";
  }
  writeJsonAtomically(manifestPath, updatedManifest);
  process.stdout.write(`${JSON.stringify({ chainId: 1, contract: "ArmoreumTokenDeployerV2", address: record.address, sourceVerification: "verified" }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "TokenDeployer V2 Etherscan verification failed"}\n`);
  process.exitCode = 1;
});
