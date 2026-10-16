const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");

const PONS_V2_MAINNET = {
  hook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  hookRuntimeHash: "0xc21b1e6c1b45403e81a581f22ed6d9c747997af1cfdac1b1dc9f4b1d346a10db",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  feeEscrowRuntimeHash: "0xf25f75cfbc1637ba068dc34f69098fa4e8a80f8ee8fe7bf7820594e0b3fed2f1",
};

const PONS_HOOK_INTERFACE = new ethers.Interface([
  "function feeEscrow() view returns (address)",
  "function feeSweepOperator() view returns (address)",
]);
const PONS_ESCROW_INTERFACE = new ethers.Interface([
  "function balanceOf(address recipient) view returns (uint256)",
]);

const ROBINHOOD_EVM_PROBES = [
  { label: "PUSH0", data: "0x5f60005260206000f3" },
  { label: "MCOPY", data: "0x5f5f5f5e00" },
  { label: "TSTORE", data: "0x5f5f5d00" },
];

const NETWORKS = [
  {
    id: "ethereum",
    label: "Ethereum Mainnet",
    chainId: 1n,
    rpcKey: "ALCHEMY_ETHEREUM_RPC_URL",
    create2AddressKey: "ETHEREUM_CREATE2_DEPLOYER_ADDRESS",
    create2HashKey: "ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH",
    verifiedContracts: [
      {
        label: "Uniswap V4 PoolManager",
        address: "0x000000000004444c5dc75cB358380D2e3dE08A90",
        source: "https://developers.uniswap.org/docs/protocols/v4/deployments",
      },
    ],
    protocol: [],
  },
  {
    id: "robinhood",
    label: "Robinhood Chain Mainnet",
    chainId: 4663n,
    rpcKey: "ALCHEMY_ROBINHOOD_RPC_URL",
    create2AddressKey: "CREATE2_DEPLOYER_ADDRESS",
    create2HashKey: "CREATE2_DEPLOYER_RUNTIME_CODE_HASH",
    verifiedContracts: [
      {
        label: "Uniswap V4 PoolManager",
        address: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
        source: "https://developers.uniswap.org/docs/protocols/v4/deployments",
      },
    ],
    protocol: [
      {
        label: "Pons V2 tax-routing hook",
        key: "PONS_TAX_ROUTING_SOURCE_ADDRESS",
        kind: "ponsFeeRoute",
        expectedAddress: PONS_V2_MAINNET.hook,
      },
    ],
  },
];

function status(id, name, state, detail, envKey) {
  return { id, name, status: state, ...(envKey ? { env: envKey } : {}), detail };
}

function parseAddress(value) {
  return typeof value === "string" && ethers.isAddress(value) && value !== ethers.ZeroAddress
    ? ethers.getAddress(value)
    : null;
}

function isHash(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function sendJsonRpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("RPC request failed");
  const payload = await response.json();
  if (payload.error || !Object.hasOwn(payload, "result")) throw new Error("RPC response invalid");
  return payload.result;
}

