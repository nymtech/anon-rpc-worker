# Proposal: rehearse-sepolia-deploy

## Why

We want a fully working anon-rpc worker deployment before the mix-fetch resilience PR (7151) lands, so that the mainnet release is a byte swap, not a first attempt. Phase 1 proved the pieces in isolation (reproducible build, on-chain deploy on anvil, mixnet round-trip in the e2e, the KPS verify tool). It did not prove them together against a real public chain and a real remote resolver: the anvil deploy used a placeholder resolver with verification skipped, and the e2e used a mock specifier. A Sepolia rehearsal exercises the whole chain end to end with the current 2.1.1 bytes, so that when mix-fetch publishes we rebuild, swap the bytes, and run the identical flow on mainnet.

It also closes the testing gaps still open: the `--github` keccak-branch resolver has never pushed real bytes, `publish-worker`'s pre-gas resolver verify loop has never run (anvil skipped it), the specifier has never been read from a real public chain, and the KPS resolver and `verify-kps` have never run against a live server.

## What Changes

- **Deploy a `WorkerSpecifier` on Sepolia** pinning the current 2.1.1 bundle hash, with real resolvers and the `publish-worker` verify loop on (no `SKIP_RESOLVER_CHECK`).
- **Host the bytes on real resolvers**: the `keccak` GitHub branch (closing the `--github` gap), and optionally a Path 1 KPS resolver when a host is available.
- **Boot end to end against Sepolia** with a custom harness that reads the specifier through a Sepolia RPC provider and fetches the bundle from the on-chain resolver, then round-trips RPC through the mixnet.
- **Rehearse the upgrade path** (`setWorker` to new bytes, and optionally `transferOwnership`), so the mainnet byte swap is a known action.
- **Record the mainnet delta**: the only differences from this rehearsal are the new bytes, a mainnet RPC, real gas, the real owner key, and production resolvers.

Non-goals: mainnet deployment; the new mix-fetch bytes (blocked on PR 7151); publishing to the `@nymproject` npm scope (that is a production resolver step).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `worker-deployment`: adds a requirement that the deploy and upgrade flow SHALL be rehearsed on a public testnet before mainnet. No behavioural change to the worker.

## Impact

- **Code**: a Sepolia e2e harness (a variant of `test/e2e/run-e2e.mjs` that uses a real Sepolia RPC provider and the deployed specifier address instead of the mock). No worker source change.
- **Infra**: a Sepolia RPC endpoint; a throwaway funded Sepolia key (faucet); a GitHub repo to hold the `keccak` branch; optionally a static-IP host for the KPS resolver.
- **On-chain**: one Sepolia `WorkerSpecifier` deploy, plus a rehearsal `setWorker`. Throwaway, no governance.
- **Not affected**: mainnet; the worker bytes and hash (the rehearsal serves the same 2.1.1 bytes everywhere).
