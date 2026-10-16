require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("@openzeppelin/hardhat-upgrades");

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
function selectedNetworkName() {
  if (process.env.HARDHAT_NETWORK) return process.env.HARDHAT_NETWORK;
  const networkFlag = process.argv.indexOf("--network");
  return networkFlag >= 0 ? process.argv[networkFlag + 1] : null;
}

const selectedNetwork = selectedNetworkName();

function readRpcUrl(environmentKey, networkName) {
  const value = process.env[environmentKey];
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    if (selectedNetwork === networkName) {
      throw new Error(`${environmentKey} must be a valid HTTPS RPC URL`);
    }
    return null;
  }
  const isLocal = ["localhost", "127.0.0.1"].includes(url.hostname.toLowerCase());
  if ((!isLocal && url.protocol !== "https:") || url.username || url.password) {
    if (selectedNetwork === networkName) {
      throw new Error(`${environmentKey} must be an HTTPS RPC URL without embedded credentials`);
    }
    return null;
  }
  return value;
}

const ethereumRpcUrl = readRpcUrl("ALCHEMY_ETHEREUM_RPC_URL", "ethereum");
const robinhoodRpcUrl = readRpcUrl("ALCHEMY_ROBINHOOD_RPC_URL", "robinhood");

module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.26",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
      {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          evmVersion: "cancun",
          viaIR: true,
        },
      },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: { chainId: Number(process.env.HARDHAT_CHAIN_ID || 4663) },
    localEthereum: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
      accounts: [],
    },
    localRobinhood: {
      url: "http://127.0.0.1:8546",
      chainId: 46630,
      accounts: [],
    },
    ...(ethereumRpcUrl
      ? {
        ethereum: {
          url: ethereumRpcUrl,
          chainId: 1,
      accounts: deployerKey ? [deployerKey] : [],
        },
      }
      : {}),
    ...(robinhoodRpcUrl
      ? {
        robinhood: {
          url: robinhoodRpcUrl,
          chainId: 4663,
      accounts: deployerKey ? [deployerKey] : [],
        },
      }
      : {}),
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_APIKEY || "",
    customChains: [
      {
        network: "robinhood",
        chainId: 4663,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api",
          browserURL: "https://robin.etherscan.io",
        },
      },
    ],
  },
};
