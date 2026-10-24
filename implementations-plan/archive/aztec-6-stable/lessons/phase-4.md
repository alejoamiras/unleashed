# Phase 4: the PrivateFPC

## The pin

`@alejoamiras/private-fee-juice@6.0.0`'s `canonical-deployment.json` names `aztecVersion` 6.0.0, the
canonical salt `0x…01` and `expectedAddress`
`0x0516ebb4f9c7988eb3cf6dd9459a47556f7a92db06b17cfa47ffb37fd35c6915`. Its artifact
`target/private_contract-PrivateFPC.json` hashes to
`bc1e27b0cfb48c8c1483071453288a27e302283c5da5fa40869a179a41079bde`.

`PRIVATE_FPC_ADDRESS` and the descriptor `private-fpc-canonical.json` now carry that version, address and
digest. The compatibility map drops the rc.3 digest and keys the new one to `["6.0.0"]`, the version the
keyless testnet node reported in Phase 1 (F6). The keyed node's version is held to that entry by
`check-fpc-version.ts` in Phase 9, before any Fee Juice moves. The salt is unchanged; the network pins move
in Phase 5.

The test derives the address from the installed artifact at the canonical salt and checks it equals both
the descriptor and the package's own `canonical-deployment.json`, so the three sources agree by
construction, not by copy.

The only other file that still names the old FPC (`0x2e18…6db4`, digest `f9dd…4e96`) is
`apps/tools/public/testnet-bridge.json`, the rc.3 generation's manifest, which promotion replaces.

## Gate

| Command | Exit | Note |
|---|---|---|
| `bun run --cwd packages/bridge-core test -- src/private-fuel.test.ts` | 0 | 15 passed |
| `bun run lint` | 0 | |
| `bun run typecheck:all` | 0 | |
| `bun run test:all` | 1 | every failure an open ledger case, plus the load timeout (below) |

Open ledger cases failing, by name:

- `manifest-v2.fixture.test.ts`; `bridge-generation.test.ts` › the sandbox generation › "re-derives the
  hub…" and "re-derives a token's L2 instance…"; four `useTokenSelection` cases (Phase 6, the fixture).
- `deployments-records.test.ts` › "passes the live file" and its three tamper cases (Phase 6, the faucet
  record).
- `bridge-generation.test.ts` › the shipped manifests › `testnet-bridge.json` (promotion): its
  `privateFpc` is the rc.3 FPC, which no longer equals the descriptor.

Closed since Phase 2: `hub-token.test.ts` (Phase 3); `private-fuel.test.ts` and the FPC registration case
of `script-l2.test.ts` (Phase 4). `published-packages.test.ts` sits in `test:ci-gating` and stays open
until Phase 7.

**Load timeout.** `AddressesView.test.ts` › "lists every contract by chain…" timed out at 5 s again
(load average about 170) and passes alone, 3/3. No timeout was raised; `follow-ups.md` already carries it.
