# Source publication checks

The following checks were performed against the initial source preview:

- `node --test scripts/tests/*.test.cjs`: 23 passed, 0 failed.
- All retained CommonJS files passed `node --check`.
- `npm pack --dry-run --ignore-scripts --json`: 50 files in the source-package allowlist; contract sources and package/license documentation only.
- Package configuration JSON parsed successfully.
- Compiler output, caches, deployment manifests, historical records, and environment values were excluded.
- Gitleaks 8.26.0 was run against the prepared source. Five generic-key matches were checked and identified as public 20-byte EVM addresses, not signing credentials. The repository configuration excludes that exact address format while preserving default secret rules.

The helper tests used ethers 6.17.0 in an isolated validation environment. An audit of that validation tool environment found no reported vulnerabilities; this is **not** an audit of the project's full dependency graph.

Full Hardhat compilation and contract integration tests, complete dependency audit, deployed-role inspection, and production operations were not performed. The source archive did not contain its original lockfile.

**Decision: suitable for a clearly labeled source preview; not approved as a deployable production or registry release.** These checks are not an independent security audit.
