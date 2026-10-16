const fs = require("node:fs");
const path = require("node:path");
const { ethers, artifacts, run } = require("hardhat");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing TokenDeployer V3 verification outside Ethereum mainnet.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const record = manifest.contracts.find((item) => item.name === "ArmoreumTokenDeployerV3");
  if (!record?.address) throw new Error("ArmoreumTokenDeployerV3 is not recorded as deployed.");
  const runtimeCode = await ethers.provider.getCode(record.address);
  const artifact = await artifacts.readArtifact("ArmoreumTokenDeployerV3");
  if (
    runtimeCode === "0x" ||
    ethers.keccak256(runtimeCode).toLowerCase() !== String(record.runtimeCodeHash).toLowerCase() ||
    ethers.keccak256(runtimeCode).toLowerCase() !== ethers.keccak256(artifact.deployedBytecode).toLowerCase()
  ) {
    throw new Error("Live V3 bytecode does not match the deployment manifest and compiled artifact.");
  }
  await run("verify:verify", {
    address: record.address,
    contract: "contracts/ArmoreumTokenDeployerV3.sol:ArmoreumTokenDeployerV3",
    constructorArguments: [],
  });
  const updated = {
    ...manifest,
    contracts: manifest.contracts.map((item) =>
      item.name === "ArmoreumTokenDeployerV3" ? { ...item, sourceVerification: "verified" } : item),
    tokenDeployerV3: {
      ...(manifest.tokenDeployerV3 || {}),
      address: record.address,
      transactionHash: record.transactionHash,
      sourceVerification: "verified",
    },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    chainId: 1,
    address: record.address,
    tokenContractName: "ArmoreumTokenLaunch",
    sourceVerification: "verified",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum TokenDeployer V3 verification failed"}\n`);
  process.exitCode = 1;
});
