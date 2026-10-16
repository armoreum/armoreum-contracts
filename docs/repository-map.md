# Cross-repository source inventory

## Current state

The public application and contract repositories cover the two supplied package archives. They are not a complete export of the full system.

The detailed evidence and proposed seven-area publication map are maintained in the [application repository inventory](https://github.com/armoreum/armoreum/blob/main/docs/repository-map.md).

## Seven-area proposed layout

| Repository / proposed repository | Evidence and status |
| --- | --- |
| `armoreum` | Supplied frontend package; published source preview |
| `armoreum-contracts` | Supplied contract package; published source preview |
| `armoreum-api` | API-server path directly referenced by a relay script; implementation absent |
| `armoreum-api-client` | `@workspace/api-client-react` directly imported by the application; implementation absent |
| `armoreum-api-schemas` | `@workspace/api-zod` imported by the application and network configuration read by an operator script; implementation absent |
| `armoreum-database` | PostgreSQL responsibility described in the supplied overview; separate source package not confirmed |
| `armoreum-api-spec` | OpenAPI/generation responsibility described in the overview; separate source package not confirmed |

The five proposed names are not claims that those repositories or original standalone packages have been recovered. Database and specification source might be located inside another package in the original workspace.

## Contract-side dependencies beyond this repository

`scripts/activate-atomic-relay.cjs` imports an API-server policy implementation at `../../../artifacts/api-server/src/lib/bridgeRelayPolicy.ts`.

`scripts/upgrade-launch-mode-policy-mainnet.cjs` reads `../api-zod/src/network-config.ts` through `readPonsFactoryFromApiConfig()`.

Neither referenced source file is supplied. Scripts that load deployment manifests also require installation-specific records that were deliberately excluded from public source.

## Source coverage

All 96 supplied non-generated code file paths are retained: 46 Solidity files and 50 CommonJS files. No additional package manifests or nested source archives were found in the contract ZIP. This is a file-path coverage statement, not a full compilation, integration-test, audit, or deployment guarantee.

## Next prerequisite

The complete original workspace is needed to establish the remaining package boundaries and recover real source. Creating five empty repositories or copying unrelated modules into them would not make the system complete.

Do not include real credentials, signer keys, recovery proofs, database exports, user data, or operational history in that source export.

Support: **support@armoreum.io**.
