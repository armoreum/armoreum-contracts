const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const { LOCAL_CHAINS, inspectChain, verifyManifest, waitForChain: waitForVerifiedChain } = require("./local-state.cjs");

const packageDir = path.resolve(__dirname, "..");
const children = [];
let stopping = false;
let monitor;

function stop() {
  if (stopping) return;
  stopping = true;
  if (monitor) clearInterval(monitor);
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
}

process.on("SIGINT", () => {
  stop();
  process.exit(130);
});
process.on("SIGTERM", () => {
  stop();
  process.exit(143);
});

function startNode(chainId, port) {
  const child = spawn(
    process.execPath,
    [
      require.resolve("hardhat/internal/cli/bootstrap"),
      "node",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
        HARDHAT_CHAIN_ID: String(chainId),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  const forwardSafeLines = (source, destination) => {
    let pending = "";
    source.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || "";
      for (const line of lines) {
        if (/\bAccount #\d+:|Private Key:|WARNING: These accounts|^Accounts$|^=+$/.test(line)) continue;
        destination.write(`${line}\n`);
      }
    });
    source.on("end", () => {
      if (pending && !/\bAccount #\d+:|Private Key:|WARNING: These accounts|^Accounts$|^=+$/.test(pending)) {
        destination.write(`${pending}\n`);
      }
    });
  };
  forwardSafeLines(child.stdout, process.stdout);
  forwardSafeLines(child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (!stopping) {
      process.stderr.write(`Local node ${chainId} exited with code ${code}\n`);
      stop();
      process.exitCode = code || 1;
    }
  });
  child.on("error", () => {
    process.stderr.write(`Cannot start local node ${chainId}.\n`);
    stop();
    process.exitCode = 1;
  });
  return child;
}

function deploy(networkName, chainId) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "hardhat", "run", "scripts/deploy-local.cjs", "--network", networkName],
      {
        cwd: packageDir,
        env: {
          ...process.env,
          HARDHAT_DISABLE_TELEMETRY_PROMPT: "true",
          HARDHAT_CHAIN_ID: String(chainId),
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Local deployment failed for ${networkName} (exit ${code}).`));
    });
  });
}

async function main() {
  const instances = new Map();
  for (const chain of LOCAL_CHAINS) {
    const existing = await inspectChain(chain);
    if (!existing) {
      if (fs.existsSync(path.join(packageDir, "deployments", "local", `${chain.chainId}.json`))) {
        throw new Error(`Chain ${chain.chainId} is offline but has a saved manifest. Refusing to replace its state automatically.`);
      }
      startNode(chain.chainId, chain.port);
      instances.set(chain.chainId, await waitForVerifiedChain(chain));
      await deploy(chain.networkName, chain.chainId);
    } else {
      instances.set(chain.chainId, existing);
      process.stdout.write(`Reusing existing local chain ${chain.chainId} without reset or redeployment.\n`);
    }
    const contracts = await verifyManifest(chain);
    process.stdout.write(`Verified ${contracts.length} contract deployments on local chain ${chain.chainId}.\n`);
  }
  process.stdout.write(
    "\nLocal EVMs are ready on 127.0.0.1:8545 (31337) and 127.0.0.1:8546 (46630). Only nodes started by this workflow are stopped on exit.\n",
  );
  let checking = false;
  monitor = setInterval(async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      for (const chain of LOCAL_CHAINS) {
        const current = await inspectChain(chain);
        if (!current || current.instanceId !== instances.get(chain.chainId).instanceId) {
          throw new Error(`Local chain ${chain.chainId} stopped or was reset; refusing to trust stale deployment state.`);
        }
      }
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      stop();
      process.exitCode = 1;
      clearInterval(monitor);
    } finally { checking = false; }
  }, 5000);
}

main().catch((error) => {
  process.stderr.write(`${error.message || "Local stack failed"}\n`);
  stop();
  process.exit(1);
});