function inspectStaticConfiguration(env = process.env) {
  const items = [];
  const walletFromKey = (raw) => {
    if (!raw || !/^0x[0-9a-fA-F]{64}$/.test(raw)) return null;
    try {
      return new ethers.Wallet(raw);
    } catch {
      return null;
    }
  };
  const ownerKey = env.DEPLOYER_PRIVATE_KEY;
  const ownerWallet = walletFromKey(ownerKey);
  items.push(!ownerKey
    ? status("DEPLOYER_PRIVATE_KEY", "Canonical platform owner and deployment signer", "MISSING", "Add the funded owner/deployment signer through your secret manager; it receives the configured administrator and upgrade roles.", "DEPLOYER_PRIVATE_KEY")
    : ownerWallet
      ? status("DEPLOYER_PRIVATE_KEY", "Canonical platform owner and deployment signer", "CONFIGURED", "Key format is valid; its derived address is used as the owner without exposing the key.", "DEPLOYER_PRIVATE_KEY")
      : status("DEPLOYER_PRIVATE_KEY", "Canonical platform owner and deployment signer", "INVALID", "Expected a 32-byte 0x-prefixed private key. The value is never logged.", "DEPLOYER_PRIVATE_KEY"));

  const emergencyKey = env.PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY;
  const emergencyWallet = walletFromKey(emergencyKey);
  items.push(!emergencyKey
    ? status("PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY", "Emergency operator signer", "MISSING", "Add a separate emergency-operator signer through your secret manager.", "PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY")
    : emergencyWallet
      ? status("PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY", "Emergency operator signer", "CONFIGURED", "Key format is valid; the signer is assigned only the emergency authority configured by the contracts.", "PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY")
      : status("PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY", "Emergency operator signer", "INVALID", "Expected a 32-byte 0x-prefixed private key. The value is never logged.", "PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY"));
  items.push(ownerWallet && emergencyWallet
    ? ownerWallet.address.toLowerCase() !== emergencyWallet.address.toLowerCase()
      ? status("owner-operator-separation", "Owner and emergency key separation", "CONFIGURED", "Owner and emergency operator derive to distinct addresses.")
      : status("owner-operator-separation", "Owner and emergency key separation", "INVALID", "Owner and emergency operator must use separate keys.")
    : status("owner-operator-separation", "Owner and emergency key separation", "MISSING", "Both signer keys are required to verify that the roles are distinct."));

  const ponsFeeProcessorKey = env.PONS_FEE_PROCESSOR_PRIVATE_KEY;
  let ponsFeeProcessorWallet = null;
  try {
    if (
      ponsFeeProcessorKey &&
      /^0x[0-9a-fA-F]{64}$/.test(ponsFeeProcessorKey)
    ) {
      ponsFeeProcessorWallet = new ethers.Wallet(ponsFeeProcessorKey);
    }
  } catch {
    ponsFeeProcessorWallet = null;
  }
  items.push(!ponsFeeProcessorKey
    ? status(
      "PONS_FEE_PROCESSOR_PRIVATE_KEY",
      "Pons fee keeper signer",
      "MISSING",
      "Add a dedicated keeper signing key through your secret manager; never use a creator or deployment signer.",
      "PONS_FEE_PROCESSOR_PRIVATE_KEY",
    )
    : ponsFeeProcessorWallet
      ? status(
        "PONS_FEE_PROCESSOR_PRIVATE_KEY",
        "Pons fee keeper signer",
        "CONFIGURED",
        "Key format is valid; its derived address must match the deployed factory processor.",
        "PONS_FEE_PROCESSOR_PRIVATE_KEY",
      )
      : status(
        "PONS_FEE_PROCESSOR_PRIVATE_KEY",
        "Pons fee keeper signer",
        "INVALID",
        "Expected a 32-byte hexadecimal signing key. The value is never returned by this check.",
        "PONS_FEE_PROCESSOR_PRIVATE_KEY",
      ));

  const foundationKey = env.WALLET_FNDN_KEY;
  let foundationWallet = null;
  try {
    if (foundationKey && /^0x[0-9a-fA-F]{64}$/.test(foundationKey)) {
      foundationWallet = new ethers.Wallet(foundationKey);
    }
  } catch {
    foundationWallet = null;
  }
  items.push(!foundationKey
    ? status(
      "WALLET_FNDN_KEY",
      "Foundation tax recipient signer",
      "MISSING",
      "Add the foundation signer through your secret manager; its address is derived for deployment.",
      "WALLET_FNDN_KEY",
    )
    : foundationWallet
      ? status(
        "WALLET_FNDN_KEY",
        "Foundation tax recipient signer",
        "CONFIGURED",
        "Key format is valid; its address is derived for base-tax routing without logging the key.",
        "WALLET_FNDN_KEY",
      )
      : status(
        "WALLET_FNDN_KEY",
        "Foundation tax recipient signer",
        "INVALID",
        "Expected a 32-byte hexadecimal signing key. The value is never returned by this check.",
        "WALLET_FNDN_KEY",
      ));

  items.push(status("upgrade-admin", "Separate upgrade administrator", "NOT APPLICABLE",
    "Current ArmoreumFactory initialization assigns UPGRADER_ROLE to the canonical platform owner; a separate upgrade admin requires a contract change."));

  for (const network of NETWORKS) {
    for (const [key, label, validator] of [
      [network.create2AddressKey, "CREATE2 deployer address", parseAddress],
      [network.create2HashKey, "CREATE2 deployer runtime hash", isHash],
    ]) {
      const value = env[key];
      items.push(!value
        ? status(`${network.id}:${key}`, `${network.label}: ${label}`, "MISSING", `Set ${key} from the verified CREATE2 deployment source.`, key)
        : validator(value)
          ? status(`${network.id}:${key}`, `${network.label}: ${label}`, "CONFIGURED", "Format is valid; live bytecode and runtime hash are checked separately.", key)
          : status(`${network.id}:${key}`, `${network.label}: ${label}`, "INVALID", `${key} has an invalid format.`, key));
    }

    const rpc = env[network.rpcKey];
    let url;
    try {
      if (rpc) url = new URL(rpc);
    } catch {
      url = null;
    }
    const rpcProblem = !rpc
      ? "missing"
      : !url
        ? "invalid URL format"
        : url.protocol !== "https:"
          ? "must use HTTPS"
          : !url.hostname
            ? "must include a host"
            : (url.username || url.password)
              ? "must not embed username/password credentials"
              : "";
    items.push(!rpc
      ? status(`${network.id}:rpc`, `${network.label}: RPC`, "MISSING", `Add ${network.rpcKey} through your secret manager.`, network.rpcKey)
      : !rpcProblem
        ? status(`${network.id}:rpc`, `${network.label}: RPC`, "CONFIGURED", "URL format is valid; chain connectivity is checked separately.", network.rpcKey)
        : status(`${network.id}:rpc`, `${network.label}: RPC`, "INVALID", `${network.rpcKey} ${rpcProblem}.`, network.rpcKey));

    for (const { label, key, kind } of network.protocol) {
      const value = env[key];
      const valid = kind === "hash" ? isHash(value) : !!parseAddress(value);
      items.push(!value
        ? status(`${network.id}:${key}`, `${network.label}: ${label}`, "MISSING", `Required before activating this integration; set ${key} only from a verified source.`, key)
        : valid
          ? status(`${network.id}:${key}`, `${network.label}: ${label}`, "CONFIGURED", "Format is valid; live code, protocol identity, permissions, and configuration are checked separately.", key)
          : status(`${network.id}:${key}`, `${network.label}: ${label}`, "INVALID", kind === "hash" ? `${key} must be a 32-byte hex value.` : `${key} must be a non-zero EVM address.`, key));
    }
  }

  items.push(status("external-explorer-keys", "Explorer API credentials", "NOT APPLICABLE", "They are optional for deployment; they become relevant only if automated source verification is configured."));
  items.push(status("bridge-per-launch", "Bridge peers and token mappings", "NOT APPLICABLE", "These are per-launch configuration, not global deployment inputs; do not enable a bridge until both peers and token mappings are verified."));
  for (const source of ["VaultFactory.sol", "JailSwapVault.sol"]) {
    const file = path.join(__dirname, "..", "contracts", source);
    items.push(fs.existsSync(file)
      ? status(`contract:${source}`, `${source} implementation`, "UNVERIFIED ON-CHAIN", "Source exists; compilation, proxy safety, launch wiring, and deployment configuration still need verification.")
      : status(`contract:${source}`, `${source} implementation`, "MISSING", "Required implementation is not present in the contract source tree."));
  }
  for (const [script, label] of [
    ["deploy.cjs", "Ethereum and Robinhood deployment entry point"],
  ]) {
    items.push(fs.existsSync(path.join(__dirname, script))
      ? status(`script:${script}`, label, "UNVERIFIED ON-CHAIN", "Script exists; it still requires deployment-script tests, resume reconciliation, and live preflight.")
      : status(`script:${script}`, label, "MISSING", "No deployment entry point exists."));
  }

  return items;
}

