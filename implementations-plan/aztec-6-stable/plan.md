---
plan: aztec-6-stable
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: artifact
eli5_source: implementations-plan/aztec-6-stable/eli5.html
eli5_url: https://claude.ai/artifact/GSHHUw4cs1HMrqenuBNBRA
budget: "recon: 1 Sonnet agent; code-review: off; Codex on gpt-6.1-sol at high; Claude leg on Opus 5.5; no parallel lanes"
status: approved
base: main (b1a52e6)
---

# aztec-6-stable: Aztec 6.0.0 and a new testnet generation

## Summary

Aztec 6.0.0 is out and the testnet has already reset to it. The keyless node reports nodeVersion `6.0.0` and
rollupVersion `679261766` (was `3409706519`), and two public Sepolia RPCs agree: the registry maps that version to
the rollup `0x1f43…efba`, whose FeeJuicePortal is `0xe59a…f505`. The fee asset, the handler and the registry did
not move. The deployed testnet app is dead: its boot identity check refuses the new node.

This plan replays the archived `aztec-rc3` bump on today's `main`, in one PR:

1. **The line moves to 6.0.0.** `@aztec-labs/*` and `@aztec-foundation/*` both at `6.0.0` (the foundation number
   equals the labs number on this line), `aztec-standards` and `private-fee-juice` at `6.0.0`, aztec-nr at `v6.0.0`.
   The hub recompiles, its class ids move, the PrivateFPC gets its new address, the chain identity cascades.
2. **A new testnet bridge generation** deploys through the `bridge-generation` runbook, Branch B, under the
   intent tooling and keyed runs. The owner authorized it (A1).
3. **One external dependency.** `@nulo-sh/wallet-crypto` and `@nulo-sh/wallet-sdk-schema-patch` 0.2.0 pin rc.3
   peers, and the wallet repository has not published on 6.0.0. Bun links 0.2.0 against the workspace's 6.0.0
   with a warning (F13), so the code runs on one `Fr` class; only `published-packages.test.ts` refuses the
   mismatch. The live deploy waits for the 6.0.0 packages, which the Nulo team publishes as `0.3.0` (A6, D9):
   Phase 7 pins them before Phase 9.

Presto is not a dependency of this repository. `@alejoamiras/private-fee-juice@6.0.0` published during planning.

Length: about 740 lines against the mid tier's 350, because eleven gated phases, three audit tables, nineteen
ledger rows and the two seeds each need their own text.

## Owner decisions (Phase 0)

| Question | Answer |
|---|---|
| A1 Live authorization | **Granted: the full scripted redeploy**, same shape as rc.3. Signer `0x7F42…6a9a`, cap 2.0 Sepolia ETH, the four testnet templates. No credential is created. Each keyed run still waits for the owner's `op-remote alejo-box <id>` |
| A2 Nulo packages | The owner or another session publishes `@nulo-sh/*` on 6.0.0; this plan watches npm and pins them when they land |
| Verdict | **Approve**, with A4 (preview check before merge), A5 *"Leave it open"*, A6 *"Wait for 0.3.0"*, A7 (a), A8 (a) |
| Legs | Claude leg Opus 5.5 (also the main-work subagent model) · Codex `gpt-6.1-sol` at `high` · `/code-review` off · explainer off · `/harden` not scheduled |
| Scope | Testnet only. Mainnet stays on its line until Aztec Alpha upgrades (`follow-ups.md`). Production rigor with the rc.3 gates. Tier `mid`: irreversibility, migration cost, external coupling and security sensitivity are high, novelty is nil, and the runbook plus the rc.3 record carry the method |
| Gate answers, verbatim | A4: *"Before Merge, I can test Nulo on the preview URL."* A6: *"Nulo will be releasing the packages we need on 0.3.0 they are already working on it."* A7: *"(a)"*. A8: *"sure? (a)"* |

## Outcome & Quality Bar

**For whom.** The owner, who operates the testnet bridge and faucet. A tester on `testnet.app.unleashed.systems`
with a 6.0.0 wallet who bridges, exits or drips. The next maintainer, who bumps Aztec again.

**Excellent looks like:**
1. The testnet app works on 6.0.0 against a proven generation: public and private bridges, with and without fuel,
   exits and drips. Every runbook canary passes against the promoted manifest, and the private self-paying claim
   settles through the PrivateFPC, which no script publishes.
2. Nothing was deployed against an unproven input: the sandbox rehearsal, the candidate smokes and the
   calibration all run on the tree that ships, the Nulo `0.3.0` pin included (A6).
3. The next bump is cheaper than this one: `UPDATE.md` and the runbook read true for 6.0.0, the stale cast
   candidate is gone, and the follow-ups that this bump resolves are deleted.

**Good enough.** Mainnet scripts and its FPC descriptor stay as they are. rc.3 testnet records stay withheld at
boot with no migration UI. The owner's manual check with the Nulo wallet runs on the branch preview before the
merge (A4).

## Architecture & Implementation

### Proposed architecture

No new module. The change is the pin surface, the Noir artifacts, the identity constants, one re-pinned address
and the live output, all on code that exists (`recon.md` § Reuse map). Three small code edits beyond literals:

- `live-intent.ts` `castBin()` drops its `versions/5.0.0` candidate and resolves `~/.aztec/versions/<bridge-core
  aztec.js pin>/internal-bin/cast` before `current` (which other sessions may point elsewhere), the way
  `local-network.ts` reads the pin.
- `scripts/ci-cd/aztec-line.test.ts` is unchanged: on 6.0.0 the foundation version it derives equals the labs
  version, and it proves that from the lockfile.
- The identity cascade is literal edits; the manifest's `walletChainId` is written by the conductor.

### Key interfaces

None change. The reset baseline keeps the rc.3 shape:

```json
{ "identity": { "nodeVersion": "6.0.0", "l1ChainId": 11155111, "rollupVersion": 679261766, "walletChainId": 685146337 },
  "l1": { "rollup": "0x1f435a7f2da358caf887a470faeee7d5d5f4efba", "feeJuicePortal": "0xe59acba462a0324b1d619a7a1b219419f156f505",
          "feeJuice": "0x762c132040fda6183066fa3b14d985ee55aa3c18", "feeAssetHandler": "0x5602c39a6e9c5ace589f64f754927bcda4f4bfc9",
          "registry": "0xa0bfb1b494fb49041e5c6e8c2c1be09cd171c6ba" } }
```

### Data and control flow (the critical path)

1. Phases 1–5 move the line, the Noir artifacts, the FPC pin and the identity, with the expected-red ledger
   shrinking at each gate.
2. Phase 6 rehearses on the sandbox and runs the browser suite. Phase 7 pins the Nulo packages when npm has
   them; it floats over Phases 1–8, and Phase 9 waits for it (A6).
3. Phase 8 runs the quality loop; its last fix lands **before** `live-intent build`, because a source change after
   `build` voids the intent.
4. Phase 9 is the live window (keyed runs): `build` → generation → faucet → FPC gate → smokes and samples →
   calibrate → `verify --candidate` → retire the old manifest → `promote --bridge-only`.
5. Phase 10: canaries → preview → final `verify`. Phase 11: docs and the final gates. Then § Post-implementation:
   the final Codex pass, the PR, the close-out as its final commits.

### File-level change map

| Area | Files |
|---|---|
| Pins | `apps/tools`, `packages/bridge-core`, `txe-server` `package.json`; root `patchedDependencies`; `patches/@aztec-foundation%2Fnoir-{acvm_js,noirc_abi}@6.0.0.patch`; `bunfig.toml` (temporary excludes, removed again); both `bun.lock` |
| Noir | six `Nargo.toml` tags; the vendored lib's header; `compile.sh`, `nargo.sh`, `run-txe-tests.sh`; `target/*.json` (hub and keystone) |
| Class ids, vectors | `noir-artifact-classids.test.ts`, `hub-token.test.ts`, `keystone.nr` (comment), `fixtures/sandbox-manifest.json` |
| PrivateFPC | `private-fuel.ts`, `private-fpc-canonical.json`, `private-fuel.test.ts` |
| Identity | `chain-constants.ts`, `chain-info.test.ts`, `wallet-chain-id.test.ts`, `build-integrity.test.ts`, `bridge-generation.test.ts`, `live-intent.test.ts`; `contracts/bridge/evm/.env.example`, `DeployFuelLive.s.sol`, `DeployFuelLive.fork.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`; `live-intent.ts` (`NO_RESET_BASELINE`, `OPERATIONAL_ALLOWLIST`, `castBin`); `lessons/reset-baseline.json` (new) |
| Faucet record | `apps/tools/src/contracts/deployments.json`, reproduced by the sandbox and committed before `build` |
| Live output | `apps/tools/public/testnet-bridge.json`, `deploy-journal/`, `lessons/intent.json`, `lessons/promotion-receipt.json` |
| Docs | `UPDATE.md`, the skill, `contracts/bridge/aztec/README.md`, `apps/tools/tests/browser/README.md`, `follow-ups.md`, `lessons.md` |

