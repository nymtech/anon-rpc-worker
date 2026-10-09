// Core logic of the Nym anon-rpc worker, kept free of any import of
// @nymproject/mix-fetch so it can be unit-tested in Node without WASM,
// nested Workers, or a mixnet. The entry point (worker-main.ts) injects the
// real tunnel functions via `TunnelDeps`.

import type {
  AnonRpcWorkerApi,
  AnonRequestInit,
  AnonFetchResponse,
  ByteBody,
  HeaderList,
} from "./spec-types.js";

// The subset of @nymproject/mix-fetch this worker consumes.
export type TunnelDeps = {
  setupMixTunnel(opts?: Record<string, unknown>): Promise<void>;
  mixFetch(url: string, init?: RequestInit): Promise<Response>;
};

// Optional worker configuration, stored by the host (via its own tooling)
// under this key as UTF-8 JSON. The value is passed to setupMixTunnel as
// SetupMixTunnelOpts: preferredIpr, disableCoverTraffic, connectTimeoutMs, …
export const CONFIG_KEY = "nym/setup-opts";

// Bootstrap retry backoff, mirroring the tor-js canonical network worker: base
// 1s, doubling per attempt, capped at 60s, then 50-100% jitter so many workers
// do not retry in lockstep against the same gateways.
const BOOTSTRAP_RETRY_BASE_MS = 1_000;
const BOOTSTRAP_RETRY_MAX_MS = 60_000;
function bootstrapBackoff(attempt: number): number {
  const exp = Math.min(
    BOOTSTRAP_RETRY_MAX_MS,
    BOOTSTRAP_RETRY_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

export async function readSetupOpts(
  api: AnonRpcWorkerApi,
): Promise<Record<string, unknown> | undefined> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await api.storage.get(CONFIG_KEY);
  } catch (e) {
    api.log.warn("storage.get(config) failed:", errMsg(e));
    return undefined;
  }
  if (!bytes) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    api.log.warn("config is not a JSON object; ignoring");
  } catch (e) {
    api.log.warn("config is not valid JSON; ignoring:", errMsg(e));
  }
  return undefined;
}

// Config precedence (§7.1). The host-supplied `config` object is the standard
// path, which the wallet guide configures a worker through, so it wins. When the
// host supplies none, `config` is undefined and we fall back to the repo's own
// opts stored under CONFIG_KEY. A config that is present but not a JSON object
// is a permanent error (it throws): our config is optional (the IPR
// auto-discovers), so only a present, malformed config is fatal, matching how
// tor-js treats bad config as permanent rather than retryable.
export async function readConfig(
  api: AnonRpcWorkerApi,
): Promise<Record<string, unknown> | undefined> {
  const c = api.config;
  if (c !== undefined) {
    if (c && typeof c === "object" && !Array.isArray(c)) {
      return c as Record<string, unknown>;
    }
    throw new Error("anonRpcWorker.config must be a JSON object");
  }
  return readSetupOpts(api);
}

