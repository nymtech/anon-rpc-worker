# Tasks: rehearse-sepolia-deploy

Status: Sepolia run PASSED 2026-10-06. Specifier `0xaf91843ceF06A3D6B3cE2029338EF3119fbe771F`. The remote-resolver blocker (6.3) is cleared: `nymtech/anon-rpc-worker` is public, the `keccak` branch is pushed (commit `6361085`), and the worker is published to npm `0.1.0` (jsdelivr + unpkg). mix-fetch shipped as `3.0.0` and the production bundle is built (hash `0xf13a448a...`), so the mainnet prerequisites are met; funding the owner key and running the deploy remain.

## 0. Prerequisites

- [x] 0.1 Sepolia RPC: public endpoint `https://ethereum-sepolia-rpc.publicnode.com`.
- [x] 0.2 Throwaway deploy key funded with Sepolia ETH (`0x7A90..`, 0.5 ETH).
- [x] 0.3 keccak branch repo: `origin` was your fork during the rehearsal; the repo is now public at `nymtech/anon-rpc-worker` (see 2.1).
- [x] 0.4 KPS leg DEFERRED to a second pass (an additional extra, not required now). The HTTPS resolver legs proceed without it.

## 1. Build and self-test (rehearsal 2.1.1 bytes)

- [x] 1.1 Built; hash `0x7e7f84691f72d4d548525cbf88039ebe51ed580f75fc1e2c9b62dc72580b3b29`. Reproducible from the lockfile.

## 2. Host the bytes on a resolver

- [x] 2.1 `push-keccak.mjs` works: pushed the keccak branch to the repo over SSH. The repo was PRIVATE during the rehearsal, so remote hosting was deferred (see 6.3). Now resolved: `nymtech/anon-rpc-worker` is public and the `keccak` branch is pushed (commit `6361085`), so `raw.githubusercontent` serves the bundle at `f1/3a448a...` unauthenticated.
- [x] 2.2 (local resolver stood in) `serve-bundle.mjs` serves the bundle with CORS at `http://127.0.0.1:8099`, referenced on-chain. The headless browser resolves it on the same machine; nothing is published. Verified by the pre-gas check and the boot.
- [ ] 2.3 (optional, KPS pass) Stand up a Path 1 resolver (`tor-js-gateway --no-sync`, config at the `keccak` branch) on a static-IP host; record its `kps:` address.
- [ ] 2.4 (optional, KPS pass) `npm run verify-kps -- <kps-address>/keccak/<hh>/<rest> <pinned-hash>` passes. First real run of `verify-kps` and the `openStream` dial.

## 3. Deploy the specifier on Sepolia

- [x] 3.1 `.env` set: Sepolia RPC, funded throwaway key, local resolver URL, verify loop ON, Etherscan key.
- [x] 3.2 Deployed: specifier `0xaf91843ceF06A3D6B3cE2029338EF3119fbe771F`; resolver verified pre-gas; on-chain read-back matched. (Sourcify/Etherscan source verification failed on index lag; best-effort, non-blocking.)
- [x] 3.3 Recorded the specifier, hash, and resolver.

## 4. End-to-end boot against Sepolia

- [x] 4.1 On-chain e2e harness written: `test/e2e/run-onchain.mjs` (`npm run test:onchain`; written as run-sepolia.mjs during the rehearsal). Reads the real specifier over `SPECIFIER_RPC_URL` (proxied through the local server so the page does not depend on the testnet RPC's CORS), fetches the bundle from the on-chain resolver, then boots and round-trips RPC over the mixnet. Env: `SPECIFIER_ADDRESS`, `SPECIFIER_RPC_URL`, optional `RPC_URL`/`EXPECT_CHAIN_ID`. No prior art in tor-js (it mocks the chain everywhere).
- [x] 4.2 PASSED 2026-10-06: booted off the real Sepolia specifier and the resolver, tunnel ready 7.0s, `eth_blockNumber` -> `0x18ec66c`, `eth_chainId` -> `0x1`, all assertions green.
- [ ] 4.3 (optional) Live-site check: open the public demo and use its "drag a .js worker bundle" mode with `dist/nym-anon-rpc-worker.js`. The page pins the hash, builds an in-memory specifier, and runs the real harness over the mixnet, with nothing published and no chain. Note: the demo's paste-a-specifier mode reads from MAINNET only (hardcoded RPCs), so a Sepolia specifier will not resolve there; drag-bundle is the way to test our worker on the live site now.

## 5. Rehearse the upgrade path (de-risk the mainnet byte swap)

- [ ] 5.1 Produce a second bundle variant and host it (serve it locally, or on the public resolver once available).
- [ ] 5.2 `setWorker(newHash, newResolvers)` on the Sepolia specifier via the owner key. Host the new bytes BEFORE the call.
- [ ] 5.3 Re-run the Sepolia e2e; confirm it now boots the new bytes. This is the exact action the mainnet release takes (mix-fetch 3.0.0 has shipped).
- [ ] 5.4 (optional) Rehearse `transferOwnership`: transfer to a second throwaway key, confirm `owner()` reads it back, confirm the old key can no longer `setWorker`.

## 6. Record and mainnet readiness

- [x] 6.1 Recorded the rehearsal outcome and gotchas.
- [x] 6.2 Mainnet delta confirmed and now satisfied: new bytes (mix-fetch shipped as `3.0.0`; production hash `0xf13a448a...`), mainnet RPC, real gas, the real owner key, and the production resolver set (`@nymproject` npm `0.1.0` for jsdelivr + unpkg, the `nymtech` `keccak` branch; KPS deferred to its own pass). Everything else is unchanged from this rehearsal.
- [x] 6.3 REMOTE resolver hosting done: `nymtech/anon-rpc-worker` is public, the `keccak` branch is pushed (commit `6361085`), and `@nymproject/anon-rpc-worker@0.1.0` is on npm, so jsdelivr, unpkg, and `raw.githubusercontent` all resolve. Still worth one live remote boot against the real URL before mainnet to prove availability and CORS end to end.
