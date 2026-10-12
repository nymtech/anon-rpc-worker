// End-to-end test against a REAL on-chain WorkerSpecifier, on any chain
// (testnet or mainnet). Unlike run-e2e.mjs, which injects a mock specifier and
// serves the bundle from a local http server, this reads a deployed specifier
// over a real RPC and lets the harness fetch the bundle from the on-chain
// resolver, so the full SPEC §4 path runs against real infrastructure. Point
// SPECIFIER_RPC_URL at Sepolia to rehearse, or at mainnet for the production
// check; only the address, chain, and resolver set differ.
//
// Two chains are independent here: SPECIFIER_RPC_URL is the chain the specifier
// lives on; RPC_URL/EXPECT_CHAIN_ID is the chain the worker calls through the
// mixnet. They need not match.
//
// The specifier read (eth_call) is proxied through the local http server to
// SPECIFIER_RPC_URL, server-side, so the page does not depend on that RPC
// sending CORS headers. The bundle fetch from the resolver stays a real
// cross-origin browser fetch, which also proves the resolver sends the CORS
// headers a production harness needs.
//
// Run: npm run test:onchain
// Env (required):
//   SPECIFIER_ADDRESS   the deployed WorkerSpecifier
//   SPECIFIER_RPC_URL   a JSON-RPC endpoint for the chain the specifier is on
// Env (optional):
//   RPC_URL             the endpoint the worker calls through the mixnet
//                       (default a public mainnet RPC)
//   EXPECT_CHAIN_ID     asserted eth_chainId of RPC_URL (default 0x1)
//   READY_TIMEOUT_MS    default 180000

import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { chromium } from "playwright";
import { build as esbuild } from "esbuild";
import { assessTopology } from "./topology.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../..", import.meta.url).pathname;

const SPECIFIER_ADDRESS = process.env.SPECIFIER_ADDRESS;
const SPECIFIER_RPC_URL = process.env.SPECIFIER_RPC_URL;
const RPC_URL = process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";
const EXPECT_CHAIN_ID = process.env.EXPECT_CHAIN_ID ?? "0x1";
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS ?? 180_000);

const cleanups = [];
const cleanup = () => cleanups.splice(0).reverse().forEach((fn) => { try { fn(); } catch {} });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });

function fail(msg) {
  console.error(`error: ${msg}`);
  cleanup();
  process.exit(1);
}

function check(label, ok, detail) {
  if (!ok) fail(`${label}${detail ? `\n   ${detail}` : ""}`);
  console.log(`  ok ${label}`);
}

const enc = new TextEncoder();
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const selector = (sig) => "0x" + toHex(keccak_256(enc.encode(sig))).slice(0, 8);

