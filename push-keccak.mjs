// Publish the built worker bundle to THIS repo's content-addressed `keccak`
// branch, so it is served at
//   https://raw.githubusercontent.com/<owner>/<repo>/keccak/<hh>/<rest>
// (SPEC §4.1). <hh> is the first byte of the keccak256 (two hex chars), <rest>
// the remaining hash. The path is the hash, so it is immutable and additive.
//
// Why this and not anon-rpc's publish-worker --github: that tool pushes to the
// SPECIFIER repo (ethereum/anon-rpc), where anon-rpc co-locates its own worker.
// The worker lives in its own repo, so it hosts its own keccak branch here, on
// this repo's `origin`. Deploy the specifier separately, passing the printed URL
// as a resolver (publish-worker without --github).
//
// Git plumbing (hash-object / mktree / commit-tree / update-ref) appends one
// file to an orphan branch without touching the working tree, the index, or the
// current branch.
//
// Usage: node push-keccak.mjs [bundle-path]   (default: dist/nym-anon-rpc-worker.js)
// Env:   RESOLVER_REMOTE (default origin), RESOLVER_BRANCH (default keccak),
//        NO_PUSH=1 to build the commit locally without pushing.

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { keccak_256 } from "@noble/hashes/sha3.js";

const REPO_DIR = new URL(".", import.meta.url).pathname;
const DEFAULT_BUNDLE = `${REPO_DIR}dist/nym-anon-rpc-worker.js`;
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function git(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("git", args, { cwd: REPO_DIR });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(" ")} failed:\n${err || out}`)),
    );
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

async function tryGit(args) {
  try {
    return await git(args);
  } catch {
    return undefined;
  }
}

function parseGithubRemote(url) {
  const m =
    url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/) ??
    url.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`not a github remote: ${url}`);
  return { owner: m[1], repo: m[2] };
}

async function main() {
  const bundlePath = process.argv[2] || DEFAULT_BUNDLE;
  const remote = process.env.RESOLVER_REMOTE || "origin";
  const branch = process.env.RESOLVER_BRANCH || "keccak";
  const push = process.env.NO_PUSH !== "1";

  const bytes = new Uint8Array(await readFile(bundlePath));
  const hashHex = toHex(keccak_256(bytes));
  const dir = hashHex.slice(0, 2);
  const file = hashHex.slice(2);

  const remoteUrl = await git(["remote", "get-url", remote]);
  const { owner, repo } = parseGithubRemote(remoteUrl);
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}/${file}`;

  // Base the commit on the freshest view of the branch: remote-tracking after a
  // fetch, else a local branch, else an orphan root (history stays independent).
  await tryGit(["fetch", remote, branch]);
  const base =
    (await tryGit(["rev-parse", "--verify", `refs/remotes/${remote}/${branch}`])) ??
    (await tryGit(["rev-parse", "--verify", `refs/heads/${branch}`]));

  const blob = await git(["hash-object", "-w", "--stdin"], { input: bytes });

  // Already stored? Content-addressed, but compare the blob to be exact.
  if (base) {
    const existing = await tryGit(["rev-parse", "--verify", `${base}:${dir}/${file}`]);
    if (existing === blob) {
      await git(["update-ref", `refs/heads/${branch}`, base]);
      if (push) await git(["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
      console.log(`already present: ${url}`);
      return;
    }
  }

  // Inner tree: existing entries of <dir> plus our blob.
  const inner = new Map();
  if (base && (await tryGit(["rev-parse", "--verify", `${base}:${dir}`]))) {
    for (const line of (await git(["ls-tree", `${base}:${dir}`])).split("\n")) {
      if (!line) continue;
      const [meta, name] = line.split("\t");
      inner.set(name, meta);
    }
  }
  inner.set(file, `100644 blob ${blob}`);
  const innerTree = await git(["mktree"], {
    input: [...inner.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, m]) => `${m}\t${n}`).join("\n") + "\n",
  });

  // Root tree: existing top-level entries with <dir> pointing at the new tree.
  const root = new Map();
  if (base) {
    for (const line of (await git(["ls-tree", base])).split("\n")) {
      if (!line) continue;
      const [meta, name] = line.split("\t");
      root.set(name, meta);
    }
  }
  root.set(dir, `040000 tree ${innerTree}`);
  const rootTree = await git(["mktree"], {
    input: [...root.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([n, m]) => `${m}\t${n}`).join("\n") + "\n",
  });

  // The keccak branch holds only bundle bytes, so the commit author is
  // cosmetic; give it a sensible default (overridable) so commit-tree works
  // without a configured git identity.
  const name = process.env.GIT_AUTHOR_NAME || "anon-rpc-worker";
  const email = process.env.GIT_AUTHOR_EMAIL || "anon-rpc-worker@users.noreply.github.com";
  const commit = await git([
    "-c", `user.name=${name}`,
    "-c", `user.email=${email}`,
    "commit-tree", rootTree,
    ...(base ? ["-p", base] : []),
    "-m", `keccak: add ${hashHex}`,
  ]);
  await git(["update-ref", `refs/heads/${branch}`, commit]);
  if (push) await git(["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);

  console.log(`${push ? "pushed" : "committed (not pushed)"}: ${url}`);
}

main().catch((e) => {
  console.error(`error: ${e.stack || e}`);
  process.exit(1);
});
