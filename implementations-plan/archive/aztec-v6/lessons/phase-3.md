# Phase 3 — External packages (blocking checkpoint)

Status: **✓.** The wallet packages published at 0.2.0 on the v6 line and are pinned. Gate below.

## Step 1 queries

```
$ npm view @alejoamiras/private-fee-juice@6.0.0-rc.1 version peerDependencies --json
{ "version": "6.0.0-rc.1",
  "peerDependencies": { "@aztec-labs/stdlib": "6.0.0-rc.1", "@aztec-labs/aztec.js": "6.0.0-rc.1", "@aztec-labs/protocol-contracts": "6.0.0-rc.1" } }

$ npm view @alejoamiras/nulo-wallet-crypto versions --json          → ["0.0.0-bootstrap.0", "0.1.0"]
$ npm view @alejoamiras/nulo-resolve-asset versions --json          → ["0.0.0-bootstrap.0", "0.1.0"]
$ npm view @alejoamiras/nulo-wallet-sdk-schema-patch versions --json → ["0.0.0-bootstrap.0", "0.1.0"]

$ npm view @alejoamiras/nulo-wallet-crypto@0.1.0 peerDependencies --json
{ "@aztec/accounts": "5.2.0", "@aztec/foundation": "5.2.0" }
$ npm view @alejoamiras/nulo-resolve-asset@0.1.0 peerDependencies --json
(no output: no Aztec peers, already scope-neutral)
$ npm view @alejoamiras/nulo-wallet-sdk-schema-patch@0.1.0 peerDependencies --json
{ "@aztec/stdlib": "5.2.0", "@aztec/aztec.js": "5.2.0" }
```

**blocked: waiting on `@alejoamiras/nulo-wallet-crypto` and `@alejoamiras/nulo-wallet-sdk-schema-patch`** releases that peer on `@aztec-labs/*@6.0.0-rc.1`. `nulo-resolve-asset@0.1.0` is fine as it is.

## Prepared, then reverted to honour the hold

The FPC hand-pin below landed and was reverted: the plan holds at step 2 while any package is unpublished, and step 3 runs only after. Re-apply it once the pair publishes. The values remain correct:

- **FPC hand-pin**:
  - `PRIVATE_FPC_ADDRESS` is now `0x0b3bc795…3c08`.
  - The testnet descriptor now has `aztecVersion` 6.0.0-rc.1, `artifactSha256` `68f0c043…3974` and `compatibleNodeVersions` `{digest: ["6.0.0-rc.1"]}`. The dRPC v6 node reported `nodeVersion` 6.0.0-rc.1.
  - `private-fuel.test.ts` now also asserts the address, salt and version equal the installed package's `canonical-deployment.json`, and it is 15/15 green.
  - The network identity pins (l1ChainId 11155111, rollupVersion still 1821665230; the node reports 2914217885) are **left for phase 5**, so `check-fpc-version` fails closed on v6 testnet until then.
- **I7 resolved**: the layout is unchanged (`target/` and `dist/target/private_contract-PrivateFPC.json`), and the digest changed as expected.

## Risk noted (follow-up candidate)

`PRIVATE_FPC_ADDRESS` is network-global. Mainnet still runs the 5.0.1 FPC at `0x1a6d…1bc0` (the frozen mainnet descriptor and `mainnet-bridge.json`). Today that is safe: on mainnet `App.vue` renders only `MainnetPlaceholderView`, the mainnet manifest has `bridge: null`, and `check-fpc-version` fails closed on mainnet under a v6 install. **Before any mainnet UI lights up on the v6 tree**, the pin must become per-network, or private fuel would be sent to an address with no contract, which is unrecoverable.

## Wallet-side status

- Planned version **0.2.0** of both packages, peering on `@aztec-labs/*@6.0.0-rc.1`.
- Gated on two owner steps in the wallet's repository: merge its pull request (green, mergeable), then publish the packages.
- The wallet pins the v6 PrivateFPC at `0x0b3bc795…3c08`, the same address as the held re-pin above. The shared fact agrees on both sides.

## Remaining when the pair publishes

