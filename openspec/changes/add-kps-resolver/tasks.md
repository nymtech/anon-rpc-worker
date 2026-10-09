# Tasks: add-kps-resolver

## 1. Verification tooling

- [x] 1.1 `verify-kps.mjs`: parse the `kps:` string, dial over `@kpstreams/quic-client`, run the §4.2 single-exchange GET, decode any advertised Content-Encoding, keccak the bytes, assert against the pinned hash. Committed (`e8a110a`).
- [x] 1.2 Add `@kpstreams/quic-client` to the lockfile. Committed (`b8ed7a3`).
- [ ] 1.3 Confirm the `@kpstreams/quic-client` `openStream` API against a real resolver (the stream shape is assumed to mirror the webrtc client).

## 2. Stand up a resolver (Path 1, fast)

- [ ] 2.1 Push the `keccak` branch with the current bundle (the `--github` step), so the resolver has bytes to mirror.
- [ ] 2.2 Provision a static-IP host, forward the UDP port, install `tor-js-gateway`.
- [ ] 2.3 Write the keccak-only `config.json5` (all fields required; `keccak_repo`/`keccak_branch` at this repo's `keccak` branch; do not ship a `consensus-microdesc.txt`). Run `tor-js-gateway -c <path> run --no-sync`.
- [ ] 2.4 Record the published `kps:` address (`ip:port:certhash`) and guard the key file.

## 3. Verify and deploy (testnet first)

- [ ] 3.1 `verify-kps.mjs <kps-entry> <workerHash>` passes against the running resolver.
- [ ] 3.2 Add the verified `kps:` entry to a testnet specifier's `workerResolvers` (anvil or an L2).
- [ ] 3.3 Boot a harness against that specifier and confirm it fetches the bundle over KPS.

## 4. Production resolver (Path 2)

- [ ] 4.1 Decide whether to move from `tor-js-gateway --no-sync` to a Node `@kpstreams/server` service for production (no Tor crates). Confirm one-port-both-transports first.
- [ ] 4.2 Run two or more KPS resolvers for redundancy (two addresses in the list).
- [ ] 4.3 On the production `setWorker`: bytes live and `verify-kps` green at every resolver before the call.

## 5. Docs

- [ ] 5.1 Record the resolver hosting model: the KPS resolver is a standalone host (model A), no KPS-to-gateway bridge peer needed; cite the host-side fetch evidence.
- [ ] 5.2 Document `verify-kps.mjs` usage alongside the deploy steps.
