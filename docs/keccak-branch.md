# The `keccak` branch resolver

One day-one resolver: a GitHub branch, named `keccak`, that serves the worker bundle from a content-addressed path. It is one of several resolver options; this page covers the `keccak` branch on its own and how the tool ships it.

## Status

Built, not yet run. The deploy tool lives in the `anon-rpc` repo at `impl/specifier/publish-worker.mjs`; its `--github` flag uploads the bundle to the `keccak` branch through `impl/specifier/github-resolver.mjs`, then verifies the pushed URL. This worker repo has `build.mjs`, which writes `dist/nym-anon-rpc-worker.js` and prints its keccak256 `workerHash`. The `keccak` branch itself does not exist yet, because no deploy has run.

## What it is

The anon-rpc spec needs two or more resolvers that serve the exact bundle bytes. One `pnpm publish` gives us two for free, because npm fans the package out to jsdelivr and unpkg. The `keccak` branch is a third resolver that we host in our own repo (`nymtech/anon-rpc-worker`). It serves the same bytes from a path derived from the bundle's own keccak256 hash. That hash is the name.

## Why we want it

It costs very little (one flag on the publish tool) and it is the one day-one resolver we control. The two CDN URLs depend on npm; the `keccak` branch does not. Three resolvers from two independent hosts is more robust than two resolvers from one.

## How it works

The harness never trusts a resolver. It reads the bundle's keccak256 from the on-chain `WorkerSpecifier`, fetches the bytes from a resolver, and runs them only if `keccak256(bytes) == workerHash()`. Wrong bytes get rejected and the harness tries the next resolver. So the `keccak` branch is about how reliably the correct bytes reach a wallet, not about whether we trust GitHub.

The branch is a content-addressed file tree. The bundle lives at `<hh>/<rest>`, where `<hh>` is the first byte of the keccak256 (two hex characters) as a shard directory, and `<rest>` is the remaining hash as the filename. The branch name is a path segment in the URL, so with the default `keccak` branch the resolver URL a harness fetches is:

```
https://raw.githubusercontent.com/nymtech/anon-rpc-worker/keccak/<hh>/<rest>
```

A hash `194f04...8d` serves from `.../keccak/19/4f04...8d`. This matches the kps resolver example in SPEC §4.1 and the tor-js gateway route `GET /keccak/{hh}/{rest}`: one byte of shard, the rest of the hash as the name. The specifier stores the full URL (`github-resolver.mjs` builds it from the bundle hash at deploy time), so the harness fetches it as-is and checks the bytes against the hash it already read on-chain.

Three properties fall out of the content-addressed layout:

| Property | Reason |
| --- | --- |
| Immutable | the path is the hash, so the bytes at a path can never change meaning |
| Additive | a new build lands at a new path, so old versions stay fetchable |
| Clean history | the branch holds bundle bytes only, so the large binary never enters `main` |

## The trade-off

| Property | `keccak` branch |
| --- | --- |
| Effort | Low (one `--github` flag on the publish tool) |
| Immutable URL | Yes (content-addressed path) |
| Availability | Medium (`raw.githubusercontent.com`, no immutable CDN cache in front) |
| We control it | Partly (our repo, but GitHub can block or remove it) |
| Censorship-resistant | No (still a domain and CA endpoint, so a censor can block it) |
| Cost | Free |

The last row is the limit worth stating plainly. Like the two CDNs, the `keccak` branch sits behind a domain and a CA. A censor can block the domain and stop a wallet fetching the bundle at all, even though the mixnet transport resists blocking. The only resolver that removes that weakness is a `kps:` resolver on Nym infrastructure (no domain, no CA, pinned by cert hash). That is a separate, larger decision in the hosting doc. The `keccak` branch is a cheap, controlled mirror, not the censorship-resistant path.

## What the `--github` step does

`publish-worker.mjs --github` turns a built bundle into a commit on the `keccak` branch, then checks that the pushed URL serves back the right bytes. The steps below are implemented in `github-resolver.mjs` (steps 1 to 4) and `publish-worker.mjs` (step 5).

| # | Step | Reason |
| --- | --- | --- |
| 1 | Read `dist/nym-anon-rpc-worker.js`, recompute its keccak256 | the path comes from the hash, so never use a stale one |
| 2 | Work out the path `<hh>/<rest>` | the content-addressed layout above |
| 3 | Add the bytes to the `keccak` branch at that path and commit | the publish itself |
| 4 | Push the branch | makes the `raw.githubusercontent.com` URL live |
| 5 | Fetch that URL, keccak256 it, assert it equals the pinned hash | verify byte-identity before we trust the resolver |

Two design points, both settled in the implementation:

Git plumbing, not a branch checkout. `github-resolver.mjs` uses `hash-object -w`, `mktree`, `commit-tree`, and `update-ref` to append one file to the branch without checking it out and without touching `main`. A `checkout keccak && cp && commit` flow is fragile in CI and risks dragging source files into the branch. The branch is orphan, so its history stays independent of the code history.

Verification is part of the contract, not polish. The hosting doc is firm: the HTTPS resolvers are keccak-checked before `publish-worker.mjs` spends gas, and the update path must do the same before `setWorker`. Step 5 runs in `publish-worker.mjs` with four retries a few seconds apart, to cover propagation of a just-pushed path.

## Open questions

1. Confirm the `keccak` branch as a day-one resolver, alongside jsdelivr and unpkg. (Recommended: yes. Low effort, one resolver under our control.)

Two earlier questions are now closed:

- The path split is `<hh>/<rest>`, one byte of shard and the rest of the hash as the filename (`github-resolver.mjs`, `rawUrl`). It matches the SPEC §4.1 kps example and the tor-js route, so our URLs match what harnesses expect.
- `publish-worker.mjs`, its `--github` step, and the pre-gas verification loop are written, in the `anon-rpc` repo at `impl/specifier/`.