export async function runNymWorker(
  api: AnonRpcWorkerApi,
  deps: TunnelDeps,
): Promise<void> {
  // §7.1: read and validate config once. A permanent error (a present-but-
  // malformed config) rejects the host's `.ready` via signalFailed and stops;
  // retrying cannot fix it. Message only, no code, to match the tor-js
  // canonical network worker (the spec does not standardise a code).
  let baseOpts: Record<string, unknown>;
  try {
    baseOpts = (await readConfig(api)) ?? {};
  } catch (e) {
    api.log.error("fatal config error:", errMsg(e));
    api.signalFailed({ message: errMsg(e) });
    return;
  }

  // One tunnel-setup attempt at a time. A failed attempt clears the slot so
  // the next fetch call (or the boot retry loop) starts a fresh one; the call
  // that awaited the failed attempt rejects rather than waiting forever.
  let tunnelReady: Promise<void> | undefined;
  const ensureTunnel = (): Promise<void> => {
    if (!tunnelReady) {
      tunnelReady = (async () => {
        // Per-attempt copy of the validated config. Fresh clientId per attempt
        // unless the host pinned one: smolmix namespaces its stored identity by
        // clientId, and a failed attempt can leave its gateway connection
        // orphaned, and retrying with the same identity then livelocks on "already
        // an open connection to this client". A fresh identity re-registers
        // cleanly (and is ephemeral anyway wherever the IndexedDB shim is active).
        const opts = { ...baseOpts };
        if (opts["debug"] === undefined) {
          opts["debug"] = false;
        }
        if (opts["clientId"] === undefined) {
          opts["clientId"] = `anon-rpc-${randomId()}`;
        }
        if (opts["primaryDns"] === undefined) {
          opts["primaryDns"] = "194.72.35.194:53";
        }
        if (opts["fallbackDns"] === undefined) {
          opts["fallbackDns"] = "9.9.9.9:53";
        }
        await deps.setupMixTunnel(opts);
      })();
      tunnelReady.catch(() => {
        tunnelReady = undefined;
      });
    }
    return tunnelReady;
  };

  // §7: signalReady() once the mixnet tunnel is up. A transient setup failure
  // (a down/unreachable gateway or IPR) is retried indefinitely with capped
  // jittered backoff, the tor-js way: `.ready` stays pending rather than
  // rejecting, and we never signalFailed for a transient failure. The harness
  // buffers calls until then, and the accept loop below runs from boot, so
  // nothing is dropped meanwhile.
  void (async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await ensureTunnel();
        api.signalReady();
        api.log.info("nym tunnel ready");
        return;
      } catch (e) {
        const delay = bootstrapBackoff(attempt);
        api.log.warn(
          `tunnel setup failed (attempt ${attempt}); retrying in ${(delay / 1000).toFixed(1)}s:`,
          errMsg(e),
        );
        await sleep(delay);
      }
    }
  })();

  for (;;) {
    let call;
    try {
      call = await api.acceptCall();
    } catch (e) {
      api.log.error("acceptCall failed:", errMsg(e));
      return;
    }
    if (call.kind !== "fetch") continue; // §8: ignore unknown call kinds
    call.respond(handleFetch(call.url, call.requestInit));
  }

  async function handleFetch(
    url: string,
    init?: AnonRequestInit,
  ): Promise<AnonFetchResponse> {
    init?.signal?.throwIfAborted();
    await abortable(ensureTunnel(), init?.signal);
    const resp = await abortable(
      deps.mixFetch(url, await toRequestInit(init)),
      init?.signal,
    );
    return toAnonResponse(resp);
  }
}

// AnonRequestInit → the RequestInit handed to mixFetch. Everything in the
// result must survive structured clone: mix-tunnel ships it over Comlink to
// its tunnel worker. So headers stay a plain pair array, a streaming body is
// buffered to a Uint8Array, and `signal` is never included (AbortSignal is
// not cloneable, so cancellation is handled outside via `abortable`).
export async function toRequestInit(
  init?: AnonRequestInit,
): Promise<RequestInit | undefined> {
  if (!init) return undefined;
  const out: RequestInit = {};
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers as [string, string][];
  if (init.body) out.body = (await readAll(init.body)) as BodyInit;
  if (init.redirect) out.redirect = init.redirect;
  return out;
}

export async function toAnonResponse(
  resp: Response,
): Promise<AnonFetchResponse> {
  const headers: HeaderList = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  return {
    status: resp.status,
    headers,
    body: new Uint8Array(await resp.arrayBuffer()),
    url: resp.url || undefined,
  };
}

// Reject when `signal` aborts, so the host's cancellation is observed even
// though an in-flight mixnet transfer itself cannot be cancelled mid-way.
export function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort),
    );
  });
}

async function readAll(body: ByteBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// crypto.randomUUID is unavailable here: the sandboxed worker has an opaque
// origin, which is not a secure context. getRandomValues always exists.
function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