// Forward one JSON-RPC call to the specifier-chain RPC, server-side (no CORS).
async function specifierRpc(method, params) {
  const r = await fetch(SPECIFIER_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`specifier RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`specifier RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Decode an ABI-encoded string[] eth_call return, for logging the resolvers.
// Mirrors the encoding in run-e2e.mjs; best-effort, used only for display.
function decodeStringArray(hex) {
  const b = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const w = (o) => Number(BigInt("0x" + (b.subarray(o, o + 32).toString("hex") || "0")));
  const arr = w(0);
  const len = w(arr);
  const headsBase = arr + 32;
  const out = [];
  for (let i = 0; i < len; i++) {
    const tailOff = headsBase + w(headsBase + i * 32);
    const slen = w(tailOff);
    out.push(b.subarray(tailOff + 32, tailOff + 32 + slen).toString("utf8"));
  }
  return out;
}

async function main() {
  if (!SPECIFIER_ADDRESS) fail("SPECIFIER_ADDRESS is required (the deployed WorkerSpecifier)");
  if (!SPECIFIER_RPC_URL) fail("SPECIFIER_RPC_URL is required (a JSON-RPC endpoint for the specifier's chain)");

  // 0. gate on live directory health, as run-e2e.mjs does: a thin topology or a
  // fresh epoch rollover fails for network reasons, not code reasons.
  for (let i = 0; ; i += 1) {
    let t;
    try {
      t = await assessTopology();
    } catch (e) {
      fail(`cannot reach the Nym directory API: ${e.message}`);
    }
    if (t.ok) {
      console.log(`topology gate: epoch ${t.epochId}, ${t.mixCount} mixnodes, ${t.gwCount} gateways, proceeding`);
      break;
    }
    if (i >= 3) {
      console.log(`\nSKIPPED: ${t.reason} (live-network condition, not a code failure)`);
      cleanup();
      process.exit(0);
    }
    console.log(`topology gate: ${t.reason}; re-checking in 60s (${i + 1}/3)`);
    await new Promise((r) => setTimeout(r, 60_000));
  }

  // 1. read the real specifier off its chain, server-side. This both proves
  // the specifier exists on this chain and shows what it pins.
  const onchainHash = await specifierRpc("eth_call", [
    { to: SPECIFIER_ADDRESS, data: selector("workerHash()") },
    "latest",
  ]);
  if (!onchainHash || onchainHash === "0x" || /^0x0+$/.test(onchainHash)) {
    fail(`no WorkerSpecifier at ${SPECIFIER_ADDRESS} on this chain (workerHash() returned ${onchainHash})`);
  }
  let resolvers = [];
  try {
    const resolversRet = await specifierRpc("eth_call", [
      { to: SPECIFIER_ADDRESS, data: selector("workerResolvers()") },
      "latest",
    ]);
    resolvers = decodeStringArray(resolversRet);
  } catch (e) {
    console.log(`  (could not decode workerResolvers for display: ${e.message})`);
  }
  console.log(`specifier:  ${SPECIFIER_ADDRESS}`);
  console.log(`workerHash: ${onchainHash}`);
  console.log(`resolvers:  ${resolvers.join("\n            ") || "(none decoded)"}`);

  // 2. bundle the published harness entry the way a consumer's bundler would.
  const bundled = await esbuild({
    entryPoints: [`${ROOT}node_modules/@anon-rpc/browser-harness/dist/host.js`],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "warning",
  });
  const hostBundle = bundled.outputFiles[0].contents;
  const pageHtml = await readFile(`${HERE}page.html`);

  // 3. local http server: the page, the harness bundle, and an eth_call proxy
  // to the specifier-chain RPC. The worker bundle is NOT served here; the
  // harness fetches it from the on-chain resolver, as a real wallet would.
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (req.method === "POST" && url === "/rpc") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const upstream = await fetch(SPECIFIER_RPC_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });
          const text = await upstream.text();
          res.writeHead(upstream.status, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          });
          res.end(text);
        } catch (e) {
          res.writeHead(502, { "content-type": "application/json", "access-control-allow-origin": "*" });
          res.end(JSON.stringify({ error: { message: String(e) } }));
        }
      });
      return;
    }
    const send = (status, type, bodyOut) => {
      res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
      res.end(bodyOut);
    };
    if (url === "/") return send(200, "text/html", pageHtml);
    if (url === "/dist/host.js") return send(200, "text/javascript", hostBundle);
    send(404, "text/plain", "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`http server: ${origin}`);

  // 4. drive chromium
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const logFile = `${HERE}.last-run.log`;
  writeFileSync(logFile, `# onchain e2e ${new Date().toISOString()}\n`);
  const logLine = (line) => {
    console.log(`  ${line}`);
    appendFileSync(logFile, `${line}\n`);
  };
  page.on("console", (m) => logLine(`[page:${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logLine(`[page:error] ${e.message}`));

  await page.goto(`${origin}/`);
  await page.waitForFunction(() => "AnonRpcWorker" in window, null, { timeout: 5000 });

  console.log(`\nwaiting for mixnet tunnel (up to ${READY_TIMEOUT_MS / 1000}s)…`);
  const result = await page.evaluate(
    async (cfg) => {
      // A real provider: forward every call to the local proxy, which relays to
      // the specifier-chain RPC. The harness uses it only for eth_call (the specifier).
      const provider = {
        request: async ({ method, params }) => {
          const r = await fetch(cfg.rpcProxy, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          const j = await r.json();
          if (j.error) throw new Error(JSON.stringify(j.error));
          return j.result;
        },
      };
      const w = new window.AnonRpcWorker({
        address: cfg.specifier,
        preExisting: { rpcProvider: provider },
      });

      const t0 = performance.now();
      await Promise.race([
        w.ready,
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`worker not ready after ${cfg.readyTimeoutMs}ms`)), cfg.readyTimeoutMs),
        ),
      ]);
      const readyMs = Math.round(performance.now() - t0);
      const sandbox = document.querySelector("iframe")?.getAttribute("sandbox");

      const t1 = performance.now();
      const resp = await w.fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      const rpcMs = Math.round(performance.now() - t1);
      const status = resp.status;
      const json = await resp.json();

      const t2 = performance.now();
      const resp2 = await w.fetch(cfg.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_chainId", params: [] }),
      });
      const rpc2Ms = Math.round(performance.now() - t2);
      const json2 = await resp2.json();

      w.close();
      return { sandbox, readyMs, status, json, rpcMs, json2, rpc2Ms };
    },
    { specifier: SPECIFIER_ADDRESS, rpcProxy: `${origin}/rpc`, rpcUrl: RPC_URL, readyTimeoutMs: READY_TIMEOUT_MS },
  );

  console.log(`\ntunnel ready in ${result.readyMs / 1000}s;` +
    ` eth_blockNumber in ${result.rpcMs / 1000}s; eth_chainId in ${result.rpc2Ms / 1000}s`);
  console.log(`responses: ${JSON.stringify(result.json)} ${JSON.stringify(result.json2)}`);

  check("iframe sandbox is allow-scripts only (§6)", result.sandbox === "allow-scripts", result.sandbox);
  check("worker became ready off the on-chain specifier + real resolver", typeof result.readyMs === "number");
  check("HTTP 200 from RPC endpoint via mixnet", result.status === 200, `status=${result.status}`);
  check(
    "eth_blockNumber returns a hex quantity",
    typeof result.json?.result === "string" && /^0x[0-9a-f]+$/i.test(result.json.result),
    JSON.stringify(result.json),
  );
  check(
    `eth_chainId is ${EXPECT_CHAIN_ID}`,
    result.json2?.result === EXPECT_CHAIN_ID,
    JSON.stringify(result.json2),
  );

  console.log("\nall assertions passed: the worker booted off a real on-chain specifier and a real resolver, over the live mixnet");
  cleanup();
  process.exit(0);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", ...opts });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

main().catch((e) => fail(e.stack || String(e)));
