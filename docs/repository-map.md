# Cross-repository source inventory

## Current state

The public application and contract repositories cover the two supplied package archives. They are not a complete export of the full system.

The source-grounded seven-repository map and missing-runtime evidence are maintained in the [application repository inventory](https://github.com/armoreum/armoreum/blob/main/docs/repository-map.md).

## Artifact-based publication layout

| Repository | Evidence and status |
| --- | --- |
| `armoreum` | Supplied frontend package; published source preview |
| `armoreum-contracts` | Supplied contract package; published source preview |
| `armoreum-authorization` | Existing hash-chain/password/signing libraries and verifier contracts extracted with provenance |
| `armoreum-recovery` | Existing QRC libraries, shared source dependency, and tests extracted with provenance |
| `armoreum-bridge` | Existing bridge/relay contracts with local import closure and explorer/retry/error helpers |
| `armoreum-launchpad` | Existing token-deployer/V4/launch contract closure and routing/funding helpers |
| `armoreum-docs` | Supplied overview, architecture, product scope, security, and economic reference |

The five additional repositories are module/documentation extractions, not five recovered original workspace packages. Shared copies have source-path and checksum manifests. The absent backend, client/schema packages, database, and API specification are not fabricated.

## Contract-side dependencies beyond this repository

`scripts/activate-atomic-relay.cjs` imports an API-server policy implementation at `../../../artifacts/api-server/src/lib/bridgeRelayPolicy.ts`.

`scripts/upgrade-launch-mode-policy-mainnet.cjs` reads `../api-zod/src/network-config.ts` through `readPonsFactoryFromApiConfig()`.

Neither referenced source file is supplied. Scripts that load deployment manifests also require installation-specific records that were deliberately excluded from public source.

## Source coverage

All 96 supplied non-generated code file paths are retained: 46 Solidity files and 50 CommonJS files. No additional package manifests or nested source archives were found in the contract ZIP. This is a file-path coverage statement, not a full compilation, integration-test, audit, or deployment guarantee.

## Remaining system limits

Seven artifact-based source repositories do not establish a complete running system. The missing server, shared API packages, database schema/migrations, and OpenAPI inputs would still be needed for full-stack restoration.

Do not include real credentials, signer keys, recovery proofs, database exports, user data, or operational history in that source export.

Support: **support@armoreum.io**.
