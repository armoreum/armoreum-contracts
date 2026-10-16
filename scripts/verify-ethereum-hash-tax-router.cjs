const fs = require("node:fs");
const { ethers } = require("hardhat");

const API_URL = "https://api.etherscan.io/v2/api";
const VERIFIED_SEVENTY_BPS_IMPLEMENTATION = "0x6900D24009107630F1b22747a0Bac14e4e594330";
const HASH_ROUTER_PROXY = "0x0cAA8Af1Cb8EB9057b5554C79c94d8699D85C90C";
const HASH_ROUTER_IMPLEMENTATION = "0x6900De1848a25b27aE0C8617c240f515C1cBBEC4";

async function etherscanRequest(params, apiKey, method = "GET") {
  const url = new URL(API_URL);
  url.searchParams.set("chainid", "1");
  url.searchParams.set("apikey", apiKey);
  if (method === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
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

function parseSourceInput(sourceCode) {
  let text = sourceCode.trim();
  if (text.startsWith("{{") && text.endsWith("}}")) text = text.slice(1, -1);
  return JSON.parse(text);
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 1n) {
    throw new Error("Refusing HASH TaxRouter verification outside Ethereum mainnet.");
  }
  const apiKey = process.env.ETHERSCAN_APIKEY;
  if (!apiKey) throw new Error("ETHERSCAN_APIKEY is not configured.");

  const proxy = new ethers.Contract(HASH_ROUTER_PROXY, [
    "function BASE_TAX_BPS() view returns(uint16)",
  ], ethers.provider);
  const implementationTax = new ethers.Contract(HASH_ROUTER_IMPLEMENTATION, [
    "function BASE_TAX_BPS() view returns(uint16)",
  ], ethers.provider);
  const [proxyBaseTax, implementationBaseTax] = await Promise.all([
    proxy.BASE_TAX_BPS(),
    implementationTax.BASE_TAX_BPS(),
  ]);
  if (BigInt(proxyBaseTax) !== 100n || BigInt(implementationBaseTax) !== 100n) {
    throw new Error("The existing HASH TaxRouter no longer reports its protected 1% base tax.");
  }

  const verifiedSourceResponse = await etherscanRequest({
    module: "contract",
    action: "getsourcecode",
    address: VERIFIED_SEVENTY_BPS_IMPLEMENTATION,
  }, apiKey);
  const verifiedSource = Array.isArray(verifiedSourceResponse.result)
    ? verifiedSourceResponse.result[0]
    : null;
  if (!verifiedSource?.SourceCode || !verifiedSource.CompilerVersion) {
    throw new Error("Could not retrieve the verified future TaxRouter compiler input.");
  }
  const standardInput = parseSourceInput(verifiedSource.SourceCode);
  const taxRouterSource = standardInput.sources?.["contracts/TaxRouter.sol"]?.content;
  const currentSource = fs.readFileSync("contracts/TaxRouter.sol", "utf8");
  if (!taxRouterSource || taxRouterSource !== currentSource) {
    throw new Error("The current TaxRouter source no longer matches the verified 0.7% implementation.");
  }
  const oldSource = taxRouterSource.replace(
    "uint16 public constant BASE_TAX_BPS = 70;",
    "uint16 public constant BASE_TAX_BPS = 100;",
  );
  if (oldSource === taxRouterSource) throw new Error("Could not isolate the original 1% TaxRouter source change.");
  standardInput.sources["contracts/TaxRouter.sol"].content = oldSource;
  standardInput.settings.outputSelection = {
    "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] },
  };

  const submission = await etherscanRequest({
    module: "contract",
    action: "verifysourcecode",
    contractaddress: HASH_ROUTER_IMPLEMENTATION,
    sourceCode: JSON.stringify(standardInput),
    codeformat: "solidity-standard-json-input",
    contractname: "contracts/TaxRouter.sol:TaxRouter",
    compilerversion: verifiedSource.CompilerVersion,
    optimizationUsed: verifiedSource.OptimizationUsed,
    runs: verifiedSource.Runs,
    evmVersion: verifiedSource.EVMVersion || "default",
    constructorArguments: "",
    licenseType: "3",
  }, apiKey, "POST");

  if (String(submission.result || "").toLowerCase().includes("already verified")) {
    process.stdout.write(`${JSON.stringify({
      chainId: 1,
      hashRouter: HASH_ROUTER_PROXY,
      baseTaxBps: 100,
      sourceVerification: "already verified",
    }, null, 2)}\n`);
    return;
  }
  const guid = submission.result;
  if (submission.status !== "1" || typeof guid !== "string" || guid.length < 8) {
    throw new Error(`Etherscan rejected the HASH TaxRouter verification: ${submission.result || submission.message || "unknown error"}`);
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
        hashRouter: HASH_ROUTER_PROXY,
        implementation: HASH_ROUTER_IMPLEMENTATION,
        baseTaxBps: 100,
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
  process.stderr.write(`${error.message || "HASH TaxRouter Etherscan verification failed"}\n`);
  process.exitCode = 1;
});
