# Architecture: what this is and how it works

An explanation of the Nym anon-rpc worker: the problem it solves, the layers it is built from, and what happens when a wallet makes a request through it. For the quickstart and the published specifier, see the README. The on-chain distribution model (`WorkerSpecifier`, hash pin, resolvers) follows anon-rpc SPEC §4.

## What this is, in one paragraph

This project is an anon-rpc *worker*: a small client program that a wallet runs, inside a sandbox, to make its RPC requests anonymously. It conforms to the anon-rpc specification (`ethereum/anon-rpc`, the SPEC §3.2 "conforming worker"), and it carries each request over the Nym mixnet using `@nymproject/mix-fetch`. The result is a drop-in anonymous `fetch`: a wallet calls `worker.fetch(url, init)` and gets back a normal `Response`, but the request travelled through the mixnet and left it at a Nym exit node, so the RPC endpoint never sees the user's IP address, and no single network hop links the user to what they asked for.

## The problem it solves

A wallet that talks to an Ethereum RPC endpoint leaks its IP address to that endpoint (and to anyone watching the path). Over time the endpoint can link a stream of requests to one IP, and an IP to a person. anon-rpc is a standard for closing that gap without every wallet reinventing the plumbing: the wallet integrates one harness, and any anonymising network can supply a worker that the harness runs. This project is the Nym network's worker.

Two worlds have to meet for that to work, and this project is the join between them:

- The anon-rpc world: a specification, a sandboxing harness, and an on-chain integrity model that lets a wallet run untrusted, hash-pinned worker code safely.
- The Nym world: a mixnet plus a client stack (`mix-fetch` over smolmix WASM) that turns "send bytes anonymously" into "make an HTTP request".

## The layers

From the wallet's call down to the wire:

```
  wallet / app
     │  worker.fetch(url, init)
     ▼
  anon-rpc harness  (@anon-rpc/browser-harness)
     │  loads + verifies the hash-pinned bundle, runs it sandboxed,
     │  exposes the anonRpcWorker capability API across postMessage
     ▼
  THIS WORKER  (dist/nym-anon-rpc-worker.js, one hash-pinned IIFE)
     │  src/worker-main.ts, entry: wires anonRpcWorker + real mix-fetch
     │  src/nym-anon-client.ts, the core: accept loop, tunnel lifecycle, conversions
     ▼
  @nymproject/mix-fetch  →  @nymproject/mix-tunnel
     │  fetch-over-mixnet protocol; spawns a nested Web Worker (blob: URL)
     ▼
  smolmix WASM  (inside the nested worker)
     │  Sphinx packet format + smoltcp userspace TCP/IP + TLS + DoH
     ▼
  WebSocket ⇒ Nym gateway ⇒ mixnet ⇒ IP Packet Router (IPR) ⇒ RPC endpoint
```

Each layer has one job:

- The harness isolates the worker and hands it a narrow capability API (`anonRpcWorker`) as its entire platform: `signalReady`/`signalFailed`, an `acceptCall` inbound-call stream, `config`, `storage`, `log`, and `kps`. It also enforces the integrity model: it will only run bytes whose keccak256 matches the on-chain `workerHash()`.
- This worker is the adapter. It does not implement any mixnet cryptography itself; it reads config, brings the Nym tunnel up, and translates between the anon-rpc call shape and `mix-fetch`'s `fetch` shape.
- `mix-fetch`/`mix-tunnel` implement HTTP over the mixnet, and run the heavy stack in a nested worker so the WASM does not block the anon-rpc worker's message loop.
- smolmix is the mixnet client proper: it builds Sphinx packets (layered encryption, one layer per hop), runs a userspace TCP/IP stack (smoltcp) and TLS so a real HTTPS connection can be carried inside the tunnel, and resolves names over DoH. It reaches the mixnet over a WebSocket to a Nym gateway.

Why `mix-fetch` and not the raw Nym SDK: the raw SDK only sends and receives bytes to a Nym address. Turning that into HTTP needs an exit-side counterpart and a full client-side HTTP-over-mixnet protocol, which is exactly what `mix-fetch` v2 already packages, as a single self-contained ESM chunk with the WASM and nested worker inlined. That single-file, zero-runtime-dependency shape is what makes it suitable for anon-rpc's one-file, hash-pinned artifact.

## The core, and why it is shaped that way

`src/nym-anon-client.ts` holds the logic and imports nothing from Nym. It takes its tunnel functions by dependency injection (`TunnelDeps`: `setupMixTunnel`, `mixFetch`). `src/worker-main.ts` is the only file that imports `@nymproject/mix-fetch` and wires the real functions in. This split is deliberate: the core can be unit-tested in Node against fakes, with no WASM, no nested worker, and no mixnet, which is why the test suite runs in milliseconds.

The core does three things:

1. Reads and validates config once at boot (`readConfig`): the host-supplied `anonRpcWorker.config` object is the standard path and wins; a `nym/setup-opts` storage blob is the fallback. A present-but-malformed config is a permanent error and calls `signalFailed`.
2. Brings the tunnel up, retrying transient failures forever with capped, jittered backoff, and calls `signalReady()` only once the tunnel is usable. This mirrors the canonical tor-js network worker: a down gateway is transient, so `.ready` stays pending rather than failing.
3. Runs the accept loop: for each inbound `fetch` call, converts `AnonRequestInit` to a `RequestInit`, calls `mixFetch`, and converts the `Response` back to an `AnonFetchResponse`.

