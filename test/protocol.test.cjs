const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { ethers, network, upgrades } = require("hardhat");

const coder = ethers.AbiCoder.defaultAbiCoder();
const RP_ID = "armoreum.io";
const RP_ID_HASH = `0x${createHash("sha256").update(RP_ID).digest("hex")}`;
const PASSKEY_X = ethers.zeroPadValue("0x01", 32);
const PASSKEY_Y = ethers.zeroPadValue("0x02", 32);
const CREDENTIAL_HASH = ethers.id("test-credential");

function proofFor(digest) {
  return coder.encode(["bytes32"], [digest]);
}

async function requestUnjailETH(vault, signer, amount, recipient, deadline) {
  const digest = await vault.unjailRequestAuthorizationDigest(
    amount,
    recipient,
    deadline,
  );
  return vault
    .connect(signer)
    .requestUnjailETH(amount, recipient, deadline, proofFor(digest));
}

const AUTH_PURPOSES = ["claim", "redemption", "rotation", "recovery"];
const AUTH_DOMAIN_PREFIX =
  "0x42756c6c657470726f6f662f496e646570656e64656e74417574686f72697a6174696f6e2f7631";
const AUTH_LEAF_DOMAIN = ethers.sha256(
  ethers.concat([AUTH_DOMAIN_PREFIX, ethers.toUtf8Bytes("/epoch-leaf/")]),
);

function hashChain(seed, count) {
  let value = seed;
  for (let index = 0; index < count; index += 1) value = ethers.sha256(value);
  return value;
}

function sortedHashPair(left, right) {
  return left.toLowerCase() < right.toLowerCase()
    ? ethers.sha256(ethers.concat([left, right]))
    : ethers.sha256(ethers.concat([right, left]));
}

async function authorizationTree(launchId, vault, creator, proofCount = 256) {
  const { chainId } = await ethers.provider.getNetwork();
  const seeds = {
    claim: ethers.id(`claim-seed-${launchId}`),
    redemption: ethers.id(`redemption-seed-${launchId}`),
    rotation: ethers.id(`rotation-seed-${launchId}`),
    recovery: ethers.id(`recovery-seed-${launchId}`),
  };
  const epochs = [];
  const leaves = [];

  for (let epoch = 1; epoch <= 64; epoch += 1) {
    const commitments = {};
    for (const purpose of AUTH_PURPOSES) {
      commitments[purpose] =
        epoch === 1 && seeds[purpose]
          ? hashChain(seeds[purpose], proofCount)
          : ethers.id(`${purpose}-${epoch}-${launchId}`);
    }
    epochs.push({ commitments, merkleProof: [] });
    leaves.push(
      ethers.sha256(
        ethers.solidityPacked(
          [
            "bytes32",
            "uint256",
            "address",
            "address",
            "bytes32",
            "uint32",
            "bytes32",
            "bytes32",
            "bytes32",
            "bytes32",
          ],
          [
            AUTH_LEAF_DOMAIN,
            chainId,
            vault,
            creator,
            launchId,
            epoch,
            commitments.claim,
            commitments.redemption,
            commitments.rotation,
            commitments.recovery,
          ],
        ),
      ),
    );
  }

  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const current = layers.at(-1);
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(sortedHashPair(current[index], current[index + 1]));
    }
    layers.push(next);
  }
  for (let epochIndex = 0; epochIndex < epochs.length; epochIndex += 1) {
    let index = epochIndex;
    for (const layer of layers.slice(0, -1)) {
      epochs[epochIndex].merkleProof.push(layer[index ^ 1]);
      index = Math.floor(index / 2);
    }
  }
  return {
    root: layers.at(-1)[0],
    epochs,
    seeds,
  };
}

async function vanitySalt(deployer, initCodeHash, startCounter = 1n) {
  for (let counter = startCounter; counter < 2_000_000n; counter += 1n) {
    const salt = ethers.toBeHex(counter, 32);
    const predicted = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (predicted.toLowerCase().startsWith("0x6900")) return { salt, predicted };
  }
  throw new Error("Test CREATE2 vanity search exceeded its limit");
}

const vanitySaltSearchStarts = new Map();

async function deployVanity(helper, initCode) {
  const deployer = await helper.getAddress();
  const initCodeHash = ethers.keccak256(initCode);
  const startCounter = vanitySaltSearchStarts.get(initCodeHash) ?? 1n;
  const { salt, predicted } = await vanitySalt(
    deployer,
    initCodeHash,
    startCounter,
  );
  vanitySaltSearchStarts.set(initCodeHash, BigInt(salt) + 1n);
  const tx = await helper.deploy(salt, initCode);
  await tx.wait();
  const deployed = await ethers.provider.getCode(predicted);
  assert.notEqual(deployed, "0x", `expected code at ${predicted}`);
  assert.ok(predicted.toLowerCase().startsWith("0x6900"));
  return predicted;
}

async function initCodeFor(factory) {
  const contract = await ethers.getContractFactory(factory);
  return contract.bytecode;
}

