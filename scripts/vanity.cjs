const fs = require("node:fs");
const path = require("node:path");
const { getCreate2Address, keccak256, isAddress, getAddress } = require("ethers");

const PREFIX = "0x6900";
const CHECKPOINT_EVERY = 2500;

function readInitCode(filePath) {
  const raw = fs.readFileSync(filePath);
  const text = raw.toString("utf8").trim();
  if (/^0x(?:[0-9a-fA-F]{2})+$/.test(text)) return text;
  if (raw.length === 0) throw new Error("Init code file is empty");
  return `0x${raw.toString("hex")}`;
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temporary, filePath);
}

async function mineVanitySalt({
  deployer,
  initCode,
  initCodeHash,
  stateFile,
  maxAttempts = 2_000_000,
  suffixMask = 0n,
  suffixValue = 0n,
}) {
  if (!isAddress(deployer)) throw new Error("A valid CREATE2 deployer address is required");
  const normalizedDeployer = getAddress(deployer);
  const computedHash = initCode ? keccak256(initCode) : null;
  if (computedHash && initCodeHash && computedHash.toLowerCase() !== initCodeHash.toLowerCase()) {
    throw new Error("Provided init-code hash does not match the init code");
  }
  const targetHash = (computedHash || initCodeHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(targetHash)) throw new Error("A valid init-code hash is required");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive safe integer");
  const normalizedSuffixMask = `0x${BigInt(suffixMask).toString(16).padStart(64, "0")}`;
  const normalizedSuffixValue = `0x${BigInt(suffixValue).toString(16).padStart(64, "0")}`;
  const emptySuffixConstraint = `0x${"0".repeat(64)}`;
  if ((BigInt(normalizedSuffixValue) & ~BigInt(normalizedSuffixMask)) !== 0n) {
    throw new Error("Suffix value sets bits outside the suffix mask");
  }

  let nextCounter = 1n;
  if (stateFile && fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (
      state.deployer?.toLowerCase() !== normalizedDeployer.toLowerCase() ||
      state.initCodeHash?.toLowerCase() !== targetHash ||
      state.prefix !== PREFIX ||
      (state.suffixMask || emptySuffixConstraint).toLowerCase() !== normalizedSuffixMask ||
      (state.suffixValue || emptySuffixConstraint).toLowerCase() !== normalizedSuffixValue
    ) {
      throw new Error("Vanity-search state does not match this deployer, init code, or address constraints");
    }
    if (state.found) {
      return {
        address: state.address,
        salt: state.salt,
          suffixMask: normalizedSuffixMask,
          suffixValue: normalizedSuffixValue,
        initCodeHash: targetHash,
        deployer: normalizedDeployer,
        attempts: state.attempts,
      };
    }
    nextCounter = BigInt(state.nextCounter || "1");
  }

  const startingCounter = nextCounter;
  for (let attempts = 0; attempts < maxAttempts; attempts += 1, nextCounter += 1n) {
    const salt = `0x${nextCounter.toString(16).padStart(64, "0")}`;
    const address = getCreate2Address(normalizedDeployer, salt, targetHash);
    if (
      address.toLowerCase().startsWith(PREFIX) &&
      (BigInt(address) & BigInt(normalizedSuffixMask)) === BigInt(normalizedSuffixValue)
    ) {
      const result = {
        prefix: PREFIX,
        suffixMask: normalizedSuffixMask,
        suffixValue: normalizedSuffixValue,
        deployer: normalizedDeployer,
        initCodeHash: targetHash,
        salt,
        address,
        attempts: Number(nextCounter - startingCounter + 1n),
        found: true,
      };
      if (stateFile) saveState(stateFile, result);
      return result;
    }
    if (stateFile && attempts > 0 && attempts % CHECKPOINT_EVERY === 0) {
      saveState(stateFile, {
        prefix: PREFIX,
        suffixMask: normalizedSuffixMask,
        suffixValue: normalizedSuffixValue,
        deployer: normalizedDeployer,
        initCodeHash: targetHash,
        nextCounter: (nextCounter + 1n).toString(),
        attempts: Number(nextCounter - startingCounter + 1n),
        found: false,
      });
    }
  }

  if (stateFile) {
    saveState(stateFile, {
      prefix: PREFIX,
      suffixMask: normalizedSuffixMask,
      suffixValue: normalizedSuffixValue,
      deployer: normalizedDeployer,
      initCodeHash: targetHash,
      nextCounter: nextCounter.toString(),
      attempts: Number(nextCounter - startingCounter),
      found: false,
    });
  }
  throw new Error(`No address matching ${PREFIX} and the requested suffix bits was found within ${maxAttempts} attempts; search progress was saved`);
}

function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith("--")) continue;
    result[args[i].slice(2)] = args[i + 1];
    i += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployer = args.deployer || process.env.CREATE2_DEPLOYER_ADDRESS;
  const initCodeFile = args["init-code-file"];
  if (!deployer || !initCodeFile) {
    throw new Error("Usage: pnpm vanity --deployer 0x... --init-code-file ./init-code.hex [--state-file ./vanity.json] [--suffix-mask 0x3fff --suffix-value 0x20cc]");
  }
  const initCode = readInitCode(initCodeFile);
  const stateFile = args["state-file"] || `${initCodeFile}.vanity.json`;
  const maxAttempts = Number(args["max-attempts"] || process.env.MAX_VANITY_ATTEMPTS || 2_000_000);
  const result = await mineVanitySalt({
    deployer,
    initCode,
    stateFile,
    maxAttempts,
    suffixMask: BigInt(args["suffix-mask"] || "0"),
    suffixValue: BigInt(args["suffix-value"] || "0"),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message || "Vanity search failed"}\n`);
    process.exitCode = 1;
  });
}

module.exports = { PREFIX, mineVanitySalt, readInitCode };
