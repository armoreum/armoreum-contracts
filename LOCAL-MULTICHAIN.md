# Local multichain launch environment

## Run

Start the **Armoreum Local EVMs** workflow, then the API workflow in development. Their lifecycles are separate: restarting the API does not restart or redeploy the chains.

The local EVM workflow reuses recognized running Hardhat instances and verifies deployment receipts and runtime bytecode against compiled artifacts. It never resets an existing chain or automatically replaces a stale deployment manifest. An offline chain with an existing manifest requires explicit recovery/rebuild decisions; it is not treated as a fresh chain.

If local chains are offline or fail validation, the API still serves draft/upload endpoints, logs the exact readiness failure, and returns unavailable for local transaction endpoints. This is a reported degraded state, not a successful local launch environment. Recover the EVMs and restart the API to enable local transactions.

Each new manifest is bound to the Hardhat instance identity and records runtime bytecode hashes. Even identical redeployed code cannot make an old instance's manifest current.

For an explicitly approved rebuild of offline chains, first preserve database records and classify any old local launches as historical. Then run `pnpm --filter @workspace/armoreum-contracts run local:prepare-rebuild --confirm-local-rebuild`, which archives and hash-verifies every existing local manifest before removing its active copy; this also handles a previous partial rebuild. It refuses running chains and never accesses the database or public networks. Start the local EVM workflow, then restart the API. An archive is historical evidence, not an EVM state backup.

On a fresh environment without a manifest it starts two isolated Hardhat EVMs and deploys the local contracts. The persistent Ethereum node does not deploy Uniswap V4 PoolManager by default; V4 tests deploy it on an isolated Hardhat chain so a heavy test deployment cannot take down the launch RPC.

- Local Ethereum: chain ID `31337`, JSON-RPC `http://127.0.0.1:8545`
- Local Robinhood-compatible EVM: chain ID `46630`, JSON-RPC `http://127.0.0.1:8546`

The launch form can deploy its fixed-supply token on either local EVM or both. Requests are keyed to the draft and mode; retrying a partially completed request resumes any missing network deployment. Deployment results are stored in the development database.

Run the contract suite with:

```sh
pnpm --filter @workspace/armoreum-contracts test
```

## Current local scope

These workflows deploy local Armoreum implementations and the upstream Uniswap V4 `PoolManager` on local Ethereum. Local token deployment verifies the emitted address, metadata, fixed total supply, and creator allocation.

The multichain presets are fixed in shared configuration: `0.02 ETH → 1% → 10,000,000 Bridge Vault tokens per chain`, `0.05 ETH → 2.5% → 25,000,000 per chain`, `0.1 ETH → 5% → 50,000,000 per chain`, and `0.2 ETH → 10% → 100,000,000 per chain`. These reserves are separate from Creator Vault/JailETH accounting. The initial buy is intended for Robinhood Chain only; Ethereum does not execute a second ETH purchase. The local API records both bridge reserves as not configured and does not fund them.

The local Pons-compatible adapter creates a fixed-supply token only; it is not the official Pons V2 deployment and does not initialize a pool or enable trading. The local multichain draft path deploys independent local tokens and does not create one shared cross-chain supply. The local bridge adapter locks Robinhood-compatible-chain tokens and releases only prefunded Ethereum-compatible-chain inventory through an operator-relayed message with replay protection. This is a local test fixture, not a trustless bridge, and the app/API do not initiate or relay these bridge messages. The UI keeps bridging, initial buys, pools, liquidity, taxes, and reward claims inactive or not configured.

The Robinhood-compatible local chain is a test EVM, not Robinhood Chain mainnet (4663). Its chain ID is deliberately different.

## Mainnet safeguards and remaining prerequisites

The local chain IDs are the only exceptions to the Armoreum-owned contract address prefix check. Deployments on non-local chains must use addresses beginning with `0x6900`; the test suite covers the fixed-supply token deployer and factory proxy checks. The production deployment script requires an explicitly configured RPC and deployment confirmation.

Do not enable mainnet launches until official Pons V2 integration details, the production Uniswap V4 hook and liquidity flow, bridge peers and message policy, independent deployment authorities, treasury addresses, and operational recovery procedures are configured and audited. No local script sends transactions to a public network.
