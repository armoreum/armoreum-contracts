// Deploys the coordinator without changing existing operators or active paths.
// Run via hardhat --network ethereum|robinhood; explicit broadcast flag required.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const ethereum = hre.network.name === "ethereum";
  if (!ethereum && hre.network.name !== "robinhood") throw new Error("Select an approved mainnet.");
  const chainId = ethereum ? 1 : 4663;
  const provider = new ethers.JsonRpcProvider(
    process.env[ethereum ? "ALCHEMY_ETHEREUM_RPC_URL" : "ALCHEMY_ROBINHOOD_RPC_URL"],
    chainId, { staticNetwork: true },
  );
  try {
    if (Number(BigInt(await provider.send("eth_chainId", []))) !== chainId) throw new Error("RPC chain mismatch.");
    const file = path.resolve(__dirname, `../deployments/${chainId}.multichain-bridge-operators.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
    const owner = new ethers.Wallet(process.env.PLATFORM_OWNER_PRIVATE_KEY).address;
    const keeper = new ethers.Wallet(process.env[ethereum ? "lz_eth" : "lz_robinhood"]).address;
    if (owner.toLowerCase() !== record.owner.toLowerCase() || keeper.toLowerCase() !== record.keeper.toLowerCase()) {
      throw new Error("Configured signer addresses do not match the approved operator manifest.");
    }
    const artifact = await hre.artifacts.readArtifact("ArmoreumAtomicRelay");
    const args = [owner, keeper, record.contracts.ArmoreumCustomDVN, record.contracts.ArmoreumLayerZeroExecutor, record.endpoint];
    let address = record.contracts.ArmoreumAtomicRelay ?? record.atomicRelayDeployment?.address;
    if (address && await provider.getCode(address) === "0x") {
      throw new Error("An earlier relay deployment is unresolved. Inspect its saved hash before sending anything else.");
    }
    if (!address) {
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
      const request = await factory.getDeployTransaction(...args);
      const [block, price, nonce, pending] = await Promise.all([
        provider.getBlock("latest"), provider.send("eth_gasPrice", []),
        provider.getTransactionCount(deployer.address, "latest"), provider.getTransactionCount(deployer.address, "pending"),
      ]);
      if (!block?.baseFeePerGas || pending !== nonce) throw new Error("Missing base fee or pending deployment-wallet transaction.");
      const gasPrice = block.baseFeePerGas * 120n / 100n;
      if (BigInt(price) > gasPrice) throw new Error("Live gas quote exceeds base fee +20%.");
      const estimate = await provider.estimateGas({ ...request, from: deployer.address, gasPrice });
      const gasLimit = (estimate * 120n + 99n) / 100n;
      await provider.call({ ...request, from: deployer.address, gasPrice, gasLimit });
      const budget = gasPrice * gasLimit;
      if (await provider.getBalance(deployer.address) < budget) throw new Error("Deployment wallet cannot cover the estimated budget.");
      console.log(JSON.stringify({ chainId, gasEstimate: String(estimate), budgetEth: ethers.formatEther(budget), broadcast: process.env.ARMOREUM_ATOMIC_RELAY_BROADCAST === "YES" }));
      if (process.env.ARMOREUM_ATOMIC_RELAY_BROADCAST !== "YES") return;
      const raw = await deployer.signTransaction({ ...request, chainId, nonce, gasPrice, gasLimit });
      const hash = ethers.keccak256(raw);
      address = ethers.getCreateAddress({ from: deployer.address, nonce });
      record.atomicRelayDeployment = { address, transactionHash: hash, status: "pending" };
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      await provider.broadcastTransaction(raw);
      const receipt = await provider.waitForTransaction(hash, 1, 90_000);
      if (!receipt || receipt.status !== 1) throw new Error("Deployment is not confirmed successful; inspect the saved hash.");
      record.atomicRelayDeployment = { address, transactionHash: hash, blockNumber: receipt.blockNumber,
        gasUsed: String(receipt.gasUsed), feeEth: ethers.formatEther(receipt.fee), status: "confirmed" };
    }
    const relay = new ethers.Contract(address, artifact.abi, provider);
    const bindings = await Promise.all([relay.owner(), relay.keeper(), relay.dvn(), relay.executor(), relay.endpoint()]);
    if (bindings.some((value, i) => value.toLowerCase() !== args[i].toLowerCase())) throw new Error("Deployed relay bindings mismatch.");
    record.contracts.ArmoreumAtomicRelay = address;
    record.atomicRelayActivation = "awaiting-compatible-production-worker";
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify({ chainId, address, bindingsVerified: true, operatorsChanged: false }));
  } finally { provider.destroy(); }
}
main().catch(error => { console.error("Atomic relay deployment stopped:", error.shortMessage ?? error.message.split("\n")[0]); process.exitCode = 1; });
