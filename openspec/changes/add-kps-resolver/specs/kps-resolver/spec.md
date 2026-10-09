# Delta: kps-resolver, new capability

## ADDED Requirements

### Requirement: The KPS resolver SHALL serve the bundle over KPS at the content-addressed path

The resolver MUST serve the worker bundle at `/keccak/<hh>/<rest>` (SPEC §4.2 syntax: `<hh>` the first byte of the keccak256 as two lowercase hex characters, `<rest>` the remainder) over KPS on one UDP port, answering QUIC (native harnesses) and WebRTC (browser harnesses). It MUST perform one HTTP/1.1 GET exchange per stream: read the request to EOF, write `200` with an EOF-delimited or `Content-Length` body, then close. It MUST NOT use `Transfer-Encoding`, MUST NOT follow redirects, and MUST return `200` only for a path whose bytes keccak-hash to the path.

#### Scenario: Bundle fetched over KPS
- **GIVEN** a bundle with keccak256 `H` is served by the resolver
- **WHEN** a harness dials `kps:<ip>:<port>:<certhash>` and sends `GET /keccak/<H[0:2]>/<H[2:]> HTTP/1.1`
- **THEN** the resolver returns `200` and the bundle bytes, and the harness admits them because `keccak256(bytes)` equals the on-chain `workerHash()`

#### Scenario: Unknown path
- **WHEN** a harness requests a `/keccak/...` path the resolver has no bytes for
- **THEN** the resolver returns a non-`200` status and the harness tries the next resolver

### Requirement: The resolver SHALL be a standalone static-IP host pinned by certhash

The resolver MUST be reachable directly at `ip:port:certhash` without a domain, a CA, or a KPS-to-gateway bridge peer (hosting model A). The certhash MUST derive from a persistent key file; the key file MUST be guarded, because the certhash is pinned on-chain. The resolver bytes SHOULD come from this repo's `keccak` branch, so there is one bundle store across all resolver kinds.

#### Scenario: Direct dial, no domain
- **WHEN** a harness holds a `kps:` resolver entry
- **THEN** it dials the host directly by `ip:port:certhash` over WebRTC or QUIC, with no DNS lookup and no CA check

### Requirement: A KPS resolver entry SHALL be byte-verified before it goes on-chain

Before a `kps:` entry is added to `workerResolvers()` by `setWorker`, the bytes it serves MUST be fetched over KPS and confirmed to keccak-hash to the pinned `workerHash()`. The resolver MUST be live and serving the correct bytes at the exact address before the entry goes on-chain.

#### Scenario: Pre-deploy verification
- **GIVEN** a `kps:` entry and the pinned `workerHash`
- **WHEN** `verify-kps.mjs <entry> <workerHash>` is run
- **THEN** it dials the resolver, fetches the bundle, and exits zero only if the served bytes keccak-hash to `workerHash`

### Requirement: Changing the address SHALL be a governed action

Because the certhash, IP, and port are baked into the on-chain entry, any change to them MUST be a governed `setWorker` with the new entry, after the new resolver is live and verified. Redundancy SHOULD be provided by two or more KPS resolver entries rather than by repointing one.

#### Scenario: Host re-IP
- **GIVEN** a running KPS resolver whose host must change IP
- **WHEN** the new host is live, serving the pinned bytes, and verified
- **THEN** the new `kps:` entry is added by `setWorker`, and the old entry is removed only after the new one is confirmed
