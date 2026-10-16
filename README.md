# Armoreum Contracts

Solidity source for Armoreum creator vaults, reward accounting, token launch infrastructure, and cross-chain bridge components.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Source preview](https://img.shields.io/badge/Status-Source%20preview-orange.svg)](docs/source-scope.md)

[Application](https://github.com/armoreum/armoreum) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Releases](https://github.com/armoreum/armoreum-contracts/releases) · [Support](mailto:support@armoreum.io)

## Release status

This repository publishes the supplied contract source and development scripts for review and contribution. **It is not an audit, a verified production deployment, or authorization to send mainnet transactions.** Contract compilation and integration tests must be completed in a reviewed dependency environment before deployment.

Live deployment manifests, deployment history, cached compiler outputs, build artifacts, and operational records are intentionally not part of this public source release. Some operator scripts require those records. One relay activation script also depends on API-server policy code that was not included in the source archive; see [source scope](docs/source-scope.md).

## Components

| Area | Source |
| --- | --- |
| Creator rewards and protected withdrawals | `CreatorRewardVault.sol`, `JailReceiptToken.sol` |
| Vault and token factories | `ArmoreumFactory.sol`, `VaultFactory.sol`, `JailTokenFactory.sol` |
| Personal vaults | `PersonalJailVault.sol`, `PersonalJailVaultFactory.sol` |
| Token deployment and fee routing | `ArmoreumTokenDeployer*.sol`, `TaxRouter.sol` |
| Hash-chain authorization | `contracts/libraries/AuthorizationHashChain.sol` |
| Conventional passkey verification | `ArmoreumPasskeyVerifier.sol` |
| Bridge, relay, and multichain modules | `contracts/bridge/` |
| V4 hooks and launch seeding | `contracts/v4/` |
| Local adapters and test helpers | `contracts/local/`, `contracts/test/` |

The presence of source does not prove that every component is deployed or enabled.

## Development

Prerequisites: a compatible Node.js version, npm, network access to dependency registries and Solidity compilers, and an independently reviewed dependency resolution. No signing key is needed for compilation or in-process tests.

```sh
npm install --ignore-scripts
npm run compile
npm test
npm run test:readiness
npm run test:startup
node --test scripts/tests/create2-deployment.test.cjs
```

The supplied archive had no lockfile. Review dependency resolution and audit results before trusting a new installation; the source preview does not claim a reproducible build or a clean vulnerability audit.

`hardhat.config.cjs` configures Solidity 0.8.26 and 0.8.28 with optimization and IR compilation. Inspect that file before changing compiler settings.

## Local chains and operational scripts

Local fixtures use Ethereum chain ID `31337` on port `8545` and Robinhood fixture chain ID `46630` on port `8546`. They are distinct from production chain IDs `1` and `4663`.

```sh
npm run local:ethereum:node
# In another terminal:
npm run local:robinhood:node
```

See [LOCAL-MULTICHAIN.md](LOCAL-MULTICHAIN.md) for the original workspace integration guide. Its full-stack portions depend on the API server and workspace layout, which are not included here.

Scripts named `deploy:*`, `upgrade:*`, `fund-*`, `repair-*`, and relay activation scripts can change state or spend funds when configured. **Do not run them casually.** Do not supply live keys while exploring source. Operator configuration, contract roles, destination addresses, chain identity, dry-run results, and recovery procedures require separate review.

Configuration values are read from process environment variables. `.env.example` lists selected names without credentials; Hardhat is not configured to load `.env` automatically. Inject secrets using an appropriate secret manager. Never commit them.

## Security boundaries

- Hash preimage authorization is an additional protection mechanism, not blanket post-quantum security.
- ECDSA remains relevant to wallet signing, administration, and conventional authorization.
- Source code does not establish deployed proxy implementations, administrator roles, current balances, bridge configuration, or settlement.
- Hash-chain proofs and recovery files are sensitive; do not include real values in public examples.
- An approval, source submission, confirmed lock, and destination delivery are different events.

Read [SECURITY.md](SECURITY.md) before testing with assets.

## Releases and packages

The initial release, `v0.1.0-source.1`, is a **source-only prerelease** distributed through GitHub's tagged ZIP and TAR archives. It is not an npm or GitHub Packages registry publication. `private: true` prevents accidental npm publication; it does not restrict this repository's public MIT-licensed source.

The `files` allowlist in `package.json` limits an intentional future package to contract sources and license documentation. Registry publication should happen only after compilation, tests, dependency/license review, package inspection, and a separate release decision.

## Related resources

- [Armoreum application source](https://github.com/armoreum/armoreum)
- [OpenZeppelin documentation](https://docs.openzeppelin.com/)
- [LayerZero documentation](https://docs.layerzero.network/)
- [Uniswap V4 documentation](https://docs.uniswap.org/contracts/v4/overview)
- [Ethereum explorer](https://etherscan.io/)
- [Robinhood explorer](https://robin.etherscan.io/)

Explorer links are reference resources, not verification of a particular deployment.

## Contributing, support, and license

Issues and pull requests are open to contributors. Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

General support: **support@armoreum.io**.

Project-owned code is provided under the [MIT License](LICENSE). Imported upstream code and dependencies retain their own licenses; this release does not relicense them. See [NOTICE.md](NOTICE.md).