async function inspectNetwork(network, env = process.env, rpcCall = sendJsonRpc) {
  const rpc = env[network.rpcKey];
  if (!rpc) return [status(`${network.id}:chain-id`, `${network.label}: live chain ID`, "MISSING", `No ${network.rpcKey} configured.`, network.rpcKey)];
  try {
    const request = (method, params) => rpcCall(rpc, method, params);
    const actual = await request("eth_chainId", []);
    const chainId = BigInt(actual);
    if (chainId !== network.chainId) {
      return [status(`${network.id}:chain-id`, `${network.label}: live chain ID`, "INVALID", `RPC reports chain ID ${chainId}; expected ${network.chainId}.`)];
    }

    const items = [status(`${network.id}:chain-id`, `${network.label}: live chain ID`, "CONFIGURED", `RPC confirms chain ID ${network.chainId}.`)];
    if (network.id === "robinhood") {
      const unsupported = [];
      for (const probe of ROBINHOOD_EVM_PROBES) {
        try {
          await request("eth_call", [{ data: probe.data }, "latest"]);
        } catch {
          unsupported.push(probe.label);
        }
      }
      items.push(unsupported.length
        ? status("robinhood:cancun-opcodes", "Robinhood EVM instructions required by the build", "INVALID", `Unsupported instruction probe(s): ${unsupported.join(", ")}.`)
        : status("robinhood:cancun-opcodes", "Robinhood EVM instructions required by the build", "CONFIGURED", "Read-only probes confirmed PUSH0, MCOPY, and TSTORE; BLOBBASEFEE is not required by this build."));
    }

    const create2Address = parseAddress(env[network.create2AddressKey]);
    const expectedHash = env[network.create2HashKey];
    if (create2Address && isHash(expectedHash)) {
      const code = await request("eth_getCode", [create2Address, "latest"]);
      if (code === "0x") {
        items.push(status(`${network.id}:create2-code`, `${network.label}: CREATE2 deployer code`, "INVALID", "Configured address has no deployed bytecode."));
      } else if (ethers.keccak256(code).toLowerCase() !== expectedHash.toLowerCase()) {
        items.push(status(`${network.id}:create2-code`, `${network.label}: CREATE2 deployer code`, "INVALID", "On-chain runtime hash does not match the configured verified hash."));
      } else {
        items.push(status(`${network.id}:create2-code`, `${network.label}: CREATE2 deployer code`, "CONFIGURED", "Runtime bytecode matches the configured hash."));
      }
    } else {
      items.push(status(`${network.id}:create2-code`, `${network.label}: CREATE2 deployer code`, "UNVERIFIED ON-CHAIN", "Address and expected runtime hash are both required to verify."));
    }

    for (const { label, key, kind } of network.protocol) {
      if (kind === "hash" || !parseAddress(env[key])) continue;
      if (kind === "ponsFeeRoute") {
        const source = parseAddress(env[key]);
        if (source.toLowerCase() !== parseAddress(PONS_V2_MAINNET.hook).toLowerCase()) {
          items.push(status(`${network.id}:${key}:identity`, `${network.label}: ${label} identity`, "INVALID", "Configured hook does not match the verified Pons V2 mainnet deployment."));
          continue;
        }
        const hookCode = await request("eth_getCode", [source, "latest"]);
        if (hookCode === "0x" || ethers.keccak256(hookCode).toLowerCase() !== PONS_V2_MAINNET.hookRuntimeHash.toLowerCase()) {
          items.push(status(`${network.id}:${key}:code`, `${network.label}: ${label} bytecode`, "INVALID", "Hook bytecode does not match the verified Pons V2 runtime."));
          continue;
        }
        const hookCall = (name) => PONS_HOOK_INTERFACE.encodeFunctionData(name);
        const escrowResult = await request("eth_call", [{ to: source, data: hookCall("feeEscrow") }, "latest"]);
        const escrow = ethers.getAddress(PONS_HOOK_INTERFACE.decodeFunctionResult("feeEscrow", escrowResult)[0]);
        const operatorResult = await request("eth_call", [{ to: source, data: hookCall("feeSweepOperator") }, "latest"]);
        const operator = ethers.getAddress(PONS_HOOK_INTERFACE.decodeFunctionResult("feeSweepOperator", operatorResult)[0]);
        if (escrow.toLowerCase() !== PONS_V2_MAINNET.feeEscrow.toLowerCase()) {
          items.push(status(`${network.id}:${key}:escrow`, `${network.label}: Pons fee escrow`, "INVALID", "Hook getter returned an escrow address that does not match the verified Pons deployment."));
          continue;
        }
        const escrowCode = await request("eth_getCode", [escrow, "latest"]);
        if (escrowCode === "0x" || ethers.keccak256(escrowCode).toLowerCase() !== PONS_V2_MAINNET.feeEscrowRuntimeHash.toLowerCase()) {
          items.push(status(`${network.id}:${key}:escrow-code`, `${network.label}: Pons fee escrow bytecode`, "INVALID", "Escrow bytecode does not match the verified Pons V2 runtime."));
          continue;
        }
        const balanceCall = PONS_ESCROW_INTERFACE.encodeFunctionData("balanceOf", [ethers.ZeroAddress]);
        const balanceResult = await request("eth_call", [{ to: escrow, data: balanceCall }, "latest"]);
        PONS_ESCROW_INTERFACE.decodeFunctionResult("balanceOf", balanceResult);
        items.push(status(`${network.id}:${key}:route`, `${network.label}: Pons fee-recipient route`, "CONFIGURED", "Verified hook bytecode returns the verified escrow, whose recipient balance getter responds."));

        items.push(ponsUpstreamSweepStatus(network.id, network.label, operator));
        continue;
      }
      const code = await request("eth_getCode", [env[key], "latest"]);
      items.push(code === "0x"
        ? status(`${network.id}:${key}:code`, `${network.label}: ${label} code`, "INVALID", "Configured address has no deployed bytecode.")
        : status(`${network.id}:${key}:code`, `${network.label}: ${label} code`, "UNVERIFIED ON-CHAIN", "Bytecode exists, but protocol identity, source, ABI compatibility, permissions, and route configuration still need verification."));
    }

    for (const external of network.verifiedContracts) {
      const code = await request("eth_getCode", [external.address, "latest"]);
      items.push(code === "0x"
        ? status(`${network.id}:official:${external.label}`, `${network.label}: ${external.label}`, "INVALID", `Official deployment map lists the address but RPC reports no bytecode; source: ${external.source}`)
        : status(`${network.id}:official:${external.label}`, `${network.label}: ${external.label}`, "CONFIGURED", `Official deployment map and on-chain bytecode are present; Armoreum hook, pool and liquidity configuration remain separate. Source: ${external.source}`));
    }

    const wallet = env.DEPLOYER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_PRIVATE_KEY)
      ? new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY)
      : null;
    if (wallet) {
      const balance = BigInt(await request("eth_getBalance", [wallet.address, "latest"]));
      items.push(balance > 0n
        ? status(`${network.id}:deployer-balance`, `${network.label}: deployer gas balance`, "CONFIGURED", "Signer has a non-zero native balance; transaction-specific gas sufficiency remains to be simulated.")
        : status(`${network.id}:deployer-balance`, `${network.label}: deployer gas balance`, "INVALID", "Deployment signer has zero native balance."));
    } else {
      items.push(status(`${network.id}:deployer-balance`, `${network.label}: owner/deployer gas balance`, "MISSING", "A valid owner/deployment signer is required to check gas funding.", "DEPLOYER_PRIVATE_KEY"));
    }
    return items;
  } catch {
    return [status(`${network.id}:chain-id`, `${network.label}: live chain ID`, "INVALID", "Could not query the RPC or decode its chain ID; endpoint details were suppressed.")];
  }
}