Pin them exactly, then:
- update the PEERS map in `published-packages.test.ts`
- delete the `@aztec/noir-*@5.2.0` patches and keys
- add `scripts/ci-cd/aztec-line.test.ts`
- drop their bunfig excludes once they are 7 days old

Then run the gate: typecheck to 0 errors, the unrestricted scope scan empty.

## Unblocked: the pair published at 0.2.0

Verified on npm:
- `nulo-wallet-crypto@0.2.0` peers `@aztec-labs/{accounts,foundation}` and `nulo-wallet-sdk-schema-patch@0.2.0` peers `@aztec-labs/{aztec.js,stdlib}`, all exactly 6.0.0-rc.1.
- `nulo-resolve-asset@0.2.0` has no peers.
- All three were published by GitHub Actions with SLSA provenance.

Done:
- The three wallet packages are pinned at 0.2.0. The PEERS map is on `@aztec-labs`. The `@aztec/noir-*@5.2.0` patches and keys are deleted. The lockfile scan shows the only `@aztec/*` identity left is `@aztec/viem@2.38.3`.
- The FPC re-pin is re-applied.
- `scripts/ci-cd/aztec-line.test.ts` holds both lockfiles to one generation, and the CI pin-reader workspaces to one pin. Negative check: its filter flags 14 `@aztec/*@5.2.0` strays in the pre-bump lockfile.

## Gate (each command run separately)

| Command | Result |
|---|---|
| `bun run lint` | exit 0 (the pre-existing 1 warning and 2 infos) |
| `bun run typecheck:all` | **exit 0, 0 errors** (24 before, all from the held packages) |
| `bun run test:ci-gating` | exit 0, 35/35, `published-packages` and `aztec-line` included |
| `npm audit signatures` | exit 0: 2015 registry signatures, 500 attestations verified |
| `bun run test:all` | exit 1, 60 failing files (below) |
| scope scan | the three planned temporary exceptions are gone; regex false positives remain (below) |

`test:all` reds:
- `private-fuel.test.ts` and `published-packages.test.ts` are green now.
- The 60 failing files are the phase 2 recompile cascade (the 5.0.1 TokenBridgeHub artifact fails v6 `loadContractArtifact`: 9 bridge-core files and 48 tools files) plus the Noir and Token class-ID re-pins (`noir-artifact-classids`, `hub-token`) and the manifest re-derivation (`send-flow`).
- None of the 60 is a phase 3 regression. Phase 3 stays un-✓ only because its expected-red list assumed phase 2 had recompiled.

The scope scan's "prints nothing" can't hold with this regex. The remaining hits are:
- `gen-remappings.ts`: the permanent Solidity `@aztec/` remap alias.
- `aztec-line.test.ts`: the guard naming the retired scope.

None of them is a package import. The lockfile guard is the authoritative check.

## Gate (rebased tree)

- **The phase 1 commands** are recorded in `lessons/phase-5.md` § Gate.
  - `typecheck:all` reports 0 errors.
  - `test:all`'s only red is the testnet manifest test, inside this phase's expected-red set ("the testnet identity, deployment and manifest tests that phases 5 and 6 regenerate").
  - `private-fuel.test.ts` and `published-packages.test.ts` are green.
  - `test:ci-gating`, which includes `aztec-line.test.ts`, passes 35/35.
- **The unrestricted scope scan** prints nothing (exit 1) once the regex also excludes a bare `@aztec/` followed by a quote, backtick, whitespace or `*`:

  ```
  rg -n --pcre2 '@aztec/(?!viem|core/|governance/|=|[`"'"'"'\s*])' --glob '*.{ts,mts,mjs,tsx,vue,json}' --glob '!**/bun.lock' --glob '!implementations-plan/**' .
  ```
  - The plan's regex excluded the forge alias only when written `@aztec/=`. Its 7 remaining hits were the alias the plan keeps (`gen-remappings.ts` comments and its assertion table) and the guard's own detection strings (`aztec-line.test.ts`). None names a package.
  - The refined regex still flags `"@aztec/foundation/fields"` and `"@aztec/aztec.js"`, which was checked.
