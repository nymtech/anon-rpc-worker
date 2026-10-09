# worker-deployment Specification

> Specifies the reproducible build, the keccak256 pin, the resolver kinds, pre-gas verification, and ownership. The deploy tooling lives in the `anon-rpc` repo at `impl/specifier`.

## Purpose

This capability is how the worker bundle is distributed and pinned: the reproducible build, the keccak256 pin, the on-chain `WorkerSpecifier`, the resolvers that serve the bytes, and the verification that the served bytes match the pin. Integrity comes from the hash, so resolvers are untrusted. A wallet points at a specifier by address; the harness reads the pin and resolvers on-chain, fetches the bytes from any resolver, verifies `keccak256(bytes) == workerHash()`, and runs the bundle sandboxed.

## Requirements

### Requirement: The build SHALL be reproducible from the lockfile

`pnpm install --frozen-lockfile && pnpm build` MUST reproduce the pinned keccak256 on any machine, because the worker compiles no transport and consumes published `@nymproject/mix-fetch`. The build MUST print the bundle's keccak256 `workerHash`.

#### Scenario: Reproducible hash
- **WHEN** two machines run `pnpm install --frozen-lockfile && pnpm build` from the same lockfile
- **THEN** both produce a bundle with the same keccak256

### Requirement: The specifier SHALL pin the hash and list resolvers

The on-chain `WorkerSpecifier` (SPEC §4) MUST expose `workerHash()` (the keccak256 of the canonical bundle) and `workerResolvers()` (advisory locations). A harness MUST reject any bytes whose keccak256 does not equal `workerHash()`, and MUST ignore resolver entries it does not recognise.

#### Scenario: Wrong bytes are rejected
- **GIVEN** a resolver serves bytes whose keccak256 does not equal `workerHash()`
- **WHEN** the harness fetches them
- **THEN** it rejects them and tries the next resolver

### Requirement: Resolver entries SHALL cover the defined kinds

`workerResolvers()` entries MUST each be one of: an `https:` (or `http:` for local development) URL fetched by GET; a `blob:` URL; or a kps resolver string `kps:<ip>:<port>:<certhash>/<path>` fetched over KPS (§4.1, §4.2). The `keccak` GitHub branch resolver MUST serve the bundle at `<hh>/<rest>`, where `<hh>` is the first byte of the keccak256 (two hex characters) and `<rest>` is the remainder.

#### Scenario: keccak branch path
- **GIVEN** a bundle with keccak256 `194f04...8d`
- **WHEN** it is published to the `keccak` branch
- **THEN** it is served from `.../keccak/19/4f04...8d`

### Requirement: Resolver bytes SHALL be verified before setWorker

Before deploying a specifier or calling `setWorker`, each resolver MUST be fetched and its bytes keccak-checked against the pinned hash. `publish-worker.mjs` does this for `https:` resolvers before it spends gas. `kps:` entries, which that tool does not dial, MUST be verified out of band with `verify-kps.mjs` before the entry goes on-chain. The bytes MUST be live at every resolver before `setWorker`, or wallet boots fail until they are.

#### Scenario: KPS entry verified out of band
- **GIVEN** a `kps:` resolver entry to add to the specifier
- **WHEN** `verify-kps.mjs <entry> <workerHash>` is run before `setWorker`
- **THEN** it dials the resolver, fetches the bundle, and confirms the keccak256 equals the pinned hash

### Requirement: The specifier SHALL be owner-updatable, with a one-way freeze

`setWorker(hash, resolvers)`, `transferOwnership(newOwner)`, and `renounceOwnership()` MUST be restricted to the owner. The owner key is the supply chain for every pinned wallet, so it MUST NOT be a personal hot key for a production specifier. `renounceOwnership()` MUST be irreversible (owner set to the zero address, freezing the current bundle forever). `transferOwnership` MUST be callable at any time while ownership is live, so a specifier MAY deploy from a plain key and move to governance later.

#### Scenario: Freeze is permanent
- **GIVEN** the owner calls `renounceOwnership()`
- **WHEN** anyone later calls `setWorker` or `transferOwnership`
- **THEN** the call reverts, because there is no owner

## Technical Notes

- **Deploy tooling**: `anon-rpc/impl/specifier/publish-worker.mjs` (deploy + resolver verify + read-back), `github-resolver.mjs` (the `keccak` branch via git plumbing), and this repo's `verify-kps.mjs` (the KPS pre-gas byte check).
- **Resolvers day one**: one `pnpm publish` gives jsdelivr and unpkg; the `keccak` branch is a third we control. None is censorship-resistant (all sit behind a domain and a CA); only a `kps:` resolver removes that, which the active change [[kps-resolver]] covers.
- **Ownership path**: deploy from a plain key, then `transferOwnership` to the governance target (multisig or timelock). Single-step transfer with no recipient confirmation, so a wrong address loses control permanently.
- **Related specs**: [[anon-rpc-worker]], [[kps-resolver]].
