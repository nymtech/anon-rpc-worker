// Bundles the worker to a single standalone IIFE: dist/nym-anon-rpc-worker.js.
// The bytes of that file are the §4 artifact, keccak256 of them is what a
// specifier contract's workerHash() pins; it is printed after the build.
//
// Two-stage: the IndexedDB shim prelude (src/idb-prelude.ts) is bundled first
// and injected as the virtual module "idb-prelude-source" (a string), which
// tunnel-worker-patch.ts prepends to mix-tunnel's nested-worker blob at
// runtime.

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { keccak_256 } from "@noble/hashes/sha3.js";

const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const outfile = "dist/nym-anon-rpc-worker.js";

const prelude = await build({
  entryPoints: ["src/idb-prelude.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
  logLevel: "warning",
});
const preludeSource = new TextDecoder().decode(prelude.outputFiles[0].contents);

await build({
  entryPoints: ["src/worker-main.ts"],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
  plugins: [
    {
      name: "idb-prelude-source",
      setup(b) {
        b.onResolve({ filter: /^idb-prelude-source$/ }, (args) => ({
          path: args.path,
          namespace: "idb-prelude-source",
        }));
        b.onLoad({ filter: /.*/, namespace: "idb-prelude-source" }, () => ({
          contents: `export default ${JSON.stringify(preludeSource)};`,
          loader: "js",
        }));
      },
    },
  ],
});

const bytes = await readFile(outfile);
const workerHash = `0x${toHex(keccak_256(bytes))}`;
console.log(`workerHash (keccak256): ${workerHash}`);
console.log(`bundle size: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`);

// Optional reproducibility gate: set EXPECTED_HASH to fail the build unless it
// reproduces that hash. Used by CI, and handy for verifying a pinned release.
const expected = process.env.EXPECTED_HASH?.trim().toLowerCase();
if (expected && workerHash !== expected) {
  console.error(`EXPECTED_HASH mismatch: built ${workerHash}, expected ${expected}`);
  process.exit(1);
}
