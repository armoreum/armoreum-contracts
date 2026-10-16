const { ethers, run } = require("hardhat");

const HOOK = "0xcfbbbf537bf99f2c788af68eee37f0215eef20cc";
const TOKEN = "0x074f226b8771f73599e7849ac7910c4b08e3c60d";
const LAUNCH_ID = "0xc066343e9ae89a2b4117f7e830b2735e2bb78d8d61f89cbc5c2097c265afed64";
const ABI = [
  "function poolManager() view returns(address)",
  "function launchId() view returns(bytes32)",
  "function launchToken() view returns(address)",
  "function admin() view returns(address)",
];

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing V4 hook verification outside Ethereum mainnet.");
  }
  const hook = new ethers.Contract(HOOK, ABI, ethers.provider);
  const [poolManager, launchId, launchToken, admin] = await Promise.all([
    hook.poolManager(),
    hook.launchId(),
    hook.launchToken(),
    hook.admin(),
  ]);
  if (
    ethers.getAddress(launchToken) !== ethers.getAddress(TOKEN) ||
    launchId.toLowerCase() !== LAUNCH_ID.toLowerCase()
  ) {
    throw new Error("The V4 hook does not match the HASH token and launch ID.");
  }
  await run("verify:verify", {
    address: HOOK,
    contract: "contracts/v4/ArmoreumV4TaxHook.sol:ArmoreumV4TaxHook",
    constructorArguments: [poolManager, launchId, launchToken, admin],
  });
  process.stdout.write(`${JSON.stringify({
    chainId: 1,
    hook: HOOK,
    token: launchToken,
    launchId,
    sourceVerification: "verified",
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "HASH V4 hook Etherscan verification failed"}\n`);
  process.exitCode = 1;
});
