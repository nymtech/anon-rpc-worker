# anon-rpc-worker

[![ci](https://github.com/nymtech/anon-rpc-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/nymtech/anon-rpc-worker/actions/workflows/ci.yml)

An [anon-rpc](https://github.com/ethereum/anon-rpc) conforming worker (anon-client, SPEC §3.2) that fulfils `fetch` and RPC calls over the **Nym mixnet**, built on [`@nymproject/mix-fetch`](https://www.npmjs.com/package/@nymproject/mix-fetch).

A wallet runs this worker's hash-pinned bundle inside an anon-rpc harness (for example `@anon-rpc/browser-harness`). Each `worker.fetch()` travels through the mixnet and leaves it at a Nym IP Packet Router (IPR), so the RPC endpoint sees the IPR's address, not the user's, and no single gateway links a user to what they request.

```
wallet ── AnonRpcWorker.fetch() ──▶ harness sandbox (null-origin iframe ▸ Web Worker)
                                      └─ this bundle: acceptCall loop
                                          └─ @nymproject/mix-fetch → @nymproject/mix-tunnel
                                              └─ nested Worker (blob: URL)
                                                  └─ smolmix WASM: Sphinx + smoltcp + TLS
                                                      └─ WebSocket ⇒ Nym gateway ⇒ mixnet ⇒ IPR ⇒ RPC endpoint
```

The worker consumes `@nymproject/mix-fetch` as a published npm package with the WASM inlined. It compiles no transport source, so `pnpm install --frozen-lockfile && pnpm build` reproduces the pinned hash on any machine. That reproducibility is why it lives in a small standalone repo rather than in the Nym monorepo.

## Quickstart

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm build     # writes dist/nym-anon-rpc-worker.js and prints its keccak256 workerHash
```

## Using it

A wallet points at a deployed specifier by address:

```js
const worker = new AnonRpcWorker({
  address: "0x...",            // the Nym worker's specifier
  preExisting: { rpcProvider },
});
```

The harness reads the specifier on-chain, fetches the bundle from a resolver, verifies its keccak256 against the pinned `workerHash()`, and runs it sandboxed. Integrity comes from the hash, so resolvers are untrusted. Any `https://` RPC endpoint works through the worker.

To try it without integrating, paste a deployed specifier address into the balance-watcher demo at <https://ethereum.github.io/anon-rpc/demo/>. Mixnet bootstrap takes a few seconds before the first response.

## Testing

```sh
pnpm test        # unit: conversion, accept loop, config precedence, retry, abort, bundle smoke
pnpm test:e2e    # end-to-end: headless Chromium + the real harness, over the live mixnet
```

Unit tests run in Node against injected fakes, with no WASM, browser, or network, so they finish in milliseconds. The e2e drives headless Chromium with `@anon-rpc/browser-harness`: a mock specifier pins the built bundle's hash, the harness boots it in the null-origin sandbox, and the test asserts that `eth_blockNumber` and `eth_chainId` round-trip through the mixnet to a public Ethereum RPC. The live network rebuilds its node set each epoch, so the e2e checks directory health first and skips, rather than fails, on bad network conditions.

| Probe | Needs | Checks |
| --- | --- | --- |
| `test/e2e/probe-network.mjs` | network | epoch position, active mixnode/gateway counts |
| `test/e2e/probe-sandbox.mjs` | browser | nested Worker, WASM, IndexedDB state, WebSocket from `Origin: null`, directory CORS |
| `test/e2e/probe-idb.mjs` | browser | the IndexedDB failure mode in the sandbox |
| `test/e2e/run-e2e.mjs` | browser + mixnet | the full §4 to §9 path with real RPC |

## Configuration

Optional, read once at boot. The harness-supplied `anonRpcWorker.config` object is the primary source; a UTF-8 JSON blob at the storage key `nym/setup-opts` is the fallback. The IPR auto-discovers and DNS has defaults, so config is optional; a `config` that is present but not a JSON object is fatal.

| Field | Meaning |
| --- | --- |
| `preferredIpr` | Pin the exit IPR (a Nym address) instead of auto-discovering |
| `disableCoverTraffic` | Turn off Poisson cover traffic |
| `connectTimeoutMs` | Per-attempt tunnel connect timeout |
| `clientId` | Pin the mixnet client identity (default: a fresh random id per attempt) |
| `primaryDns` / `fallbackDns` | DoH resolvers (defaults applied when unset) |
| `debug` | Verbose smolmix logging |

## Layout

| Path | Role |
| --- | --- |
| `src/nym-anon-client.ts` | The core: accept loop, config precedence, tunnel lifecycle, request/response conversion. Imports nothing from Nym, so it unit-tests in Node |
| `src/worker-main.ts` | Entry point: wires the real `mix-fetch` and the `anonRpcWorker` capability API into the core |
| `src/tunnel-worker-patch.ts`, `src/idb-prelude.ts` | The sandbox shim: an in-memory IndexedDB for mix-tunnel's nested worker, because the null-origin sandbox denies the real one |
| `src/spec-types.ts` | Worker-facing spec types, a standalone copy per spec convention |
| `build.mjs` | esbuild to `dist/nym-anon-rpc-worker.js` (one IIFE, the §4 artifact); prints its keccak256 |
| `test/` | Unit tests against fakes, a bundle smoke test, and the live-mixnet e2e under `test/e2e/` |

## Docs

- [`docs/architecture.md`](docs/architecture.md): what it is, the layers, the request lifecycle, the sandbox mechanics, and the anonymity model.
- [`docs/keccak-branch.md`](docs/keccak-branch.md): the content-addressed `keccak` branch resolver.

## Limitations

- **Browser-like harnesses only.** Needs `Worker`, `WebAssembly`, `Blob`, `URL.createObjectURL`, `WebSocket`, `fetch`, and `crypto.getRandomValues`.
- **Ephemeral identity.** The null-origin sandbox denies IndexedDB, so it is shimmed in memory and the Nym client identity is fresh per boot.
- **Abort is not cancel.** Aborting fails the call at the worker, but the in-flight mixnet transfer completes inside the WASM stack.
- **Large bundle.** The WASM is inlined, so the file is large; hash verification and boot are one-time per session.
- **No KPS transport yet.** Anonymity rides the mixnet over a WebSocket to a gateway, which the spec permits.
- **Not yet confirmed working on Safari.** 

## Licence

Apache-2.0

