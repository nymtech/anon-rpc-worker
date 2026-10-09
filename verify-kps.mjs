// Verify that a kps: resolver serves bundle bytes matching a pinned keccak256
// (anon-rpc SPEC §4.1-4.2). The specifier deploy tool (publish-worker.mjs)
// skips kps: entries ("checked by harnesses only"), so the mandatory pre-gas
// byte check does not exist for KPS. This closes that gap: run it before any
// setWorker that adds or keeps a kps: resolver.
//
// It dials over QUIC (the node-side KPS client). The browser harness uses the
// webrtc client against the same ip:port:certhash address; both speak the same
// single-exchange profile, so a QUIC verify predicts a browser fetch.
//
// Usage:
//   node verify-kps.mjs <kps-resolver> <expected-keccak256>
//   node verify-kps.mjs --print <kps-resolver>
//
//   <kps-resolver>       kps:<ip>:<port>:<certhash>/<path>  (SPEC §4.1)
//   <expected-keccak256> 0x-prefixed 32-byte keccak256 the served bytes must match
//   --print              print the served bytes' keccak256 and exit WITHOUT
//                        verifying (for discovering a hash, never a pass)
//
// Exit 0 means verified (or --print). Every other outcome exits non-zero, so a
// deploy wrapper can treat exit 0 as "bytes match the pin". An omitted or
// malformed expected hash is an error, never a silent pass.

import { keccak_256 } from "@noble/hashes/sha3.js";
import zlib from "node:zlib";

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024; // headroom above the ~16 MB bundle
const HEADER_HEADROOM = 64 * 1024;
const EXCHANGE_TIMEOUT_MS = 60_000; // a resolver that never sends EOF must not hang us
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const CRLF = "\r\n";
const enc = new TextEncoder();
const toHex = (b) => "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// Content codings this Node build can decode, each capped at the bundle size so
// a compression bomb throws (ERR_BUFFER_TOO_LARGE) instead of allocating
// gigabytes before the size check. Only these are advertised in Accept-Encoding,
// so the request never offers a coding it cannot decode (§4.2).
function buildDecoders() {
  const opts = { maxOutputLength: MAX_BUNDLE_BYTES };
  const d = {
    gzip: (b) => zlib.gunzipSync(b, opts),
    deflate: (b) => zlib.inflateSync(b, opts),
  };
  if (typeof zlib.brotliDecompressSync === "function") d.br = (b) => zlib.brotliDecompressSync(b, opts);
  if (typeof zlib.zstdDecompressSync === "function") d.zstd = (b) => zlib.zstdDecompressSync(b, opts);
  return d;
}

// §4.1: split at the FIRST "/". A certhash is base64url and a bracketed IPv6
// host never contains "/", so this is unambiguous. Deliberately not a URL.
function parseKpsResolver(entry) {
  if (!entry.startsWith("kps:")) fail(`not a kps resolver: ${entry}`);
  // Reject control characters anywhere: the path goes into the request line and
  // the certhash into the Host header, so a CR or LF would inject a new line.
  if (/[\u0000-\u001f\u007f]/.test(entry)) fail("malformed kps resolver: control character");
  const rest = entry.slice("kps:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) fail("malformed kps resolver: missing /path");
  const addr = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (path.includes(" ")) fail("malformed kps resolver: space in path");
  if (addr.split(":").length < 3) fail("malformed kps resolver: bad address");
  const certhash = addr.slice(addr.lastIndexOf(":") + 1);
  return { addr, path, certhash };
}

function findHeaderEnd(b) {
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  }
  return -1;
}

// Parse a complete (EOF-delimited) response. Strict per §4.2: a violation is
// fatal, never leniently recovered.
function parseResponse(bytes) {
  const sep = findHeaderEnd(bytes);
  if (sep < 0) fail("no header terminator in response");
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, sep));
  const lines = head.split(CRLF);
  const m = /^HTTP\/1\.1 (\d{3})(?: |$)/.exec(lines[0]);
  if (!m) fail(`malformed status line: ${JSON.stringify(lines[0].slice(0, 80))}`);
  const headers = [];
  for (const line of lines.slice(1)) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) fail(`malformed header line: ${JSON.stringify(line.slice(0, 80))}`);
    const name = line.slice(0, colon).trim().toLowerCase();
    // §4.2: Transfer-Encoding is forbidden in either direction.
    if (name === "transfer-encoding") fail("forbidden Transfer-Encoding in response");
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { status: Number(m[1]), headers, body: bytes.subarray(sep + 4) };
}

