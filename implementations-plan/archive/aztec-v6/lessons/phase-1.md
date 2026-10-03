# Phase 1 — JS line on the new scopes

Status: **✓.** The gate below was held because one root cause widened `test:all`'s red set; phase 2's recompile removed it. Re-run on the rebased tree with the phase 6 review fixes (`lessons/phase-5.md` § Gate): `test:all` fails only the testnet manifest test, which waits for the phase 6 deploy. Lint, typecheck, `test:ci-gating` and `npm audit signatures` pass. `bun audit` reports the same 64 advisories as the pre-bump lockfile; CI runs it advisory.

## Supply chain — per-scope publisher table

| Package @ version | npm publisher | Published | Provenance |
|---|---|---|---|
| `@aztec-labs/*` @ 6.0.0-rc.1 (accounts, aztec.js, constants, ethereum, foundation, kv-store, noir-contracts.js, protocol-contracts, pxe, sqlite3mc-wasm, standard-contracts, stdlib, txe, wallet-sdk, wallets) | `charlielye` (all 15) | outside the release-age window at the time | none |
| `@aztec-foundation/{bb.js,noir-acvm_js,noir-noirc_abi,l1-artifacts}` @ 6.0.0-rc.1 | GitHub Actions | outside the release-age window at the time | attested |
| `@aztec-foundation/aztec-standards` @ 6.0.0-rc.1 | GitHub Actions | inside the release-age window at the time | attested |
| `@alejoamiras/private-fee-juice` @ 6.0.0-rc.1 | GitHub Actions | inside the release-age window at the time | attested |
| `@aztec/viem` @ 2.38.3 | `spalladino` | outside the release-age window at the time | none |

- Matches the plan's per-scope expectation: one human publisher for the whole `@aztec-labs` set in a single six-minute window, CI with provenance for `@aztec-foundation`.
- `npm audit signatures`: 2015 packages have verified registry signatures, 500 have verified attestations, exit 0.
- Young packages under the 7-day gate go in **local, uncommitted** `bunfig.toml` excludes: aztec-standards and private-fee-juice, plus the three held wallet packages that `bun install` re-gates. The excludes come out in phase 7.

## Gate results (each command run separately)

| Command | Result |
|---|---|
| `bun run lint` | exit 0 (1 pre-existing warning `useBridgeJournal.stages.test.ts:9`, 2 pre-existing infos) |
| `bun run typecheck:all` | exit 2, **24 errors, all expected** (below) |
| `bun run test:all` | exit 1, **red set larger than planned** (below) |
| `bun run test:ci-gating` | exit 1, only `published-packages.test.ts` ("each is an exact pin whose peers its dependent declares at the same pin"), which is expected-red |
| `bun audit` | exit 1, 64 advisories (30 high, 27 moderate, 7 low). **Identical to the pre-bump lockfile ** (set diff empty). CI runs it advisory. The plan's "stays clean" was wrong about the baseline: v6 adds nothing. |
| `npm audit signatures` | exit 0 |

### Typecheck expected errors (D16)

All 24 are TS2345/TS2322 v6 `Fr` against the `@aztec/foundation@5.2.0` `Fr` in the held wallet packages (`_branding` private member). Every error names the 5.2.0 path, and no casts were added.
- bridge-core: `scripts/deploy-private-fpc-mainnet.ts`, `scripts/deploy-private-fpc-testnet.ts`, `scripts/drip-canary-testnet.ts`, `scripts/fpc-dust-canary-mainnet.ts`, `scripts/relay-claim-testnet.ts`, `scripts/sandbox/l2.ts`, `scripts/script-l2.ts`
- tools: `scripts/deploy.ts`, plus `sandbox/l2.ts` and `script-l2.ts` again through the tools project

### Scope scan

The plan's `rg --pcre2 '@aztec/(?!viem|core/|governance/|=)'` hits the three planned exceptions (the 5.2.0 `patchedDependencies` keys, `txe-server/package.json`, and the `published-packages.test.ts` PEERS) plus one the regex was never meant to catch:
- `packages/bridge-core/scripts/gen-remappings.ts`: the Solidity `@aztec/` remap alias in prose and a template string. It is the same alias `foundry.toml` keeps, and it is permanent.

