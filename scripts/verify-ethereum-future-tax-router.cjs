const fs = require("node:fs");
const path = require("node:path");
const { ethers, run } = require("hardhat");

const manifestPath = path.join(__dirname, "..", "deployments", "1.json");

function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing TaxRouter source verification outside Ethereum mainnet.");
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const record = manifest.contracts.find((item) =>
    item.name === "TaxRouter-implementation" && item.baseTaxBps === 70,
  );
  if (!record) throw new Error("The manifest has no future-launch 0.7% TaxRouter implementation.");
  const code = await ethers.provider.getCode(record.address);
  if (code === "0x" || ethers.keccak256(code).toLowerCase() !== record.runtimeCodeHash.toLowerCase()) {
    throw new Error("Live 0.7% TaxRouter bytecode does not match its deployment record.");
  }
  const router = new ethers.Contract(record.address, [
    "function BASE_TAX_BPS() view returns(uint16)",
    "function proxiableUUID() view returns(bytes32)",
  ], ethers.provider);
  if (BigInt(await router.BASE_TAX_BPS()) !== 70n) throw new Error("Live TaxRouter does not report 70 basis points.");
  await run("verify:verify", { address: record.address, contract: "contracts/TaxRouter.sol:TaxRouter", constructorArguments: [] });

  const currentManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const currentRecord = currentManifest.contracts.find((item) =>
    item.name === "TaxRouter-implementation" && item.address.toLowerCase() === record.address.toLowerCase(),
  );
  if (!currentRecord) throw new Error("The TaxRouter manifest record changed during verification.");
  currentRecord.sourceVerification = "verified";
  writeJsonAtomically(manifestPath, currentManifest);
  process.stdout.write(`${JSON.stringify({
    chainId: 1,
    address: record.address,
    baseTaxBps: 70,
    sourceVerification: "verified",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Ethereum TaxRouter source verification failed"}\n`);
  process.exitCode = 1;
});
