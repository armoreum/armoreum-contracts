const { ethers } = require("hardhat");

const API_URL = "https://api.etherscan.io/v2/api";
const TOKEN_DEPLOYER = "0x690042d17d87120a068c291bf13e95c893297696";
const TOKEN = "0x074f226b8771f73599e7849ac7910c4b08e3c60d";
const DEPLOYER_ABI = [
  "event TokenDeployed(address indexed creator,address indexed token,address indexed initialHolder,string name,string symbol,bytes32 salt)",
];

function parseSourceInput(sourceCode) {
  let sourceText = sourceCode.trim();
  if (sourceText.startsWith("{{") && sourceText.endsWith("}}")) {
    sourceText = sourceText.slice(1, -1);
  }
  const parsed = JSON.parse(sourceText);
  if (!parsed.sources?.["contracts/FixedSupplyLaunchToken.sol"] || !parsed.settings) {
    throw new Error("The verified deployer source does not contain a reusable token compiler input.");
  }
  parsed.settings.outputSelection = {
    "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] },
  };
  return parsed;
}

async function etherscanRequest(params, apiKey, method = "GET") {
  const url = new URL(API_URL);
  url.searchParams.set("chainid", "1");
  url.searchParams.set("apikey", apiKey);
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, method === "POST" ? {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  } : undefined);
  const result = await response.json();
  if (!response.ok) throw new Error(`Etherscan HTTP ${response.status}`);
  return result;
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing HASH token source verification outside Ethereum mainnet.");
  }
  const apiKey = process.env.ETHERSCAN_APIKEY;
  if (!apiKey) throw new Error("ETHERSCAN_APIKEY is not configured.");

  const sourceResponse = await etherscanRequest({
    module: "contract",
    action: "getsourcecode",
    address: TOKEN_DEPLOYER,
  }, apiKey);
  const verifiedDeployerSource = Array.isArray(sourceResponse.result) ? sourceResponse.result[0] : null;
  if (!verifiedDeployerSource?.SourceCode) {
    throw new Error("Could not obtain the verified TokenDeployer compiler input from Etherscan.");
  }
  const standardInput = parseSourceInput(verifiedDeployerSource.SourceCode);

  const eventInterface = new ethers.Interface(DEPLOYER_ABI);
  const latestBlock = await ethers.provider.getBlockNumber();
  const logs = await ethers.provider.getLogs({
    address: TOKEN_DEPLOYER,
    topics: [
      eventInterface.getEvent("TokenDeployed").topicHash,
      null,
      ethers.zeroPadValue(TOKEN, 32),
    ],
    fromBlock: Math.max(0, latestBlock - 100_000),
    toBlock: latestBlock,
  });
  const matchingEvents = logs.flatMap((log) => {
    try {
      const event = eventInterface.parseLog(log);
      return event ? [event.args] : [];
    } catch {
      return [];
    }
  });
  if (matchingEvents.length !== 1) {
    throw new Error("Could not uniquely match the HASH token to its TokenDeployer event.");
  }
  const [creator, eventToken, initialHolder, name, symbol] = matchingEvents[0];
  if (ethers.getAddress(eventToken) !== ethers.getAddress(TOKEN) || name !== "Hashbased" || symbol !== "HASH") {
    throw new Error("The on-chain HASH token identity does not match the expected launch record.");
  }

  const constructorArguments = ethers.AbiCoder.defaultAbiCoder()
    .encode(["string", "string", "address"], [name, symbol, initialHolder])
    .slice(2);
  const submission = await etherscanRequest({
    module: "contract",
    action: "verifysourcecode",
    contractaddress: TOKEN,
    sourceCode: JSON.stringify(standardInput),
    codeformat: "solidity-standard-json-input",
    contractname: "contracts/FixedSupplyLaunchToken.sol:FixedSupplyLaunchToken",
    compilerversion: verifiedDeployerSource.CompilerVersion,
    optimizationUsed: verifiedDeployerSource.OptimizationUsed,
    runs: verifiedDeployerSource.Runs,
    evmVersion: verifiedDeployerSource.EVMVersion || "default",
    constructorArguments,
    licenseType: "3",
  }, apiKey, "POST");

  if (String(submission.result || "").toLowerCase().includes("already verified")) {
    process.stdout.write(`${JSON.stringify({
      chainId: 1,
      token: TOKEN,
      creator: ethers.getAddress(creator),
      sourceVerification: "already verified",
    }, null, 2)}\n`);
    return;
  }
  const guid = submission.result;
  if (submission.status !== "1" || typeof guid !== "string" || guid.length < 8) {
    throw new Error(`Etherscan rejected the token verification submission: ${submission.result || submission.message || "unknown error"}`);
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const status = await etherscanRequest({
      module: "contract",
      action: "checkverifystatus",
      guid,
    }, apiKey);
    if (status.status === "1" && /pass|verified/i.test(String(status.result))) {
      process.stdout.write(`${JSON.stringify({
        chainId: 1,
        token: TOKEN,
        creator: ethers.getAddress(creator),
        sourceVerification: "verified",
      }, null, 2)}\n`);
      return;
    }
    if (status.status === "0" && /fail|unable|error/i.test(String(status.result))) {
      throw new Error(`Etherscan verification failed: ${status.result}`);
    }
  }
  throw new Error("Etherscan verification is still pending after three minutes; rerun this command to check again.");
}

main().catch((error) => {
  process.stderr.write(`${error.message || "HASH token Etherscan verification failed"}\n`);
  process.exitCode = 1;
});
