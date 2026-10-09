# anon-rpc-worker Specification

> Hand-authored 2026-10-06. Source: `README.md`, `docs/architecture.md`, `src/nym-anon-client.ts`.

## Purpose

This capability is the worker itself: an anon-rpc conforming anon-client (SPEC §3.2) that a wallet runs inside an anon-rpc harness. Each `worker.fetch()` travels through the Nym mixnet and leaves it at an IP Packet Router (IPR), so the RPC endpoint sees the IPR address, not the user, and no single gateway links a user to what they request. The worker converts the anon-rpc call types to and from `@nymproject/mix-fetch` and manages the mixnet tunnel lifecycle. The core (`src/nym-anon-client.ts`) is dependency-injected, so it imports nothing from Nym and unit-tests in Node against fakes.

## Requirements

### Requirement: The worker SHALL start accepting calls before the tunnel is up

The worker MUST start the `acceptCall` loop at once and bring the mixnet tunnel up in the background. The harness buffers host calls until the loop runs. `signalReady()` MUST fire once the tunnel is up.

#### Scenario: Boot order
- **WHEN** the worker starts
- **THEN** it begins accepting calls immediately, brings the tunnel up in the background, and calls `signalReady()` only after the tunnel is up

### Requirement: Transient setup failures SHALL retry; permanent failures SHALL stop

A transient tunnel setup failure MUST retry indefinitely with capped, jittered backoff (base 1 s, cap 60 s); `ready` MUST stay pending rather than reject. A permanent error, including a `config` that is present but not a JSON object, MUST instead call `signalFailed({ message })` and stop.

#### Scenario: Transient failure retries
- **GIVEN** the tunnel setup fails for a transient reason
- **WHEN** the worker retries
- **THEN** it backs off with jitter up to 60 s and keeps `ready` pending rather than rejecting

#### Scenario: Malformed config is fatal
- **GIVEN** a `config` is present but is not a JSON object
- **WHEN** the worker reads it at boot
- **THEN** it calls `signalFailed({ message })` and stops

### Requirement: The worker SHALL convert anon-rpc fetch calls to and from mix-fetch

The worker MUST convert `AnonRequestInit` to a `RequestInit`, call `mixFetch(url, init)`, and convert the `Response` back to an `AnonFetchResponse` (ordered header pairs, a buffered body, the final URL). A streaming request body MUST be buffered. `AbortSignal` MUST be stripped, because it cannot cross mix-tunnel's structured-clone boundary; aborts are honoured worker-side instead.

#### Scenario: Request and response round-trip
- **WHEN** the host issues a fetch call with an `AnonRequestInit`
- **THEN** the worker buffers any streaming body, strips the `AbortSignal`, calls `mixFetch`, and returns an `AnonFetchResponse` with ordered headers, a buffered body, and the final URL

#### Scenario: Abort fails the call but does not cancel the transfer
- **GIVEN** an in-flight fetch call is aborted
- **WHEN** the worker honours the abort
- **THEN** the call fails at the worker, but the in-flight mixnet transfer runs to completion inside the WASM stack (mix-tunnel exposes no per-request cancellation)

### Requirement: Configuration SHALL be optional with a defined precedence

Config MUST be read once at boot. The host-supplied `anonRpcWorker.config` object (§7.1) is the primary source; a UTF-8 JSON blob at the worker-scoped storage key `nym/setup-opts` (§11) is the fallback. Either MUST be passed to `setupMixTunnel` as `SetupMixTunnelOpts`. Config is optional, because the IPR auto-discovers and DNS has defaults. Recognised fields: `preferredIpr`, `disableCoverTraffic`, `connectTimeoutMs`, `clientId`, `primaryDns`, `fallbackDns`, `debug`.

#### Scenario: Host config takes precedence over stored config
- **GIVEN** both an `anonRpcWorker.config` object and a `nym/setup-opts` storage blob exist
- **WHEN** the worker reads config at boot
- **THEN** it uses the host-supplied object

#### Scenario: No config is valid
- **WHEN** neither a config object nor a storage blob is present
- **THEN** the worker boots with defaults (IPR auto-discovery, default DNS)

### Requirement: Unknown call kinds SHALL be ignored

The worker MUST ignore call kinds it does not recognise, per §8.

#### Scenario: Unknown kind
- **WHEN** the host sends a call of an unrecognised kind
- **THEN** the worker ignores it and does not fail

## Technical Notes

- **Implementation**: `src/nym-anon-client.ts` (core), `src/worker-main.ts` (wires the real `mix-fetch` and the `anonRpcWorker` capability API), `src/tunnel-worker-patch.ts` and `src/idb-prelude.ts` (the sandbox IndexedDB shim).
- **Sandbox and identity**: the harness runs the worker in a null-origin Web Worker; mix-tunnel's nested WASM worker spawns from a `blob:` URL, and the patch prepends an in-memory IndexedDB shim because the opaque origin denies the real one. The Nym identity is ephemeral per boot.
- **Not a secure context**: the opaque origin means `crypto.subtle` and `crypto.randomUUID` are absent; `crypto.getRandomValues` is the dependable primitive.
- **Known limits**: abort is not cancel; redirects are best-effort (smolmix follows them itself); the bundle is large (inlined WASM); WebKit is unverified.
- **Related specs**: [[worker-deployment]], and the active change [[kps-resolver]].
