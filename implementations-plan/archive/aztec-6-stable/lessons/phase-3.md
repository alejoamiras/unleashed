# Phase 3: the Noir line

## Tags and toolchain

Seven tags in five `Nargo.toml` files moved to `v6.0.0`: the `aztec` dependency of every crate, and the
hub's `compressed_string` and standards `token` dependencies. Our aztec-nr URL already matched the
standards' spelling, so no URL changed. The vendored `token_portal_content_hash_lib` header names tag
`v6.0.0`, commit `d2e67c1d938f06a6476dd7d4bd01e73771923dd1`; the upstream bytes' sha256 `5e20eaf6…` is
unchanged, so the body is untouched. `compile.sh`, `nargo.sh` and `run-txe-tests.sh` default to
`~/.aztec/versions/6.0.0`. The TXE server's lockfile moved to `@aztec-labs/txe@6.0.0` in Phase 2.

## The hub artifact

`compile.sh` rebuilt `token_bridge_hub_contract-TokenBridgeHub.json`: class
`0x2132a9de52d748417fb251b0924154633658534d6cf806bd9c3d79554d632abe` (rc.3: `0x198c…d124`),
`aztec_version` 6.0.0, no local paths. `noir-artifact-classids.test.ts` re-pins both.

## The keystone vector

`hub-token.test.ts` and `keystone.nr` share one in-circuit vector. Its `TOKEN_CLASS_ID` input moved to the
6.0.0 standards Token class `0x2ff0…ea9f`, which moves the expected Token address to
`0x2a7bc05ce46e0510b3ed3b0b57ad498b60b59f068352bdfd5ab2f647c745493c`. The value came from the TS leg; the
Noir leg (`token_bridge_hub` `test keystone`, 2 passed) derives the same address in-circuit, so the two
legs agree independently.

## Gate

| Command | Exit | Note |
|---|---|---|
| `compile.sh --check token_bridge_hub` | 0 | the committed artifact matches a fresh compile |
| `nargo.sh keystone test --force` | 0 | 10 passed |
| `nargo.sh token_bridge_hub test --force keystone` | 0 | 2 passed |
| `run-txe-tests.sh --crate token_bridge_hub` | 0 | 65 passed |
| `gen-remappings.ts` | 0 | |
| `forge build` (1.7.1, commit `4072e487`) | 0 | |
| `forge test --no-match-contract Fork` | 0 | 157 passed in 21 suites |
| `forge snapshot … --check --tolerance 2` | 0 | |
| halmos 0.3.3, as `_bridge-contracts.yml` runs it | 0 | 12 proofs: clone 2, factory 2, router 8 |
| ABI pins (`factory-abi`, `router-abi`, `quoter-abi`) | 0 | 8 passed |
| `check-sole-consumer.sh` | 0 | |
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
of `script-l2.test.ts` (Phase 4, run on the same tree). `published-packages.test.ts` sits in `test:ci-gating` and stays open
until Phase 7.

**Load timeout.** `AddressesView.test.ts` › "lists every contract by chain…" timed out at 5 s again
(load average about 170) and passes alone, 3/3. No timeout was raised; `follow-ups.md` already carries it.

The 6.0.0 L1 artifacts build and pass on foundry 1.7.1, so D5's stop did not fire and the CI pin stays.
