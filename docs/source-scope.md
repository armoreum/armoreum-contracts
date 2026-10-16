# Source scope

This release contains project contract sources, test fixtures, development scripts, and selected technical documentation from the supplied archive.

## Deliberately excluded

- Compiler artifacts, build-info, cached storage layouts, and validation caches.
- Production and local deployment manifests, vanity-search records, partial deployment state, and historical receipts.
- Operational audit reports and deployment runbooks specific to an existing installation.
- Credentials, environment values, recovery material, database contents, and Git history.

Public chain addresses remaining in source or tests are public identifiers, not private credentials. No claims about their current deployment status are made.

## Known integration dependencies

Operator scripts commonly load `deployments/` records. Those records must be created or supplied privately for an operator's own environment; they are not copied into this source release.

`scripts/activate-atomic-relay.cjs` imports `bridgeRelayPolicy.ts` from an API-server workspace outside this repository. That API-server source was not supplied. The script is retained for source transparency, not advertised as independently runnable.

`LOCAL-MULTICHAIN.md` describes an original full-stack workspace. Its backend integration instructions require the missing server and workspace structure. The local Hardhat node commands in the main README do not themselves restore that full stack.

The archive did not include a dependency lockfile. Compilation, full contract tests, an independently reviewed dependency resolution, third-party license review, and a vulnerability audit are prerequisites to a deployable package. No production deployment is performed by this source publication.
