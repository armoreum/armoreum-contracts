const fs = require("node:fs");
const path = require("node:path");
const { run } = require("hardhat");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");
const temporaryManifestPath = `${manifestPath}.tmp`;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const contracts = [
  {
    name: "ArmoreumFactory-implementation",
    contract: "contracts/ArmoreumFactory.sol:ArmoreumFactory",
  },
  {
    name: "VaultFactory-implementation",
    contract: "contracts/VaultFactory.sol:VaultFactory",
  },
  {
    name: "TaxRouter-implementation",
    contract: "contracts/TaxRouter.sol:TaxRouter",
  },
  {
    name: "ArmoreumMultichainVault-implementation",
    contract: "contracts/bridge/ArmoreumMultichainVault.sol:ArmoreumMultichainVault",
  },
  {
    name: "ArmoreumMultichainLaunchModule",
    contract: "contracts/bridge/ArmoreumMultichainLaunchModule.sol:ArmoreumMultichainLaunchModule",
  },
];

async function main() {
  for (const item of contracts) {
    const record = manifest.contracts.find((entry) => entry.name === item.name);
    if (!record?.address || !record.runtimeCodeHash) {
      throw new Error(`Ethereum deployment manifest is missing ${item.name}`);
    }
    try {
      await run("verify:verify", {
        address: record.address,
        contract: item.contract,
        constructorArguments: [],
      });
      record.sourceVerification = "verified";
      process.stdout.write(`${JSON.stringify({
        status: "verified",
        name: item.name,
        address: record.address,
      })}\n`);
    } catch (error) {
      if (/already verified|already been verified/i.test(String(error?.message || error))) {
        record.sourceVerification = "verified";
        process.stdout.write(`${JSON.stringify({
          status: "already-verified",
          name: item.name,
          address: record.address,
        })}\n`);
        continue;
      }
      throw error;
    }
    fs.writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporaryManifestPath, manifestPath);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