### Non-obvious mechanics

- **One number, two scopes.** On 6.0.0 labs and foundation both publish `6.0.0`. `aztec-line.test.ts` still reads
  the foundation version from the lockfile's aztec.js entry, so the next split line needs no test edit.
- **The 7-day gate.** No 6.0.0 package has cleared it at plan time (F1). The install needs temporary
  `minimumReleaseAgeExcludes` naming every new-line package (Bun 1.4.2 ignores a scope glob, F13), removed in the
  same phase; the lockfile is proven with `bun install --frozen-lockfile --force`. Until each publish is seven
  days old (`npm view <pkg> time`), a `package.json` edit in a workspace that reaches the line re-gates it: add
  the excludes locally, uncommitted, never inside the live window.
- **The Nulo peers under the isolated linker.** Bun does not nest a second `@aztec-labs/foundation` for a peer
  pinned at rc.3: it links the workspace's 6.0.0 and prints `warn: incorrect peer dependency` (F13). So the tree
  has one `Fr` class and the lockfile holds no rc entry; `aztec-line.test.ts` is green, and
  `published-packages.test.ts` is the one tripwire, red until Phase 7 pins the 6.0.0 packages. That holds from a
  fresh resolution only: an existing lockfile carries the rc.3 peer resolution forward as nested entries, which
  Phase 2 deletes (D21).
- **The expected-red ledger.** Each gate names the cases that may fail and the phase that greens them:
  `published-packages.test.ts` (Phase 7); the hub's class id and `aztec_version` in
  `noir-artifact-classids.test.ts` and `hub-token.test.ts`'s in-circuit vector (Phase 3; the standards Token and
  Dripper class ids move with the npm package and are re-pinned in Phase 2, in that tripwire and in every test
  that takes the Token class as an input); `private-fuel.test.ts` and the `registerPrivateFpc` case of `script-l2.test.ts`, which derives
  the installed artifact and holds it to `PRIVATE_FPC_ADDRESS` (Phase 4; the network-pin case of
  `private-fuel.test.ts` Phase 5); `deployments-records.test.ts`'s "passes the live file" case and the three
  tamper cases that run against the live file, which re-derive the committed faucet record from the standards
  Dripper class (Phase 6, when the sandbox's record is committed); the fixture-derived cases, which parse `fixtures/sandbox-manifest.json` strictly and rebuild its hub
  and tokens from the installed artifacts: `manifest-v2.fixture.test.ts`, the sandbox cases of
  `bridge-generation.test.ts`, and the `useTokenSelection`, `useTokenCatalog` and `useSend` tests (Phase 6, when
  the fixture is copied from the smoke); and `bridge-generation.test.ts`'s testnet-manifest case (promotion,
  Phase 9). A test command passes a gate when every failure it reports is an open ledger case; the phase's
  lessons file records the failing case names and the exit code. Any other failure is a real red.
- **Pools persist.** The fee asset did not move, so the ETH/FJ pool and the four TOKEN/WETH pools carry over
  (rc.3 D8). The conductor runs with `SKIP_POOL_SEED=1`, and `pre-create` without `--seed-pool`.
- **The reset baseline is hand-written** from the two-RPC reads in § Assumptions, never from the node.
  `NO_RESET_BASELINE` points at it before `build` and at the archived path at close-out.
- **The faucet record is chain-independent.** Universal deploys with fixed salts give the same addresses on the
  sandbox and the testnet, so the sandbox's record is committed in Phase 6 and the testnet deploy must reproduce
  it byte for byte; promotion is `--bridge-only`.
- **The vendored content-hash lib did not change.** Upstream at `v6.0.0` hashes to the header's `5e20eaf6…`; the
  re-vendor is a header edit (tag and commit `d2e67c1d…`).
- **CI's foundry pin stays at 1.7.1.** The sandbox and the node's L1 deploy use the toolchain's own `internal-bin`
  forge (1.8.5) through `FORGE_BIN`; the contract build, halmos and the gas snapshots keep their pinned compiler,
  and `_bridge-contracts.yml` records that 1.8.1 passed none of the twelve halmos proofs and moved the snapshot
  by 8 %. The host's bare `forge` is 1.4.1, so Phase 3 runs its forge gate and halmos on an explicit 1.7.1. If
  1.7.1 fails on the 6.0.0 L1 artifacts, the phase stops for the owner (D5).
- **One forge builds what the live window deploys and verifies.** The conductor deploys the bytecode in
  `contracts/bridge/evm/out` (`script-artifacts.ts`), and a strict `verify:l1` rebuilds `out/` with `--force` and
  compares masked runtime hashes. A keyed run gets `env-exec`'s own PATH (`~/.foundry/bin`, `/opt/foundry/bin`,
  …) and a rebuilt environment, so `verify-l1.ts`'s PATH-first `resolveBin` picks `/opt/foundry/bin/forge` (1.4.1
  here) and no `FORGE_BIN` reaches it. Phase 9 therefore rebuilds `out/` with that same binary right before
  `build`, prints its version, and nothing (no sandbox, no local forge) builds again until the final strict verify
  (rc.3 phase 12: an overlapping build breaks the sandbox). rc.3's strict verify passed on this pairing (D18).
- **Keyed runs pin a pushed HEAD.** `env-exec` requires a clean tree, HEAD at the tip of a pushed branch, and
  voids a pending request on any commit (rc.3 phase 4). Commit and push before each request; make no edit while
  one waits. Inside the live window `plan.md` is not allowlisted, so a ✓ mark there voids the intent at the next
  chained `verify` (`assertNoSourceDrift`): the ✓ marks for Phases 1–9 are written in Phase 10 step 4, after the
  final verify, and the seeds say so.
- **The young line.** No 6.0.0 package is seven days old at plan time, and labs and foundation carry no
  attestation: the install relies on exact pins and the lockfile's integrity hashes, not on the age gate (A7).
  The TXE server has no `bunfig.toml`, so its install is gated by the flag, with a local, uncommitted bunfig
  holding the excludes; its lockfile diff must touch Aztec-scoped entries only.
- **The spend tally is kept by hand.** `verify` reconciles the cap against the signer's balance delta, which an
  incoming transfer can mask. `lessons/phase-9.md` keeps the gross ETH spend per broadcast group, checked against
  the 2.0 ETH cap before each signing run.
- **Live window freeze.** From `build` to the final `verify`, nothing changes outside `OPERATIONAL_ALLOWLIST`.
  Interim status goes to `lessons/` only. No rebase inside the window.

### Competing outline B (for the audits)

**Three parallel streams on Opus subagents**, as rc.3's D19 did: L (phases 2–3) and F (phases 4–5) in agent
worktrees from this branch, D (docs) likewise, cherry-picked by the lead in order L, F, D; the lead runs the gates
and the Nulo watch. Outline A, this plan, runs phases 2–5 in sequence in this worktree. The critical path is the
Nulo publish plus the live window, which no lane shortens; A avoids three worktree installs and a cherry-pick
merge for about two hours of mechanical edits. Both audits chose A (D2).

## Security & Adversarial Considerations

- **Threat model.** A wrong PrivateFPC address loses every Fee Juice deposit sent to it. A tampered dependency runs
  inside keyed runs with the signer in its environment. A malicious or stale node names contracts that agree with
  each other. A leaked script key spends the owner's dRPC CU.
- **PrivateFPC.** `private-fuel.test.ts` re-derives the address from the installed 6.0.0 artifact at salt `0x…01`
  with deployer zero and holds it equal to the package's `canonical-deployment.json`; the gate runs before any Fee
  Juice moves. The Nulo wallet pins the same address from the same tarball, so it is not independent evidence; the
  sandbox smoke on 6.0.0 circuits proves the JS derivation and the protocol circuits agree before any live Fee
  Juice moves.
- **Supply chain.** Exact pins, frozen lockfiles in CI, `bun audit` against the Phase 1 baseline. Provenance in a
  scratch npm project outside the repository (`npm audit signatures --include-attestations`): `aztec-standards`
  6.0.0 attested by `AztecProtocol/aztec-standards` at `v6.0.0` (`ed402d82…`), the commit the hub's Noir `token`
  dep resolves; `private-fee-juice` 6.0.0 by `alejoamiras/ecosystem-tooling`; the Nulo packages by `nulo-sh/nulo`
  with digests equal to that repository's `approved-digests.json`. Labs and foundation carry no attestation, as
  before. `aztec-up` resolves its installs live with no age gate; its log is kept in `lessons/`.
