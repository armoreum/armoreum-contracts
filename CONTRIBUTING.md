# Contributing to Armoreum Contracts

Issues and pull requests are welcome. Start with the README, [source scope](docs/source-scope.md), [security policy](SECURITY.md), and [Code of Conduct](CODE_OF_CONDUCT.md).

## Workflow

1. Fork the repository and branch from `main`.
2. Keep each change focused. Explain storage-layout, authorization, accounting, and upgrade implications.
3. Add tests for the intended behavior and for relevant rejection, replay, and boundary cases.
4. Compile and run the relevant tests in a local, unfunded environment.
5. Open a pull request with the problem, implementation, exact check results, and remaining risks.

## Checks

```sh
npm run compile
npm test
npm run test:readiness
npm run test:startup
node --test scripts/tests/create2-deployment.test.cjs
```

These commands require reviewed dependencies. The source preview contains no original lockfile, so record the dependency resolution used. Run a vulnerability audit and inspect the package before proposing a registry release.

Never run a mainnet deployment, upgrade, repair, or funding script as a contribution check. Never use real keys, secrets, recovery proofs, or customer records in tests. Tests should use synthetic fixtures.

## Security-sensitive changes

Authorization checks, proxy initialization, storage layout, hash-chain state transitions, bridge replay protection, accounting, and role changes require explicit reasoning and focused regression tests. Source availability is not a substitute for independent security review.

Report vulnerabilities privately to **support@armoreum.io**, not in a public issue.

## Licensing and communication

Use English for code comments, documentation, issues, and pull requests. Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Contributions must be your own work or properly licensed. Project-owned contributions are submitted under the MIT License; preserve upstream licenses and notices.
