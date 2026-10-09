# Design: add-kps-resolver

## The constraint that drives everything: the address is on-chain

A `kps:` resolver entry is `kps:<ip>:<port>:<certhash>/keccak/<hh>/<rest>`, stored verbatim in `workerResolvers()`. So the certhash, IP, and port are effectively permanent for the life of that entry. This inverts the usual ops assumptions:

- Cert rotation is a governed `setWorker`, not a server config change. The cert is permanent, so the certhash derives from a long-lived key file that MUST be guarded.
- The IP and port are fixed too. There is no DNS layer to move behind. That absence is the censorship-resistance property and also the operational cost.
- Ordering (stricter than the HTTPS case): the resolver MUST be live, reachable, and serving the right bytes at that exact address before its entry goes on-chain.
- Redundancy: run two or more KPS resolvers (two addresses), because a single static-IP box cannot be repointed cheaply.

## Server choice

Three paths, laziest first.

| Path | What | When |
| --- | --- | --- |
| 1. Reuse `tor-js-gateway --no-sync` | run the existing Rust binary keccak-only, config pointed at our `keccak` branch | fast first proof and testnet; zero code |
| 2. Node `@kpstreams/server` | productionise the reference `serveBundle` into a standalone service | production; no Tor crates, matches the anon-rpc reference server |
| 3. Fresh Rust on `kps`, or a lean fork | our own, or strip Tor from the gateway | only if a lean Rust binary is specifically wanted |

Path 1 is confirmed viable: `tor-js-gateway run --no-sync` serves keccak-only with no Tor at startup or runtime; relay routes remain present but inert. It still links the full Arti stack, which is why Path 2 is the production target. Both feed from the `keccak` branch this repo already publishes, so there is one bundle store for every resolver kind.

## Why host-side dialling matters

The harness fetches and keccak-verifies the bundle in the host context (`anon-rpc/impl/browser-harness/src/host/specifier.ts`), then boots the worker in the sandbox. So the worker's null-origin limits (no `crypto.subtle`, shimmed IndexedDB) do not constrain a `kps:` resolver. The null-origin WebRTC worry applies only to tunnelling the worker's own traffic, which is out of scope.

## Verification

`publish-worker.mjs` dials no KPS, so it skips `kps:` entries ("checked by harnesses only"). `verify-kps.mjs` closes that gap: it dials over `@kpstreams/quic-client`, runs the §4.2 single-exchange GET, decodes any advertised Content-Encoding, and asserts the keccak256 equals the pinned hash. It reuses the §4.2 logic shape from the harness `kps-http.ts` but stays self-contained.

## Open questions

- Does one `@kpstreams/server` `listen()` serve both WebRTC and QUIC on one port? tor-js confirms its native `kps` listener does (one UDP port, port 12298). Confirm for the Node server before choosing it for production.
- `@kpstreams/*` is at 0.2.1 and the Rust `kps` crate at 0.2.2, both early. Note maturity before depending on either for production infra.
