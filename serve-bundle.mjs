// Serve the built worker bundle on a fixed local port with permissive CORS, so
// it can act as a resolver for a local or testnet rehearsal WITHOUT publishing
// the repo. Point the specifier's resolver at http://127.0.0.1:<port>/<path>;
// the headless browser in test:onchain reaches it on the same machine. Leave it
// running during both the deploy (publish-worker verify) and test:onchain.
//
// Not for production: a 127.0.0.1 resolver only resolves on this machine.
//
// Usage: node serve-bundle.mjs
// Env:   PORT (default 8099), BUNDLE (default dist/nym-anon-rpc-worker.js),
//        ROUTE (default /nym-anon-rpc-worker.js)

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8099);
const ROUTE = process.env.ROUTE ?? "/nym-anon-rpc-worker.js";
const BUNDLE = process.env.BUNDLE
  ? new URL(process.env.BUNDLE, `file://${process.cwd()}/`)
  : new URL("./dist/nym-anon-rpc-worker.js", import.meta.url);

const bytes = readFileSync(BUNDLE);

createServer((req, res) => {
  if (req.url.split("?")[0] === ROUTE) {
    res.writeHead(200, {
      "content-type": "text/javascript",
      "access-control-allow-origin": "*",
    });
    res.end(bytes);
    return;
  }
  res.writeHead(404, { "access-control-allow-origin": "*" });
  res.end("not found");
}).listen(PORT, "127.0.0.1", () =>
  console.log(`serving ${bytes.length} bytes at http://127.0.0.1:${PORT}${ROUTE} (CORS open), leave running`),
);
