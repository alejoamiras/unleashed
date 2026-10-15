# Phase 5: preconditions

## Identity reads (step 4)

Two public Sepolia RPCs (`ethereum-sepolia-rpc.publicnode.com`, `1rpc.io/sepolia`), neither of them dRPC, gave the
same answers:

| Read | Value |
|---|---|
| `chainId` | `11155111` |
| registry `0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba` `getCanonicalRollup()` | `0xEd1eB2eB670b42E2fB5A478c076A264b9604089d` |
| registry `getRollup(3409706519)` | the same rollup |
| rollup `getVersion()` | `3409706519` |
| rollup `getFeeAssetPortal()` | `0x6974Bde62C47A0041f5B4a2E61c5506c2B59Ce59` |
| rollup `getFeeAsset()` | `0x762C132040fdA6183066Fa3B14d985ee55aA3C18` |
| portal `ROLLUP()` / `UNDERLYING()` | the rollup / the fee asset |
| handler `0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9` `FEE_ASSET()` | the fee asset |

The keyless node `aztec-testnet.drpc.org` reports nodeVersion `6.0.0-rc.3`, l1ChainId `11155111`, rollupVersion
`3409706519`, and the same registry, rollup, fee portal and fee asset. F5 and F7 hold.

`1rpc.io` rate-limits a burst of reads ("cu limit exceeded"); a retry a few seconds later answered. A tool that
reads it in a loop needs backoff.

F8 (the SponsoredFPC and AuthRegistry classes) is re-read after the rc.3 packages are installed, because both
addresses are derived from the rc.3 artifacts.

## `bun audit` baseline (step 5)

On `main`, `bun audit` exits 1: 20 package groups, 71 advisories (34 high, 30 moderate, 7 low), all transitive
(`undici`, `ws`, `@opentelemetry/*`, and others under `@aztec-labs/*`, `jsdom` and `wrangler`). Phases 6 and 13
pass when the bump adds no group beyond these.

## F8, re-read on the rc.3 packages

On the keyless node, the SponsoredFPC derived from the rc.3 artifact (`0x2adfb70e…2130`) is published with the
artifact's class, and the rc.3 `STANDARD_AUTH_REGISTRY_ADDRESS` (`0x2ba87146…3a9c`) is published (class
`0x2929c576…0b7e`). F8 holds.

## Toolchain and forge (steps 2–3)

Stream L installed `6.0.0-rc.3` with `aztec-up` (complete: 16 `bin/` and 6 `internal-bin/` entries). The install
re-points `~/.aztec/current`, which other sessions on the host use, so it was restored to its previous target. The
forge `lib/` and `out/` came from the canonical clone, without `cache/`, and `lib/v4-core/.env` was deleted.
