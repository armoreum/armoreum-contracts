const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { encodeCreate2Deployment } = require("../create2-deployment.cjs");

describe("CREATE2 deployment calldata", () => {
  it("uses the raw salt || initCode format required by the verified 0x4e59 deployer", () => {
    const salt = `0x${"ab".repeat(32)}`;
    const initCode = "0x60006000f3";
    const data = encodeCreate2Deployment(salt, initCode);
    assert.equal(data, `${salt}${initCode.slice(2)}`);
    assert.equal(data.slice(0, 66), salt);
    assert.equal(data.slice(66), initCode.slice(2));
  });

  it("rejects malformed salts and empty init code", () => {
    assert.throws(() => encodeCreate2Deployment("0x1234", "0x6000"), /salt must be 32 bytes/);
    assert.throws(() => encodeCreate2Deployment(`0x${"12".repeat(32)}`, "0x"), /init code must be non-empty/);
  });
});