// One stream, one request/response exchange (§4.2): write the GET, closeWrite,
// read to EOF (wire-capped), return the raw response bytes.
async function fetchExchange(addr, path, certhash, advertised) {
  const request = enc.encode(
    `GET ${path} HTTP/1.1${CRLF}Host: ${certhash}${CRLF}` +
      `Accept-Encoding: ${advertised.join(", ")}${CRLF}${CRLF}`,
  );
  // openStream mirrors the webrtc client the harness uses.
  const { openStream } = await import("@kpstreams/quic-client");
  const stream = await openStream(addr);
  try {
    const writer = stream.writable.getWriter();
    await writer.write(request);
    await writer.close(); // closeWrite: the request is EOF-terminated

    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BUNDLE_BYTES + HEADER_HEADROOM) {
        await reader.cancel().catch(() => {});
        fail(`response exceeds the ${MAX_BUNDLE_BYTES}-byte cap`);
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      all.set(c, off);
      off += c.byteLength;
    }
    return all;
  } finally {
    await stream.close().catch(() => {});
  }
}

function withTimeout(promise, ms, msg) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print");
  const [resolver, expected] = argv.filter((a) => a !== "--print");
  if (!resolver) {
    fail("usage: node verify-kps.mjs <kps-resolver> <expected-keccak256> | --print <kps-resolver>");
  }
  if (!printOnly) {
    if (!expected) fail("expected keccak256 required (or pass --print to only print the served hash)");
    if (!HASH_RE.test(expected)) fail(`not a 0x-prefixed 32-byte keccak256: ${expected}`);
  }
  const { addr, path, certhash } = parseKpsResolver(resolver);

  const decoders = buildDecoders();
  const advertised = Object.keys(decoders);
  const all = await withTimeout(
    fetchExchange(addr, path, certhash, advertised),
    EXCHANGE_TIMEOUT_MS,
    `resolver did not complete within ${EXCHANGE_TIMEOUT_MS} ms`,
  );

  const resp = parseResponse(all);
  // §4.2: any status other than 200 fails the resolver; redirects never followed.
  if (resp.status !== 200) fail(`HTTP ${resp.status} from resolver`);

  // §4.2: a response may use exactly one coding the request advertised. More
  // than one Content-Encoding field, or an unadvertised coding, fails. The cap
  // is enforced on the decoded bytes (by maxOutputLength in the decoder).
  const encodings = resp.headers.filter(([n]) => n === "content-encoding");
  if (encodings.length > 1) fail("multiple Content-Encoding header fields");
  const coding = encodings[0]?.[1].toLowerCase();
  let body = resp.body;
  if (coding && coding !== "identity") {
    if (!advertised.includes(coding)) fail(`unadvertised Content-Encoding: ${coding}`);
    try {
      body = new Uint8Array(decoders[coding](body));
    } catch (e) {
      fail(`cannot decode ${coding} body within the ${MAX_BUNDLE_BYTES}-byte cap: ${e.message}`);
    }
  }
  if (body.byteLength > MAX_BUNDLE_BYTES) fail(`body exceeds the ${MAX_BUNDLE_BYTES}-byte cap`);

  const got = toHex(keccak_256(body));
  console.log(`resolver:  ${resolver}`);
  console.log(`bytes:     ${body.byteLength}`);
  console.log(`keccak256: ${got}`);

  if (printOnly) {
    console.log("print-only mode: no verification performed");
    return;
  }
  if (got.toLowerCase() !== expected.toLowerCase()) {
    fail(`hash mismatch: resolver serves ${got}, expected ${expected}`);
  }
  console.log("match: resolver serves the pinned bytes");
}

main().catch((e) => fail(e.stack || String(e)));