- **Keys.** No key is created. `DRPC_API_KEY` and the signer reach only keyed-run processes; scripts never print
  a node URL; `node-keys.test.ts` allows no committed key; forge's broadcast cache is deleted after every live
  `forge script`.
- **Live deploy.** The signer pin, the caps and the tree gate; the conductor's nonce prediction and journal; one
  signer at a time; L1 corroboration of every node claim from two public RPCs; the hub's initialization-hash
  readback; the hand-kept gross spend tally. Residual: one L2 node operator (dRPC) behind both endpoints; the L1
  anchoring and the caps bound it. `verify` compares `nodeVersion` exactly; on a flap, stop and ask the owner.
- **Known limit: the rc.3 factory stays unpaused**, as the rc.1 one did (rc.3 D10), on the owner's A5 answer.
  Path: a direct caller deposits a test token into an rc.3 portal; the rc.3 rollup is no longer canonical, so no
  claim exists. Consequence: lost Sepolia test tokens only. Reopening condition: a user reports a stranded
  deposit. Filed as a `known-limit` issue at close-out.
- **Smart-contract risks** do not change in kind. Every derived L2 address is new under 6.0.0 bytecode, so no old
  authwit or record targets the new contracts; the journal withholds old records; stored data is keyed by wallet
  chain id.

## Assumptions

### Facts

- **F1.** `@aztec-labs/*@6.0.0` depend on `@aztec-foundation/*@6.0.0` (`npm view @aztec-labs/aztec.js@6.0.0
  dependencies`). `@aztec-labs/txe`, `@aztec-foundation/aztec-standards` and `@alejoamiras/private-fee-juice` publish
  `6.0.0`. None had cleared the 7-day gate at plan time; `npm view <pkg> time` says when each does.
- **F2.** `private-fee-juice@6.0.0` peers are exact labs `6.0.0` (`stdlib`, `aztec.js`, `protocol-contracts`).
- **F3.** `@nulo-sh/wallet-crypto@0.2.0` peers `@aztec-labs/{accounts,foundation}@6.0.0-rc.3`;
  `wallet-sdk-schema-patch@0.2.0` peers `aztec.js` and `stdlib` at rc.3; `resolve-asset` has none. `nulo-sh/nulo`
  has no 6.0.0 branch or PR, and its `main` pins rc.3.
- **F4.** Sepolia, read through `ethereum-sepolia-rpc.publicnode.com` and `1rpc.io/sepolia`: chainId 11155111; the
  registry `0xa0bf…c6ba` returns `getCanonicalRollup()` = `getRollup(679261766)` = `0x1f435a7f…efba`; the rollup
  reports version 679261766, fee portal `0xe59acba4…f505`, fee asset `0x762c…3c18`; the portal's `ROLLUP()` and
  `UNDERLYING()` point back; the handler `0x5602…bfc9` reports `FEE_ASSET()` equal to the fee asset.
- **F5.** Upstream `AztecProtocol/networks` `network_config.json` names the same registry and handler for testnet.
- **F6.** The keyless node `aztec-testnet.drpc.org` reports nodeVersion `6.0.0`, l1ChainId 11155111, rollupVersion
  679261766, the L1 addresses of F4, and block 574 at planning time. Wallet chainId `(11155111 ^ 679261766) >>> 0`
  = 685146337 (re-proven by `wallet-chain-id.test.ts` in Phase 5).
- **F7.** The signer `0x7F42…6a9a` holds 2.9036 Sepolia ETH on both RPCs, above the 2.0 cap.
- **F8.** `aztec-labs-eng/aztec-node` `v6.0.0-rc.3...v6.0.0`: 110 commits, three `!:` (a trace-capable L1 endpoint
  for the archiver, a CLI withdrawal recipient, declared dependencies in the deployment framework); none names a
  symbol this repository uses. The 6.0.0 changelog's Noir and TS migrations have no hit in hand-written source
  (`recon.md`). `AztecProtocol/aztec-standards` `v6.0.0-rc.3...v6.0.0` is five commits, one `!:` (Aztec rc.4 and
  noir-bignum v0.11.0): the Token class id moves, which a new generation absorbs.
- **F9.** The toolchain `~/.aztec/versions/6.0.0` is installed and complete (16 `bin/`, 6 `internal-bin/` entries,
  forge 1.8.5, `aztec --version` 6.0.0); `~/.aztec/current` was restored to rc.3 for other sessions.
- **F10.** The vendored `token_portal_content_hash_lib/src/lib.nr` upstream at `v6.0.0` (commit `d2e67c1d…`) hashes
  to `5e20eaf6…`, the digest the current header records.
- **F11.** Tags: aztec-nr `v6.0.0` = `46d118ff…`, aztec-standards `v6.0.0` = `ed402d82…`, aztec-node `v6.0.0` =
  `d2e67c1d…`.
- **F12.** No open issue and no `known-limit` issue; `follow-ups.md` is this repository's open-work file
  (`AGENTS.md` § Plans).
