const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { LOCAL_CHAINS, inspectChain } = require("./local-state.cjs");

async function main() {
  if (!process.argv.includes("--confirm-local-rebuild")) {
    throw new Error("Explicit local rebuild approval is required: --confirm-local-rebuild. Never use this for mainnet.");
  }
  const root = path.resolve(__dirname, "..", "deployments", "local");
  const records = [];
  for (const chain of LOCAL_CHAINS) {
    if (await inspectChain(chain)) {
      throw new Error(`Local chain ${chain.chainId} is still running. Refusing to archive its active manifest.`);
    }
    const source = path.join(root, `${chain.chainId}.json`);
    if (!fs.existsSync(source)) continue;
    const bytes = fs.readFileSync(source);
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.environment !== "local-only" || manifest.chainId !== chain.chainId ||
        manifest.rpcUrl !== `http://127.0.0.1:${chain.port}`) {
      throw new Error(`Manifest ${chain.chainId} is not a recognized local deployment.`);
    }
    records.push({ chainId: chain.chainId, source, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (records.length === 0) {
    throw new Error("No recognized local manifests exist to archive.");
  }
  const archive = path.join(root, "archives", `${Date.now()}-${randomUUID()}`);
  fs.mkdirSync(archive, { recursive: true });
  for (const record of records) {
    const destination = path.join(archive, `${record.chainId}.json`);
    fs.writeFileSync(destination, record.bytes, { flag: "wx", mode: 0o600 });
    if (createHash("sha256").update(fs.readFileSync(destination)).digest("hex") !== record.sha256) {
      throw new Error(`Archive verification failed for ${record.chainId}; active manifests are unchanged.`);
    }
  }
  fs.writeFileSync(path.join(archive, "archive.json"), JSON.stringify({
    purpose: "User-approved local rebuild; historical deployment records, not live chain evidence",
    chainIds: records.map((r) => r.chainId),
    hashes: records.map((r) => ({ chainId: r.chainId, sha256: r.sha256 })),
    databaseChanged: false,
  }, null, 2), { flag: "wx", mode: 0o600 });
  for (const record of records) fs.unlinkSync(record.source);
  process.stdout.write(`Verified archive: ${path.relative(path.resolve(__dirname, ".."), archive)}\n`);
  process.stdout.write("Both old local manifests preserved. No database access or public-network transactions performed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
