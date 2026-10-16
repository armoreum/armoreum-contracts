// One-time, publish-gated migration. New launches reuse the shared configuration.
// Dry run by default. Explicit ARMOREUM_ATOMIC_RELAY_ACTIVATE=YES permits writes.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const write = process.env.ARMOREUM_ATOMIC_RELAY_ACTIVATE === "YES";
  const origin = new URL(process.env.ARMOREUM_RELAY_PRODUCTION_URL);
  if (origin.protocol !== "https:" || origin.username || origin.password) throw new Error("Use the verified HTTPS production URL.");
  const fetchJson = async resource => {
    const response = await fetch(new URL(resource, origin), { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Production readiness endpoint is unavailable.");
    return response.json();
  };
  const health = await fetchJson("/api/healthz");
  if (health.bridgeRelayWorkerVersion !== "atomic-relay-v1") {
    if (write) throw new Error("Publish the compatible worker before activating any mainnet operator.");
    console.log(JSON.stringify({ activationReady: false, reason: "compatible-production-worker-not-published", transactionsSent: 0 }));
    return;
  }
  const ethereum = hre.network.name === "ethereum";
  if (!ethereum && hre.network.name !== "robinhood") throw new Error("Select an approved mainnet.");
  const chainId = ethereum ? 1 : 4663;
  const remoteChainId = ethereum ? 4663 : 1;
  const remoteEid = ethereum ? 30416 : 30101;
  const provider = new ethers.JsonRpcProvider(process.env[ethereum ? "ALCHEMY_ETHEREUM_RPC_URL" : "ALCHEMY_ROBINHOOD_RPC_URL"], chainId, { staticNetwork: true });
  const sourceProvider = new ethers.JsonRpcProvider(process.env[ethereum ? "ALCHEMY_ROBINHOOD_RPC_URL" : "ALCHEMY_ETHEREUM_RPC_URL"], remoteChainId, { staticNetwork: true });
  try {
    for (const [rpc, expected] of [[provider, chainId], [sourceProvider, remoteChainId]]) {
      if (Number(BigInt(await rpc.send("eth_chainId", []))) !== expected) throw new Error("RPC chain mismatch.");
    }
    const policy = await import(pathToFileURL(path.resolve(__dirname, "../../../artifacts/api-server/src/lib/bridgeRelayPolicy.ts")).href);
    const file = path.resolve(__dirname, `../deployments/${chainId}.multichain-bridge-operators.json`);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const sourceRecord = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../deployments/${remoteChainId}.multichain-bridge-operators.json`), "utf8"));
    const address = record.contracts.ArmoreumAtomicRelay;
    const owner = new ethers.Wallet(process.env.PLATFORM_OWNER_PRIVATE_KEY, provider);
    const relayArtifact = await hre.artifacts.readArtifact("ArmoreumAtomicRelay");
    const relay = new ethers.Contract(address, relayArtifact.abi, provider);
    const expected = [record.owner, record.keeper, record.contracts.ArmoreumCustomDVN, record.contracts.ArmoreumLayerZeroExecutor, record.endpoint];
    const bindings = await Promise.all([relay.owner(), relay.keeper(), relay.dvn(), relay.executor(), relay.endpoint()]);
    if (bindings.some((value, i) => value.toLowerCase() !== expected[i].toLowerCase())
      || owner.address.toLowerCase() !== record.owner.toLowerCase()) throw new Error("Relay/owner bindings mismatch.");
    const endpoint = new ethers.Contract(record.endpoint, [
      "function getSendLibrary(address,uint32) view returns(address)",
      "function getReceiveLibrary(address,uint32) view returns(address,bool)",
      "function getConfig(address,address,uint32,uint32) view returns(bytes)",
      "function setConfig(address,address,(uint32 eid,uint32 configType,bytes config)[])",
    ], provider);
    const dvn = new ethers.Contract(record.contracts.ArmoreumCustomDVN, [
      "function operator() view returns(address)", "function setOperator(address)",
      "function verificationSubmitted(bytes32) view returns(bool)",
      "function setInboundPath(uint32,bytes32,address,address,uint64,bool)",
    ], provider);
    const executor = new ethers.Contract(record.contracts.ArmoreumLayerZeroExecutor, [
      "function operator() view returns(address)", "function setOperator(address)",
    ], provider);
    if (await provider.getTransactionCount(record.keeper, "latest")
      !== await provider.getTransactionCount(record.keeper, "pending")) {
      throw new Error("Destination keeper still has an in-flight legacy transaction.");
    }
    const packetEvents = new ethers.Interface(["event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)"]);
    let cursor;
    do {
      const page = await fetchJson(`/api/bridge-transfers?status=pending&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page.items)) throw new Error("Invalid pending-transfer response.");
      for (const transfer of page.items.filter(item => item.destinationChainId === chainId)) {
        const receipt = await sourceProvider.getTransactionReceipt(transfer.sourceTransactionHash);
        if (!receipt || receipt.status !== 1) throw new Error("Pending transfer source receipt is unavailable; activation stopped.");
        const [receiveLibrary] = await endpoint.getReceiveLibrary(transfer.destinationBridge, remoteEid);
        let matched = false;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== sourceRecord.endpoint.toLowerCase()) continue;
          let packet;
          try { packet = packetEvents.parseLog(log); } catch { continue; }
          if (!packet) continue;
          const encoded = packet.args.encodedPayload;
          if (ethers.dataSlice(encoded, 81, 113).toLowerCase() !== transfer.guid.toLowerCase()) continue;
          matched = true;
          const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "bytes32", "bytes32"],
            [receiveLibrary, ethers.keccak256(ethers.dataSlice(encoded, 0, 81)), ethers.keccak256(ethers.dataSlice(encoded, 81))],
          ));
          if (await dvn.verificationSubmitted(key)) throw new Error("Drain partially verified legacy packets before changing receive policy.");
        }
        if (!matched) throw new Error("Pending source packet could not be correlated; activation stopped.");
      }
      cursor = page.nextCursor;
    } while (cursor);
    const pairs = await fetchJson("/api/multichain-bridges");
    if (!Array.isArray(pairs)) throw new Error("Invalid active-pair response.");
    const transact = async (contract, method, args, label) => {
      const request = { to: contract.target, data: contract.interface.encodeFunctionData(method, args), from: owner.address };
      const block = await provider.getBlock("latest");
      if (!block?.baseFeePerGas) throw new Error("Missing live base fee.");
      const gasPrice = block.baseFeePerGas * 120n / 100n;
      if (BigInt(await provider.send("eth_gasPrice", [])) > gasPrice) throw new Error("Live fee exceeds base fee +20%.");
      const nonce = await provider.getTransactionCount(owner.address, "latest");
      if (await provider.getTransactionCount(owner.address, "pending") !== nonce) throw new Error("Owner wallet has a pending transaction.");
      const gasLimit = (await provider.estimateGas({ ...request, gasPrice }) * 120n + 99n) / 100n;
      await provider.call({ ...request, gasPrice, gasLimit });
      if (await provider.getBalance(owner.address) < gasPrice * gasLimit) throw new Error("Insufficient owner gas balance.");
      console.log(JSON.stringify({ chainId, label, write, maximumCostEth: ethers.formatEther(gasPrice * gasLimit) }));
      if (!write) return;
      const raw = await owner.signTransaction({ to: request.to, data: request.data, nonce, chainId, gasPrice, gasLimit });
      const hash = ethers.keccak256(raw);
      record.atomicRelayActivationTransactions ??= [];
      record.atomicRelayActivationTransactions.push({ label, transactionHash: hash });
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
      await provider.broadcastTransaction(raw);
      const receipt = await provider.waitForTransaction(hash, 1, 90_000);
      if (!receipt || receipt.status !== 1) throw new Error("Configuration receipt is not successful; inspect its saved hash.");
    };
    const ulnConfig = confirmations => ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(uint64 confirmations,uint8 requiredDVNCount,uint8 optionalDVNCount,uint8 optionalDVNThreshold,address[] requiredDVNs,address[] optionalDVNs)"],
      [[confirmations, 1, 0, 0, [record.contracts.ArmoreumCustomDVN], []]],
    );
    for (const pair of pairs) {
      const localApp = ethereum ? pair.ethereumBridge : pair.robinhoodBridge;
      const remoteApp = ethereum ? pair.robinhoodBridge : pair.ethereumBridge;
      const sendLibrary = await endpoint.getSendLibrary(localApp, remoteEid);
      const [receiveLibrary] = await endpoint.getReceiveLibrary(localApp, remoteEid);
      for (const [library, confirmations, name] of [
        [sendLibrary, policy.relayPolicy(chainId).confirmations, "send"],
        [receiveLibrary, policy.relayPolicy(remoteChainId).confirmations, "receive"],
      ]) {
        const config = ulnConfig(confirmations);
        if ((await endpoint.getConfig(localApp, library, remoteEid, 2)).toLowerCase() !== config.toLowerCase()) {
          await transact(endpoint, "setConfig", [localApp, library, [{ eid: remoteEid, configType: 2, config }]], `${name} ULN ${pair.launchDraftId}`);
        }
      }
      await transact(dvn, "setInboundPath", [remoteEid, ethers.zeroPadValue(remoteApp, 32), localApp, receiveLibrary,
        policy.relayPolicy(remoteChainId).confirmations, true], `inbound DVN ${pair.launchDraftId}`);
    }
    for (const [contract, label] of [[dvn, "DVN operator"], [executor, "executor operator"]]) {
      if ((await contract.operator()).toLowerCase() !== address.toLowerCase()) {
        await transact(contract, "setOperator", [address], label);
      }
    }
    if (write) {
      for (const contract of [dvn, executor]) {
        if ((await contract.operator()).toLowerCase() !== address.toLowerCase()) throw new Error("Operator handoff is incomplete.");
      }
      record.atomicRelayActivation = "active";
      fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    }
    console.log(JSON.stringify({ chainId, activationReady: true, activated: write, pairCount: pairs.length }));
  } finally { provider.destroy(); sourceProvider.destroy(); }
}
main().catch(error => { console.error("Atomic relay activation stopped:", error.shortMessage ?? error.message.split("\n")[0]); process.exitCode = 1; });
