const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  inspectStaticConfiguration,
  inspectNetwork,
  NETWORKS,
  ponsUpstreamSweepStatus,
} = require("../mainnet-readiness.cjs");

describe("mainnet readiness checks", () => {
  it("reports missing/invalid secrets without revealing their values", () => {
    const secretSentinel = "private-secret-must-not-be-printed";
    const checks = inspectStaticConfiguration({
      DEPLOYER_PRIVATE_KEY: secretSentinel,
      PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY: secretSentinel,
      PONS_FEE_PROCESSOR_PRIVATE_KEY: secretSentinel,
      WALLET_FNDN_KEY: secretSentinel,
    });
    const signer = checks.find((check) => check.id === "DEPLOYER_PRIVATE_KEY");
    const emergency = checks.find((check) => check.id === "PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY");
    const keeper = checks.find((check) => check.id === "PONS_FEE_PROCESSOR_PRIVATE_KEY");
    const foundation = checks.find((check) => check.id === "WALLET_FNDN_KEY");
    assert.equal(signer.status, "INVALID");
    assert.equal(emergency.status, "INVALID");
    assert.equal(keeper.status, "INVALID");
    assert.equal(foundation.status, "INVALID");
    assert.equal(JSON.stringify(checks).includes(secretSentinel), false);

    const validOwner = inspectStaticConfiguration({
      DEPLOYER_PRIVATE_KEY: `0x${"3".repeat(64)}`,
    });
    assert.equal(
      validOwner.find((check) => check.id === "DEPLOYER_PRIVATE_KEY").status,
      "CONFIGURED",
    );
    const validEmergency = inspectStaticConfiguration({
      PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY: `0x${"4".repeat(64)}`,
    });
    assert.equal(
      validEmergency.find((check) => check.id === "PLATFORM_EMERGENCY_OPERATOR_PRIVATE_KEY").status,
      "CONFIGURED",
    );
    const validKeeper = inspectStaticConfiguration({
      PONS_FEE_PROCESSOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    });
    assert.equal(
      validKeeper.find((check) => check.id === "PONS_FEE_PROCESSOR_PRIVATE_KEY").status,
      "CONFIGURED",
    );
    const validFoundation = inspectStaticConfiguration({
      WALLET_FNDN_KEY: `0x${"2".repeat(64)}`,
    });
    assert.equal(
      validFoundation.find((check) => check.id === "WALLET_FNDN_KEY").status,
      "CONFIGURED",
    );
  });

  it("rejects malformed deployment addresses and hashes", () => {
    const checks = inspectStaticConfiguration({
      DEPLOYER_PRIVATE_KEY: "not-a-private-key",
      ETHEREUM_CREATE2_DEPLOYER_ADDRESS: "not-an-address",
      ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH: "not-a-hash",
    });
    assert.equal(checks.find((check) => check.id === "DEPLOYER_PRIVATE_KEY").status, "INVALID");
    assert.equal(checks.find((check) => check.id === "ethereum:ETHEREUM_CREATE2_DEPLOYER_ADDRESS").status, "INVALID");
    assert.equal(checks.find((check) => check.id === "ethereum:ETHEREUM_CREATE2_DEPLOYER_RUNTIME_CODE_HASH").status, "INVALID");
  });

  it("does not require WebAuthn configuration for the password-based launch path", () => {
    const checks = inspectStaticConfiguration({});
    assert.equal(checks.some((check) => check.id === "PASSKEY_RP_ID" || check.id === "PASSKEY_RP_ID_HASH"), false);
  });

  it("validates the intended independent chain IDs", async () => {
    const wrongChain = await inspectNetwork(NETWORKS[0], {
      ALCHEMY_ETHEREUM_RPC_URL: "https://rpc.example",
    }, async (_url, method) => method === "eth_chainId" ? "0x1234" : "0x");
    assert.equal(wrongChain[0].status, "INVALID");

    const rightChain = await inspectNetwork(NETWORKS[1], {
      ALCHEMY_ROBINHOOD_RPC_URL: "https://rpc.example",
    }, async (_url, method) => method === "eth_chainId" ? "0x1237" : "0x");
    assert.equal(rightChain[0].status, "CONFIGURED");
  });

  it("keeps Pons upstream sweep authority separate from the Armoreum fee keeper", () => {
    assert.equal(
      ponsUpstreamSweepStatus("robinhood", "Robinhood Chain Mainnet", "0x0000000000000000000000000000000000000000").status,
      "MISSING",
    );
    assert.equal(
      ponsUpstreamSweepStatus("robinhood", "Robinhood Chain Mainnet", "0x1111111111111111111111111111111111111111").status,
      "CONFIGURED",
    );
  });

  it("probes Robinhood's required EVM opcodes rather than trusting a manual flag", async () => {
    const run = async (rejectMcopy) => inspectNetwork(NETWORKS[1], {
      ALCHEMY_ROBINHOOD_RPC_URL: "https://rpc.example",
    }, async (_url, method, params) => {
      if (method === "eth_chainId") return "0x1237";
      if (method === "eth_call" && rejectMcopy && params[0].data === "0x5f5f5f5e00") {
        throw new Error("mock unsupported opcode");
      }
      return "0x";
    });

    const supported = await run(false);
    assert.equal(
      supported.find((check) => check.id === "robinhood:cancun-opcodes").status,
      "CONFIGURED",
    );
    const unsupported = await run(true);
    const opcodeCheck = unsupported.find((check) => check.id === "robinhood:cancun-opcodes");
    assert.equal(opcodeCheck.status, "INVALID");
    assert.match(opcodeCheck.detail, /MCOPY/);
  });
});