- **F13.** A scratch Bun 1.4.2 project outside the repository, isolated linker, depending on
  `@aztec-labs/{accounts,foundation}@6.0.0` and `@nulo-sh/wallet-crypto@0.2.0`: the install succeeds with
  `warn: incorrect peer dependency` for both peers, the store holds one `foundation@6.0.0` and no rc.3 copy, and
  the lockfile records only the peer's declared range. The same project with `minimumReleaseAgeExcludes =
  ["@aztec-labs/*", …]` is still gated: a scope glob is ignored.

### Inferences

- **I1.** The 6.0.0 L1 artifacts build, test and prove on CI's foundry 1.7.1. Phase 3's local gate proves it on
  an attestation-verified 1.7.1 before any key; `bridge-contracts-status` on the PR re-proves it (D5 names the
  stop). The sandbox builds with the toolchain's 1.8.5 (I2) and the keyed runs with the host's 1.4.1 (D18); the
  compiler is solc 0.8.28 with `via_ir` in every case, pinned by `foundry.toml`.
- **I2.** The sandbox's local network on 6.0.0 boots with the toolchain's forge 1.8.5 through `FORGE_BIN`.
  Phase 6 proves it.
- **I3.** The keyed node (`lb.drpc.live`) reports the same `nodeVersion` `6.0.0` as the keyless one. Phase 5's
  keyed probe proves it; the FPC compatibility entry records the keyed value.
- **I4.** The Nulo packages on 6.0.0 keep `deriveNuloAccountKeys`'s vectors. `deployer-keys.test.ts` proves it
  before they are pinned; a package that moves them is never pinned.
- **I5.** The owner has a Nulo wallet build on 6.0.0 by the time the PR's final head has a preview (the owner's
  A4 answer); the Nulo team is publishing the shared packages as `0.3.0` (the owner's A6 note).

### Asks

- **A1. Live authorization: granted** (§ Owner decisions). Templates: `testnet-generation.env.example` for
  `deploy:generation` and `pre-create`; `testnet-l1.env.example` for `build`, the smokes, `fuel-testnet` and the
  fee-juice canary; `apps/tools/testnet-faucet.env.example` for `deploy:testnet`; `testnet-rpc.env.example` for
  the probes, `check-fpc-version`, `verify`, `promote`, `verify:l1` and the drip canary. Every run that signs on
  L1 chains `verify` ahead of it on its own template. The faucet signs on L2 only and its template carries no
  Sepolia RPC, so a read-only `verify` on `testnet-rpc` runs immediately before it instead.
- **A2. Nulo packages: the owner's side.** The fastest path: a `chore(publish)` PR in `nulo-sh/nulo` that moves
  the three packages' peers to `6.0.0` and publishes `0.3.0`, ahead of the wallet's own bump. This plan does not
  edit that repository.
- **A3. Merge: the owner's call** after `quality-status`, `tools-e2e-status` and `bridge-contracts-status` are
  green and the canaries passed. Squash, no `--admin`.
- **A4. Manual wallet check: before the merge, on the preview** (the owner's answer). It runs on the Workers
  Builds preview of the PR's final head, after Phase 7's pin, because the schema-patch package is part of the app
  bundle and a preview built on 0.2.0 would not prove the shipped app. It gates the merge, sits outside the live
  window, and spends from the owner's wallet, not the capped signer.
- **A5. The rc.3 factory.** **Ask:** (a) leave it unpaused (the known limit above, as rc.1), or (b) pause its
  deposits with one extra keyed signing run, Phase 9 step 7b (`pause-factory.ts` on the old manifest, dry run
  first; the signer must be that factory's owner, which the script checks). Recommended: (a); only test tokens
  are at stake. The answer is recorded in `lessons/phase-8.md`, and (b) is executed, not just noted.
- **A6. The live deploy and the Nulo pin.** **Ask:** (a) deploy only after Phase 7 has pinned the 6.0.0 Nulo
  packages, the rc.3 order; or (b) if npm still lacks them when Phase 8 converges, deploy on 0.2.0 (F13: one `Fr`
  class; `deployer-keys.test.ts` pins the derived keys), then pin the 6.0.0 packages after Phase 10's final
  verify and before the PR opens, with the vector test, the browser suite and `verify:deployments` re-run on the
  pinned tree. Recommended: (b). The on-chain generation does not embed the wallet package; the deployer's keys
  are what matter, and the vectors hold them. Either way the PR waits for the pin, and the pin never lands inside
  the live window: its `package.json` and lockfile edits are not allowlisted and would void the intent (D19).
  The owner reports the Nulo team is publishing the packages as `0.3.0`; if they are on npm when Phase 8
  converges, Phase 7 runs before Phase 9 and this Ask is moot.
- **A7. The young, unattested line beside the signer.** Labs and foundation carry no attestation, and no 6.0.0
  package is seven days old. Exact pins and lockfile hashes fix the bytes that install; they say nothing about
  whether those bytes are honest. A compromised package runs as this host's user from the Phase 2 install
  onwards (every test and build imports it), and that user boundary holds the passphrase-less SSH signing key
  (`~/.agents/machine.md`), the CLI logins and every other worktree; inside a keyed run it additionally sees
  `PRIVATE_KEY` (the testnet signer, 2.9 Sepolia ETH, cap 2.0), the testnet deployer secret and the dRPC key, and
  can sign outside the scripts, which no cap or tally constrains. The same toolchain compiles the hub bytecode
  that `compile.sh --check` pins against itself. **Answered (a)** by the owner. **Ask:** (a) run the live window on the young line now; (b)
  hold every keyed run until each package is seven days old (the signer, the deployer secret and the dRPC key
  are the incremental exposure; the host boundary is exposed from Phase 2 either way); or (c) hold the install
  too, a week of nothing. Recommended: (a), on the owner's own "push this as much as possible", with the exposure
  stated as above; Codex's final pass prefers (b) as the stronger default, and the Nulo wait may cover the week
  anyway. Age buys observation time, not authenticity.
- **A8. Two follow-ups that name "the next generation".** `follow-ups.md` asks for `MIN_FUEL_FJ` to be set from the
  measured private ceiling (8.516 FJ against the 29.773 FJ floor) and for `createPortal` to send gas headroom and
  check its receipt (its bare estimate ran out once, and the revert reads like RPC lag). **Answered (a)** by the
  owner. **Ask:** (a) fix
  `createPortal` in Phase 5 (local: headroom plus a receipt check, with a test) and keep the floor with a recorded
  deferral, or (b) defer both. Recommended: (a). The floor stays, because lowering it is a product call on the
  fuel margin, not a bug.

## Phases

Every gate runs from the repository root in this worktree. "The fast layers" means `bun run lint`,
`bun run typecheck:all` and `bun run test:all`; a test command passes when every failure it reports is an open
expected-red ledger case, recorded by name with the exit code in the phase's lessons file (§ Non-obvious
mechanics); lint and typecheck pass only at exit 0. "Both builds" means
`bun run --cwd apps/tools build:testnet`, `bun run --cwd apps/tools verify:build-target testnet`, then the same pair
for `mainnet`. Every keyed run is `env-exec request --template <template> --slug <name> -- <command>`, filed after
a commit and a push, with its id given to the owner as `op-remote alejo-box <id>`.

### Phase 1: Preconditions and the reset evidence ✓

1. Commit this plan folder (`plan.md`, `recon.md`, `lessons/`) and the `implementations-plan/index.md` line.
2. Write `lessons/reset-baseline.json` from F4 and F5 (§ Key interfaces), and `lessons/phase-1.md` with the two-RPC
   reads, the upstream config values, the `aztec-up` log summary and the `bun audit` baseline on `main`.
3. Record that the forge `lib/` and `out/` were copied from the canonical clone without `cache/`, and that
   `lib/v4-core/.env` was deleted.

**Validation gate**
- Commands: `bun install --frozen-lockfile`; the fast layers.
- Pass criteria: every command exits 0 with no open ledger case. `lessons/phase-1.md` quotes F4 from both RPCs.
- Layers: typecheck/lint, unit.

### Phase 2: The JS line ✓

1. Set every `@aztec-labs/*` and `@aztec-foundation/*` pin, `aztec-standards`, `private-fee-juice` and
   `@aztec-labs/txe` to `6.0.0`. Leave `@aztec/viem` and `@nulo-sh/*` as they are.
2. Regenerate the two Noir wasm patches as `@6.0.0` and update `patchedDependencies`.
3. Add temporary `minimumReleaseAgeExcludes` naming every new-line package `bun install` reports blocked. Run
   `bun install` at the root. In `txe-server`, run `bun install --minimum-release-age=604800` with a local,
   uncommitted `bunfig.toml` carrying the same excludes, and check that its lockfile diff touches Aztec-scoped
   entries only. Remove the temporary excludes (the standing ones stay).
4. In `live-intent.ts`, make `castBin()` try `~/.aztec/versions/<bridge-core aztec.js pin>/internal-bin/cast`
   first, then `current`, then `PATH`; drop the `5.0.0` literal.
5. Fix the type and API breaks the typecheck reports.
6. Open the expected-red ledger in `lessons/phase-2.md` with every entry of § Non-obvious mechanics.
7. Read the SponsoredFPC address (the 6.0.0 artifact at `SPONSORED_FPC_SALT`) and `STANDARD_AUTH_REGISTRY_ADDRESS`
   from the installed packages, and confirm with a keyless `node_getContract` that both are published on the
   testnet with the artifacts' classes: the conductor's class publication, the faucet and the drip canary pay
   through the SponsoredFPC.

**Validation gate**
- Commands: `bun install --frozen-lockfile --force`; the fast layers; `bun run test:ci-gating`; `bun audit`; the
  provenance check in a scratch npm project outside the repository for `aztec-standards@6.0.0` and
  `private-fee-juice@6.0.0`.
- Pass criteria: `bun audit` reports no advisory group beyond the Phase 1 baseline. `bun.lock` and the TXE
  server's lockfile hold no `6.0.0-rc` entry under either scope, and `aztec-line.test.ts` is green. Every other
  command exits 0 with only the ledger's open cases failing.
- Layers: typecheck/lint, unit.

### Phase 3: The Noir line

1. Move the seven tags in the five `Nargo.toml` files to `v6.0.0`: the `aztec` dep in every crate, the hub's
   `compressed_string`, and the hub's standards `token` dep (the one the Token class id depends on), with the
   aztec-nr URL spelled as the standards spell it.
2. Update the vendored lib's header to tag `v6.0.0`, commit `d2e67c1d…`, same digest (F10).
3. Move the `AZTEC_HOME` defaults in `compile.sh`, `nargo.sh` and `run-txe-tests.sh` to `6.0.0`.
4. Recompile and commit `target/*.json`. Re-pin the hub class id and `aztec_version` in
   `noir-artifact-classids.test.ts`, and the in-circuit vector shared by `hub-token.test.ts` and `keystone.nr`
   (its `TOKEN_CLASS_ID` input moves to the 6.0.0 standards class, `0x2ff0…ea9f`).
5. Install the TXE server's lockfile at `@aztec-labs/txe@6.0.0`.

**Validation gate**
- Commands, as `_bridge-contracts.yml` runs them: `bash contracts/bridge/aztec/scripts/compile.sh --check
  token_bridge_hub`; `bash contracts/bridge/aztec/scripts/nargo.sh contracts/bridge/aztec/keystone test --force`;
  `bash contracts/bridge/aztec/scripts/nargo.sh contracts/bridge/aztec/token_bridge_hub test --force keystone`
  (at least one passed test); `bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate token_bridge_hub`;
  in `contracts/bridge/evm` after `bun packages/bridge-core/scripts/gen-remappings.ts`, with foundry **1.7.1**
  first on `PATH` (the CI pin, fetched as the release tarball into `~/.cache/foundry-1.7.1`, verified with
  `gh attestation verify`, never through `foundryup`, which refuses while any anvil runs on this host) and
  `forge --version` printed first: `forge build`, `forge test --no-match-contract Fork`, `forge snapshot
  --match-test test_gas_ --no-match-contract Fork --check --tolerance 2`, then halmos as `_bridge-contracts.yml`
  runs it (`pipx install "halmos==$(cat halmos.version)"`, its proof-name checks, twelve proofs);
  `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh`; the fast layers.
- Pass criteria: every command passes and the twelve halmos proofs pass on 1.7.1; the ledger closes the class-id
  and vector tests. Its remaining open cases: `published-packages.test.ts`, the FPC test and the FPC registration
  case of `script-l2.test.ts`, the faucet-record case and the fixture-derived cases, the testnet-manifest case.
  > **Stop:** if the 6.0.0 L1 artifacts fail on 1.7.1, stop and ask the owner before moving the pin (D5).
- Layers: contract suites, unit.

### Phase 4: The PrivateFPC

1. Set `PRIVATE_FPC_ADDRESS` and the descriptor from the installed 6.0.0 package: `aztecVersion`, `expectedAddress`
   (equal to its `canonical-deployment.json`), `artifactSha256`, a compatibility entry `["6.0.0"]`, the comments.
   Keep `PRIVATE_FPC_SALT`. The network pins move in Phase 5.
2. Update `private-fuel.test.ts`'s compatibility and version literals.

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core test -- src/private-fuel.test.ts`; the fast layers.
- Pass criteria: the FPC test re-derives the package's canonical address from the artifact; the ledger closes it
  and the FPC registration case of `script-l2.test.ts`, except the network-pin case. Remaining:
  `published-packages.test.ts`, the network-pin case, the faucet-record case, the fixture-derived cases, the
  testnet-manifest case.
- Layers: unit.

### Phase 5: Chain cascade, L1 constants, the baseline wiring

1. Set `TESTNET_ROLLUP_VERSION = 679261766`. Update every old-identity literal in `recon.md` § Literal inventory,
   the `live-intent.test.ts` fixtures, the FPC descriptor's network pins and `private-fuel.test.ts`'s testnet
   `rollupVersion` assertion (not in the inventory; the gate's search would catch it anyway).
2. Move `FEE_JUICE_PORTAL` in the three Solidity fixtures and `contracts/bridge/evm/.env.example` to
   `0xe59acba462a0324b1d619a7a1b219419f156f505`. The fee asset, handler and registry stay.
3. Point `NO_RESET_BASELINE` at `implementations-plan/aztec-6-stable/lessons/reset-baseline.json`. Add
   `implementations-plan/aztec-6-stable/lessons/` to `OPERATIONAL_ALLOWLIST`.
4. Retire `deploy-journal/testnet-generation.jsonl` in its own commit.
5. Commit and push. No keyed probe here: the owner is unavailable overnight, and the probe is folded into
   Phase 9. `live-intent build` records the keyed node's `nodeVersion` and rollupVersion in the intent, and
   `check-fpc-version.ts` (Phase 9 step 5) holds the descriptor's compatibility entry to it (I3); a mismatch
   stops there, before any Fee Juice moves.
6. Update the literal docs: `UPDATE.md` current line and toolchain path, the skill's toolchain path and examples,
   `contracts/bridge/aztec/README.md`, `apps/tools/tests/browser/README.md`.
7. Under A8(a): in `generation.ts`'s `ensurePortal`, send `createPortal` with its estimate plus 25 % (as `runSend`
   does) and fail on a receipt whose status is not success, with a unit test for the receipt check. Leave
   `MIN_FUEL_FJ` at 29.773 FJ and record the deferral (A8).

**Validation gate**
- Commands: the fast layers; both builds; `rg -n -i --hidden '3409706519|3415328944|0x6974bde6|0xed1eb2eb'
  --glob '!.git/**' --glob '!**/node_modules/**' --glob '!implementations-plan/**' --glob '!bun.lock' --glob '!.claude/**'`.
- Pass criteria: every command exits 0; the ledger closes the network-pin case. Remaining:
  `published-packages.test.ts`, the faucet-record case, the fixture-derived cases, the testnet-manifest case. The
  search hits only `apps/tools/public/testnet-bridge.json`, which changes at promotion.
- Layers: typecheck/lint, unit, build.

### Phase 6: The local rehearsal

1. Run the sandbox smoke. Copy `packages/bridge-core/sandbox-deploy/deployments.json` to
   `apps/tools/src/contracts/deployments.json` and `packages/bridge-core/sandbox-deploy/manifest.json` to
   `packages/bridge-core/fixtures/sandbox-manifest.json` (nothing else writes the fixture); commit both.
2. Clear `apps/tools/node_modules/.vite`. Run the browser suite and the integration suite.

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core deploy:sandbox --smoke`; `bun run e2e:tools`;
  `bun run --cwd packages/bridge-core test:integration`; the fast layers; `bun run test:ci-gating`; both builds.
- Pass criteria: every command exits 0; the ledger closes the faucet-record case and the fixture-derived cases.
  Remaining: `published-packages.test.ts` (until Phase 7) and the testnet-manifest case. The smoke runs every
  step, the PrivateFPC credit flows included, and reports the FPC absent at its end. Each run is reaped by its
  own process group.
- Layers: unit, sandbox smoke, browser e2e, integration.

### Phase 7: The Nulo packages (floats; before the PR opens)

> **Warning:** this phase starts when `@nulo-sh/wallet-crypto` and `wallet-sdk-schema-patch` publish versions
> whose peers are `6.0.0` (the Nulo team's `0.3.0`); a watcher polls npm. The owner chose A6(a): Phase 9 waits
> for this phase. Its `package.json` and lockfile edits are not allowlisted, so it never runs inside the live
> window (D19).

1. Check the new tarballs' sha256 against the wallet repository's `approved-digests.json` and their provenance
   (`nulo-sh/nulo`) in the scratch npm project. Run `deployer-keys.test.ts` against the new `wallet-crypto` in
   that project first: a moved vector stops here and goes to the owner.
2. Pin the three packages in `apps/tools` and `packages/bridge-core`, with the local excludes if the line is still
   under the gate. `bun install`.
3. If this phase runs after Phase 6: clear `.vite`, re-run the browser suite.

**Validation gate**
- Commands: `bun install --frozen-lockfile --force`; the fast layers; `bun run test:ci-gating`; the vector test;
  `bun run e2e:tools` when step 3 applies.
- Pass criteria: every command exits 0; the ledger closes `published-packages.test.ts`.
- Layers: unit, browser e2e.

### Phase 8: The quality loop, before any key

1. If `main` moved, `git fetch origin main` and rebase this branch onto it; re-run the Phase 6 gate.
2. Run the quality loop over this branch's diff from `origin/main` (§ Post-implementation), excluding
   `target/*.json`, lockfiles and the retired journal by name. Commit every fix; `git status --porcelain` is empty.
3. If Phase 7 has not run when the loop converges, Phase 9 waits for it (A6(a)): log the wait in
   `lessons/phase-8.md` and keep the tree frozen apart from Phase 7 itself, which re-runs this gate.

**Validation gate**
- Commands: the Phase 6 gate, re-run after the last fix.
- Pass criteria: the loop's last round yields no material finding, quoted in `lessons/phase-8.md`.
- Layers: all local layers.

### Phase 9: The live generation (keyed runs, A1)

> **Warning:** from step 1 until Phase 10's final verify, change nothing outside `OPERATIONAL_ALLOWLIST`: no
> edit to `plan.md`, no ✓ mark, no rebase. Record progress in `lessons/` only. Run one signing command at a time.
> Commit and push each run's output before the next request, and never commit while a request is pending. Keep
> the gross spend tally per broadcast group in `lessons/phase-9.md`. Every fuel and smoke run on the candidate
> passes `--config apps/tools/public/testnet-bridge.candidate.json`: `fuel-testnet.ts` falls back to the live
> manifest, which still names the dead rc.3 generation until step 8. Phase 7 never runs inside the window (D19).

1. `bun packages/bridge-core/scripts/gen-remappings.ts`, then `/opt/foundry/bin/forge build --force --root
   contracts/bridge/evm` with `forge --version` printed into `lessons/phase-9.md`: the binary a keyed run
   resolves (D18). No sandbox and no other forge build from here to Phase 10's final verify. Then
   `live-intent.ts build implementations-plan/aztec-6-stable/lessons/intent.json` (testnet-l1). Commit and push
   the intent.
2. Read the four Sepolia tokens (code, `decimals()`, `maxMintPerTx()`, sorted below WETH) and the five pools'
   liquidity, plus a quote per token for 0.25, 0.5, 1 and 1.5 tokens against the carried 29.773 FJ floor. Pick
   `FUEL_SLICE_UNITS` from the table, as rc.3 did (1500000).
3. `SKIP_POOL_SEED=1 SEED_TOKENS=<USDC>,<USDT> deploy:generation deploy --dry-run`, then the live run
   (testnet-generation, `verify` chained ahead), with the runbook's bounded retry on lagging readbacks, and in the
   same keyed run `pre-create --no-register --token <EURC>` then `--token <GBPC>` (rc.3's ordering: the deployer
   secret stays in this one run and the fuel runs below need none). Delete forge's broadcast cache.
4. A read-only `verify` (testnet-rpc), then `deploy:testnet --output <outside the repository>` (testnet-faucet).
   It must equal the committed `deployments.json` byte for byte. Never overlap it with the conductor.
5. `check-fpc-version.ts` (testnet-rpc): green before any Fee Juice moves.
6. On the candidate (`--config apps/tools/public/testnet-bridge.candidate.json` on every run, `FUEL_SLICE_UNITS`
   from step 2 on every fueled run, the swap smoke included), `verify` chained ahead of each signing run
   (testnet-l1): `smoke-existing-testnet.ts`; `smoke-swap-existing-testnet.ts`; `fuel-testnet.ts --token <EURC>`
   (the paid public first-registration sample); `PUBLIC_RUNS=0 fuel-testnet.ts --token <GBPC>` with `PRIVATE_RUNS`
   unset (the private first claim, three runs); `PUBLIC_RUNS=1 PRIVATE_RUNS=0 fuel-testnet.ts` on USDC (the plain
   `claim_public` sample the matrix needs).
7. `calibrate --samples <path outside the repository>`. `minFuelFj` keeps the carried floor (a source constant).
   > **Stop:** if the worst measured private ceiling exceeds `MIN_FUEL_FJ`, stop before `verify --candidate` and
   > ask the owner.
   7b. Not run: the owner chose A5(a). The rc.3 factory `0xc68a…565a` (owner `0x7F42…6a9a`, deposits open)
   stays as it is, a known limit.
8. `verify --candidate` (testnet-rpc); commit and push the intent. Delete `apps/tools/public/testnet-bridge.json`
   in its own commit, push. `check-fpc-version.ts` again, then `promote --bridge-only` (testnet-rpc). Commit and
   push the promoted manifest and the receipt.
9. Send the owner the four `tokens[].l2Token` addresses for the wallet's repository.

**Validation gate**
- Commands: `live-intent.ts verify <intent> --candidate <candidate>`, then `promote`; the Phase 5 identity search.
- Pass criteria: the receipt is committed, `testnet-bridge.json` equals the promoted candidate, all four tokens
  are registered, the gross spend tally and the balance delta both stay under 2.0 ETH, the search prints nothing
  and exits 1. The ledger closes the testnet-manifest case.
- Layers: live testnet.

### Phase 10: Canaries, the preview, the final verify

1. The runbook's step 9 canaries against the promoted manifest: `verify:l1 --strict` (testnet-rpc; its `--force`
   rebuild runs on the keyed PATH's forge, the binary of Phase 9 step 1, and its printed version is quoted in
   `lessons/phase-10.md`); `verify:deployments` on the live manifest; `check-fpc-version.ts` then `PRIVATE_RUNS=1 fuel-testnet.ts` with a quote-validated
   `FUEL_SLICE_UNITS`; `fee-juice-canary-testnet.ts`; `drip-canary-testnet.ts`; `token-list.test.ts` with
   `TOKEN_LIST_LIVE=1`.
2. Load the branch's Workers Builds preview in Chromium: no CSP violation, and the boot `node_getNodeInfo` POST
   answered 200 with rollupVersion 679261766 in the network log.
3. Nothing for the owner's wallet: A4's check runs on the PR's final head, after Phase 7 (§ Post-implementation).
4. The final `live-intent verify` (testnet-rpc). The freeze ends. Mark Phases 1–10 ✓ (Phase 7 when it has run).

**Validation gate**
- Commands: the canaries above; the final `verify`.
- Pass criteria: every canary exits 0, the private self-paying claim settles, the preview loads with no CSP
  violation, the final verify is green. Each success line is quoted in `lessons/phase-10.md`.
- Layers: live testnet.

### Phase 11: Docs and the final gates

1. `UPDATE.md` (current line, couplings), the runbook (6.0.0 as the worked example, any new gotcha), `AGENTS.md`'s
   Nulo table row if the mirrored facts changed. In `follow-ups.md`: delete "Aztec 6.0.0 final needs a new testnet
   generation"; re-word `lifi-routing` to rebase onto 6.0.0; add the rc.3 records entry.
2. Then § Post-implementation from step 1: the final Codex pass, the PR, the close-out as its final commits.

**Validation gate**
- Commands: the fast layers; `bun run test:ci-gating`; `bun run audit:tools`; `bun run lint:actions`;
  `bun audit`; `bun run e2e:tools`; both builds.
- Pass criteria: every command exits 0 with an empty ledger, except `bun audit`, judged as in Phase 2.
- Layers: all local layers.

## Decision ledger

Sources: **M** the lead's draft, **C** Codex (`gpt-6.1-sol`, high), **C2** Codex's fresh-context final pass, **F** the
Claude leg (Opus 5.5), **O** the owner.

| # | Decision | Source | Rejected alternative and why |
|---|---|---|---|
| D1 | One PR: the line, the generation and the close-out | M | A bump-only PR first: `verify:deployments` runs inside the tools build gate, so a reset cannot land with the redeploy deferred; the live app is already dead, so nothing regresses by waiting |
| D2 | Outline A, sequential phases 2–5 in this worktree | M, C | Outline B, three Opus streams: the critical path is the Nulo publish plus the live window, which lanes do not shorten |
| D3 | The Nulo pin is its own floating phase, before the PR opens; the vectors gate it | M, F13 | Hold every phase for the publish: the probe shows one `Fr` class on 0.2.0, so only the pin test waits |
| D4 | `SKIP_POOL_SEED=1`; pre-create without `--seed-pool` | F4, rc.3 D8 | Seed as on a fresh network: a seed on an existing pool adds liquidity again |
| D5 | CI foundry stays 1.7.1; Phase 3 runs forge and halmos on an explicit, attestation-verified 1.7.1; a failure stops for the owner | M, C, F | Move to 1.8.5 now, or let CI be the only 1.7.1 proof: 1.8.1 passed none of the twelve halmos proofs, and a late CI red would land inside the live window |
| D6 | `castBin` reads the bridge-core pin | M | Replace `5.0.0` with `6.0.0`: the next bump re-edits it |
| D7 | The rc.3 factory stays unpaused, a known limit (the owner's A5); the pause was offered as an executable step | M, C, C2, O | Decide it silently from rc.3's D10; or name `pause-factory.ts` with no phase that runs it |
| D8 | The owner's wallet check runs before the merge, on the preview of the PR's final head after the Nulo pin (A4) | O | Check after the merge on production (the drafted default); or check inside Phase 10 on a preview built with the 0.2.0 schema patch, which would not prove the shipped bundle |
| D9 | The live deploy waits for the Nulo `0.3.0` pin (the owner's A6(a)) | M, O | Deploy on 0.2.0 and pin after the final verify (the recommendation): sound on the derivation vectors, but the owner prefers the deploy on the tree that ships |
| D10 | The faucet run is preceded by a read-only `verify` on `testnet-rpc`; only L1-signing runs chain `verify` | C | Chain `verify` on the faucet template: it has no Sepolia RPC, so `verify` throws |
| D11 | A gross spend tally per broadcast group in lessons, beside the tool's balance delta | C | Add a tally to the tool: a new persistent record for a cap that one hand-kept table already covers |
| D12 | The close-out follows the final pass and the PR, never before | C | Phase 11 "runs the close-out": it would archive the live plan before the PR exists |
| D13 | Every candidate fuel and smoke run passes `--config …candidate.json` and a quote-sized `FUEL_SLICE_UNITS` | F (rc.3 audit) | Rely on defaults: `fuel-testnet.ts` falls back to the live manifest, which names the dead rc.3 generation until promotion, and the swap smoke's slice is a whole token |
| D14 | No `plan.md` edit and no commit while a keyed request is pending inside the window; ✓ marks for Phases 1–9 are written after the final verify | F | The seed's "mark ✓ on every green gate": `plan.md` is not allowlisted, so the next chained `verify` voids the intent |
| D15 | EURC and GBPC are pre-created inside the deploy's keyed run; the USDC public sample runs with `PRIVATE_RUNS=0`; the FPC gate re-runs before `promote` | F (rc.3 phase 11) | Separate pre-create runs: two more approvals and the deployer secret in runs that need none; three extra private runs for one public sample |
| D16 | The young line runs beside the signer, the owner having chosen A7(a) with the exposure stated in full: the host user boundary from Phase 2, the keyed secrets inside the window | F, C2, O | Decide silently: the rc.3 plan's "no attestation, as before" held for one young package, not the whole line; or state the blast radius as "testnet funds and the dRPC key" |
| D17 | `createPortal` headroom and receipt check in Phase 5 (the owner chose A8(a)); `MIN_FUEL_FJ` stays with a recorded deferral | F, O | Skip both follow-ups silently in the generation they name |
| D18 | `out/` is rebuilt right before `build` with the forge a keyed run resolves (`/opt/foundry/bin/forge`, env-exec's PATH), and nothing builds again until the final strict verify | C2 | Pass `FORGE_BIN` into the keyed run: env-exec rebuilds the environment and fixes the PATH by design; or leave `out/` to the sandbox's 1.8.5 and let a 1.4.1 rebuild judge it after the spend |
| D20 | `bridge-core` pins stock `viem@2.57.1`, the exact viem the 6.0.0 line depends on, instead of `npm:@aztec/viem@2.38.3`; `@aztec/viem` leaves the tree | M (Phase 2) | Keep the alias, as the plan first said: 6.0.0 dropped the fork, so the alias would put a second viem copy behind `flows.ts`'s `OutboxContract` client, the one boundary the alias existed for |
| D21 | Delete the 43 lockfile entries that nest rc.3 copies under the Nulo packages' peers, and let Bun re-resolve each peer edge to 6.0.0 | M (Phase 2) | Keep them until Phase 7: two `Fr` classes in the rehearsal and a red `aztec-line.test.ts`; or regenerate the whole lockfile, which re-resolves every unrelated dependency |
| D19 | Phase 7 runs before Phase 9 step 1 or after Phase 10 step 4, never inside the window | C2 | Let it float freely: a publish inside the window would edit `package.json` and the lockfile and void the intent |

Still disputed after consolidation: none. The one open evidence question, how Bun resolves the mismatched Nulo
peers, was settled by the probe (F13) after both legs reported.

## Audit verdicts

**Dual audit.** Codex (`gpt-6.1-sol`, high): *conditional approve*, high confidence; conditions: repair the
contradictory gates, correct the keyed-run preconditions, pin the validation toolchain, untangle the close-out
ordering. Each claim was checked against the repository before adoption.

| Finding | Leg | Disposition |
|---|---|---|
| The faucet's template has no `SEPOLIA_RPC_URL`, so a chained `verify` throws (`requireSepoliaRpc`) | C | Adopted: A1 wording, Phase 9 step 4, D10 |
| `verify`'s cap check is a balance delta that incoming ETH can mask | C | Adopted: the hand-kept gross tally, D11 |
| Phase 3's bare `forge` is the host's 1.4.1, so it never proves CI's 1.7.1 | C | Adopted: the gate runs twice with the version printed; CI proves 1.7.1; D5 names the halmos cost of a move |
| A4 and A5 were defaults, not decisions | C | Adopted: both are Asks at the gate |
| Phase 2's gate was self-contradictory (nested rc.3 entries vs. "no rc entry"), and `aztec-line.test.ts` has no Nulo-peer check | C | Adopted, with the probe (F13) showing Bun nests nothing: the lockfile holds no rc entry, `aztec-line.test.ts` is green, `published-packages.test.ts` is the one red |
| Expected reds were incomplete: `bridge-generation.test.ts` re-derives the sandbox fixture, red from Phase 3 to Phase 6 | C | Adopted: the expected-red ledger, carried gate to gate |
| `env-exec` requires HEAD at the tip of a pushed branch; the plan pushed only at Phase 9 | C | Adopted: commit and push before each request |
| The close-out ordering was circular | C | Adopted: Phase 11 ends in § Post-implementation step 1; D12 |
| Calendar dates in the plan | C | Adopted: removed; the gate condition is "until each publish is seven days old" |

Claude leg (Opus 5.5, `Plan` agent): *conditional approve*, high confidence on the code findings, moderate on the
Bun peer resolution (settled by F13). Conditions C1–C6, each checked in the code:

| Finding | Leg | Disposition |
|---|---|---|
| C1 The candidate fuel runs had no `--config`, so `fuel-testnet.ts` would fall back to the live rc.3 manifest and deposit into a dead portal; the swap smoke's default slice is a whole token | F | Adopted: Phase 9 warning and step 6, D13 |
| C2 The whole unattested line installs beside the signer before it is seven days old | F | Adopted as A7 (the owner's call), D16; the TXE install is gated by the flag with a local bunfig |
| The SponsoredFPC and auth-registry publication was not re-read (rc.3 F8) | F | Adopted: Phase 2 step 7 |
| The "second foundation" mechanism was unverified and contradicted Phase 2's gate | F | Adopted: the probe (F13); one `Fr`, `published-packages.test.ts` is the one red |
| Seven tags in five `Nargo.toml` files, not six; calendar dates | F | Adopted |
| C3 Phase 3 ran whatever `forge` is on `PATH` and omitted halmos; D5's fallback contradicted the workflow's 1.8.1 record | F | Adopted: an attestation-verified 1.7.1 and halmos locally; a failure stops for the owner (D5) |
| C4 Two follow-ups naming "the next generation" were silently skipped | F | Adopted as A8, D17 |
| C5 More expected reds: the faucet-record case and the fixture-derived cases, red from Phases 2–3 to Phase 6 | F | Adopted: the ledger |
| Phase 6 named no source for the fixture; the smoke writes `sandbox-deploy/manifest.json` | F | Adopted: Phase 6 step 1 |
| C6 The `/loop` seed's ✓ marks and commit-push would void the intent or a pending request | F | Adopted: Phase 9 warning, the seeds, D14 |
| The new `castBin` candidate would sit behind `current` (rc.3 here), dead | F | Adopted: Phase 2 step 4, the pin first |
| Live-window ordering: pre-create inside the deploy run, `PRIVATE_RUNS=0` on the public sample, the FPC gate before `promote` | F | Adopted: Phase 9 steps 3, 6, 8, D15 |
| Use the Nulo wait for an early rehearsal | F | Adopted: Phase 6 precedes Phase 7, which floats |
| Outline A over B | F | Adopted: D2 |

**Final pass.** Codex (`gpt-6.1-sol`, high, fresh session): *conditional approve*, high confidence; conditions:
resolve A4–A8 explicitly, repair the freeze scheduling and the incomplete ledger, correct A7's exposure
statement. Each claim was checked in the code; all adopted.

| Finding | Label | Disposition |
|---|---|---|
| A7 understated the compromise boundary: a compromised package runs as the host user from the Phase 2 install, not only inside keyed runs, and pins fix bytes, not honesty | plausible | Adopted: A7 rewritten with the three options and the host boundary; recommendation (a) kept on the owner's own instruction, Codex's preference for (b) recorded; D16 |
| A floating Phase 7 could land inside the freeze and void the intent | demonstrated | Adopted: Phase 7 runs before `build` or after the final verify; A6, Phase 7 warning and step 3, the seeds; D19 |
| A5's pause alternative had no executable step | demonstrated | Adopted: Phase 9 step 7b under A5(b), the answer recorded in Phase 8; D7 |
| Ledger misses: `script-l2.test.ts`'s `registerPrivateFpc` case (red Phase 2 → 4) and its `TOKEN_CLASS_ID` literal (Phase 3); `private-fuel.test.ts`'s old rollupVersion assertion (Phase 5); "exit 0 with cases failing" is contradictory | demonstrated | Adopted: the ledger, Phase 3 step 4, Phases 3–5 pass criteria, the gate definition |
| Strict `verify:l1` rebuilds `out/` with the PATH forge (1.4.1 in a keyed run) while the deployed bytecode came from the sandbox's 1.8.5 | plausible | Adopted as parity, not `FORGE_BIN`: env-exec fixes the PATH and rebuilds the environment; Phase 9 step 1 rebuilds `out/` with that same binary; D18 |
| Stale passages: I1, the `castBin` order in § Architecture, recon's "second foundation" | demonstrated | Adopted: all three corrected |
| `verify:build-target` is not a derivation proof | low | Not applicable: the plan names it only as a build gate; `verify:deployments` and the unit cases carry the derivations |
| A6(b) sound; D13–D17 reflected in Phase 9; live ordering, templates, Noir and halmos gates match the scripts | looks fine | — |

## Post-implementation

This section is the execution contract. `code_review` is `off`, so there is no `/code-review` step.

1. **Quality loops.** The Phase 8 loop over `git diff origin/main...HEAD` minus `target/*.json`, lockfiles and
   the retired journal; then, after Phase 11, **the final pass** in a fresh Codex session over the PR's net diff,
   asking for drift from this plan and seams between the pre-window and post-window commits. Each loop:
   1. `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with the diff,
      this plan and its ledger, the adversarial ask *"What could go wrong? What would an attacker target? What are
      we trusting that we shouldn't? Where are the supply-chain / crypto / least-privilege weaknesses?"*, and the
      two rules below, verbatim.
   2. Verify Codex's factual claims against the repository.
   3. Apply the accepted fixes, commit, log the round in `lessons/phase-N.md`.
   4. Resume the same session with `resume-codex.sh` and the fix diff.
   5. Repeat until a round yields no new material finding. After 3 material rounds, stop and surface.

   A fix that adds persistent state, a lifecycle, a coordination protocol, a recovery policy or a public contract
   is a plan change: stop for the owner. A fix that would change deployed state is surfaced, never applied in a loop.
2. **Delivery** per § Delivery: `gh pr create`, the first time the PR opens, after the final pass converges.
3. **Close-out**, as the PR's final commits, after the PR exists:
   1. `## Outcome` after the front matter: status, what shipped with the PR number, the deployment record
      (addresses, digests, caps; no timestamps, no commit ids), what was dropped and why, `Known limits:` (the
      rc.3 factory issue, if A5 keeps it unpaused), `Open items:`, one line retiring the seeds below.
   2. Promote the generalizable gotchas into `implementations-plan/lessons.md` (under 8 KiB, deduplicated,
      superseded entries retired); `memo note` each.
   3. Open items: `follow-ups.md` entries (this repository's open-work file, `AGENTS.md` § Plans); the known
      limit as a closed `known-limit` issue.
   4. Strip timestamps and commit ids from `lessons/intent.json` and the receipt.
   5. `git mv implementations-plan/aztec-6-stable implementations-plan/archive/aztec-6-stable`, in its own commit.
   6. Next commit: `NO_RESET_BASELINE` and the allowlist entry at the archived path; repair every
      `git grep -n aztec-6-stable` link; move the `index.md` line to `archive/index.md`.
   7. `gh pr checks --watch`. Then give the owner the Workers Builds preview URL of the PR's final head for the A4
      wallet check, and stop: the merge is the owner's (A3), after that check.
4. **Teardown after the merge.** Trigger: `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/aztec-6-stable/plan.md`. A `/loop` session checks it on every firing; a
   `/goal` session arms one background wait after its wrap-up report. Then `ExitWorktree` with `keep` (this session
   entered through `EnterWorktree`), then `agent-worktree done aztec-6-stable --merged`; relay a refusal, never force.

**The no-over-engineering rule** (verbatim in every post-impl Codex prompt): *"Report bugs and small, targeted
improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites
— the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**The comment-quality rule** (verbatim in every post-impl Codex prompt): *"Audit the comments for value per
character. Flag any comment that narrates what the code visibly does, restates its line, references
implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a
non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every
future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

**While implementing:** comments to the bar as written; each attempt logged in `lessons/phase-N.md`; at each gate
`agent-worktree status aztec-6-stable "phase N green: <next>"`; stop after 3 failures on one step (5 in a `/loop`).

## Delivery

| Arc | Phases | Branch → base | PR title | `/code-review` |
|---|---|---|---|---|
| 1 | 1–11 + close-out | `worktree-aztec-6-stable` → `main` | `feat!: move to aztec 6.0.0 and deploy a new testnet generation` | off |

- Single arc, plain `gh pr create`, after the Phase 8 loop and the final pass converge and Phase 7 has run. Add
  the `e2e:tools` label after it opens, never at creation. Check `mergeable` if no CI appears.
- **Parallelism.** Phases 2–5 touch disjoint files, but the critical path is the external Nulo publish and the live
  window; lanes would cut nothing that matters. No lanes (D2).
- Owner steps, in order: answer A4–A8 at the gate; get the Nulo packages published (A2); approve each keyed run
  (Phases 5, 9, 10); fund the signer if the tally runs short; the wallet check on the preview of the PR's final
  head (A4); merge (A3).

## Seeds

Final, after the owner's approval. Use exactly one per session; they do not compose.

```
/goal All phases marked ✓ in implementations-plan/aztec-6-stable/plan.md (the per-phase headers in the file — not the chat, not the task list), each ✓ backed by its phase's validation gate (as defined in plan.md) reported passing in the transcript; for each phase the agent has printed `LESSONS_FILE=implementations-plan/aztec-6-stable/lessons/phase-N.md` in the transcript; `/code-review` was NOT run (code_review is off); the Codex fix loop converged for the Phase 8 diff and for the final pass over the PR's net diff, each convergence evidenced by a resumed Codex pass reporting no new material findings, quoted in the transcript; the single PR exists on GitHub, created only AFTER both loops converged and Phase 7 pinned the Nulo packages (`gh pr view` output in the transcript), including the close-out as its final commits (`git show --stat` of the archive-move commit in the transcript); `bun run test:all` and `bun run lint` both report exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/aztec-6-stable forward. Never idle waiting for my input. Each firing:
1. **Reality check**: read implementations-plan/aztec-6-stable/plan.md and lessons/ (authoritative state — not the chat), including its Outcome & Quality Bar section. If that path is gone, the close-out has run: `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/aztec-6-stable/plan.md` succeeds → it merged: run the teardown now, without asking — `ExitWorktree` (`keep`), then `agent-worktree done aztec-6-stable --merged` — report what it removed or its refusal verbatim, clear this loop and STOP. Fails → delivered and awaiting my merge: babysit only (CI per step 2, keep the Outcome true), never resume a phase; once the PR is green, report that once and STOP. A live plan.md that already carries an `## Outcome` block means a close-out was interrupted: finish it. Otherwise, native task list empty? rebuild it from plan.md; run `git status` and `git log --oneline -5`. If a PR exists, `gh pr view --json statusCheckRollup` (no --watch). Without a PR but with CI configured, `gh run list --branch $(git branch --show-current) --limit 1 --json status,databaseId`.
2. **Waiting on CI or on npm is fine** — confirm it is progressing (`gh run watch <run-id>` up to 10 minutes). Phase 7 waits for `@nulo-sh/wallet-crypto` and `@nulo-sh/wallet-sdk-schema-patch` with `6.0.0` peers on npm (`npm view <pkg> dist-tags.latest`, then `peerDependencies`); until they exist, do every other pending step and log the wait in lessons. Phase 9 waits for Phase 7 (the owner's A6: wait for 0.3.0), and Phase 7 never runs inside the live window (Phase 9 step 1 to Phase 10 step 4): a package or lockfile edit there voids the intent. Every keyed run needs my op-remote approval: when the next step is keyed, file the request, give me the `op-remote alejo-box <id>` line, and hold; commit nothing while it is pending.
3. **No task in hand?** Pick the next pending step from plan.md and start it. After each meaningful edit, run `bun run lint` and `bun run test:all` for the touched packages. Then commit → push, except while a keyed `env-exec` request is pending (a commit voids it) and except inside the live window (Phase 9 step 1 to Phase 10 step 4), where only `OPERATIONAL_ALLOWLIST` paths change and each run's output is committed and pushed before the next request.
4. **Stuck, or facing a decision you would normally bring to me?** Call `/codex high` (gpt-6.1-sol) with full context and reach a defensible decision, then act on it. Log every consult + verdict in lessons/phase-N.md. Hard limits stay hard: never merge, never publish, never run a keyed run without my `op-remote` approval, never expand scope beyond plan.md; if a decision crosses one, surface it and hold.
5. **Same step failed 5 times?** Stop retrying; reassess with codex, then continue down the agreed path.
6. **Phase green?** "Green" means THE PHASE'S VALIDATION GATE as written in plan.md passes. Run the full gate, paste the result, file the lessons entry, print `LESSONS_FILE=implementations-plan/aztec-6-stable/lessons/phase-N.md`, advance. Mark ✓ in plan.md at once for Phases 1–8 and 11; for Phases 9 and 10 the ✓ marks (and any Phase 1–8 mark still pending) are written only after Phase 10's final verify, never inside the live window: plan.md is not allowlisted and an edit there voids the intent.
7. **All phases ✓?** Run plan.md's Post-implementation section from where it stands: the final Codex pass, then Delivery (the first time the PR opens), then the close-out, then `gh pr checks --watch`. Write the wrap-up report: what shipped, each contentious decision with its ELI5 context, open items. Surface and stop — merging is my call.
Keep the native task list current (`TaskUpdate` as steps start/finish; plan.md stays the source of truth).
```
