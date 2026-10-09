# Delta: worker-deployment, rehearse on a testnet before mainnet

## ADDED Requirements

### Requirement: The deploy and upgrade flow SHALL be rehearsed on a public testnet before mainnet

Before a mainnet deploy or a mainnet `setWorker`, the same flow MUST be rehearsed on a public testnet with the real tooling: a specifier deployed and read on a real public chain, bytes served from a real remote resolver, the `publish-worker` pre-gas verify loop enabled (not skipped), a harness booting against the testnet specifier, and a `setWorker` upgrade exercised. The rehearsal MUST differ from mainnet only in the bytes, the chain and RPC, the gas, the owner key, and the production resolver set.

#### Scenario: Testnet rehearsal precedes mainnet
- **GIVEN** a bundle to deploy
- **WHEN** the team prepares a mainnet deploy or upgrade
- **THEN** the identical flow has first run on a public testnet (specifier deployed and read on-chain, bytes fetched from a real resolver and hash-verified, the worker booted, and an upgrade rehearsed), with only the bytes, chain, gas, owner key, and resolver set changing for mainnet

#### Scenario: Verify loop runs in the rehearsal
- **GIVEN** a testnet specifier deploy
- **WHEN** `publish-worker` runs
- **THEN** it verifies each resolver serves the pinned bytes before spending gas (no `SKIP_RESOLVER_CHECK`), so the resolver-verification path itself is exercised before mainnet