function ponsUpstreamSweepStatus(networkId, networkLabel, operator) {
  if (!ethers.isAddress(operator) || operator === ethers.ZeroAddress) {
    return status(
      `${networkId}:pons-upstream-sweep-operator`,
      `${networkLabel}: Pons upstream sweep operator`,
      "MISSING",
      "Pons has no non-zero upstream sweep operator configured; creator sweep remains possible only where Pons permits it without internal conversion or buyback.",
    );
  }
  return status(
    `${networkId}:pons-upstream-sweep-operator`,
    `${networkLabel}: Pons upstream sweep operator`,
    "CONFIGURED",
    "Pons has a separate upstream sweep operator configured. It does not need to match the Armoreum keeper, which claims the TaxRouter's credited escrow balance.",
  );
}

async function main() {
  const all = inspectStaticConfiguration();
  for (const network of NETWORKS) all.push(...await inspectNetwork(network));
  process.stdout.write(`${JSON.stringify({ generatedAt: new Date().toISOString(), networks: NETWORKS.map(({ id, label, chainId }) => ({ id, label, chainId: chainId.toString() })), checks: all }, null, 2)}\n`);
  const blockers = all.filter((item) => item.status === "MISSING" || item.status === "INVALID" || item.status === "UNVERIFIED ON-CHAIN");
  if (blockers.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write("Readiness check failed; sensitive provider details were suppressed.\n");
    process.exitCode = 1;
  });
}

module.exports = { NETWORKS, inspectStaticConfiguration, inspectNetwork, ponsUpstreamSweepStatus };
