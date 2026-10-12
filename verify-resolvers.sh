#!/usr/bin/env bash
# Verify that each resolver URL serves bytes whose keccak256 equals the pinned
# workerHash, before trusting it in a WorkerSpecifier. The keccak and the
# compare are done in node (same @noble/hashes the build uses); this script just
# loops over the URLs and reports.
#
# With no arguments it reads the pinned hash and URLs from resolvers.json, so
# the stored record is the single source of truth. Pass them explicitly to
# check an ad-hoc set instead.
#
# Usage: ./verify-resolvers.sh                         (reads resolvers.json)
#        ./verify-resolvers.sh <0x-workerHash> <url>...  (explicit)
# Exit:  0 if every URL matches, 1 if any mismatch or fetch fails.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -eq 0 ]; then
  manifest="$here/resolvers.json"
  [ -f "$manifest" ] || { echo "no resolvers.json at $manifest, and no arguments given" >&2; exit 2; }
  want=$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(m.workerHash)' "$manifest")
  mapfile -t urls < <(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).resolvers.forEach((u) => console.log(u))' "$manifest")
elif [ "$#" -ge 2 ]; then
  want="$1"
  shift
  urls=("$@")
else
  echo "usage: $0 [<0x-workerHash> <url> ...]   (no args reads resolvers.json)" >&2
  exit 2
fi

rc=0
for url in "${urls[@]}"; do
  if node --input-type=module -e '
    import { keccak_256 } from "@noble/hashes/sha3.js";
    const [want, url] = process.argv.slice(1);
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = new Uint8Array(await r.arrayBuffer());
      const got = "0x" + [...keccak_256(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      if (got.toLowerCase() !== want.trim().toLowerCase()) throw new Error("hash mismatch, got " + got);
    } catch (e) {
      console.error("      " + e.message);
      process.exit(1);
    }
  ' "$want" "$url"; then
    echo "ok    $url"
  else
    echo "FAIL  $url"
    rc=1
  fi
done

exit "$rc"
