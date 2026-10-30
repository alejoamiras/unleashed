# Phase 4: tooling, CI, documentation

## Attempts

- The CI gating guard (`scripts/ci-cd/behavior-gating.test.ts`) failed once the SDK bundled the records: `tools must
  gate contracts/bridge/generations/mainnet/record.json`, `sdk-pack must gate …/testnet/aztec/TokenBridgeHub.json`.
  `contracts/bridge/generations/**` joined both `pr-quick.yml` filters; a record-only PR would otherwise have skipped
  the unit tests and both builds.
- `vi.fn(real)` keeps `real` as the mock's implementation and `mockReset` restores it (vitest 4), so the interrupted
  promote tests take the real `renameSync`/`rmSync` back after each case instead of re-wrapping them.

## Gate

| Command | Result |
|---|---|
| `bun run lint`, `bun run typecheck:all` | exit 0 (2 Biome infos, both outside this diff) |
| `bun run test:all` | exit 0: sdk 477, bridge-core 543, tools 1705, the rest unchanged |
| `bun run audit:tools` | exit 0 |
| `bun run lint:actions`, `bun run test:ci-gating` | exit 0, 52 pass |
| `BRIDGE_INTEGRATION=1 bun run --cwd packages/bridge-core test:integration -- sdk-flows router-only` | 2 files, 13 passed, 754 s |
| `forge build`, `forge test --no-match-contract Fork` (`contracts/bridge/evm`) | 172 passed |
| `generation-record.ts check testnet --build-out contracts/bridge/evm/out` (the new CI step) | intact, bound; every entry equals this build |

After merging `origin/main` (#69, #85; one conflict in `packages/sdk/src/bridge/claim.ts`, where the claim now passes
`hubArtifactOf(leg.net)` to `hubAt`): lint, typecheck:all and test:all exit 0 (sdk 500, bridge-core 553, tools 1716).

## Review rounds

### Codex round 1 (`gpt-6.1-sol`, high, read-only)

The first prompt asked it to "think like an attacker"; OpenAI's endpoint refused it as a possible cybersecurity risk
before any review. The same checks framed as a defensive review of the owner's code ran. Verdict: `reject`, three
material findings, each verified against the code and fixed:

1. A fresh build matched a record's pin by `hash` alone, which does not commit to the immutable groups: a kept
   artifact whose copies were split into singleton groups passes integrity and the fresh-build check, and lets the
   copies disagree on chain. `samePin` (SDK `code-hash.ts`) compares the whole pin in `assertRecordIntegrity`,
   `verify-l1`'s fresh-build check and `check --build-out`; regression in `code-hash.test.ts`.
2. `promote` re-read the candidate record and pinned only `record.json`'s digest: an artifact changed after `verify`
   was written live before `verifyWritten` caught it. `promotableRecord` re-runs integrity on the buffered files before
   any live write; tested with a one-byte artifact change.
3. The D5 map missed `swapTokensSingleV3ERC20ToERC20`, which the SDK encodes for the testnet swapper. Added; the gate
   now compares entries without parameter names (they change neither selector nor encoding, and solc leaves an unused
   parameter unnamed, as the kept swapper's `_integrator` and `_referrer` are).

Non-material, adopted: the runbook claimed the keyless check shares no provider with the keyed reads; the hub's class
comes from dRPC's keyless node, the keyed node's provider. Reworded.

### Opus diff review (alongside round 1)

`conditional approve`. Its findings 1–3 were Codex's three (already fixed). Adopted besides:

- A masked span could sit over any PUSH32 operand, a constant the build fixed included (a slice of the witness type
  string). `assertSolcShaped` now requires every span to be zero in the kept build, as solc leaves an immutable's
  placeholder; every kept build passes.
- The sandbox control in `generation.test.ts` was refused by the hub derivation before the L1 pins mattered; it now
  holds `codeOf(sandbox).pins` to this release's pins.
- `check` printed viem's error text, which quotes the request URL: every `--rpc`/`--node` value is redacted from what
  it prints.
- Stale wording: the `network.ts` and `trust-roots.ts` headers, and the runbook's allowlist and `verify` description.

### Codex round 2 (resumed)

`conditional approve`: all three round-1 findings closed, the second reviewer's fixes sound, no regression. One material
finding: the endpoint redaction replaced URLs in argument order, so a URL that prefixes another left the longer one's
tail (its key) printed. It now replaces longest first, keeping each URL's label; the prefix case is in the test.

## Final gates on HEAD

lint, typecheck:all, audit:tools and lint:actions exit 0. `test:all`: one tools case (`capabilities.test.ts`, the
send grant against the kept hub, which loads two hub artifacts) timed out at 5 s while two browser suites ran on the
host; alone it passed in 3 s (28 of 28), with no timeout raised. `test:ci-gating`'s doc-link check failed until the plan
moved to `archive/`, where the promoted lessons link; after the move and a second `main` merge (#81, #86, #92, no
conflict) lint, typecheck:all, test:all (sdk 504, bridge-core 562, tools 1717), test:ci-gating and lint:actions exit 0.

## CI, first run

`Build Tools` failed in its jsdom smoke (`apps/tools` `test:e2e`, not part of `audit:tools`): `tools-smoke` case 2 stayed
at `setting-up`. Its fixture spread the real `bridge-generation`, whose `hubArtifact()` now imports the kept artifact
on first use and loads it through the aztec.js the smoke guts, the same wedge the fixture already avoids for the
PrivateFPC. The fixture stubs `hubArtifact` beside the hub instance it stubs; `test:e2e` 30 of 30, both target builds
and `verify:build-target` pass locally.
