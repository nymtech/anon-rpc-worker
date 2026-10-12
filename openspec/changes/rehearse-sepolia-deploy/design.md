# Design: rehearse-sepolia-deploy

## How the harness reads the specifier (why Sepolia just works)

`AnonRpcWorker` reads the specifier through `preExisting.rpcProvider` (`impl/browser-harness/src/host/specifier.ts` `readSpecifier`, an `eth_call` to `workerHash()`/`workerResolvers()`). The chain is whatever that provider points at; there is no hardcoded chain. So a Sepolia boot needs a harness constructed with the Sepolia specifier address and a provider pointed at a Sepolia RPC.

The public demo page likely fixes its provider to mainnet, so pasting a Sepolia address there would `eth_call` the wrong chain. The reliable route is a custom harness. The existing `test/e2e/run-e2e.mjs` already drives the full path but injects a mock specifier (`ethCallMap`) and serves the bundle from a local http server. The Sepolia variant replaces the mock with a real provider (a thin `RpcProvider` that POSTs `eth_call` to a Sepolia RPC URL) and the deployed specifier address, and drops the local bundle server so the harness fetches from the on-chain resolver. Everything else (sandbox boot, mixnet round-trip) is unchanged.

## What the rehearsal proves that Phase 1 did not

| Path | Phase 1 (anvil) | This rehearsal |
| --- | --- | --- |
| On-chain read | local anvil | real public chain (Sepolia) |
| Resolver | placeholder, verification skipped | real `keccak` branch (and optionally KPS), verify loop on |
| `--github` push | not run | run (real `raw.githubusercontent` URL) |
| Harness boot | mock specifier | real specifier read over a Sepolia provider |
| Upgrade | not run | `setWorker` rehearsed |

## The RPC endpoint vs the specifier chain

Two chains are in play and must not be confused. The specifier lives on Sepolia (where the harness reads the pin). The RPC the worker actually calls through the mixnet (for `eth_blockNumber` etc.) is a separate public Ethereum RPC endpoint, unrelated to Sepolia. The rehearsal can keep using a mainnet public RPC for the round-trip; only the specifier moves to Sepolia.

## The mainnet delta (PR 7151 has shipped as mix-fetch 3.0.0)

The rehearsal is designed so that mainnet is a swap of five things and nothing else:

1. Bytes: rebuilt against the released mix-fetch 3.0.0; production hash `0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8` (the rehearsal used the 2.1.1 bytes, `0x7e7f84...`).
2. Chain: mainnet RPC instead of Sepolia.
3. Gas: real ETH on the owner key (~1.1M gas to deploy).
4. Owner: the real Nym key (deploy from it, or `transferOwnership` to governance after).
5. Resolvers: add the production set (`@nymproject` npm publish for jsdelivr and unpkg, the `nymtech` `keccak` branch, and, in a later pass, the KPS resolver).

The flow, the tooling, the harness, and the verification are identical to what the rehearsal exercises.

## Open questions

- Resolved: production uses `nymtech/anon-rpc-worker`, now public with the `keccak` branch pushed (commit `6361085`). A personal fork stood in during the private-repo phase.
- Is a static-IP host available for the KPS leg now, or do we rehearse HTTPS resolvers first and add KPS when the host is ready? The HTTPS legs do not block on it.