async function deployTestContract(_helper, contractName, ...args) {
  const factory = await ethers.getContractFactory(contractName);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function deployHookWithPermissions(helper, contractName, ...args) {
  const factory = await ethers.getContractFactory(contractName);
  const initCode = ethers.concat([
    factory.bytecode,
    factory.interface.encodeDeploy(args),
  ]);
  const initCodeHash = ethers.keccak256(initCode);
  const deployer = await helper.getAddress();
  const requiredPermissionBits = 0x20ccn;
  let salt;
  let predicted;

  for (let counter = 1n; counter < 2_000_000n; counter += 1n) {
    const candidateSalt = ethers.toBeHex(counter, 32);
    const candidateAddress = ethers.getCreate2Address(
      deployer,
      candidateSalt,
      initCodeHash,
    );
    if ((BigInt(candidateAddress) & 0x3fffn) === requiredPermissionBits) {
      salt = candidateSalt;
      predicted = candidateAddress;
      break;
    }
  }
  if (!salt || !predicted) {
    throw new Error("Uniswap V4 hook permission salt search exceeded its limit");
  }

  await (await helper.deploy(salt, initCode)).wait();
  assert.notEqual(await ethers.provider.getCode(predicted), "0x");
  assert.equal(BigInt(predicted) & 0x3fffn, requiredPermissionBits);
  return ethers.getContractAt(contractName, predicted);
}

describe("Armoreum contracts", function () {
  this.timeout(180_000);

  let helper;
  let factory;
  let factoryAddress;
  let vaultRegistry;
  let source;
  let ponsEscrow;
  let owner;
  let ownerSigner;
  let verifier;
  let vaultImplementation;
  let routerImplementation;
  let mockVerifier;
  let creators;
  let launchToken;

  before(async function () {
    helper = await (await ethers.getContractFactory("TestCreate2Deployer")).deploy();
    await helper.waitForDeployment();
    source = await (await ethers.getContractFactory("MockTaxSource")).deploy();
    await source.waitForDeployment();
    ponsEscrow = await (
      await ethers.getContractFactory("MockPonsV2FeeEscrow")
    ).deploy();
    await ponsEscrow.waitForDeployment();
    await (
      await source.setFeeEscrow(await ponsEscrow.getAddress())
    ).wait();

    creators = await ethers.getSigners();
    ownerSigner = creators[0];
    owner = ownerSigner.address;
    launchToken = await (
      await ethers.getContractFactory("MockLaunchToken")
    ).deploy(owner, ethers.parseEther("1000000"));
    await launchToken.waitForDeployment();

    const mockVerifierInitCode = await initCodeFor("MockPasskeyVerifier");
    const mockVerifierAddress = await deployVanity(helper, mockVerifierInitCode);
    mockVerifier = await ethers.getContractAt("MockPasskeyVerifier", mockVerifierAddress);

    const vaultInitCode = await initCodeFor("CreatorRewardVault");
    vaultImplementation = await deployVanity(helper, vaultInitCode);
    const routerInitCode = await initCodeFor("TaxRouter");
    routerImplementation = await deployVanity(helper, routerInitCode);
    const factoryInitCode = await initCodeFor("ArmoreumFactory");
    const factoryImplementation = await deployVanity(helper, factoryInitCode);

    const factoryContract = await ethers.getContractFactory("ArmoreumFactory");
    const initialization = factoryContract.interface.encodeFunctionData("initializeWithEmergencyOperator", [
      owner,
      mockVerifierAddress,
      RP_ID_HASH,
      vaultImplementation,
      routerImplementation,
      await source.getAddress(),
      1,
      creators[6].address,
      creators[1].address,
      creators[1].address,
    ]);
    const proxyInitCode = await helper.proxyInitCode(factoryImplementation, initialization);
    factoryAddress = await deployVanity(helper, proxyInitCode);
    factory = await ethers.getContractAt(
      "ArmoreumFactory",
      factoryAddress,
      ownerSigner,
    );
    assert.equal(await factory.canonicalOwner(), owner);
    assert.equal(await factory.platformTreasury(), owner);
    assert.equal(await factory.foundationRecipient(), creators[6].address);
    assert.equal(await factory.instanceEmergencyWithdrawer(), creators[1].address);
    assert.equal(await factory.vaultImplementation(), vaultImplementation);
    assert.equal(await factory.taxRouterImplementation(), routerImplementation);
    assert.equal(await factory.passkeyVerifier(), mockVerifierAddress);
    assert.equal(await factory.hasRole(ethers.ZeroHash, owner), true);
    assert.equal(
      await factory.hasRole(await factory.UPGRADER_ROLE(), owner),
      true,
    );
  });

  async function deployRewardSystem(
    creator,
    additionalTaxBps = 350,
    label = "launch",
    taxConfig = {},
  ) {
    const config = {
      launchId: ethers.id(`${label}-${creator.address}-${additionalTaxBps}`),
      quoteAsset: ethers.ZeroAddress,
      taxSource: await source.getAddress(),
      passkeyX: PASSKEY_X,
      passkeyY: PASSKEY_Y,
      credentialIdHash: CREDENTIAL_HASH,
      additionalTaxBps,
      authorizationEpochRoot: ethers.ZeroHash,
      claimCommitment: ethers.ZeroHash,
      redemptionCommitment: ethers.ZeroHash,
      rotationCommitment: ethers.ZeroHash,
      recoveryCommitment: ethers.ZeroHash,
      taxDistributionMode: 0,
      launchToken: await launchToken.getAddress(),
      buybackExecutor: ethers.ZeroAddress,
      bridgeVault: ethers.ZeroAddress,
      ...taxConfig,
    };
    const vaultSalt = ethers.id(`vault:${config.launchId}`);
    const vaultAddress = await factory.predictVaultProxyAddress(
      config,
      creator.address,
      vaultSalt,
    );
    const authorization = await authorizationTree(
      config.launchId,
      vaultAddress,
      creator.address,
    );
    const initial = authorization.epochs[0];
    config.authorizationEpochRoot = authorization.root;
    config.claimCommitment = initial.commitments.claim;
    config.redemptionCommitment = initial.commitments.redemption;
    config.rotationCommitment = initial.commitments.rotation;
    config.recoveryCommitment = initial.commitments.recovery;
    const routerSalt = ethers.id(`router:${config.launchId}`);
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const enrollment = await factory.enrollmentDigest(
      config,
      creator.address,
      deadline,
      vaultSalt,
      routerSalt,
    );
    await assert.rejects(
      factory.connect(creator).createRewardSystem(
        config,
        deadline,
        proofFor(ethers.id("invalid-enrollment")),
        vaultSalt,
        routerSalt,
        initial.merkleProof,
      ),
      /InvalidPasskey/,
    );
    const tx = await factory.connect(creator).createRewardSystem(
      config,
      deadline,
      proofFor(enrollment),
      vaultSalt,
      routerSalt,
      initial.merkleProof,
    );
    await tx.wait();
    const system = await factory.rewardSystems(config.launchId);
    assert.equal(system.vault.toLowerCase(), vaultAddress.toLowerCase());
    return {
      creator,
      config,
      launchId: config.launchId,
      deadline,
      authorization,
      vault: await ethers.getContractAt("CreatorRewardVault", system.vault),
      router: await ethers.getContractAt("TaxRouter", system.taxRouter),
    };
  }

  async function deployPasswordRewardSystem(creator, label = "password-launch") {
    const passwordSigner = ethers.Wallet.createRandom();
    const config = {
      launchId: ethers.id(`${label}-${creator.address}`),
      quoteAsset: ethers.ZeroAddress,
      taxSource: await source.getAddress(),
      passkeyX: ethers.ZeroHash,
      passkeyY: ethers.ZeroHash,
      credentialIdHash: ethers.ZeroHash,
      additionalTaxBps: 100,
      authorizationEpochRoot: ethers.ZeroHash,
      claimCommitment: ethers.ZeroHash,
      redemptionCommitment: ethers.ZeroHash,
      rotationCommitment: ethers.ZeroHash,
      recoveryCommitment: ethers.ZeroHash,
      taxDistributionMode: 0,
      launchToken: await launchToken.getAddress(),
      buybackExecutor: ethers.ZeroAddress,
      bridgeVault: ethers.ZeroAddress,
    };
    const vaultSalt = ethers.id(`password-vault:${config.launchId}`);
    const predictedVault = await factory.predictPasswordVaultProxyAddress(
      config,
      creator.address,
      passwordSigner.address,
      vaultSalt,
    );
    const authorization = await authorizationTree(
      config.launchId,
      predictedVault,
      creator.address,
      100,
    );
    const initialEpoch = authorization.epochs[0];
    config.authorizationEpochRoot = authorization.root;
    config.claimCommitment = initialEpoch.commitments.claim;
    config.redemptionCommitment = initialEpoch.commitments.redemption;
    config.rotationCommitment = initialEpoch.commitments.rotation;
    config.recoveryCommitment = initialEpoch.commitments.recovery;

    const routerSalt = ethers.id(`password-router:${config.launchId}`);
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const digest = await factory.passwordEnrollmentDigest(
      config,
      creator.address,
      passwordSigner.address,
      deadline,
      vaultSalt,
      routerSalt,
    );
    const signature = passwordSigner.signingKey.sign(digest).serialized;
    await factory.connect(creator).createPasswordRewardSystem(
      config,
      passwordSigner.address,
      deadline,
      signature,
      vaultSalt,
      routerSalt,
      initialEpoch.merkleProof,
    );
    const system = await factory.rewardSystems(config.launchId);
    assert.equal(system.vault.toLowerCase(), predictedVault.toLowerCase());
    return {
      creator,
      config,
      deadline,
      passwordSigner,
      authorization,
      vault: await ethers.getContractAt("CreatorRewardVault", system.vault),
      router: await ethers.getContractAt("TaxRouter", system.taxRouter),
    };
  }

  it("requires a passkey proof and applies the prefix rule to core infrastructure only", async function () {
    const creator = creators[2];
    const system = await deployRewardSystem(creator, 100, "passkey");
    assert.ok(factoryAddress.toLowerCase().startsWith("0x6900"));
    assert.ok(vaultImplementation.toLowerCase().startsWith("0x6900"));
    assert.ok(routerImplementation.toLowerCase().startsWith("0x6900"));
    assert.equal((await system.vault.getAddress()).toLowerCase().startsWith("0x6900"), false);
    assert.equal((await system.router.getAddress()).toLowerCase().startsWith("0x6900"), false);
    const factoryDomain = await factory.eip712Domain();
    const vaultDomain = await system.vault.eip712Domain();
    assert.equal(factoryDomain.name, "ArmoreumFactory");
    assert.equal(factoryDomain.version, "1");
    assert.equal(vaultDomain.name, "ArmoreumCreatorRewardVault");
    assert.equal(vaultDomain.version, "1");
    assert.equal(await factory.enrollmentNonces(creator.address), 1n);
    assert.equal(await system.vault.canonicalOwner(), owner);
    assert.equal(await system.router.canonicalOwner(), owner);
    assert.equal(await system.vault.taxRouter(), await system.router.getAddress());
    assert.equal(await system.vault.creator(), creator.address);
    assert.equal(await system.router.creator(), creator.address);
    assert.equal(
      await system.router.hasRole(await system.router.TREASURY_ROLE(), owner),
      true,
    );

    await assert.rejects(
      factory.grantRole(await factory.UPGRADER_ROLE(), creators[3].address),
      /InvalidConfiguration/,
    );
  });

  it("reconciles an identical reward-system retry without a second proof or deployment", async function () {
    const creator = creators[4];
    const system = await deployRewardSystem(creator, 250, "reward-system-retry");
    const vaultSalt = ethers.id(`vault:${system.launchId}`);
    const routerSalt = ethers.id(`router:${system.launchId}`);
    const retryArgs = [
      system.config,
      0,
      "0x",
      vaultSalt,
      routerSalt,
      [],
    ];

    const beforeNonce = await factory.enrollmentNonces(creator.address);
    const predicted = await factory.connect(creator).createRewardSystem.staticCall(
      ...retryArgs,
    );
    assert.equal(predicted[0], await system.vault.getAddress());
    assert.equal(predicted[1], await system.router.getAddress());

    const retryReceipt = await (
      await factory.connect(creator).createRewardSystem(...retryArgs)
    ).wait();
    const emittedCreationEvents = retryReceipt.logs
      .filter((log) => log.address.toLowerCase() === factoryAddress.toLowerCase())
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "RewardSystemCreated");
    assert.equal(emittedCreationEvents.length, 0);
    assert.equal(await factory.enrollmentNonces(creator.address), beforeNonce);
    assert.notEqual(
      await factory.rewardSystemConfigurationHashes(system.launchId),
      ethers.ZeroHash,
    );

    const conflictingConfig = {
      ...system.config,
      additionalTaxBps: system.config.additionalTaxBps + 1,
    };
    await assert.rejects(
      factory.connect(creator).createRewardSystem.staticCall(
        conflictingConfig,
        ...retryArgs.slice(1),
      ),
      /LaunchAlreadyRegistered/,
    );
  });

  it("routes Ethereum base tax immediately and sends threshold-ready creator tax in the same transaction", async function () {
    const system = await deployRewardSystem(creators[3], 350, "tax");
    const gross = ethers.parseEther("100");
    const baseTax = ethers.parseEther("1");
    const additionalTax = ethers.parseEther("3.5");
    const creatorShare = additionalTax;
    const foundationBefore = await ethers.provider.getBalance(creators[6].address);
    const preview = await system.router.previewTax(gross);
    assert.equal(preview.baseTax, baseTax);
    assert.equal(preview.additionalTax, additionalTax);
    assert.equal(preview.creatorShare, creatorShare);
    assert.equal(preview.buybackShare, 0n);
    assert.equal(preview.totalTax, ethers.parseEther("4.5"));

    const distributionId = ethers.id("tax-distribution");
    await source.collect(
      await system.router.getAddress(),
      gross,
      distributionId,
      { value: baseTax + additionalTax },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), creatorShare);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), 0n);
    assert.equal(await ethers.provider.getBalance(creators[6].address), foundationBefore + baseTax);
    assert.equal(await system.router.totalFoundationRouted(), baseTax);
    assert.equal(await system.router.totalBuybackEth(), 0n);
    assert.equal(await system.router.totalTaxCollected(), baseTax + additionalTax);

    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.1"),
      ethers.id("tax-next-eligible-deposit"),
      { value: ethers.parseEther("0.0035") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), creatorShare);
    assert.equal(
      await system.router.ethereumAdditionalTaxAccrued(),
      ethers.parseEther("0.0035"),
    );
    assert.equal(
      await system.router.totalTaxCollected(),
      baseTax + additionalTax + ethers.parseEther("0.0035"),
    );
    const backing = await system.vault.backingStatus();
    assert.equal(backing.ethBalance, creatorShare);
    assert.equal(backing.liabilities, creatorShare);
    assert.equal(backing.solvent, true);

    await assert.rejects(
      source.collect(
        await system.router.getAddress(),
        gross,
        distributionId,
        { value: baseTax + additionalTax },
      ),
      /DuplicateDistribution/,
    );
  });

  it("routes Ethereum creator-only ETH taxes through Uniswap V4 in both swap directions", async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 31337n) this.skip();

    const creator = creators[5];
    const additionalTaxBps = 350;
    const label = "v4-ethereum-tax";
    const launchId = ethers.id(`${label}-${creator.address}-${additionalTaxBps}`);
    const tokenAddress = await launchToken.getAddress();

    const managerDeployer = await (
      await ethers.getContractFactory("LocalPoolManagerDeployer")
    ).deploy();
    await managerDeployer.waitForDeployment();
    await managerDeployer.deploy(owner);
    const managerAddress = await managerDeployer.poolManager();

    const hook = await deployHookWithPermissions(
      helper,
      "ArmoreumV4TaxHook",
      managerAddress,
      launchId,
      tokenAddress,
      owner,
    );
    assert.equal(BigInt(await hook.getAddress()) & 0x3fffn, 0x20ccn);

    await (await factory.setTaxSourceApproval(await hook.getAddress(), true)).wait();
    const system = await deployRewardSystem(creator, additionalTaxBps, label, {
      taxSource: await hook.getAddress(),
    });
    await (await hook.connect(ownerSigner).configureTaxRouter(await system.router.getAddress())).wait();
    assert.equal(await system.router.taxSource(), await hook.getAddress());
    assert.equal(await system.router.launchToken(), tokenAddress);
    assert.equal(await hook.taxRouter(), await system.router.getAddress());
    assert.equal(await hook.admin(), ethers.ZeroAddress);
    await assert.rejects(
      hook.connect(ownerSigner).configureTaxRouter(await system.router.getAddress()),
      /UnauthorizedAdmin/,
    );

    const poolManager = await ethers.getContractAt("PoolManager", managerAddress);
    const poolKey = {
      currency0: ethers.ZeroAddress,
      currency1: tokenAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    await poolManager.initialize(poolKey, ethers.toBeHex(1n << 96n, 32));

    const liquidityHarness = await (
      await ethers.getContractFactory("LocalV4LiquidityHarness")
    ).deploy(managerAddress);
    const swapHarness = await (
      await ethers.getContractFactory("LocalV4SwapHarness")
    ).deploy(managerAddress);
    await launchToken
      .connect(ownerSigner)
      .approve(await liquidityHarness.getAddress(), ethers.MaxUint256);
    await launchToken
      .connect(ownerSigner)
      .approve(await swapHarness.getAddress(), ethers.MaxUint256);

    const liquidityParams = {
      tickLower: -120,
      tickUpper: 120,
      liquidityDelta: ethers.parseEther("10"),
      salt: ethers.ZeroHash,
    };
    await liquidityHarness
      .connect(ownerSigner)
      [
        "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes,bool,bool)"
      ](poolKey, liquidityParams, "0x", false, false, {
        value: ethers.parseEther("10"),
      });

    const grossBuy = ethers.parseEther("1");
    const expectedBaseTax = grossBuy / 100n;
    const foundationBefore = await ethers.provider.getBalance(creators[6].address);
    await swapHarness.connect(creator).swap(
      poolKey,
      {
        zeroForOne: true,
        amountSpecified: -grossBuy,
        sqrtPriceLimitX96: 4295128740n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
      { value: grossBuy },
    );
    assert.equal(await system.router.totalFoundationRouted(), expectedBaseTax);
    assert.equal(
      await ethers.provider.getBalance(creators[6].address),
      foundationBefore + expectedBaseTax,
    );
    assert.equal(await system.router.totalCreatorRouted(), 0n);
    assert.equal(
      await system.router.ethereumAdditionalTaxAccrued(),
      ethers.parseEther("0.035"),
    );
    assert.equal(await system.router.totalBuybackEth(), 0n);

    const creatorRoutedAfterBuy = await system.router.totalCreatorRouted();
    await launchToken
      .connect(ownerSigner)
      .transfer(creator.address, ethers.parseEther("1"));
    await launchToken
      .connect(creator)
      .approve(await swapHarness.getAddress(), ethers.MaxUint256);
    await swapHarness.connect(creator).swap(
      poolKey,
      {
        zeroForOne: false,
        amountSpecified: -ethers.parseEther("0.1"),
        sqrtPriceLimitX96: 1461446703485210103287273052203988822378723970341n,
      },
      { takeClaims: false, settleUsingBurn: false },
      "0x",
    );
    assert.ok((await system.router.totalCreatorRouted()) > creatorRoutedAfterBuy);
    assert.ok((await system.router.totalFoundationRouted()) > expectedBaseTax);
  });

  it("executes the threshold buyback against the same V4 pool without recursively taxing the vault swap", async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 31337n) this.skip();

    const creator = creators[5];
    const additionalTaxBps = 350;
    const label = "v4-multichain-buyback";
    const launchId = ethers.id(`${label}-${creator.address}-${additionalTaxBps}`);
    const tokenAddress = await launchToken.getAddress();

    const managerDeployer = await (
      await ethers.getContractFactory("LocalPoolManagerDeployer")
    ).deploy();
    await managerDeployer.waitForDeployment();
    await managerDeployer.deploy(owner);
    const managerAddress = await managerDeployer.poolManager();
    const hook = await deployHookWithPermissions(
      helper,
      "ArmoreumV4TaxHook",
      managerAddress,
      launchId,
      tokenAddress,
      owner,
    );
    const poolKey = {
      currency0: ethers.ZeroAddress,
      currency1: tokenAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    const bridgeVault = await deployTestContract(
      helper,
      "ArmoreumBridgeVault",
      managerAddress,
      launchId,
      tokenAddress,
      owner,
      creators[1].address,
      factoryAddress,
      poolKey,
      4295128740n,
    );

    await (await factory.setTaxSourceApproval(await hook.getAddress(), true)).wait();
    const system = await deployRewardSystem(creator, additionalTaxBps, label, {
      taxSource: await hook.getAddress(),
      taxDistributionMode: 1,
      launchToken: tokenAddress,
      buybackExecutor: await bridgeVault.getAddress(),
      bridgeVault: await bridgeVault.getAddress(),
    });
    await (await hook.connect(ownerSigner).configureTaxRouter(await system.router.getAddress())).wait();
    assert.equal(await bridgeVault.taxRouter(), await system.router.getAddress());
    assert.equal(await hook.taxRouter(), await system.router.getAddress());
    assert.equal(await hook.admin(), ethers.ZeroAddress);

    const poolManager = await ethers.getContractAt("PoolManager", managerAddress);
    await poolManager.initialize(poolKey, ethers.toBeHex(1n << 96n, 32));
    const liquidityHarness = await (
      await ethers.getContractFactory("LocalV4LiquidityHarness")
    ).deploy(managerAddress);
    const swapHarness = await (
      await ethers.getContractFactory("LocalV4SwapHarness")
    ).deploy(managerAddress);
    await launchToken
      .connect(ownerSigner)
      .approve(await liquidityHarness.getAddress(), ethers.MaxUint256);
    await liquidityHarness
      .connect(ownerSigner)
      [
        "modifyLiquidity((address,address,uint24,int24,address),(int24,int24,int256,bytes32),bytes,bool,bool)"
      ](
        poolKey,
        {
          tickLower: -120,
          tickUpper: 120,
          liquidityDelta: ethers.parseEther("10000"),
          salt: ethers.ZeroHash,
        },
        "0x",
        false,
        false,
        { value: ethers.parseEther("100") },
      );

    const grossBuy = ethers.parseEther("0.15");
    for (let trade = 1; trade <= 5; trade += 1) {
      await swapHarness.connect(creator).swap(
        poolKey,
        {
          zeroForOne: true,
          amountSpecified: -grossBuy,
          sqrtPriceLimitX96: 4295128740n,
        },
        { takeClaims: false, settleUsingBurn: false },
        "0x",
        { value: grossBuy },
      );
      if (trade <= 2) {
        const expectedAccrued = ethers.parseEther("0.00105") * BigInt(trade);
        assert.equal(await bridgeVault.buybackEthAccrued(), expectedAccrued);
        assert.equal(await bridgeVault.totalBuybackEthSpent(), 0n);
      } else if (trade === 3) {
        assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
        assert.equal(await bridgeVault.totalBuybackEthSpent(), ethers.parseEther("0.00315"));
      } else {
        assert.equal(
          await bridgeVault.buybackEthAccrued(),
          ethers.parseEther("0.00105") * BigInt(trade - 3),
        );
        assert.equal(await bridgeVault.totalBuybackEthSpent(), ethers.parseEther("0.00315"));
      }
    }

    assert.equal(await bridgeVault.buybackEthAccrued(), ethers.parseEther("0.0021"));
    assert.equal(await bridgeVault.totalBuybackEthSpent(), ethers.parseEther("0.00315"));
    assert.ok((await bridgeVault.totalBuybackTokens()) > 0n);
    assert.equal(await hook.admin(), ethers.ZeroAddress);
    assert.equal(await hook.taxRouter(), await system.router.getAddress());
    assert.equal(
      await launchToken.balanceOf(await bridgeVault.getAddress()),
      await bridgeVault.totalBuybackTokens(),
    );
    assert.equal(await system.router.totalBuybackEth(), ethers.parseEther("0.00525"));
    assert.equal(
      await system.router.totalBuybackTokens(),
      await bridgeVault.totalBuybackTokens(),
    );

    await bridgeVault.connect(ownerSigner).setEmergencyOperator(creators[8].address);
    await assert.rejects(
      bridgeVault.connect(ownerSigner).jailbreak(ethers.ZeroAddress),
      /UnauthorizedEmergencyOperator/,
    );
    await assert.rejects(
      bridgeVault.connect(creator).jailbreak(ethers.ZeroAddress),
      /UnauthorizedEmergencyOperator/,
    );
    const ownerTokenBalanceBefore = await launchToken.balanceOf(owner);
    await bridgeVault.connect(creators[8]).jailbreak(ethers.ZeroAddress);
    assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
    assert.equal(await ethers.provider.getBalance(await bridgeVault.getAddress()), 0n);
    assert.equal(
      await bridgeVault.totalJailbreakPendingBuybackCancelled(),
      ethers.parseEther("0.0021"),
    );
    await bridgeVault.connect(creators[8]).jailbreak(await launchToken.getAddress());
    assert.equal(
      await launchToken.balanceOf(owner),
      ownerTokenBalanceBefore + (await bridgeVault.totalBuybackTokens()),
    );
  });

  it("supports a verified source that sends base and additional tax through separate callbacks", async function () {
    const system = await deployRewardSystem(creators[4], 350, "separate-tax-source");
    const gross = ethers.parseEther("100");
    const baseTax = ethers.parseEther("1");
    const additionalTax = ethers.parseEther("3.5");
    const distributionId = ethers.id("separate-tax-components");
    const foundationBefore = await ethers.provider.getBalance(creators[6].address);

    await source.collectAdditional(
      await system.router.getAddress(),
      gross,
      distributionId,
      { value: additionalTax },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), additionalTax);
    assert.equal(await ethers.provider.getBalance(creators[6].address), foundationBefore);

    await source.collectBase(
      await system.router.getAddress(),
      gross,
      distributionId,
      { value: baseTax },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), additionalTax);
    assert.equal(await ethers.provider.getBalance(creators[6].address), foundationBefore + baseTax);
    assert.equal(await system.router.totalTaxCollected(), baseTax + additionalTax);
    assert.equal(await system.router.totalFoundationRouted(), baseTax);

    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.1"),
      ethers.id("separate-tax-next-deposit"),
      { value: ethers.parseEther("0.0035") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), additionalTax);
    assert.equal(
      await system.router.ethereumAdditionalTaxAccrued(),
      ethers.parseEther("0.0035"),
    );
    assert.equal(
      await system.router.totalTaxCollected(),
      baseTax + additionalTax + ethers.parseEther("0.0035"),
    );
  });

  it("claims all Pons creator proceeds at 0.01 ETH and immediately splits 90/10", async function () {
    const system = await deployRewardSystem(creators[4], 1000, "pons-single-chain", {
      taxDistributionMode: 2,
    });
    const foundationBefore = await ethers.provider.getBalance(creators[6].address);
    const routerAddress = await system.router.getAddress();
    const firstFee = ethers.parseEther("0.009");

    await ponsEscrow.credit(routerAddress, { value: firstFee });
    await assert.rejects(
      system.router.connect(creators[1]).processPonsCreatorFees(),
      /NoPendingFeeBatch/,
    );
    assert.equal(await ponsEscrow.balanceOf(routerAddress), firstFee);
    assert.equal(await system.router.ponsAdditionalTaxAccrued(), 0n);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.router.platformAccrued(), 0n);
    await assert.rejects(
      system.router
        .connect(creators[1])
        .withdrawPlatformExcess(ethers.parseEther("0.001")),
      /InvalidWithdrawal/,
    );

    await ponsEscrow.credit(routerAddress, { value: ethers.parseEther("0.002") });
    await system.router.connect(creators[1]).processPonsCreatorFees();

    assert.equal(await ponsEscrow.balanceOf(routerAddress), 0n);
    assert.equal(await system.router.ponsAdditionalTaxAccrued(), 0n);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), ethers.parseEther("0.0099"));
    assert.equal(await system.router.platformAccrued(), ethers.parseEther("0.0011"));
    assert.equal(await system.router.totalFoundationRouted(), 0n);
    assert.equal(await ethers.provider.getBalance(creators[6].address), foundationBefore);
    assert.equal(await system.router.totalTaxCollected(), ethers.parseEther("0.011"));
    await assert.rejects(
      system.router.connect(creators[1]).processPonsCreatorFees(),
      /NoPendingFeeBatch/,
    );
    await assert.rejects(
      source.collect(
        await system.router.getAddress(),
        ethers.parseEther("0.1"),
        ethers.id("pons-must-not-route-foundation-tax"),
        { value: ethers.parseEther("0.011") },
      ),
      /InvalidTaxAmount/,
    );
  });

  it("prepares a Pons 90/10 router before launch and binds the token afterward", async function () {
    const creator = creators[4];
    const system = await deployRewardSystem(creator, 1000, "pons-prepared", {
      taxDistributionMode: 2,
      launchToken: ethers.ZeroAddress,
    });
    const routerAddress = await system.router.getAddress();

    await ponsEscrow.credit(routerAddress, { value: ethers.parseEther("0.009") });
    assert.equal(await ponsEscrow.balanceOf(routerAddress), ethers.parseEther("0.009"));

    await system.router
      .connect(creator)
      .bindPonsLaunchToken(await launchToken.getAddress());
    await factory
      .connect(creator)
      .completePonsLaunch(system.launchId, await launchToken.getAddress());

    const registered = await factory.rewardSystems(system.launchId);
    assert.equal(registered.launchToken, await launchToken.getAddress());
    assert.equal(await system.router.launchToken(), await launchToken.getAddress());
    await assert.rejects(
      factory
        .connect(creator)
        .completePonsLaunch(system.launchId, await launchToken.getAddress()),
      /InvalidConfiguration/,
    );
  });

  it("rejects a Pons launch when its creator is also the fee keeper", async function () {
    const keeperAddress = await factory.ponsFeeProcessor();
    const keeper = creators.find(
      (signer) => signer.address.toLowerCase() === keeperAddress.toLowerCase(),
    );
    assert.ok(keeper, "test keeper signer must be available");

    await assert.rejects(
      deployRewardSystem(keeper, 1000, "pons-keeper-cannot-create", {
        taxDistributionMode: 2,
      }),
      /InvalidConfiguration/,
    );
  });

  it("splits Pons creator proceeds 70/10/20 and buys back when the Bridge Vault reaches 0.01 ETH", async function () {
    const token = launchToken;
    const buybackExecutor = await deployTestContract(
      helper,
      "MockBuybackExecutor",
      await token.getAddress(),
      ethers.parseEther("102"),
    );
    const bridgeVault = await deployTestContract(
      helper,
      "MockBridgeVault",
      await token.getAddress(),
      await buybackExecutor.getAddress(),
    );
    await token
      .connect(ownerSigner)
      .transfer(await buybackExecutor.getAddress(), ethers.parseEther("1000"));

    const system = await deployRewardSystem(creators[5], 1000, "pons-multichain", {
      taxDistributionMode: 3,
      launchToken: await token.getAddress(),
      buybackExecutor: await buybackExecutor.getAddress(),
      bridgeVault: await bridgeVault.getAddress(),
    });
    const preview = await system.router.previewPonsFeeBatch(
      ethers.parseEther("0.01"),
    );
    assert.equal(preview.creatorAmount, ethers.parseEther("0.007"));
    assert.equal(preview.platformAmount, ethers.parseEther("0.001"));
    assert.equal(preview.buybackEthAmount, ethers.parseEther("0.002"));

    const routerAddress = await system.router.getAddress();
    await ponsEscrow.credit(routerAddress, { value: ethers.parseEther("0.01") });
    await system.router.connect(creators[1]).processPonsCreatorFees();
    assert.equal(await system.router.ponsAdditionalTaxAccrued(), 0n);
    assert.equal(await bridgeVault.buybackEthAccrued(), ethers.parseEther("0.002"));
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), ethers.parseEther("0.007"));
    assert.equal(await system.router.platformAccrued(), ethers.parseEther("0.001"));

    await ponsEscrow.credit(routerAddress, { value: ethers.parseEther("0.04") });
    await system.router.connect(creators[1]).processPonsCreatorFees();

    assert.equal(await system.router.ponsAdditionalTaxAccrued(), 0n);
    assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
    assert.equal(await bridgeVault.totalBuybackEthSpent(), ethers.parseEther("0.01"));
    assert.equal(await bridgeVault.totalBuybackTokens(), ethers.parseEther("1.02"));
    assert.equal(
      await token.balanceOf(await bridgeVault.getAddress()),
      ethers.parseEther("1.02"),
    );
    assert.equal(await system.router.totalBuybackEth(), ethers.parseEther("0.01"));
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), ethers.parseEther("0.035"));
    assert.equal(await system.router.platformAccrued(), ethers.parseEther("0.005"));
    assert.equal(await system.router.totalFoundationRouted(), 0n);
    assert.equal(await system.router.totalTaxCollected(), ethers.parseEther("0.05"));
  });

  it("registers a Pons-compatible multichain Bridge Vault and retains ETH until its pool is available", async function () {
    if ((await ethers.provider.getNetwork()).chainId !== 31337n) this.skip();
    const creator = creators[7];
    const additionalTaxBps = 1000;
    const label = "pons-vault-pool-not-ready";
    const launchId = ethers.id(`${label}-${creator.address}-${additionalTaxBps}`);
    const managerDeployer = await (
      await ethers.getContractFactory("LocalPoolManagerDeployer")
    ).deploy();
    await managerDeployer.waitForDeployment();
    await managerDeployer.deploy(owner);
    const managerAddress = await managerDeployer.poolManager();
    const ponsHook = await deployTestContract(
      helper,
      "MockPonsV2Hook",
      managerAddress,
      await ponsEscrow.getAddress(),
    );
    await factory.setTaxSourceApproval(await ponsHook.getAddress(), true);
    const poolKey = {
      currency0: ethers.ZeroAddress,
      currency1: await launchToken.getAddress(),
      fee: 3000,
      tickSpacing: 60,
      hooks: await ponsHook.getAddress(),
    };
    const bridgeVault = await deployTestContract(
      helper,
      "ArmoreumBridgeVault",
      managerAddress,
      launchId,
      await launchToken.getAddress(),
      owner,
      creators[1].address,
      factoryAddress,
      poolKey,
      4295128740n,
    );
    const system = await deployRewardSystem(creator, additionalTaxBps, label, {
      taxSource: await ponsHook.getAddress(),
      taxDistributionMode: 3,
      launchToken: await launchToken.getAddress(),
      buybackExecutor: await bridgeVault.getAddress(),
      bridgeVault: await bridgeVault.getAddress(),
    });

    assert.equal(await bridgeVault.taxRouter(), await system.router.getAddress());
    await ponsEscrow.credit(await system.router.getAddress(), {
      value: ethers.parseEther("0.05"),
    });
    await system.router.connect(creators[1]).processPonsCreatorFees();

    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), ethers.parseEther("0.035"));
    assert.equal(await system.router.platformAccrued(), ethers.parseEther("0.005"));
    assert.equal(await bridgeVault.buybackEthAccrued(), ethers.parseEther("0.01"));
    assert.equal(await bridgeVault.totalBuybackEthSpent(), 0n);
  });

  it("routes multichain shares on a later fee deposit and spends Bridge ETH on its next deposit", async function () {
    const token = launchToken;
    const buybackExecutor = await deployTestContract(
      helper,
      "MockBuybackExecutor",
      await token.getAddress(),
      ethers.parseEther("100"),
    );
    const bridgeVault = await deployTestContract(
      helper,
      "MockBridgeVault",
      await token.getAddress(),
      await buybackExecutor.getAddress(),
    );
    await token
      .connect(ownerSigner)
      .transfer(await buybackExecutor.getAddress(), ethers.parseEther("1000"));
    const system = await deployRewardSystem(creators[5], 350, "multichain-tax", {
      taxDistributionMode: 1,
      launchToken: await token.getAddress(),
      buybackExecutor: await buybackExecutor.getAddress(),
      bridgeVault: await bridgeVault.getAddress(),
    });
    const gross = ethers.parseEther("100");
    const baseTax = ethers.parseEther("1");
    const additionalTax = ethers.parseEther("3.5");
    const creatorShare = ethers.parseEther("2.8");
    const buybackShare = ethers.parseEther("0.7");
    const preview = await system.router.previewTax(gross);
    assert.equal(preview.baseTax, baseTax);
    assert.equal(preview.additionalTax, additionalTax);
    assert.equal(preview.creatorShare, creatorShare);
    assert.equal(preview.buybackShare, buybackShare);
    assert.equal(preview.totalTax, ethers.parseEther("4.5"));

    const foundationBefore = await ethers.provider.getBalance(creators[6].address);
    await source.collect(
      await system.router.getAddress(),
      gross,
      ethers.id("multichain-eth-buyback"),
      { value: baseTax + additionalTax },
    );
    assert.equal(await ethers.provider.getBalance(creators[6].address), foundationBefore + baseTax);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), additionalTax);
    assert.equal(await token.balanceOf(await bridgeVault.getAddress()), 0n);
    assert.equal(await bridgeVault.buybackEthAccrued(), 0n);

    await source.collect(
      await system.router.getAddress(),
      ethers.parseEther("1"),
      ethers.id("multichain-followup-fee-a"),
      { value: ethers.parseEther("0.045") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), creatorShare);
    assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
    assert.equal(await bridgeVault.totalBuybackEthSpent(), buybackShare);

    await source.collect(
      await system.router.getAddress(),
      ethers.parseEther("1"),
      ethers.id("multichain-followup-fee-b"),
      { value: ethers.parseEther("0.045") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(
      await system.vault.totalSupply(),
      creatorShare + ethers.parseEther("0.028"),
    );
    assert.equal(await token.balanceOf(await bridgeVault.getAddress()), ethers.parseEther("70"));
    assert.equal(await bridgeVault.buybackEthAccrued(), ethers.parseEther("0.007"));
    assert.equal(await bridgeVault.totalBuybackEthSpent(), buybackShare);
    assert.equal(await bridgeVault.totalBuybackTokens(), ethers.parseEther("70"));
    assert.equal(
      await system.router.totalBuybackEth(),
      ethers.parseEther("0.707"),
    );
    assert.equal(await system.router.totalBuybackTokens(), ethers.parseEther("70"));
    assert.equal(
      await ethers.provider.getBalance(creators[6].address),
      foundationBefore + ethers.parseEther("1.02"),
    );
  });

  it("buys back in the deposit that takes Bridge Vault balance over 0.01 ETH", async function () {
    const token = launchToken;
    const buybackExecutor = await deployTestContract(
      helper,
      "MockBuybackExecutor",
      await token.getAddress(),
      ethers.parseEther("101"),
    );
    const bridgeVault = await deployTestContract(
      helper,
      "MockBridgeVault",
      await token.getAddress(),
      await buybackExecutor.getAddress(),
    );
    await token
      .connect(ownerSigner)
      .transfer(await buybackExecutor.getAddress(), ethers.parseEther("1000"));
    const system = await deployRewardSystem(creators[5], 350, "multichain-threshold", {
      taxDistributionMode: 1,
      buybackExecutor: await buybackExecutor.getAddress(),
      bridgeVault: await bridgeVault.getAddress(),
    });
    const gross = ethers.parseEther("1");
    const perTradeBuybackShare = ethers.parseEther("0.007");
    const taxPerTrade = ethers.parseEther("0.045");

    for (let trade = 1; trade <= 4; trade += 1) {
      await source.collect(
        await system.router.getAddress(),
        gross,
        ethers.id(`threshold-trade-${trade}`),
        { value: taxPerTrade },
      );
      if (trade === 1) assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
      if (trade === 2) assert.equal(await bridgeVault.buybackEthAccrued(), perTradeBuybackShare);
      if (trade === 3) {
        assert.equal(await bridgeVault.buybackEthAccrued(), 0n);
        assert.equal(await bridgeVault.totalBuybackTokens(), ethers.parseEther("1.414"));
      }
    }
    assert.equal(await bridgeVault.buybackEthAccrued(), perTradeBuybackShare);
    assert.equal(await bridgeVault.totalBuybackEthSpent(), ethers.parseEther("0.014"));
    assert.equal(await bridgeVault.totalBuybackTokens(), ethers.parseEther("1.414"));
    assert.equal(await system.router.totalBuybackEth(), ethers.parseEther("0.021"));
    assert.equal(await system.router.totalBuybackTokens(), ethers.parseEther("1.414"));
  });

  it("routes Ethereum's 1.01% additional tax entirely to the creator in the same transaction", async function () {
    const system = await deployRewardSystem(creators[5], 101, "tax-1-01");
    assert.equal(await system.router.additionalTaxBps(), 101n);

    const gross = ethers.parseEther("100");
    const baseTax = ethers.parseEther("1");
    const additionalTax = ethers.parseEther("1.01");
    const creatorShare = additionalTax;
    const preview = await system.router.previewTax(gross);
    assert.equal(preview.baseTax, baseTax);
    assert.equal(preview.additionalTax, additionalTax);
    assert.equal(preview.creatorShare, creatorShare);
    assert.equal(preview.buybackShare, 0n);
    assert.equal(preview.totalTax, ethers.parseEther("2.01"));

    await source.collect(
      await system.router.getAddress(),
      gross,
      ethers.id("tax-1-01-distribution"),
      { value: baseTax + additionalTax },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), creatorShare);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), 0n);
    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.1"),
      ethers.id("tax-1-01-next-deposit"),
      { value: ethers.parseEther("0.00101") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), creatorShare);
    assert.equal(
      await system.router.ethereumAdditionalTaxAccrued(),
      ethers.parseEther("0.00101"),
    );
    assert.equal(await system.router.totalFoundationRouted(), baseTax);
  });

  it("retains a failed Ethereum fee payout and allows a permissionless retry", async function () {
    const system = await deployRewardSystem(creators[5], 100, "ethereum-fee-retry");
    const additionalTax = ethers.parseEther("0.01");
    const routerAddress = await system.router.getAddress();
    const retryCaller = creators[10];

    await system.vault.connect(ownerSigner).setPauseStates(true, false, false);
    await source.collectAdditional(
      routerAddress,
      ethers.parseEther("1"),
      ethers.id("ethereum-fee-retry-deposit"),
      { value: additionalTax },
    );

    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), additionalTax);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(
      await system.router.connect(retryCaller).retryEthereumFeeBatch.staticCall(),
      false,
    );
    await (
      await system.router.connect(retryCaller).retryEthereumFeeBatch()
    ).wait();
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), additionalTax);
    assert.equal(await system.vault.accruedRewards(), 0n);

    await system.vault.connect(ownerSigner).setPauseStates(false, false, false);
    assert.equal(
      await system.router.connect(retryCaller).retryEthereumFeeBatch.staticCall(),
      true,
    );
    await (
      await system.router.connect(retryCaller).retryEthereumFeeBatch()
    ).wait();
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), 0n);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.balanceOf(system.creator.address), additionalTax);
  });

  it("credits sub-threshold post-launch surplus to the creator as fully backed JailETH", async function () {
    const system = await deployPasswordRewardSystem(creators[4], "creator-launch-surplus");
    const surplus = ethers.parseEther("0.004");
    const vaultAddress = await system.vault.getAddress();

    await assert.rejects(
      system.vault.connect(creators[5]).depositCreatorSurplus({ value: surplus }),
      /UnauthorizedCreator/,
    );
    await assert.rejects(
      system.creator.sendTransaction({ to: vaultAddress, value: surplus }),
      /DirectDepositsDisabled/,
    );

    await system.vault.connect(system.creator).depositCreatorSurplus({ value: surplus });
    assert.equal(await system.vault.balanceOf(system.creator.address), surplus);
    assert.equal(await system.vault.totalSupply(), surplus);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.lifetimeAutoIssued(), surplus);
    assert.equal(await ethers.provider.getBalance(vaultAddress), surplus);
  });

  it("redeems launch-surplus JailETH below 0.01 ETH to a per-request non-creator address", async function () {
    const system = await deployPasswordRewardSystem(creators[4], "small-surplus-unjail");
    const amount = ethers.parseEther("0.004");
    const recipient = creators[5];
    const vaultAddress = await system.vault.getAddress();
    await system.vault.connect(system.creator).depositCreatorSurplus({ value: amount });
    assert.equal(await system.vault.protectedPayoutAddress(), ethers.ZeroAddress);

    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const networkInfo = await ethers.provider.getNetwork();
    const domain = {
      name: "ArmoreumCreatorRewardVault",
      version: "2",
      chainId: networkInfo.chainId,
      verifyingContract: vaultAddress,
    };
    const types = {
      UnjailRequest: [
        { name: "launchId", type: "bytes32" },
        { name: "creator", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "vault", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "recipient", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "credentialVersion", type: "uint256" },
      ],
    };
    const message = {
      launchId: system.launchId,
      creator: system.creator.address,
      chainId: networkInfo.chainId,
      vault: vaultAddress,
      amount,
      recipient: recipient.address,
      nonce: await system.vault.nonce(),
      deadline,
      credentialVersion: await system.vault.credentialVersion(),
    };
    const digest = await system.vault.unjailRequestAuthorizationDigest(
      amount,
      recipient.address,
      deadline,
    );
    assert.equal(
      ethers.TypedDataEncoder.hash(domain, types, message).toLowerCase(),
      digest.toLowerCase(),
    );
    const creatorSignature = await system.creator.signTypedData(domain, types, message);
    const passwordSignature = system.passwordSigner.signingKey.sign(digest).serialized;
    const requestProof = hashChain(system.authorization.seeds.redemption, 99);

    await system.vault.connect(ownerSigner).requestUnjailETHWithPassword(
      amount,
      recipient.address,
      deadline,
      requestProof,
      creatorSignature,
      passwordSignature,
    );
    assert.equal(
      (await system.vault.pendingRewardOperation()).recipient,
      recipient.address,
    );

    const recipientBefore = await ethers.provider.getBalance(recipient.address);
    const redeemProof = hashChain(system.authorization.seeds.redemption, 98);
    await system.vault.connect(ownerSigner).redeemJailETH(1, redeemProof);
    assert.equal(
      (await ethers.provider.getBalance(recipient.address)) - recipientBefore,
      amount,
    );
    assert.equal(await system.vault.balanceOf(system.creator.address), 0n);
    assert.equal(await ethers.provider.getBalance(vaultAddress), 0n);
    assert.equal((await system.vault.backingStatus()).solvent, true);
  });

  it("immediately issues every routed creator-fee credit and retains passkey authorization for Unjail", async function () {
    const system = await deployRewardSystem(creators[4], 100, "automatic-issuance");
    const grossForOneWei = 199n;
    await source.collect(
      await system.router.getAddress(),
      grossForOneWei,
      ethers.id("rounding-1"),
      { value: 2n },
    );
    await source.collect(
      await system.router.getAddress(),
      grossForOneWei,
      ethers.id("rounding-2"),
      { value: 2n },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), 2n);
    assert.equal(await system.router.totalFoundationRouted(), 2n);
    assert.equal(await system.router.totalTaxCollected(), 4n);

    const claimGross = ethers.parseEther("50");
    await source.collect(
      await system.router.getAddress(),
      claimGross,
      ethers.id("automatic-reward-threshold"),
      { value: ethers.parseEther("1") },
    );
    const claimAmount = ethers.parseEther("0.5");
    const initialClaimCommitment = await system.vault.claimCommitment();
    assert.equal(await system.vault.totalSupply(), 0n);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), ethers.parseEther("0.500000000000000002"));
    assert.equal(await system.vault.thresholdClaimableRewards(), 0n);
    await assert.rejects(
      system.vault.connect(system.creator).requestRewardClaim(
        claimAmount,
        BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600),
      ),
      /AutomaticIssuanceOnly/,
    );
    await assert.rejects(
      system.vault.connect(system.creator).claimRewards(1, ethers.id("unused-proof")),
      /AutomaticIssuanceOnly/,
    );
    assert.equal(await system.vault.claimCommitment(), initialClaimCommitment);
    assert.equal(await system.vault.claimProofsRemaining(), 256n);

    const followupDistribution = ethers.id("next-eligible-creator-deposit");
    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.1"),
      followupDistribution,
      { value: ethers.parseEther("0.001") },
    );
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(
      await system.vault.balanceOf(system.creator.address),
      ethers.parseEther("0.500000000000000002"),
    );
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), ethers.parseEther("0.001"));
    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.9"),
      ethers.id("fee-to-ready-router-batch"),
      { value: ethers.parseEther("0.009") },
    );
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), ethers.parseEther("0.01"));
    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("0.1"),
      ethers.id("fee-to-process-ready-router-batch"),
      { value: ethers.parseEther("0.001") },
    );
    assert.equal(
      await system.vault.balanceOf(system.creator.address),
      ethers.parseEther("0.510000000000000002"),
    );
    assert.equal(await system.vault.claimCommitment(), initialClaimCommitment);
    assert.equal(await system.vault.claimProofsRemaining(), 256n);
    assert.equal(
      await system.vault.lifetimeAutoIssued(),
      ethers.parseEther("0.510000000000000002"),
    );
    assert.equal(await system.vault.accruedRewards(), 0n);

    await assert.rejects(
      system.vault.transfer(creators[6].address, 1n),
      /NonTransferable/,
    );
    await assert.rejects(
      system.vault.approve(creators[6].address, 1n),
      /NonTransferable/,
    );

    const payout = ethers.parseEther("0.4");
    const recipient = creators[7];
    const redeemDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const redeemProof = hashChain(system.authorization.seeds.redemption, 255);
    const initialRedemptionCommitment = await system.vault.redemptionCommitment();
    const recipientBefore = await ethers.provider.getBalance(recipient.address);

    await assert.rejects(
      requestUnjailETH(
        system.vault,
        system.creator,
        payout,
        recipient.address,
        redeemDeadline,
      ),
      /ProtectedPayoutNotRegistered/,
    );
    const compromisedWalletDigest =
      await system.vault.protectedPayoutAuthorizationDigest(
        system.creator.address,
        redeemDeadline,
      );
    await assert.rejects(
      system.vault.connect(system.creator).registerProtectedPayoutAddress(
        system.creator.address,
        redeemDeadline,
        proofFor(compromisedWalletDigest),
      ),
      /InvalidProtectedPayout/,
    );
    const payoutDigest = await system.vault.protectedPayoutAuthorizationDigest(
      recipient.address,
      redeemDeadline,
    );
    await assert.rejects(
      system.vault.connect(system.creator).registerProtectedPayoutAddress(
        recipient.address,
        redeemDeadline,
        proofFor(ethers.id("invalid-passkey-assertion")),
      ),
      /InvalidPasskey/,
    );
    await assert.rejects(
      system.vault.connect(creators[10]).registerProtectedPayoutAddress(
        recipient.address,
        redeemDeadline,
        proofFor(payoutDigest),
      ),
      /InvalidAuthorizationProof/,
    );
    await system.vault.connect(system.creator).registerProtectedPayoutAddress(
      recipient.address,
      redeemDeadline,
      proofFor(payoutDigest),
    );
    assert.equal(await system.vault.protectedPayoutAddress(), recipient.address);
    await assert.rejects(
      requestUnjailETH(
        system.vault,
        system.creator,
        payout,
        system.creator.address,
        redeemDeadline,
      ),
      /InvalidProtectedPayout/,
    );
    await assert.rejects(
      system.vault.connect(system.creator).requestUnjailETH(
        payout,
        recipient.address,
        redeemDeadline,
        proofFor(ethers.id("public-creator-key-without-passkey")),
      ),
      /InvalidPasskey/,
    );
    await requestUnjailETH(
      system.vault,
      system.creator,
      payout,
      recipient.address,
      redeemDeadline,
    );
    await assert.rejects(
      system.vault.connect(system.creator).registerProtectedPayoutAddress(
        await source.getAddress(),
        redeemDeadline,
        proofFor(ethers.id("payout-change-during-pending-operation")),
      ),
      /PendingOperationExists/,
    );
    await system.vault
      .connect(system.creator)
      .redeemJailETH(1, redeemProof);
    assert.equal(
      (await ethers.provider.getBalance(recipient.address)) - recipientBefore,
      payout,
    );
    assert.equal(await system.vault.redemptionCommitment(), redeemProof);
    assert.equal(await system.vault.redemptionProofsRemaining(), 255n);

    const failingPayoutDeadline =
      BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const failingPayoutDigest =
      await system.vault.protectedPayoutAuthorizationDigest(
        await source.getAddress(),
        failingPayoutDeadline,
      );
    await system.vault.connect(system.creator).registerProtectedPayoutAddress(
      await source.getAddress(),
      failingPayoutDeadline,
      proofFor(failingPayoutDigest),
    );
    await requestUnjailETH(
      system.vault,
      system.creator,
      ethers.parseEther("0.01"),
      await source.getAddress(),
      failingPayoutDeadline,
    );
    const secondRedeemProof = hashChain(system.authorization.seeds.redemption, 254);
    await assert.rejects(
      system.vault
        .connect(system.creator)
        .redeemJailETH(1, secondRedeemProof),
      /PayoutFailed/,
    );
    assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.1"));
    assert.equal(await system.vault.redemptionCommitment(), redeemProof);
    assert.equal(await system.vault.redemptionProofsRemaining(), 255n);
    const cancelDigest =
      await system.vault.pendingRewardOperationCancellationDigest();
    await assert.rejects(
      system.vault.connect(system.creator).cancelPendingRewardOperation(
        proofFor(ethers.id("public-creator-key-cannot-cancel-without-passkey")),
      ),
      /InvalidPasskey/,
    );
    await system.vault
      .connect(system.creator)
      .cancelPendingRewardOperation(proofFor(cancelDigest));
    assert.equal(await system.vault.balanceOf(system.creator.address), ethers.parseEther("0.1"));
    const finalBacking = await system.vault.backingStatus();
    assert.equal(finalBacking.ethBalance, finalBacking.liabilities);
    assert.equal(finalBacking.solvent, true);
    assert.notEqual(initialRedemptionCommitment, redeemProof);
  });

  it("immediately issues every creator reward credit as fully backed JailETH", async function () {
    const system = await deployRewardSystem(creators[11], 100, "deposit-triggered-issuance");

    const routerAddress = await system.router.getAddress();
    await network.provider.send("hardhat_setBalance", [
      routerAddress,
      "0x3635C9ADC5DEA00000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [routerAddress]);
    const routerSigner = await ethers.getSigner(routerAddress);
    const creditRewards = async (amount, label) => {
      await system.vault.connect(routerSigner).creditCreatorRewards(
        system.launchId,
        ethers.id(label),
        { value: amount },
      );
    };

    try {
      await creditRewards(ethers.parseEther("0.009"), "pons-below-threshold");
      assert.equal(await system.vault.thresholdClaimableRewards(), 0n);
      assert.equal(
        await system.vault.balanceOf(system.creator.address),
        ethers.parseEther("0.009"),
      );
      assert.equal(await system.vault.accruedRewards(), 0n);

      await creditRewards(ethers.parseEther("0.001"), "pons-exact-threshold");
      assert.equal(await system.vault.thresholdClaimableRewards(), 0n);
      assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.01"));

      await creditRewards(ethers.parseEther("0.015"), "pons-multiple-thresholds");
      assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.025"));
      assert.equal(await system.vault.accruedRewards(), 0n);

      await assert.rejects(
        system.vault.connect(creators[12]).requestPonsThresholdRewardClaim(),
        /AutomaticIssuanceOnly/,
      );

      await system.vault.connect(ownerSigner).setPauseStates(false, true, false);
      await creditRewards(ethers.parseEther("0.004"), "issuance-paused-ready");
      assert.equal(await system.vault.accruedRewards(), ethers.parseEther("0.004"));
      assert.equal(await system.vault.thresholdClaimableRewards(), 0n);
      assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.025"));
      await system.vault.connect(ownerSigner).setPauseStates(false, false, false);
      await creditRewards(ethers.parseEther("0.001"), "issuance-resumed-next-deposit");
      assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.03"));
      assert.equal(await system.vault.accruedRewards(), 0n);
    } finally {
      await network.provider.send("hardhat_stopImpersonatingAccount", [routerAddress]);
    }
  });

  it("lets the authorized upgrader issue pre-upgrade accrued rewards without a new fee credit", async function () {
    const system = await deployRewardSystem(creators[15], 100, "creator-reward-backfill");
    const routerAddress = await system.router.getAddress();
    await network.provider.send("hardhat_setBalance", [
      routerAddress,
      "0x3635C9ADC5DEA00000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [routerAddress]);
    const routerSigner = await ethers.getSigner(routerAddress);
    const pending = ethers.parseEther("0.010240587056356629");
    try {
      await system.vault.connect(ownerSigner).setPauseStates(false, true, false);
      await system.vault.connect(routerSigner).creditCreatorRewards(
        system.launchId,
        ethers.id("pre-upgrade-accrued-reward"),
        { value: pending },
      );
      assert.equal(await system.vault.accruedRewards(), pending);
      await system.vault.connect(ownerSigner).setPauseStates(false, false, false);
      await system.vault.connect(ownerSigner).migrateAccruedRewardsToJailETH();
      assert.equal(await system.vault.accruedRewards(), 0n);
      assert.equal(await system.vault.balanceOf(system.creator.address), pending);
      assert.equal(await system.vault.totalSupply(), pending);
    } finally {
      await network.provider.send("hardhat_stopImpersonatingAccount", [routerAddress]);
    }
  });

  it("jailbreak writes off creator claims, cancels pending Unjail, and sends assets only to the fixed treasury", async function () {
    await factory.connect(ownerSigner).setInstanceEmergencyWithdrawer(creators[8].address);
    const system = await deployRewardSystem(creators[13], 100, "creator-jailbreak");
    const routerAddress = await system.router.getAddress();
    await network.provider.send("hardhat_setBalance", [
      routerAddress,
      "0x3635C9ADC5DEA00000",
    ]);
    await network.provider.send("hardhat_impersonateAccount", [routerAddress]);
    const routerSigner = await ethers.getSigner(routerAddress);
    try {
      await system.vault.connect(routerSigner).creditCreatorRewards(
        system.launchId,
        ethers.id("jailbreak-accrued-rewards"),
        { value: ethers.parseEther("0.025") },
      );
      await system.vault.connect(routerSigner).creditCreatorRewards(
        system.launchId,
        ethers.id("jailbreak-issue-jaileth"),
        { value: 1n },
      );
    } finally {
      await network.provider.send("hardhat_stopImpersonatingAccount", [routerAddress]);
    }

    assert.equal(await system.vault.totalSupply(), ethers.parseEther("0.025000000000000001"));
    assert.equal(await system.vault.accruedRewards(), 0n);
    const recipient = creators[14];
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const payoutDigest = await system.vault.protectedPayoutAuthorizationDigest(
      recipient.address,
      deadline,
    );
    await system.vault.connect(system.creator).registerProtectedPayoutAddress(
      recipient.address,
      deadline,
      proofFor(payoutDigest),
    );
    await requestUnjailETH(
      system.vault,
      system.creator,
      ethers.parseEther("0.01"),
      recipient.address,
      deadline,
    );
    assert.notEqual(
      (await system.vault.pendingRewardOperation()).operation,
      0n,
    );

    const vaultAddress = await system.vault.getAddress();
    const tokenAddress = await launchToken.getAddress();
    await launchToken.connect(ownerSigner).transfer(vaultAddress, 1234n);
    await assert.rejects(
      system.vault.connect(system.creator).jailbreak(ethers.ZeroAddress),
      /AccessControlUnauthorizedAccount/,
    );
    await assert.rejects(
      system.vault.connect(ownerSigner).jailbreak(ethers.ZeroAddress),
      /AccessControlUnauthorizedAccount/,
    );

    const nativeTx = await system.vault.connect(creators[8]).jailbreak(ethers.ZeroAddress);
    const nativeReceipt = await nativeTx.wait();
    const nativeEvent = nativeReceipt.logs
      .map((log) => {
        try {
          return system.vault.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "JailbreakExecuted");
    assert.ok(nativeEvent);
    assert.equal(nativeEvent.args.asset, ethers.ZeroAddress);
    assert.equal(nativeEvent.args.destination, owner);
    assert.equal(nativeEvent.args.amount, ethers.parseEther("0.025000000000000001"));
    assert.equal(
      nativeEvent.args.cancelledAccruedRewards,
      ethers.parseEther("0.005000000000000001"),
    );
    assert.equal(nativeEvent.args.cancelledJailETH, ethers.parseEther("0.02"));
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.vault.totalSupply(), 0n);
    assert.equal((await system.vault.pendingRewardOperation()).operation, 0n);
    assert.equal(await ethers.provider.getBalance(vaultAddress), 0n);
    assert.equal(
      await system.vault.lifetimeJailbreakLoss(),
      ethers.parseEther("0.025000000000000001"),
    );

    const treasuryTokensBefore = await launchToken.balanceOf(owner);
    await system.vault.connect(creators[8]).jailbreak(tokenAddress);
    assert.equal(await launchToken.balanceOf(vaultAddress), 0n);
    assert.equal(await launchToken.balanceOf(owner), treasuryTokensBefore + 1234n);
  });

  it("jailbreak cancels queued fee distributions and does not replay them", async function () {
    await factory.connect(ownerSigner).setInstanceEmergencyWithdrawer(creators[8].address);
    const system = await deployRewardSystem(creators[15], 100, "router-jailbreak");
    const routerAddress = await system.router.getAddress();
    const distributionId = ethers.id("router-jailbreak-pending-batch");
    await source.collectAdditional(
      await system.router.getAddress(),
      ethers.parseEther("1"),
      distributionId,
      { value: ethers.parseEther("0.01") },
    );
    assert.equal(
      await system.router.ethereumAdditionalTaxAccrued(),
      ethers.parseEther("0.01"),
    );

    const tokenAddress = await launchToken.getAddress();
    await launchToken.connect(ownerSigner).transfer(routerAddress, 4321n);
    await assert.rejects(
      system.router.connect(system.creator).jailbreak(ethers.ZeroAddress),
      /AccessControlUnauthorizedAccount/,
    );
    await assert.rejects(
      system.router.connect(ownerSigner).jailbreak(ethers.ZeroAddress),
      /AccessControlUnauthorizedAccount/,
    );
    const tx = await system.router.connect(creators[8]).jailbreak(ethers.ZeroAddress);
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return system.router.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((log) => log?.name === "JailbreakExecuted");
    assert.ok(event);
    assert.equal(event.args.cancelledEthereumTax, ethers.parseEther("0.01"));
    assert.equal(event.args.cancelledPlatformFees, 0n);
    assert.equal(await system.router.ethereumAdditionalTaxAccrued(), 0n);
    assert.equal(await ethers.provider.getBalance(routerAddress), 0n);
    assert.equal(await system.vault.accruedRewards(), 0n);
    assert.equal(await system.router.lifetimeJailbreakCancelled(), ethers.parseEther("0.01"));
    await assert.rejects(
      source.collectAdditional(
        await system.router.getAddress(),
        ethers.parseEther("1"),
        distributionId,
        { value: ethers.parseEther("0.01") },
      ),
      /DuplicateDistribution/,
    );

    const treasuryTokensBefore = await launchToken.balanceOf(owner);
    await system.router.connect(creators[8]).jailbreak(tokenAddress);
    assert.equal(await launchToken.balanceOf(routerAddress), 0n);
    assert.equal(await launchToken.balanceOf(owner), treasuryTokensBefore + 4321n);
  });

  it("recovers hash-chain state only by advancing to a precommitted epoch", async function () {
    const system = await deployRewardSystem(creators[9], 200, "authorization-recovery");
    const next = system.authorization.epochs[1];
    const recoveryProof = hashChain(system.authorization.seeds.recovery, 255);

    await assert.rejects(
      system.vault.connect(creators[10]).recoverAuthorization(
        1,
        next.commitments.claim,
        next.commitments.redemption,
        next.commitments.rotation,
        next.commitments.recovery,
        recoveryProof,
        next.merkleProof,
      ),
      /InvalidAuthorizationProof/,
    );

    await assert.rejects(
      system.vault.connect(system.creator).recoverAuthorization(
        1,
        ethers.id("uncommitted-claim-root"),
        next.commitments.redemption,
        next.commitments.rotation,
        next.commitments.recovery,
        recoveryProof,
        next.merkleProof,
      ),
      /InvalidEpochProof/,
    );
    assert.equal(await system.vault.authorizationEpoch(), 1n);

    await system.vault.connect(system.creator).recoverAuthorization(
      1,
      next.commitments.claim,
      next.commitments.redemption,
      next.commitments.rotation,
      next.commitments.recovery,
      recoveryProof,
      next.merkleProof,
    );
    assert.equal(await system.vault.authorizationEpoch(), 2n);
    assert.equal(await system.vault.claimCommitment(), next.commitments.claim);
    assert.equal(await system.vault.claimProofsRemaining(), 256n);
    await assert.rejects(
      system.vault.connect(system.creator).recoverAuthorization(
        1,
        next.commitments.claim,
        next.commitments.redemption,
        next.commitments.rotation,
        next.commitments.recovery,
        recoveryProof,
        next.merkleProof,
      ),
      /StaleAuthorizationEpoch/,
    );
  });

  it("validates upgrade layout and preserves vault liabilities", async function () {
    const system = await deployRewardSystem(creators[8], 350, "upgrade");
    await source.collect(
      await system.router.getAddress(),
      ethers.parseEther("100"),
      ethers.id("upgrade-test"),
      { value: ethers.parseEther("4.5") },
    );
    const oldFactory = await ethers.getContractFactory("CreatorRewardVault");
    const v2Factory = await ethers.getContractFactory("CreatorRewardVaultV2");
    await upgrades.validateUpgrade(oldFactory, v2Factory, {
      kind: "uups",
      // This test-only reinitializer intentionally must not reset inherited token/EIP-712 state.
      unsafeAllow: ["missing-initializer-call"],
    });
    const v2Address = await deployVanity(
      helper,
      await initCodeFor("CreatorRewardVaultV2"),
    );
    const beforeRewards = await system.vault.accruedRewards();
    const beforeJailEthSupply = await system.vault.totalSupply();
    await (
      await system.vault.connect(ownerSigner).upgradeToAndCall(v2Address, "0x")
    ).wait();
    const upgraded = await ethers.getContractAt(
      "CreatorRewardVaultV2",
      await system.vault.getAddress(),
    );
    assert.equal(await upgraded.implementationVersionForTest(), 2n);
    assert.equal(await upgraded.accruedRewards(), beforeRewards);
    assert.equal(await upgraded.totalSupply(), beforeJailEthSupply);
    const backing = await upgraded.backingStatus();
    assert.equal(backing.ethBalance, backing.liabilities);
  });

  it("verifies real WebAuthn/P-256 assertions and rejects a mismatched RP ID", async function () {
    const verifierInitCode = await initCodeFor("ArmoreumPasskeyVerifier");
    const verifierAddress = await deployVanity(helper, verifierInitCode);
    verifier = await ethers.getContractAt("ArmoreumPasskeyVerifier", verifierAddress);

    const { p256 } = await import("@noble/curves/p256");
    const privateKey = new Uint8Array(32);
    privateKey[31] = 7;
    const publicKey = p256.getPublicKey(privateKey, false);
    const publicKeyX = ethers.hexlify(publicKey.slice(1, 33));
    const publicKeyY = ethers.hexlify(publicKey.slice(33, 65));
    const challenge = ethers.id("web-authn-challenge");
    const challengeText = Buffer.from(challenge.slice(2), "hex").toString("base64url");
    const clientDataJSON = JSON.stringify({
      type: "webauthn.get",
      challenge: challengeText,
      origin: `https://${RP_ID}`,
      crossOrigin: false,
    });
    const authenticatorData = Buffer.concat([
      Buffer.from(RP_ID_HASH.slice(2), "hex"),
      Buffer.from([0x05, 0, 0, 0, 1]),
    ]);
    const signedMessage = createHash("sha256")
      .update(
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(clientDataJSON).digest(),
        ]),
      )
      .digest();
    const signature = p256.sign(signedMessage, privateKey, { prehash: false });
    assert.equal(p256.verify(signature, signedMessage, publicKey, { prehash: false }), true);
    const curveOrder =
      0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    const normalizedS = signature.s > curveOrder / 2n ? curveOrder - signature.s : signature.s;
    assert.equal(
      p256.verify({ r: signature.r, s: normalizedS }, signedMessage, publicKey, { prehash: false }),
      true,
    );
    const assertion = coder.encode(
      ["bytes32", "bytes32", "uint256", "uint256", "bytes", "string"],
      [
        ethers.toBeHex(signature.r, 32),
        ethers.toBeHex(normalizedS, 32),
        clientDataJSON.indexOf('"challenge":"'),
        clientDataJSON.indexOf('"type":"webauthn.get"'),
        authenticatorData,
        clientDataJSON,
      ],
    );

    assert.equal(
      await verifier.verify(challenge, assertion, RP_ID_HASH, publicKeyX, publicKeyY),
      true,
    );
    assert.equal(
      await verifier.verify(
        challenge,
        assertion,
        ethers.id("wrong-rp-id"),
        publicKeyX,
        publicKeyY,
      ),
      false,
    );
    assert.equal(
      await verifier.verify(challenge, "0x1234", RP_ID_HASH, publicKeyX, publicKeyY),
      false,
    );
  });

  it("creates the Creator and fee proxies through VaultFactory and registers the token mapping", async function () {
    const implementationAddress = await deployVanity(
      helper,
      await initCodeFor("VaultFactory"),
    );
    const vaultRegistryFactory = await ethers.getContractFactory("VaultFactory");
    const initialization = vaultRegistryFactory.interface.encodeFunctionData(
      "initialize",
      [owner, await factory.instanceEmergencyWithdrawer(), factoryAddress],
    );
    const proxyInitCode = await helper.proxyInitCode(implementationAddress, initialization);
    const proxyAddress = await deployVanity(helper, proxyInitCode);
    vaultRegistry = await ethers.getContractAt("VaultFactory", proxyAddress, ownerSigner);
    assert.equal(await vaultRegistry.launchFactory(), factoryAddress);
    assert.equal(
      await vaultRegistry.emergencyOperator(),
      await factory.instanceEmergencyWithdrawer(),
    );
    await (await vaultRegistry.setImplementations(
      vaultImplementation,
      routerImplementation,
      1,
    )).wait();
    assert.equal(await vaultRegistry.creatorVaultImplementation(), vaultImplementation);
    assert.equal(await vaultRegistry.feeVaultImplementation(), routerImplementation);
    await (await factory.setVaultFactory(proxyAddress)).wait();

    const creator = creators[8];
    const token = await (
      await ethers.getContractFactory("MockLaunchToken")
    ).deploy(owner, ethers.parseEther("1000000"));
    await token.waitForDeployment();
    const system = await deployRewardSystem(
      creator,
      350,
      "vault-factory-integrated-reward",
      { launchToken: await token.getAddress() },
    );
    const registered = await vaultRegistry.getVaultSet(system.config.launchId);
    assert.equal(registered.registered, true);
    assert.equal(registered.token, await token.getAddress());
    assert.equal(registered.creator, creator.address);
    assert.equal(registered.creatorVault, await system.vault.getAddress());
    assert.equal(registered.feeVault, await system.router.getAddress());
    assert.equal(registered.bridgeVault, ethers.ZeroAddress);
    assert.equal(await vaultRegistry.creatorVaultByLaunch(system.config.launchId), registered.creatorVault);
    assert.equal(await vaultRegistry.feeVaultByLaunch(system.config.launchId), registered.feeVault);
  });

  it("creates a launch-specific Bridge Vault and wires the complete Pons vault set", async function () {
    const vaultFactoryImplementation = await deployVanity(
      helper,
      await initCodeFor("VaultFactory"),
    );
    const vaultFactoryContract = await ethers.getContractFactory("VaultFactory");
    const vaultFactoryInitialization = vaultFactoryContract.interface.encodeFunctionData(
      "initialize",
      [owner, await factory.instanceEmergencyWithdrawer(), factoryAddress],
    );
    const vaultFactoryProxyInitCode = await helper.proxyInitCode(
      vaultFactoryImplementation,
      vaultFactoryInitialization,
    );
    const vaultFactoryAddress = await deployVanity(helper, vaultFactoryProxyInitCode);
    vaultRegistry = vaultFactoryContract.attach(vaultFactoryAddress).connect(ownerSigner);
    await (await vaultRegistry.setImplementations(
      vaultImplementation,
      routerImplementation,
      1,
    )).wait();
    await (await factory.setVaultFactory(vaultFactoryAddress)).wait();

    const creator = creators[9];
    const additionalTaxBps = 350;
    const label = "vault-factory-pons-bridge-integration";
    const launchId = ethers.id(`${label}-${creator.address}-${additionalTaxBps}`);
    const token = await (
      await ethers.getContractFactory("MockLaunchToken")
    ).deploy(owner, ethers.parseEther("1000000"));
    await token.waitForDeployment();

    const manager = await (
      await ethers.getContractFactory("MockVaultFactoryPoolManager")
    ).deploy();
    await manager.waitForDeployment();
    const managerAddress = await manager.getAddress();
    const hook = await deployTestContract(
      helper,
      "MockPonsV2Hook",
      managerAddress,
      await ponsEscrow.getAddress(),
    );
    const poolKey = {
      currency0: ethers.ZeroAddress,
      currency1: await token.getAddress(),
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    const vaultRegistryAddress = await vaultRegistry.getAddress();
    const createBridgeTx = await vaultRegistry.connect(creator).createBridgeVault(
      launchId,
      await token.getAddress(),
      creator.address,
      managerAddress,
      poolKey,
      4295128740n,
    );
    const createBridgeReceipt = await createBridgeTx.wait();
    const bridgeVaultAddress = await vaultRegistry.bridgeVaultByLaunch(launchId);
    const firstBridgeCreationEvents = createBridgeReceipt.logs
      .filter((log) => log.address.toLowerCase() === vaultRegistryAddress.toLowerCase())
      .map((log) => {
        try {
          return vaultRegistry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "BridgeVaultCreated");
    assert.equal(firstBridgeCreationEvents.length, 1);

    assert.equal(
      await vaultRegistry.connect(creator).createBridgeVault.staticCall(
        launchId,
        await token.getAddress(),
        creator.address,
        managerAddress,
        poolKey,
        4295128740n,
      ),
      bridgeVaultAddress,
    );
    const bridgeRetryReceipt = await (
      await vaultRegistry.connect(creator).createBridgeVault(
        launchId,
        await token.getAddress(),
        creator.address,
        managerAddress,
        poolKey,
        4295128740n,
      )
    ).wait();
    const retryBridgeCreationEvents = bridgeRetryReceipt.logs
      .filter((log) => log.address.toLowerCase() === vaultRegistryAddress.toLowerCase())
      .map((log) => {
        try {
          return vaultRegistry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "BridgeVaultCreated");
    assert.equal(retryBridgeCreationEvents.length, 0);
    await assert.rejects(
      vaultRegistry.connect(creator).createBridgeVault.staticCall(
        launchId,
        await token.getAddress(),
        creator.address,
        managerAddress,
        poolKey,
        4295128741n,
      ),
      /DuplicateLaunch/,
    );

    const bridgeVault = await ethers.getContractAt(
      "ArmoreumBridgeVault",
      bridgeVaultAddress,
    );
    await (await factory.setTaxSourceApproval(await hook.getAddress(), true)).wait();
    const system = await deployRewardSystem(
      creator,
      additionalTaxBps,
      label,
      {
        taxSource: await hook.getAddress(),
        taxDistributionMode: 3,
        launchToken: await token.getAddress(),
        buybackExecutor: bridgeVaultAddress,
        bridgeVault: bridgeVaultAddress,
      },
    );

    const registered = await vaultRegistry.getVaultSet(launchId);
    assert.equal(registered.registered, true);
    assert.equal(registered.bridgeVault, bridgeVaultAddress);
    assert.equal(registered.feeVault, await system.router.getAddress());
    assert.equal(registered.creatorVault, await system.vault.getAddress());
    assert.equal(await bridgeVault.taxRouter(), registered.feeVault);

    const jailTokenImplementation = await deployVanity(
      helper,
      await initCodeFor("JailToken"),
    );
    const jailEthImplementation = await deployVanity(
      helper,
      await initCodeFor("JailETHReceipt"),
    );
    const jailTokenFactoryImplementation = await deployVanity(
      helper,
      await initCodeFor("JailTokenFactory"),
    );
    const jailTokenFactoryContract = await ethers.getContractFactory("JailTokenFactory");
    const jailTokenFactoryInitialization =
      jailTokenFactoryContract.interface.encodeFunctionData(
        "initializeWithJailEth",
        [owner, owner, jailTokenImplementation, jailEthImplementation],
      );
    const jailTokenFactoryProxyInitCode = await helper.proxyInitCode(
      jailTokenFactoryImplementation,
      jailTokenFactoryInitialization,
    );
    const jailTokenFactoryAddress = await deployVanity(helper, jailTokenFactoryProxyInitCode);
    const jailFactory = jailTokenFactoryContract
      .attach(jailTokenFactoryAddress)
      .connect(ownerSigner);
    await (await jailFactory.setLaunchFactory(await vaultRegistry.getAddress(), true)).wait();

    const jailSwapImplementation = await deployVanity(
      helper,
      await initCodeFor("JailSwapVault"),
    );
    await (await vaultRegistry.setJailSwapImplementations(
      jailSwapImplementation,
      jailTokenFactoryAddress,
      1,
    )).wait();

    const buyLimit = 4295128740n;
    const sellLimit = 1461446703485210103287273052203988822378723970341n;
    const jailSwapDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const jailSwapDigest = await factory.connect(creator).jailSwapSetupAuthorizationDigest(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
    );
    const jailSwapAssertion = proofFor(jailSwapDigest);
    await assert.rejects(
      factory.connect(creator).createJailSwapSystem(
        launchId,
        managerAddress,
        poolKey,
        buyLimit,
        sellLimit,
        jailSwapDeadline,
        proofFor(ethers.id("invalid-jailswap-setup")),
      ),
      /InvalidPasskey/,
    );
    const predictedJailSwap = await factory.connect(creator).createJailSwapSystem.staticCall(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
      jailSwapAssertion,
    );
    await (await factory.connect(creator).createJailSwapSystem(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
      jailSwapAssertion,
    )).wait();

    assert.equal(
      await vaultRegistry.jailSwapVaultByLaunch(launchId),
      predictedJailSwap.vault,
    );
    assert.equal(
      await vaultRegistry.jailTokenByLaunch(launchId),
      predictedJailSwap.jailToken,
    );
    assert.equal(
      await vaultRegistry.jailEthReceiptByLaunch(launchId),
      predictedJailSwap.jailEthReceipt,
    );
    assert.equal(await jailFactory.jailTokens(launchId), predictedJailSwap.jailToken);
    assert.equal(
      await jailFactory.jailEthReceipts(launchId),
      predictedJailSwap.jailEthReceipt,
    );
    const completedVaultSet = await vaultRegistry.getVaultSet(launchId);
    assert.equal(completedVaultSet.creatorVault, await system.vault.getAddress());
    assert.equal(completedVaultSet.feeVault, await system.router.getAddress());
    assert.equal(completedVaultSet.bridgeVault, bridgeVaultAddress);

    const retryJailSwapReceipt = await (
      await factory.connect(creator).createJailSwapSystem(
        launchId,
        managerAddress,
        poolKey,
        buyLimit,
        sellLimit,
        0,
        "0x",
      )
    ).wait();
    const retryJailSwapEvents = retryJailSwapReceipt.logs
      .filter((log) => log.address.toLowerCase() === vaultRegistryAddress.toLowerCase())
      .map((log) => {
        try {
          return vaultRegistry.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event) => event?.name === "JailSwapSystemCreated");
    assert.equal(retryJailSwapEvents.length, 0);
  });

  it("creates an idempotent JailSwap system for an Ethereum V4 or Robinhood-compatible launch", async function () {
    const { chainId } = await ethers.provider.getNetwork();
    if (chainId !== 31337n && chainId !== 46630n) this.skip();

    const creator = creators[10];
    const additionalTaxBps = 350;
    const label = "factory-jailswap-v4-launch";
    const launchId = ethers.id(`${label}-${creator.address}-${additionalTaxBps}`);
    const token = await (
      await ethers.getContractFactory("MockLaunchToken")
    ).deploy(owner, ethers.parseEther("1000000"));
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    let managerAddress;
    let hook;
    if (chainId === 31337n) {
      const managerDeployer = await (
        await ethers.getContractFactory("LocalPoolManagerDeployer")
      ).deploy();
      await managerDeployer.waitForDeployment();
      await managerDeployer.deploy(owner);
      managerAddress = await managerDeployer.poolManager();
      hook = await deployHookWithPermissions(
        helper,
        "ArmoreumV4TaxHook",
        managerAddress,
        launchId,
        tokenAddress,
        owner,
      );
    } else {
      const manager = await deployTestContract(
        helper,
        "MockVaultFactoryPoolManager",
      );
      managerAddress = await manager.getAddress();
      hook = await deployTestContract(
        helper,
        "MockPonsV2Hook",
        managerAddress,
        await ponsEscrow.getAddress(),
      );
    }
    await (await factory.setTaxSourceApproval(await hook.getAddress(), true)).wait();

    const vaultFactoryImplementation = await deployVanity(
      helper,
      await initCodeFor("VaultFactory"),
    );
    const vaultFactoryContract = await ethers.getContractFactory("VaultFactory");
    const vaultFactoryInitialization = vaultFactoryContract.interface.encodeFunctionData(
      "initialize",
      [owner, await factory.instanceEmergencyWithdrawer(), factoryAddress],
    );
    const vaultFactoryProxyInitCode = await helper.proxyInitCode(
      vaultFactoryImplementation,
      vaultFactoryInitialization,
    );
    const vaultFactoryAddress = await deployVanity(helper, vaultFactoryProxyInitCode);
    const launchVaultFactory = vaultFactoryContract.attach(vaultFactoryAddress).connect(ownerSigner);
    await (await launchVaultFactory.setImplementations(
      vaultImplementation,
      routerImplementation,
      1,
    )).wait();

    const jailTokenImplementation = await deployVanity(
      helper,
      await initCodeFor("JailToken"),
    );
    const jailEthImplementation = await deployVanity(
      helper,
      await initCodeFor("JailETHReceipt"),
    );
    const jailTokenFactoryImplementation = await deployVanity(
      helper,
      await initCodeFor("JailTokenFactory"),
    );
    const jailTokenFactoryContract = await ethers.getContractFactory("JailTokenFactory");
    const jailTokenFactoryInitialization =
      jailTokenFactoryContract.interface.encodeFunctionData(
        "initializeWithJailEth",
        [owner, owner, jailTokenImplementation, jailEthImplementation],
      );
    const jailTokenFactoryProxyInitCode = await helper.proxyInitCode(
      jailTokenFactoryImplementation,
      jailTokenFactoryInitialization,
    );
    const jailTokenFactoryAddress = await deployVanity(helper, jailTokenFactoryProxyInitCode);
    const jailFactory = jailTokenFactoryContract
      .attach(jailTokenFactoryAddress)
      .connect(ownerSigner);
    await (await jailFactory.setLaunchFactory(vaultFactoryAddress, true)).wait();

    const jailSwapImplementation = await deployVanity(
      helper,
      await initCodeFor("JailSwapVault"),
    );
    await (await launchVaultFactory.setJailSwapImplementations(
      jailSwapImplementation,
      jailTokenFactoryAddress,
      1,
    )).wait();
    await (await factory.setVaultFactory(vaultFactoryAddress)).wait();

    const system = await deployRewardSystem(
      creator,
      additionalTaxBps,
      label,
      {
        launchToken: tokenAddress,
        taxSource: await hook.getAddress(),
        taxDistributionMode: chainId === 46630n ? 2 : 0,
      },
    );
    if (chainId === 31337n) {
      await (await hook.connect(ownerSigner).configureTaxRouter(
        await system.router.getAddress(),
      )).wait();
      assert.equal(await hook.admin(), ethers.ZeroAddress);
    }

    const poolKey = {
      currency0: ethers.ZeroAddress,
      currency1: tokenAddress,
      fee: 3000,
      tickSpacing: 60,
      hooks: await hook.getAddress(),
    };
    const buyLimit = 4295128740n;
    const sellLimit = 1461446703485210103287273052203988822378723970341n;
    const jailSwapDeadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const jailSwapDigest = await factory.connect(creator).jailSwapSetupAuthorizationDigest(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
    );
    const jailSwapAssertion = proofFor(jailSwapDigest);
    const predicted = await factory.connect(creator).createJailSwapSystem.staticCall(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
      jailSwapAssertion,
    );
    await (await factory.connect(creator).createJailSwapSystem(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      jailSwapDeadline,
      jailSwapAssertion,
    )).wait();

    const jailSwapVaultAddress = await launchVaultFactory.jailSwapVaultByLaunch(launchId);
    const jailTokenAddress = await launchVaultFactory.jailTokenByLaunch(launchId);
    const jailEthReceiptAddress = await launchVaultFactory.jailEthReceiptByLaunch(launchId);
    assert.equal(jailSwapVaultAddress, predicted.vault);
    assert.equal(jailTokenAddress, predicted.jailToken);
    assert.equal(jailEthReceiptAddress, predicted.jailEthReceipt);

    const jailSwapVault = await ethers.getContractAt("JailSwapVault", jailSwapVaultAddress);
    const jailToken = await ethers.getContractAt("JailToken", jailTokenAddress);
    const jailEthReceipt = await ethers.getContractAt(
      "JailETHReceipt",
      jailEthReceiptAddress,
    );
    assert.equal(await jailSwapVault.launchToken(), tokenAddress);
    assert.equal(await jailSwapVault.poolManager(), managerAddress);
    assert.equal(await jailSwapVault.jailToken(), jailTokenAddress);
    assert.equal(await jailSwapVault.jailEthReceipt(), jailEthReceiptAddress);
    assert.equal(await jailToken.backingAsset(), tokenAddress);
    assert.equal(await jailToken.vault(), jailSwapVaultAddress);
    assert.equal(await jailEthReceipt.backingAsset(), ethers.ZeroAddress);
    assert.equal(await jailEthReceipt.vault(), jailSwapVaultAddress);
    assert.equal(
      await jailFactory.jailTokens(launchId),
      jailTokenAddress,
    );
    assert.equal(
      await jailFactory.jailEthReceipts(launchId),
      jailEthReceiptAddress,
    );

    const retried = await factory.connect(creator).createJailSwapSystem.staticCall(
      launchId,
      managerAddress,
      poolKey,
      buyLimit,
      sellLimit,
      0,
      "0x",
    );
    assert.deepEqual(
      [retried.vault, retried.jailToken, retried.jailEthReceipt],
      [jailSwapVaultAddress, jailTokenAddress, jailEthReceiptAddress],
    );
    await assert.rejects(
      factory.connect(creator).createJailSwapSystem(
        launchId,
        managerAddress,
        poolKey,
        buyLimit,
        sellLimit - 1n,
        0,
        "0x",
      ),
    );
  });
});