## The request lifecycle

Boot:

1. The harness verifies the bundle hash and starts the worker in the sandbox.
2. `worker-main.ts` installs the IndexedDB patch (below), then calls `runNymWorker`.
3. The core reads config, starts the accept loop immediately (the harness buffers host calls until the worker accepts, so nothing is lost), and begins tunnel setup in the background.
4. Tunnel setup connects a Nym client over WebSocket to a gateway, discovers or uses a configured IP Packet Router, and comes up. `signalReady()` fires; the host's `ready` promise resolves, meaning "anonymous fetch works now".

A fetch call:

1. The host calls `worker.fetch(url, init)`; the harness delivers it as a `fetch` inbound call.
2. The core converts the request. A streaming body is buffered to a `Uint8Array`, because everything handed across `mix-tunnel`'s Comlink boundary must survive structured clone. The `AbortSignal` is stripped for the same reason; cancellation is handled worker-side instead (see the anonymity/limitations note on abort).
3. `mixFetch(url, init)` runs the request through smolmix: DoH resolves the host, smoltcp opens a TCP connection carried over the mixnet, TLS handshakes end to end with the destination, and the HTTP request/response flows over that connection.
4. The `Response` is converted back to an `AnonFetchResponse` (ordered header pairs, a buffered body, the final URL) and returned to the host.

## The sandbox mechanics

The harness runs the worker in a null-origin (opaque) sandbox: a Web Worker inside a sandboxed iframe. That environment is deliberately hostile, and two consequences shaped this worker:

- Nested worker from a blob. `mix-tunnel` spawns its WASM worker with `URL.createObjectURL(new Blob([...]))`. That nested worker gets a fresh global scope this code cannot reach. `src/tunnel-worker-patch.ts` wraps `URL.createObjectURL` so that a prelude (`src/idb-prelude.ts`, bundled to a string at build time) is prepended to every JavaScript blob created here, which is only that nested worker's source. The prelude therefore runs first inside the nested worker.
- IndexedDB is denied, so it is shimmed. In the null-origin sandbox `indexedDB` exists but `open()` throws synchronously, and smolmix's storage layer fails tunnel setup rather than degrading. The prelude probes IndexedDB and, when it is denied, installs an in-memory implementation (`fake-indexeddb`), including the class identities the wasm-bindgen glue checks with `instanceof`. The effect is that the Nym client identity is ephemeral per boot, which is privacy-fine, indeed preferable, for an anon-client.

The sandbox also has no secure context, so secure-context-only APIs (`crypto.randomUUID`, `crypto.subtle`) are absent; `crypto.getRandomValues` is the dependable primitive, which is why the worker generates its client id from it.

## What anonymity this provides

The property is that no single party on the path links the user to what they asked for:

- The RPC endpoint sees the IP of the Nym exit (the IPR), not the user's IP.
- The entry gateway sees the user's IP but only Sphinx packets, so it does not learn the destination or the content.
- The IPR sees the destination it egresses to, but not the user's IP, and because `mix-fetch` terminates TLS end to end with the destination, it does not see the HTTPS payload.
- The mixnodes in between see only layered-encrypted Sphinx packets and mix traffic to break timing links.

What it does not provide, stated honestly:

- It is not a promise about the worker itself. The sandbox limits a malicious worker's blast radius, but a worker that routes your RPC can still observe, censor, or lie about it. The defence is that this worker is open source and hash-pinned: anyone can rebuild the bundle, check the keccak256 against the on-chain specifier, and audit exactly what runs. The trust is "these exact, auditable bytes", not "this author".
- Aborting a call fails it at the worker, but the in-flight mixnet transfer runs to completion inside the WASM stack; `mix-tunnel` exposes no per-request cancellation.
- Anonymity here rides on the mixnet over a WebSocket to a gateway, which the spec permits. It does not yet use the harness's KPS transport; a future variant could tunnel gateway traffic over `anonRpcWorker.kps`, which would need a KPS-to-gateway bridge peer to exist.

## How it relates to anon-rpc and to Nym

- To anon-rpc: this is a conforming worker (§3.2). It is not merged into `ethereum/anon-rpc`; it is hosted separately and pinned on-chain by a `WorkerSpecifier` contract, and it appears upstream only as a one-line `adopters.json5` entry.
- To Nym: it is a thin adapter over `@nymproject/mix-fetch` (the smolmix WASM stack). The worker owns the anon-rpc conformance and the sandbox workarounds; Nym owns the mixnet transport. When the mixnet client improves (for example the DoH resilience work in the smolmix repo), the worker inherits it by bumping the `mix-fetch` dependency and rebuilding, which produces new bytes and a new hash.

## Where to look next

- README: quickstart, how to use it against a deployed specifier, configuration, and testing.
- `docs/keccak-branch.md`: how one resolver (the content-addressed `keccak` branch) serves the pinned bytes.
- `src/nym-anon-client.ts`: the whole core, readable top to bottom, with the accept loop and tunnel lifecycle.
