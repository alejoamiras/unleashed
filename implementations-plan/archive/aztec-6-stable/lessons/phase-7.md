# Phase 7: the Nulo packages

The watcher fired when npm served `@nulo-sh/wallet-crypto` `0.3.0` with peers `@aztec-labs/accounts` and
`@aztec-labs/foundation` at `6.0.0`. All three packages were at `0.3.0`; `wallet-sdk-schema-patch` peers
`aztec.js` and `stdlib` at `6.0.0` and depends on `zod ^4.4.3`, and `resolve-asset` has no peers.

## The tarballs

Each was downloaded into a fresh empty directory; the registry's sha512 `dist.integrity` matched the file, and
the sha256 matched the `0.3.0` block of the wallet repository's `scripts/publish/approved-digests.json`
(`dev`, added by `636df9c0`, "prepare the @nulo-sh packages 0.3.0 on aztec 6.0.0"):

| Tarball | sha256 |
|---|---|
| `nulo-sh-resolve-asset-0.3.0.tgz` | `ea222dec00145f91249d3fab9b7ff476f14a3fbcf6ea24a9a933813518c9522d` |
| `nulo-sh-wallet-crypto-0.3.0.tgz` | `f2693c948d3c715bcb999471c0cbadd659afc2fdc6f0c6105faf8bc3aa19a6e1` |
| `nulo-sh-wallet-sdk-schema-patch-0.3.0.tgz` | `e7add1a4ba9de81151661404020bdf255677542297549210de582981a026bf86` |

In a scratch npm project with install scripts off, `npm audit signatures` reported verified registry
signatures and verified attestations for all four packages (the three and `zod`). Each SLSA v1 statement names
`https://github.com/nulo-sh/nulo`, `refs/heads/dev`, `.github/workflows/publish-packages.yml` and commit
`636df9c08cf5d9c1fe6de493782e725844e5c665`, the same commit that approved the digests.

## The vectors

The wallet's `reference/nulo-v6.1/vectors.json` at `636df9c0` is unchanged since its rc.3 commit, and its two
account-key vectors equal the ones `deployer-keys.test.ts` pins. In a scratch Bun project (the repository's
7-day gate, the Aztec line excluded locally, install scripts off) holding `wallet-crypto@0.3.0` beside the
`6.0.0` peers, one `@aztec-labs/foundation` copy resolved and `deployer-keys.test.ts` passed 7 of 7. No vector
moved, so nothing went to the owner.

## The pin

`apps/tools` and `packages/bridge-core` pin the three packages at `0.3.0`. No Aztec package is seven days old
yet, so the install ran with the 17 direct Aztec names as temporary excludes (the Phase 2 loop, no name outside
the two Aztec scopes); `bunfig.toml` was restored and `bun install --frozen-lockfile --force` passed on the
committed configuration.

The lockfile changed in the three Nulo entries, whose sha512 values are the registry's, and in one more place:
the `@unleashed/tools/viem` 2.55.17 subtree left. Re-resolving the edited workspace let its `viem ^2.52.2`
range dedupe onto the `viem@2.57.1` that `bridge-core` pins (D20), so the app now bundles that single copy.

`UPDATE.md`'s current-line entry names `0.3.0` and its `6.0.0` peers.

## Gate

`AddressesView.test.ts > lists every contract by chain …` timed out at 5000 ms in the first `bun run test:all`
after the forced reinstall, and again in both full runs below, each at a load average near 300 on 188 cores.
It is the load timeout `follow-ups.md` already records, not the pin: alone, at the same load, the file passed
3 of 3 with 4.06 s of test time, and a full `test:all` re-run on the same tree after the first timeout (1680
passed, exit 1) failed only the testnet-manifest case, so the re-run rule cleared it. No timeout was touched.

The Phase 7 browser re-run and the Phase 8 gate, re-run on the pinned tree:

| Layer | Result |
|---|---|
| Sandbox smoke | exit 0, 954 s |
| `bridge-core` `test:integration` | 35 passed (6 files), 1618 s |
| `e2e:tools` | 73 passed, 5830 s; the `private FJ balance read failed` line 72 times, as in Phase 6 |
| `lint`, `typecheck:all` | exit 0 |
| `test:all` | 1679 passed; failed `testnet-bridge.json is a valid v2 manifest for its own chain` (clears at promotion) and the `AddressesView` load timeout; a re-run failed the same two |
| `test:ci-gating` | 37 passed, 0 failed (`published-packages.test.ts` closed) |
| `verify:deployments`, `build:testnet` + `verify:build-target testnet`, `build:mainnet` + `verify:build-target mainnet`, `build:landing` | exit 0 |