### Gate miss — test:all

Expected-red (planned): `private-fuel.test.ts` (2 tests: the FPC address and digest move to 6.0.0-rc.1, fixed by phase 3's pins), `noir-artifact-classids.test.ts`, `hub-token.test.ts`, and the manifest re-derivations `send-flow.test.ts` (4 tests; the manifest's hub Token class `0x0225da…` against the installed aztec-standards `0x24c340…`).

Unplanned: **the committed 5.0.1 TokenBridgeHub artifact does not load under v6** (`loadContractArtifact`: `TypeError: undefined is not an object (evaluating 'storageExport.kind')`). Every test module that imports it at load time fails, including those whose `vi.mock` factory imports it:
- bridge-core (9): `hub-l2`, `manifest-v2.fixture`, `manifest-v2`, `promotion`, `script-l2`, `deploy-manifest`, `generation`, `script-bootstrap`, `deploy-canonical-private-fpc`
- tools (48): every file listed in `test:all` under `@unleashed/tools`

These are not re-derivation tests, so widening the expected-red list to cover them would hide a real break. The plan assumed phase 1 could go green before phase 2. The artifact format coupling makes the two phases one gate: phase 1 closes when phase 2's recompile lands.

## Step 5 items

- **I1 resolved**: the MAINNET DESCRIPTOR test now pins frozen 5.0.1 literals (`0x1a6d21…`, sha `d5a245…`) instead of equality with the testnet descriptor. Its `$comment` says the same. `check-fpc-version` already fails closed on mainnet once the installed package is not 5.0.1.
- **I8 resolved**: every JS retry builds a fresh request per attempt:
  - `claimTokensUntilSynced` calls `claimViaHub` per iteration
  - `awaitClaimVisible` builds `claimCall(...)` per poll
  - the fee-juice and dust canaries use `new BatchCall(...)` per attempt
  - `retryOnRevert` receives a thunk
  - `deployBelowWeth` redeploys per attempt

  The payment-method builders (`publicFeeJuicePayment`, `privateMintAndPayFee`) are stateless.
- **Message nullifier matches**: v6 aztec-nr `compute_l1_to_l2_message_nullifier(message_hash, secret: [Field; N])` = `poseidon2_hash_with_separator([message_hash].concat(secret), DOM_SEP__MESSAGE_NULLIFIER)`. The hub passes `[secret]` (`main.nr:193,244,266`), so N = 1, which is exactly v6 stdlib's `computeFeeJuiceMessageNullifier` (`poseidon2([hash, secret], MESSAGE_NULLIFIER)`), used by `message-nullifier.ts`.
- **v6 L1→L2 readiness**: `getL1ToL2MessageCheckpoint` is gone. `l1ToL2MessageReadiness` (bridge-core) derives it from `getL1ToL2MessageIndex`, the latest block's `l1ToL2MessageTree.nextAvailableLeafIndex`, and `L1_TO_L2_MSG_SUBTREE_HEIGHT` (1024 leaves per checkpoint). Its unit test covers null, the subtree maths and the 1023/1024 boundary.
- **Fee Juice**: `FeeJuice` left noir-contracts.js. `scripts/fee-juice-l2.ts` binds `FeeJuiceContract.withWallet` (protocol address 3) and, given a node, asserts `getNodeInfo().protocolContractAddresses.feeJuice` equals it.

## Phase 3 blocker (reported to the owner)

```
$ npm view @alejoamiras/nulo-wallet-crypto versions        → ["0.0.0-bootstrap.0","0.1.0"]
$ npm view @alejoamiras/nulo-wallet-crypto@0.1.0 peerDependencies
peerDependencies = { '@aztec/accounts': '5.2.0', '@aztec/foundation': '5.2.0' }
$ npm view @alejoamiras/nulo-wallet-sdk-schema-patch@0.1.0 peerDependencies
peerDependencies = { '@aztec/stdlib': '5.2.0', '@aztec/aztec.js': '5.2.0' }
```
blocked: waiting on `@alejoamiras/nulo-wallet-crypto` and `@alejoamiras/nulo-wallet-sdk-schema-patch` releases that peer on `@aztec-labs/*@6.0.0-rc.1`.
