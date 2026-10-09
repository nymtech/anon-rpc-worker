# Proposal: add-kps-resolver

## Why

Every resolver we have day one (jsdelivr, unpkg, the `keccak` GitHub branch) sits behind a domain and a CA, so a censor can block the domain and stop a wallet fetching the bundle at all, even though the mixnet transport itself resists blocking. A `kps:` resolver is the only option that removes that weakness: no domain, no CA, pinned by cert hash and dialled directly by `ip:port:certhash` (SPEC §4.1, §4.2). For Nym, whose purpose is censorship circumvention, this makes the delivery path as resistant as the transport. The harness side already supports `kps:` resolvers; the gap is a running resolver and the pre-deploy byte check for it.

## What Changes

- **Run a KPS resolver** serving the worker bundle at the content-addressed path `/keccak/<hh>/<rest>` over one UDP port (QUIC for native harnesses, WebRTC for browsers), fed by this repo's `keccak` branch.
- **Host it as a standalone static-IP service** (decision: model A), not co-located on a Nym node and not needing a KPS-to-gateway bridge peer. The harness dials it directly.
- **Verify bytes before setWorker.** `publish-worker.mjs` skips `kps:` entries, so a dial-and-keccak check (`verify-kps.mjs`, delivered) MUST run before a `kps:` entry goes on-chain.
- **Add the verified `kps:` entry** to the specifier's `workerResolvers()` alongside the existing resolvers.

Non-goals: tunnelling the worker's own mixnet traffic over KPS (a separate idea, out of scope); replacing any existing resolver (this adds one).

## Capabilities

### New Capabilities

- `kps-resolver`: a censorship-resistant KPS bundle resolver and its pre-deploy verification.

### Modified Capabilities

- `worker-deployment`: already states that `kps:` entries MUST be verified out of band before `setWorker`; this change delivers the resolver those entries point at. No requirement text changes.

## Impact

- **Code**: `verify-kps.mjs` (delivered; adds `@kpstreams/quic-client` as a devDependency). Server side is config plus a host (reuse `tor-js-gateway --no-sync` for a fast resolver, or a Node `@kpstreams/server` service for production); no worker source change.
- **Infra**: a reachable static-IP host, one UDP port forwarded, a guarded long-lived key file (the certhash derives from it).
- **On-chain**: one `setWorker` to add the `kps:` entry, after the bytes are live and verified. The certhash, IP, and port are baked into the entry, so any later change to them is another governed `setWorker`.
- **Not affected**: the worker bundle bytes and hash (the resolver serves the same bytes); the other resolvers.
