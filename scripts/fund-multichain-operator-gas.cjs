const { JsonRpcProvider, Wallet, parseEther } = require("ethers");

const TARGET_BALANCE = parseEther("0.001");
const BPS = 10_000n;
const NETWORKS = [
  { name: "Ethereum", chainId: 1, rpc: "ALCHEMY_ETHEREUM_RPC_URL", keeper: "lz_eth" },
  { name: "Robinhood", chainId: 4663, rpc: "ALCHEMY_ROBINHOOD_RPC_URL", keeper: "lz_robinhood" },
];

function env(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment value ${name} is missing.`);
  return value;
}

function gasOverrides(baseFee, gasPrice, gasLimit, name) {
  if (baseFee <= 0n) throw new Error(`${name}: live base fee is unavailable.`);
  const maxFeePerGas = (baseFee * 12_000n + BPS - 1n) / BPS;
  if (gasPrice !== null && gasPrice > maxFeePerGas) {
    throw new Error(`${name}: current gas quote exceeds base fee +20%; no funding transaction was sent.`);
  }
  return {
    gasLimit: (gasLimit * 12_000n + BPS - 1n) / BPS,
    maxFeePerGas,
    maxPriorityFeePerGas: maxFeePerGas - baseFee,
  };
}

async function inspectNetwork(config, deployer, owner, keeper) {
  const provider = new JsonRpcProvider(env(config.rpc), config.chainId, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(`${config.name}: RPC chain ID does not match the expected mainnet.`);
  }
  const recipients = new Map([
    ["PLATFORM_OWNER", owner.address],
    ["destination keeper", keeper.address],
  ]);
  const uniqueRecipients = new Map();
  for (const [label, address] of recipients) {
    if (address.toLowerCase() === deployer.address.toLowerCase()) continue;
    const existing = [...uniqueRecipients.entries()].find(([, item]) => item.address.toLowerCase() === address.toLowerCase());
    if (existing) existing[1].labels.push(label);
    else uniqueRecipients.set(address.toLowerCase(), { address, labels: [label] });
  }

  const [deployerBalance, block, feeData] = await Promise.all([
    provider.getBalance(deployer.address),
    provider.getBlock("latest"),
    provider.getFeeData(),
  ]);
  const baseFee = block?.baseFeePerGas ?? feeData.gasPrice;
  if (baseFee === null || baseFee === undefined) {
    throw new Error(`${config.name}: live base fee is unavailable.`);
  }
  const feePolicy = gasOverrides(baseFee, feeData.gasPrice, 21_000n, config.name);
  const plan = [];
  for (const recipient of uniqueRecipients.values()) {
    const balance = await provider.getBalance(recipient.address);
    if (balance >= TARGET_BALANCE) continue;
    const value = TARGET_BALANCE - balance;
    const estimatedGas = await provider.estimateGas({
      from: deployer.address,
      to: recipient.address,
      value,
      maxFeePerGas: feePolicy.maxFeePerGas,
      maxPriorityFeePerGas: feePolicy.maxPriorityFeePerGas,
    });
    const fees = gasOverrides(baseFee, feeData.gasPrice, estimatedGas, config.name);
    plan.push({ ...recipient, value, ...fees });
  }
  const totalNeeded = plan.reduce((sum, item) => sum + item.value + item.gasLimit * item.maxFeePerGas, 0n);
  if (deployerBalance < totalNeeded) {
    throw new Error(`${config.name}: deployment wallet cannot cover the approved gas bootstrap; no funding transactions were sent.`);
  }
  return { config, provider, plan };
}

async function main() {
  const deployerKey = env("DEPLOYER_PRIVATE_KEY");
  const owner = new Wallet(env("PLATFORM_OWNER_PRIVATE_KEY"));
  const deployer = new Wallet(deployerKey);
  const plans = await Promise.all(NETWORKS.map((config) =>
    inspectNetwork(config, deployer, owner, new Wallet(env(config.keeper))),
  ));

  for (const { config, provider, plan } of plans) {
    const signer = new Wallet(deployerKey, provider);
    for (const item of plan) {
      const [block, feeData] = await Promise.all([
        provider.getBlock("latest"),
        provider.getFeeData(),
      ]);
      const baseFee = block?.baseFeePerGas ?? feeData.gasPrice;
      if (baseFee === null || baseFee === undefined) {
        throw new Error(`${config.name}: live base fee is unavailable.`);
      }
      const liveOverrides = gasOverrides(baseFee, feeData.gasPrice, item.gasLimit, config.name);
      const tx = await signer.sendTransaction({
        to: item.address,
        value: item.value,
        ...liveOverrides,
      });
      console.log(`${config.name}: funding ${item.labels.join(" / ")} to 0.001 ETH; tx ${tx.hash}`);
      const receipt = await tx.wait(1);
      if (!receipt || receipt.status !== 1) {
        throw new Error(`${config.name}: gas bootstrap transaction failed (${tx.hash}).`);
      }
    }
    if (plan.length === 0) console.log(`${config.name}: owner and keeper already meet the 0.001 ETH target.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Multichain operator gas bootstrap failed.");
  process.exitCode = 1;
});
