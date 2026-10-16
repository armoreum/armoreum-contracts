// Explicitly authorized CAPITOL recovery. Keys stay in memory; the journal contains only public data.
const fs = require("node:fs");
const path = require("node:path");
const { AbiCoder, Contract, Interface, JsonRpcProvider, Wallet, ZeroAddress, ZeroHash, getAddress, keccak256 } = require("ethers");
const root = path.resolve(__dirname, "..");
const journalPath = path.join(root, "deployments/capitol-mainnet-reconciliation.json");
const launchId = "0x59200dff89d76f535bd8304bc9df2f5dc968a86c12b1934b5f811d0496b48c00";
const creator = getAddress("0xbc00883175c75a1ae393815abda6940df425c654");
const sourceHash = "0xa4fa23d3ec94244f14cbe8a1d23b331376a3a34e78b70322eaafc58cacdeea56";
const guid = "0x8448ab0a2060a689ee82cf17187fba5532752f71b957ac2cdc63fc09eb89ac6d";
const networks = [
  { chainId: 1, env: "ALCHEMY_ETHEREUM_RPC_URL", token: "0xc97770bfb8b478ae5a9f92ff3d020ff4a5548d1d", bridge: "0xc4f3fe37f36fe3a71a9aa1ac0107d672a8b22d7f", endpoint: "0x1a44076050125825900e736c501f859c50fe728c" },
  { chainId: 4663, env: "ALCHEMY_ROBINHOOD_RPC_URL", token: "0x917cdb4499c5c8e1c50f9bfed563c778ab87ef2b", bridge: "0x6a01f62cbc77538373f944c1d8ffa2de1a350c7c", endpoint: "0x6f475642a6e85809b1c36fa62763669b1b48dd5b" },
];
const apply = process.env.ARMOREUM_CAPITOL_REPAIR_BROADCAST === "YES";
if (apply && process.env.ARMOREUM_MAINNET_CONFIRMATION !== "Repair CAPITOL bridge and credit creator surplus on chains 1 and 4663") {
  throw Error("Explicit CAPITOL mainnet confirmation is required.");
}
const journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : {};
function save() {
  const tmp = `${journalPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, journalPath);
}
function report(value) { console.log(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v)); }
function assert(value, message) { if (!value) throw Error(message); }
function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }
async function fees(provider) {
  const [block, quote] = await Promise.all([provider.getBlock("latest"), provider.send("eth_gasPrice", [])]);
  assert(block?.baseFeePerGas > 0n, "Live base fee is unavailable.");
  const gasPrice = (block.baseFeePerGas * 120n + 99n) / 100n;
  assert(BigInt(quote) <= gasPrice, "RPC quote exceeds the live base fee plus 20%.");
  return gasPrice;
}
async function nonceReady(provider, wallet) {
  const [latest, pending] = await Promise.all(["latest", "pending"].map(tag => provider.send("eth_getTransactionCount", [wallet.address, tag])));
  assert(BigInt(latest) === BigInt(pending), "Signer has an unconfirmed transaction; no additional transaction submitted.");
}
async function submit(provider, wallet, key, request) {
  if (journal[key]?.hash) {
    const receipt = await provider.getTransactionReceipt(journal[key].hash);
    assert(receipt, "Journaled transaction is pending or broadcast-uncertain; not resubmitted.");
    assert(receipt.status === 1, "Journaled transaction failed; explicit reconciliation is required.");
    return receipt;
  }
  await nonceReady(provider, wallet);
  assert(await provider.getBalance(wallet.address) >= request.gasLimit * request.gasPrice + (request.value ?? 0n), "Signer cannot fund the transaction and its gas budget.");
  await provider.call({ ...request, from: wallet.address });
  const populated = await wallet.populateTransaction({ ...request, type: 0 });
  const signed = await wallet.signTransaction(populated);
  const hash = keccak256(signed);
  journal[key] = { hash, chainId: Number(populated.chainId), sender: wallet.address, target: populated.to, valueWei: String(populated.value ?? 0), status: "prepared" };
  save(); // Save expected hash BEFORE broadcasting; never auto-resend after an RPC error.
  const tx = await provider.broadcastTransaction(signed);
  assert(same(tx.hash, hash), "Unexpected broadcast transaction hash.");
  report({ stage: "submitted", operation: key, hash });
  const receipt = await tx.wait(2, 180000);
  assert(receipt?.status === 1, "Transaction has not confirmed successfully.");
  journal[key].status = "confirmed"; journal[key].block = receipt.blockNumber; save();
  return receipt;
}
async function commitPacket(ethereum, robinhood) {
  const sourceReceipt = await ethereum.getTransactionReceipt(sourceHash);
  const finalized = await ethereum.send("eth_getBlockByNumber", ["finalized", false]);
  assert(sourceReceipt?.status === 1 && Number(BigInt(finalized.number)) >= sourceReceipt.blockNumber, "Source transaction is not successful and finalized.");
  const packetAbi = new Interface(["event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)"]);
  const packet = sourceReceipt.logs.filter(log => same(log.address, networks[0].endpoint)).map(log => {
    try { return packetAbi.parseLog(log); } catch { return null; }
  }).find(log => log?.name === "PacketSent" && same(`0x${log.args.encodedPayload.slice(164, 228)}`, guid));
  assert(packet, "The expected LayerZero packet is missing from the source receipt.");
  const encoded = packet.args.encodedPayload.slice(2);
  const header = `0x${encoded.slice(0, 162)}`, payloadHash = keccak256(`0x${encoded.slice(162)}`);
  const sender = `0x${encoded.slice(26, 90)}`, receiver = getAddress(`0x${encoded.slice(122, 162)}`);
  const nonce = BigInt(`0x${encoded.slice(2, 18)}`);
  assert(Number.parseInt(encoded.slice(18, 26), 16) === 30101 && Number.parseInt(encoded.slice(90, 98), 16) === 30416, "Wrong LayerZero direction.");
  assert(same(sender, `0x${networks[0].bridge.slice(2).padStart(64, "0")}`) && same(receiver, networks[1].bridge), "Packet does not match the CAPITOL OApps.");
  const message = AbiCoder.defaultAbiCoder().decode(["bytes32","bytes32","address","address","address","address","uint256","uint64"], `0x${encoded.slice(226)}`);
  assert(same(message[1], launchId) && same(message[2], networks[0].token) && same(message[3], networks[1].token), "Packet does not match CAPITOL tokens.");
  const endpoint = new Contract(networks[1].endpoint, [
    "function getReceiveLibrary(address,uint32) view returns(address,bool)",
    "function inboundPayloadHash(address,uint32,bytes32,uint64) view returns(bytes32)",
  ], robinhood);
  const bridge = new Contract(receiver, ["function consumedTransferIds(bytes32) view returns(bool)"], robinhood);
  if (await bridge.consumedTransferIds(message[0])) { report({ operation: "bridge", status: "already-delivered" }); return; }
  const registered = await endpoint.inboundPayloadHash(receiver, 30101, sender, nonce);
  if (same(registered, payloadHash)) { report({ operation: "bridge", status: "already-committed" }); return; }
  assert(registered === ZeroHash, "Endpoint contains a different or nilified payload.");
  const receiveLibrary = (await endpoint.getReceiveLibrary(receiver, 30101))[0];
  const keeperMaterial = process.env.lz_robinhood?.trim();
  assert(/^(0x)?[0-9a-f]{64}$/i.test(keeperMaterial ?? ""), "Robinhood keeper signing material is unavailable.");
  const keeper = new Wallet(keeperMaterial.startsWith("0x") ? keeperMaterial : `0x${keeperMaterial}`, robinhood);
  const uln = new Contract(receiveLibrary, ["function commitVerification(bytes,bytes32)"], keeper);
  await uln.commitVerification.staticCall(header, payloadHash);
  const gasPrice = await fees(robinhood);
  const data = uln.interface.encodeFunctionData("commitVerification", [header, payloadHash]);
  const gasLimit = (await robinhood.estimateGas({ to: receiveLibrary, from: keeper.address, data, gasPrice })) * 120n / 100n + 1n;
  report({ operation: "bridge", chainId: 4663, status: "commit-simulation-passed", receiveLibrary, payloadHash, gasLimit, gasPrice });
  if (apply) {
    await submit(robinhood, keeper, "bridge-commit", { to: receiveLibrary, data, gasLimit, gasPrice });
    assert(same(await endpoint.inboundPayloadHash(receiver, 30101, sender, nonce), payloadHash) || await bridge.consumedTransferIds(message[0]), "Verification commit did not reach the endpoint.");
  }
}
async function creditSurplus(network, provider, privateKey) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, `deployments/${network.chainId}.json`), "utf8"));
  const factory = new Contract(manifest.multichainCore.factoryProxy, [
    "function rewardSystems(bytes32) view returns(address creator,address vault,address taxRouter,address taxSource,uint16 additionalTaxBps,uint256 implementationVersion,uint8 taxDistributionMode,address launchToken,address buybackExecutor,address bridgeVault)",
  ], provider);
  const system = await factory.rewardSystems(launchId);
  assert(same(system.creator, creator) && same(system.launchToken, network.token), "Factory does not match CAPITOL creator and token.");
  const wallet = new Wallet(privateKey, provider);
  assert(same(wallet.address, creator), "Creator signing material does not match CAPITOL.");
  const vault = new Contract(system.vault, [
    "function creator() view returns(address)", "function launchId() view returns(bytes32)",
    "function taxRouter() view returns(address)", "function depositCreatorSurplus() payable",
    "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)",
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ], wallet);
  assert(same(await vault.creator(), creator) && same(await vault.launchId(), launchId) && same(await vault.taxRouter(), system.taxRouter), "Creator Vault identity mismatch.");
  const key = `creator-surplus-${network.chainId}`;
  let receipt;
  if (journal[key]?.hash) {
    receipt = await provider.getTransactionReceipt(journal[key].hash);
    assert(receipt?.status === 1, "Existing surplus transaction is pending or failed; not repeated.");
  } else {
    await nonceReady(provider, wallet);
    const balance = await provider.getBalance(creator);
    const gasPrice = await fees(provider);
    const gasEstimate = await vault.depositCreatorSurplus.estimateGas({ value: 1n, gasPrice });
    const gasLimit = (gasEstimate * 130n + 99n) / 100n;
    const value = balance - gasLimit * gasPrice;
    assert(value > 0n, "Creator wallet cannot fund a surplus deposit after its gas budget.");
    await vault.depositCreatorSurplus.staticCall({ value, gasPrice, gasLimit });
    report({ operation: key, vault: system.vault, balanceWei: balance, creditWei: value, maximumGasWei: gasLimit * gasPrice, status: "surplus-simulation-passed" });
    if (!apply) return;
    receipt = await submit(provider, wallet, key, { to: system.vault, data: vault.interface.encodeFunctionData("depositCreatorSurplus"), value, gasLimit, gasPrice });
  }
  const tx = await provider.getTransaction(receipt.hash);
  assert(tx && same(tx.from, creator) && same(tx.to, system.vault) &&
    same(tx.data, vault.interface.encodeFunctionData("depositCreatorSurplus")), "Surplus transaction identity mismatch.");
  const minted = receipt.logs.filter(log => same(log.address, system.vault)).reduce((sum, log) => {
    let event; try { event = vault.interface.parseLog(log); } catch { return sum; }
    return event?.name === "Transfer" && same(event.args.from, ZeroAddress) && same(event.args.to, creator) ? sum + event.args.value : sum;
  }, 0n);
  assert(minted === tx.value && minted > 0n, "Confirmed deposit does not prove exactly matching JailETH issuance.");
  const blockTag = await provider.getBlockNumber();
  const [supply, backing, jailETH, remaining] = await Promise.all([vault.totalSupply({ blockTag }), provider.getBalance(system.vault, blockTag), vault.balanceOf(creator, { blockTag }), provider.getBalance(creator, blockTag)]);
  assert(supply <= backing, "Creator JailETH is not fully backed.");
  report({ operation: key, hash: receipt.hash, vault: system.vault, creditedWei: minted, creatorJailETHWei: jailETH, vaultBackingWei: backing, remainingGasDustWei: remaining, status: "verified" });
}
async function main() {
  const providers = networks.map(n => {
    const url = process.env[n.env];
    assert(url, "Required Alchemy RPC is unavailable.");
    const parsed = new URL(url);
    assert(parsed.protocol === "https:" && parsed.hostname.endsWith(".alchemy.com"), "Expected a private HTTPS Alchemy RPC.");
    return new JsonRpcProvider(url, n.chainId, { batchMaxCount: 1 });
  });
  try {
    await Promise.all(providers.map(async (p, i) => assert(Number(BigInt(await p.send("eth_chainId", []))) === networks[i].chainId, "Wrong Alchemy network.")));
    if (!process.argv.includes("--surplus-only")) await commitPacket(...providers);
    if (!process.argv.includes("--bridge-only")) {
      const response = await fetch(`https://armoreum.io/api/launches/${launchId}/creator-key`, { signal: AbortSignal.timeout(15000) });
      assert(response.ok, "Verified CAPITOL creator-key service is unavailable.");
      const material = await response.json();
      assert(/^0x[0-9a-f]{64}$/i.test(material.privateKey), "Creator signing material is unavailable.");
      for (let i = 0; i < networks.length; i++) await creditSurplus(networks[i], providers[i], material.privateKey);
    }
  } finally { await Promise.all(providers.map(p => p.destroy())); }
}
main().catch(error => {
  const message = String(error.shortMessage || error.message || "Mainnet reconciliation failed").replace(/https?:\/\/[^\s"'\\]+/g, "[RPC URL redacted]").replace(/0x[0-9a-f]{64}/gi, "[redacted hash]");
  console.error(JSON.stringify({ error: message, broadcastEnabled: apply }));
  process.exitCode = 1;
});
