# Phase 2: the JS line

## Pins

Every `@aztec-labs/*` and `@aztec-foundation/*` pin, `aztec-standards`, `private-fee-juice` and
`@aztec-labs/txe` moved to `6.0.0`: 17 pins in `apps/tools`, 12 in `packages/bridge-core`, 1 in the TXE
server. `@nulo-sh/*` stays at `0.2.0` until Phase 7.

## The Noir wasm patches

Both patches replace the `module` field with an `exports` map. The 6.0.0 `package.json` of each package
differs from rc.6 only in its version lines (and `noirc_abi`'s `noir-types` dependency), outside the
hunks, so the hunks carry over unchanged. Each patch was renamed to `@6.0.0` with its `index` line
recomputed from the 6.0.0 file (git blob hashes, before and after the hunk).

## The age gate

No 6.0.0 package is seven days old. The root install needed 42 temporary excludes, found by
installing, reading the names Bun blocks and adding exactly those (a blocked name outside the two
Aztec scopes would have stopped the loop; none appeared): the 17 direct pins, then 8, 8, 5 and 4
transitive names (`entrypoints`, `blob-lib`, `kv-store`, `bb-prover`, `key-store`, `simulator`,
`noir-protocol-circuits-types`, `noir-types`, `bb-avm-sim` with its four platform builds, `cdb`,
`ipc-runtime`, `noir-noir_codegen`, `native`, `sqlite3mc-wasm`, `telemetry-client`, `world-state`,
`wsdb` with its four platform builds). The TXE server, gated with `--minimum-release-age=604800` and a
temporary local `bunfig.toml`, needed 14 more (`txe`, `archiver`, `aztec-node`, `blob-client`,
`epoch-cache`, `node-keystore`, `node-lib`, `p2p`, `prover-client`, `prover-node`, `sequencer-client`,
`slasher`, `validator-client`, `validator-ha-signer`). Bun reports a blocked direct dependency as
`No version matching … (blocked by minimum-release-age …)` and a blocked transitive one as
`Version "…" was published within minimum release age`.

Both excludes are gone again: the root `bunfig.toml` is byte-identical to the committed one and the
TXE server's temporary `bunfig.toml` is deleted. `bun install --frozen-lockfile --force` passes in
both places with the committed configuration.

## F13 does not hold on an existing lockfile

The first root install kept rc.3 copies nested under the two Nulo packages: 43 lockfile entries such as
`@nulo-sh/wallet-crypto/@aztec-labs/foundation → @aztec-labs/foundation@6.0.0-rc.3`, with their own
rc.3 subtrees. That is two `Fr` classes, the failure the old recon feared. The scratch probe (F13)
started from no lockfile; an existing lockfile carries the old peer resolution forward because the
exact rc.3 peer range still matches it.

Fix: delete exactly those 43 nested entries (`"@nulo-sh/wallet-crypto/@aztec-…"` and
`"@nulo-sh/wallet-sdk-schema-patch/@aztec-…"`) and re-run `bun install`. Bun then re-resolves each peer
edge to the workspace's 6.0.0 with `warn: incorrect peer dependency`, as in the probe. The lockfile
holds no `6.0.0-rc` identity; the only rc strings left are the two Nulo packages' declared peer ranges.
After a clean `rm -rf node_modules` and a frozen install, the store holds no rc copy, and both
workspaces' `@nulo-sh/*` links resolve to 6.0.0.

## `@aztec/viem` is gone from the line

6.0.0 no longer aliases `viem` to the `@aztec/viem` fork: `aztec.js`, `ethereum`, `pxe`, `stdlib` and
`telemetry-client` depend on stock `viem@2.57.1` (exact). `bridge-core` aliased its `viem` to
`npm:@aztec/viem@2.38.3` so its clients were the Aztec stack's own viem: `flows.ts` passes its public
client into `@aztec-labs/ethereum`'s `OutboxContract` behind `as never`. Left alone, that client would
be a second viem copy inside Aztec code. `bridge-core` now pins `viem@2.57.1`, the exact version the
line pins; it adds no package, and `@aztec/viem` resolves nowhere. `apps/tools` keeps stock
`viem ^2.52.2` (resolved 2.55.17), which meets `bridge-core` only at primitive values, as before.
`UPDATE.md`'s "only `@aztec/viem` keeps the old scope" is now false; Phase 5 rewrites it.

## Non-Aztec lockfile changes

Each is a dependency a 6.0.0 Aztec package declares, old enough to pass the gate without an exclude:

| Lockfile | Change | Required by |
|---|---|---|
| root | `viem` 2.57.1 added | `aztec.js`, `ethereum`, `pxe`, `stdlib`, `telemetry-client` (exact), `bridge-core` |
| root | `ox` 0.14.45 added | `viem@2.57.1` |
| root | `undici` 6.29.1 added | `@aztec-labs/foundation` (`^6.29.0`) |
| root | `@iarna/toml` 2.2.5 added | `@aztec-labs/ethereum` (`^2.2.5`) |
| root | `@aztec/viem` 2.38.3 removed | nothing on 6.0.0 |
| TXE | `viem` 2.57.1, `ox` 0.14.45, `abitype` 1.2.3, `ws` 8.21.0, `undici` 6.29.1; `@aztec/viem`, `@fastify/busboy` removed | the 6.0.0 node packages and `viem@2.57.1` |

## Provenance (scratch npm project, outside the repository)

`npm audit signatures --include-attestations`: both packages carry verified registry signatures and
SLSA provenance.

| Package | Repository | Ref | Commit |
|---|---|---|---|
| `@aztec-foundation/aztec-standards@6.0.0` | `AztecProtocol/aztec-standards` | `refs/tags/v6.0.0` | `ed402d82…` (F11) |
| `@alejoamiras/private-fee-juice@6.0.0` | `alejoamiras/ecosystem-tooling` | `refs/heads/main` | `3e358bbb…` |

Labs and foundation carry no attestation (A7).

## Protocol contracts on the reset testnet (step 7)

Keyless `aztec-testnet.drpc.org`, nodeVersion 6.0.0, rollupVersion 679261766:

- SponsoredFPC, derived from the 6.0.0 artifact at `SPONSORED_FPC_SALT`: `0x2d8f…69d3`, instance
  published, class `0x2333…3335` published and equal to the artifact's class.
- `STANDARD_AUTH_REGISTRY_ADDRESS` `0x120b…5e83`: instance published, class `0x2807…4a71` published.

## `castBin`

`live-intent.ts` resolves `cast` from `CAST_BIN`, then `~/.aztec/versions/<bridge-core aztec.js pin>/`,
then `current`, then PATH, reading the pin with `sandbox/local-network.ts`'s `aztecPin()`. The `5.0.0`
literal is gone.

## The standards class ids move in Phase 2

The standards Token and Dripper classes come from the installed `aztec-standards` npm package, so they
moved with the install, not with the Noir recompile: Token `0x163b…1d8a` → `0x2ff0…ea9f`, Dripper
`0x0f45…53f1` → `0x000a…a5f3`. The independent evidence for the new bytes is the package's provenance
(the `v6.0.0` tag build above). Re-pinned here: the standards tripwire in
`noir-artifact-classids.test.ts`, and the `TOKEN_CLASS_ID` input of `send-flow`, `manifest-v2`,
`promotion`, `deploy-manifest` and `script-l2` tests. `hub-token.test.ts` and `keystone.nr` share an
in-circuit vector, so their `TOKEN_CLASS_ID` moves with the vector in Phase 3.

## Gate

| Command | Exit | Note |
|---|---|---|
| `bun install --frozen-lockfile --force` (root, committed bunfig) | 0 | |
| `bun install --frozen-lockfile --force` (TXE server) | 0 | |
| `bun run lint` | 0 | |
| `bun run typecheck:all` | 0 | |
| `bun run test:all` | 1 | every failure an open ledger case, plus one load timeout (below) |
| `bun run test:ci-gating` | 1 | only `published-packages.test.ts` (Phase 7) |
| `bun audit` | 1 | 70 vulnerabilities (33 high, 30 moderate, 7 low), against 80 at the baseline |

Open ledger cases failing, by name:

- `script-l2.test.ts` › `registerPrivateFpc …`; `private-fuel.test.ts` › ADDRESS TRIPWIRE, CANONICAL
  DESCRIPTOR (Phase 4). The 6.0.0 artifact derives `0x0516…6915` at the canonical salt.
- `hub-token.test.ts` › in-circuit vector (Phase 3).
- `manifest-v2.fixture.test.ts`; `bridge-generation.test.ts` › sandbox re-derivation; four
  `useTokenSelection` cases (Phase 6, the fixture).
- `deployments-records.test.ts` › "passes the live file" and its three tamper cases (Phase 6, the faucet
  record).
- `published-packages.test.ts` (Phase 7).

`aztec-line.test.ts` is green: one line in both lockfiles.

**Load timeout.** `AddressesView.test.ts` › "lists every contract by chain…" timed out at 5 s in the
full run (host load average about 111) and passes alone, 3/3. Its first case spends about 2.5 s on the
cold dynamic import of the view and the Aztec modules behind it. No timeout was raised; it is watched
in every later gate and on CI.

**Audit.** Against the Phase 1 groups, three dropped out (`@fastify/busboy`, `undici@5.29.0`,
`ws@8.18.3`). Two headers look new and are not regressions of this bump: `undici@6.29.1` replaced
5.29.0 inside the existing `undici` group, whose advisories all cover 7.x only; `zod@4.4.3` was already
in the base lockfile, and its advisory (GHSA-mrhx-c7xc-m3w5, high, fixed in 4.6.6) was updated after
the baseline ran. `zod` is a direct dependency of `apps/tools` and `bridge-core`; the bump to 4.6.6 is
a follow-up, not part of this line change.

Phase 2 green.
