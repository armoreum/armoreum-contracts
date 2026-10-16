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
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 1n) {
    throw new Error(`Refusing source verification on chain ${network.chainId}; expected Ethereum mainnet chain 1.`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const record = manifest.contracts.find(
    (contract) => contract.name === "ArmoreumTokenDeployer",
  );
  if (!record) throw new Error("Ethereum manifest has no ArmoreumTokenDeployer deployment.");

  const artifact = await artifacts.readArtifact("ArmoreumTokenDeployer");
  const code = await ethers.provider.getCode(record.address);
  if (
    code === "0x" ||
    ethers.keccak256(code).toLowerCase() !== record.runtimeCodeHash.toLowerCase() ||
    ethers.keccak256(code).toLowerCase() !== ethers.keccak256(artifact.deployedBytecode).toLowerCase()
  ) {
    throw new Error("Onchain ArmoreumTokenDeployer code does not match the recorded compiled source.");
  }

  await run("verify:verify", {
    address: record.address,
    constructorArguments: [],
  });

  const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const updatedRecord = updatedManifest.contracts.find(
    (contract) => contract.name === "ArmoreumTokenDeployer",
  );
  if (!updatedRecord || updatedRecord.address.toLowerCase() !== record.address.toLowerCase()) {
    throw new Error("Manifest changed during Etherscan verification; not recording verification status.");
  }
  updatedRecord.sourceVerification = "verified";
  if (updatedManifest.tokenDeployer?.address?.toLowerCase() === record.address.toLowerCase()) {
    updatedManifest.tokenDeployer.sourceVerification = "verified";
  }
  writeJsonAtomically(manifestPath, updatedManifest);
  process.stdout.write(`${JSON.stringify({
    chainId: 1,
    network: "Ethereum mainnet",
    contract: "ArmoreumTokenDeployer",
    address: record.address,
    sourceVerification: "verified",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Etherscan source verification failed"}\n`);
  process.exitCode = 1;
});
