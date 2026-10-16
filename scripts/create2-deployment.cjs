function encodeCreate2Deployment(salt, initCode) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error("CREATE2 salt must be 32 bytes");
  }
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(initCode)) {
    throw new Error("CREATE2 init code must be non-empty bytecode");
  }
  return `${salt}${initCode.slice(2)}`;
}

module.exports = { encodeCreate2Deployment };
