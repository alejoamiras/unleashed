---
plan: aztec-v6
tier: mid
driver: claude-code
claude_model: opus
code_review: off
eli5_mode: artifact
budget: "recon: 1 agent; code-review: off; foreign reviewer at high"
status: closed
base: main; the aprime-fidelity stack lands independently, and whichever merges second reconciles
---

## Outcome

- **Closed; delivered.** It is one PR, squash-merged at the owner's call. All phases 0–7 are ✓.
- **Shipped: the line bump.** Unleashed now runs Aztec 6.0.0-rc.1:
  - JS on `@aztec-labs/*` and `@aztec-foundation/*`, with patches and build config to match;
  - Noir on `v6.0.0-rc.1`, with the vendored content-hash crate;
  - CI toolchain readers, the single-generation guard and the peer-pin guard;
  - testnet trust anchors: the dRPC node constant and a path-exact CSP, the chain identity, and the PrivateFPC on `private-fee-juice@6.0.0-rc.1`'s canonical deployment.
- **Shipped: the generation.** The testnet reset needed a new generation, deployed through keyed runs on a fresh pinned signer (`0x7F42…6a9a`).
  - Contracts: the factory, router, hub, UniswapFuelSwap, and the USDC, USDT, EURC and GBPC portals, plus the PrivateFPC and the faucet.
  - It was calibrated and promoted (`345f68c0…c76f`). The v5 manifest was retired first. Spend was 1.030 of 2.0 ETH.
  - Every canary, the CSP preview check and the owner's manual wallet check passed.
- **Shipped: fixes on the way.** The sandbox anvil leak (`reapOnSignals`), tmpfs-only wallet stores for real keys, and the hub registration in `pre-create` and a resumed `deploy`. The runbook now carries keyed runs and upstream reset-baseline authentication.
- **Reviews.** The pre-deploy Codex review converged in 4 rounds; the post-implementation loop converged in 3. `/code-review` was off.
- **Dropped:**
  - v5 testnet records, which the app withholds at boot;
  - the mainnet operator scripts' v6 refresh, deferred until Aztec Alpha upgrades.
- **dRPC key.** The testnet node URL embeds a dRPC key that ships in the bundle. It is separate from mainnet and may be public (A3). Rotating it is a one-constant change, `TESTNET_NODE_URL`, which the CSP follows.
- **Retired:** the `/goal` and `/loop` seeds below. This plan is a record, never a task list.

# aztec-v6: move unleashed to Aztec 6.0.0-rc.1 and deploy a new testnet generation

## Summary

Aztec v6 is a protocol reset. The testnet moved to rollupVersion `2914217885` with a new FeeJuicePortal, and every class id, canonical address and artifact format changed. The npm packages also moved from `@aztec/*` to `@aztec-labs/*` and `@aztec-foundation/*`, and aztec-nr moved to `aztec-labs-eng/aztec-nr`.

Under the `bridge-generation` runbook this is **Branch B, a coupled redeploy**. The bump cannot land without a new testnet bridge generation, a new faucet and a new PrivateFPC, because `verify:deployments` runs inside the build gate.

Two external publications gate everything past the Noir recompile: `@alejoamiras/private-fee-juice@6.0.0-rc.1` and the v6 builds of the wallet packages. Of the three wallet packages, `@alejoamiras/nulo-wallet-crypto` and `@alejoamiras/nulo-wallet-sdk-schema-patch` peer on Aztec, and `@alejoamiras/nulo-resolve-asset` peers on nothing but is republished alongside them. The work proceeds through phase 2, then holds at phase 3 until those packages are on npm.

## Owner decisions (Phase 0)

| Question | Answer |
|---|---|
| Tier | `mid` (the rubric scored 2 HIGH, migration cost and external coupling; the runbook de-risks novelty) |
| Live authorization (runbook Q2) | **Authorize the full scripted redeploy**: L1 forge broadcasts, L2 deploys and promotion under `live-intent`, via keyed runs. No credential is created. |
| Base | At approval, changed from "wait for the aprime-fidelity stack" to **start now on `main`**. If the stack merges first, rebase onto it. Re-resolve `bun.lock` with `bun install`, never by hand-merging. |
| Validation layers | lint+typecheck+unit · contract suites + TXE · sandbox smoke + browser e2e · live testnet canaries |
| Wallet packages | Treat like private-fee-juice: a blocker, checked when reached. The owner publishes from the wallet repo. |
| Legacy surfaces | Accept. Testnet cuts over to v6, the mainnet build stays a placeholder, mainnet operator scripts go stale until Aztec Alpha upgrades, and v5 testnet records are dropped. All of these are recorded as follow-ups. |
| Claude audit leg | Opus 5.5 |
| `/code-review` | off |
| Post-impl `/harden` | not scheduled. The trust surface (deploy tooling, CSP) is unchanged in kind; revisit before the mainnet bridge goes live. |

## Outcome & Quality Bar

**For whom.**
- The owner operating the testnet bridge and faucet.
- A tester who opens `unleashed-testnet` with a v6 Nulo wallet and bridges or drips.
- The next maintainer who bumps Aztec again.

**Excellent looks like:**
1. **The testnet app works end to end on v6.** It connects to the v6 node, bridges L1→L2 publicly and privately (with and without fuel), exits L2→L1, and drips SIGNAL/NOISE. The live canaries prove each path against the promoted manifest, not the candidate.
2. **No silent split line.** Both lockfiles (root and TXE server) hold exactly one Aztec generation: no `@aztec/*` npm package survives except `@aztec/viem`. JS, Noir, standards, private-fee-juice and the TXE server are all on 6.0.0-rc.1. `UPDATE.md` says so.
3. **The next bump is cheaper.** The testnet node URL lives in one exported constant. `UPDATE.md`, the `bridge-generation` skill and the CI pin readers name the new scope and the new Noir homes. Every workaround this bump needed is written down there or in `lessons.md`.

**Good enough.**
- Mainnet operator scripts may stay stale, with a follow-up.
- No new UI to explain the v5 records that were dropped. The journal already withholds foreign-generation records.

## Architecture & Implementation

### Proposed architecture
The shape is unchanged. The work is a pin, import and toolchain migration plus a new generation of existing on-chain units, all through existing tooling (see the `recon.md` reuse map). There are three structural changes:
1. **One testnet node constant.** `TESTNET_NODE_URL` is exported from `packages/bridge-core` and replaces the `v5.testnet.rpc.aztec-labs.com` literal that 15 files in `packages`, `apps` and `scripts` carry (`live-intent.ts:92`, `deploy-generation.ts`, `check-fpc-version.ts`, `deploy-private-fpc-testnet.ts`, the smokes, the canaries, `deposit-testnet.ts`, `relay-claim-testnet.ts`, …). `network-targets.ts` repeats it because it must stay Node-safe, and a test pins the two equal, the same pattern `TOKEN_LIST_SOURCE` already uses. `AZTEC_NODE_URL` still overrides it.
2. **Fee Juice via the canonical wrapper.** `FeeJuiceContract.withWallet(wallet)` from `@aztec-labs/aztec.js/protocol` replaces `Contract.at(addr, FeeJuiceContractArtifact, w)` at all seven sites. Helper parameters are narrowed to what they actually use. The raw `FeeJuiceArtifact` from `@aztec-labs/protocol-contracts/fee-juice` is used only where an artifact is genuinely needed. Each live script asserts **at runtime** that the wrapper's bound address equals `node_getNodeInfo().protocolContractAddresses.feeJuice`; a mismatch means a wrong endpoint or a split line, and the script aborts. `claim` vs `claim_and_end_setup` is preserved exactly.
3. **Vendored content-hash lib.** `contracts/bridge/aztec/token_portal_content_hash_lib/` holds `lib.nr` copied unchanged from `aztec-labs-eng/aztec-node` at `v6.0.0-rc.1`. Its header names the source commit SHA, the file's sha256 and the Apache-2.0 licence. Its `Nargo.toml` points `aztec` at `aztec-labs-eng/aztec-nr` `v6.0.0-rc.1`. The hub and keystone consume it by path.

### Key interfaces
- **Pin readers.** These move from `@aztec/aztec.js` to `@aztec-labs/aztec.js` and fail loud on `undefined`:
  - `setup-aztec/action.yml:32`
  - `_bridge-contracts.yml:284`
  - `_tools-e2e.yml:43`
  - `local-network.ts:243`
- **Noir tag readers.** `_bridge-contracts.yml:166,216,250` use a `sed` keyed on `aztec-packages/`. They move to `aztec-labs-eng/aztec-nr`, and the error text is updated.
- **FPC descriptor.** `private-fpc-canonical.json` gets a new `aztecVersion`, `artifactSha256`, `expectedAddress` and `compatibleNodeVersions[<sha>] = ["6.0.0-rc.1"]`, all hand-curated since no tool writes it (phase 3), plus identity pins (phase 5). `private-fpc-canonical-mainnet.json` is frozen at 5.x. Its equality assertions against the installed artifact become explicit frozen-mainnet assertions (its own digest and address literals), never deletions.

### Data and control flow (critical path)
1. Pins, imports, JS APIs (held packages interim)
2. Noir recompile (vendored lib)
3. **Hold** until the external packages publish, then swap them in and hand-pin the FPC artifact
4. Full sandbox smoke (31 steps incl. PrivateFPC) and browser e2e on a single-generation tree
5. Chain cascade, the one node constant, CSP, allowlist, a strongly corroborated reset baseline, the wallet-coupling check
6. A Codex pre-deploy review of the deploy-path diff
7. `live-intent build`, then the generation, faucet and FPC deploys (gated), smokes, calibrate, promote
8. Canaries, docs, and the min-age window closed

### File-level change map
| Area | Files |
|---|---|
| Pins | root `package.json` (`patchedDependencies`), `apps/tools/package.json`, `packages/bridge-core/package.json` (incl. `viem: npm:@aztec/viem@2.38.3`), `contracts/bridge/aztec/txe-server/{package.json,bun.lock}`, `bun.lock`, `bunfig.toml` (temporary) |
| Patches | `patches/@aztec-foundation%2Fnoir-{acvm_js,noirc_abi}@6.0.0-rc.1.patch` (same `exports` hunk). The four `@aztec%2F…` patches are deleted in phase 3. |
| Imports | about 125 TS files, via an explicit package-name mapping (below), committed alone |
| Build config | `apps/tools/vite.config.ts` dedupe, `tests/browser/test-wallet/vite.config.mts`, `tests/browser/node-json-imports.mjs`, `foundry.toml` path, `gen-remappings.ts` (the `resolvePackageAsset` package name only; the `@aztec/=` forge alias stays) |
| CI | `setup-aztec/action.yml`, `_bridge-contracts.yml` (pin reader, three Noir-tag readers), `_tools-e2e.yml` |
| Noir | four `Nargo.toml` (`aztec` and `compressed_string` → `aztec-labs-eng/aztec-nr`; `token` → `AztecProtocol/aztec-standards`; all `v6.0.0-rc.1`; content-hash lib → vendored path), the new vendored crate, `compile.sh`, `nargo-5.sh` renamed to `nargo.sh` (version from `AZTEC_HOME`), `run-txe-tests.sh`, both `target/*.json` |
| Node constant | new `TESTNET_NODE_URL` in bridge-core, the 15 literal sites, `network-targets.ts` (+ equality test), `deploy-config.ts`, both `.env.example`, SKILL.md probe |
| Chain identity | `chain-constants.ts` and the Branch B step 1 literal list. Mainnet literals stay. |
| CSP | the testnet `cspConnectSrc` adds the exact dRPC URL. `network-targets.test.ts` swaps the `.aztec-labs.com` hostname assertion for an exact-URL one. |
| L1 fixtures | `DeployFuelLive.s.sol`, `DeployFuelLive.fork.t.sol`. `MainnetFuel.fork.t.sol` stays. |
| Intent tooling | `live-intent.ts`: in phase 5, `OPERATIONAL_ALLOWLIST` gains `implementations-plan/aztec-v6/lessons/` and `NO_RESET_BASELINE` points at the hand-made bootstrap. At close-out, after all live operations, it points at this arc's archived `intent.json`. |
| Generated by the live arc | `testnet-bridge.json`, `deployments.json`, `deploy-journal/`, promotion receipt |
| Re-pinned by hand, tripwire-proved | `noir-artifact-classids.test.ts`, `hub-token.test.ts` (phase 2); `PRIVATE_FPC_ADDRESS`, `private-fpc-canonical.json`, `private-fuel.test.ts` (phases 3 and 5) |
| Wallet gate | `scripts/ci-cd/published-packages.test.ts` PEERS map; new `scripts/ci-cd/aztec-line.test.ts` single-generation guard |
| Docs | `UPDATE.md` (incl. step 2's `compare` now targeting `aztec-labs-eng/aztec-node`), `AGENTS.md`, `README.md`, `SECURITY.md`, package READMEs, SKILL.md (the smoke is 31 steps with a mandatory PrivateFPC, not "14 + optional") |

### Non-obvious mechanics
- **Scope rewrite.** The rewrite is an explicit, reviewed mapping of package names, never a prefix substitution:
  - `@aztec/(accounts|aztec\.js|constants|ethereum|foundation|kv-store|noir-contracts\.js|protocol-contracts|pxe|sqlite3mc-wasm|standard-contracts|stdlib|txe|wallet-sdk|wallets)(?=[/"'])` → `@aztec-labs/$1`
  - `@aztec/(bb\.js|noir-acvm_js|noir-noirc_abi|l1-artifacts)(?=[/"'])` → `@aztec-foundation/$1`

  It is applied with a PCRE-capable tool to `*.{ts,mts,mjs,tsx,vue,json}` (lockfiles excluded).
  - Forge aliases (`@aztec/=`, `@aztec-blob-lib/=`), Solidity `import "@aztec/core/…"`, `@aztec/viem`, the held-package PEERS strings and archived plans are untouched by construction.
  - `gen-remappings.ts`'s existing effective-remapping assertion and `forge build` prove the remap survived.
- **Reset baseline.** `live-intent build` refuses a reset by design, so the bootstrap baseline is hand-written. The dRPC endpoint is a third party, so every address is corroborated on Sepolia L1, not by `cast code` alone:
  - **Authenticate the registry first**, independently of the node, against upstream deployment evidence: Aztec's published v6 testnet addresses or the `aztec-labs-eng/aztec-node` network config, with the source URL and date recorded. Mutually consistent contracts named by the node prove nothing on their own.
  - Then follow the graph using the getters the v6 L1 sources actually expose:
    - registry: `getRollup(2914217885)` and `getCanonicalRollup()`, which must agree
    - rollup: `getVersion()`, `getFeeAssetPortal()`, `getFeeAsset()`
    - portal: `ROLLUP()`, `UNDERLYING()`, which must point back
  - The fee-asset handler has no getter on that graph. Authenticate it separately against the upstream evidence and its own `FEE_ASSET()`.
  - Every node claim must equal those reads.
  - Set `INTENT_SECOND_AZTEC_RPC` if any second v6 endpoint exists (none today; recorded).

  The evidence goes in `lessons/phase-5.md`, and the check is never loosened.
- **Salt-only protocol nullifier.** Two sends with the same origin and salt are mutually exclusive in v6. The risk is a JS retry path that re-sends a *prepared* tx request (claim retry loops, `relay-claim-testnet.ts`, the journal's resume paths): it now collides instead of landing twice. Phase 1 traces every retry path to confirm each attempt builds a fresh request (a fresh salt from aztec.js), and the sandbox smoke's retry flows plus the browser e2e journal-resume specs prove it. `message-nullifier.ts` (L1→L2 message nullifiers) is a distinct derivation; its vectors stay unless upstream moved the message-nullifier helper, which phase 1 checks against v6 aztec-nr.
- **ETH/FJ pool.** Compare `feeJuiceAddress` to the old manifest's `feeJuice.asset`. If it moved, re-seed in seed-only mode: dry-run first, then `--broadcast --slow`.

### Trade-offs and alternatives not taken
- **Vendor the content-hash lib (chosen) vs a git dep on aztec-node.** The aztec-node lib resolves `aztec` by a path inside that repo. Nargo keys crates by resolved source, so it becomes a second `aztec` crate, and `AztecAddress` from one is not the other's, even with an identical tree. The hub and keystone both pass `AztecAddress` into it. Vendoring 2971 bytes with provenance is smaller than fighting the graph. The keystone Noir vectors and `ContentHash.t.sol` prove parity.
- **Single PR (chosen) vs stacked arcs.** An SDK-only arc cannot pass `verify:deployments` or reach any v6 node without disabling a gate. Commits stay separable.
- **Competing outline B, a parallel `testnet-v6` target** that keeps the v5 testnet beside it until sunset. It is defensible for legacy continuity: two scopes could live in two bundles, but `apps/tools` source can't target both lines at once. Rejected by the owner's legacy decision.
- **Official host vs dRPC.** No `aztec-labs.com` v6 testnet host answers today.

## Security & Adversarial Considerations

- **Threat model.**
  - Supply chain: fresh rc publishes under brand-new scopes, the separately installed Aztec CLI, and mutable git tags.
  - Deploy integrity: a mis-derived FPC or hub address means unrecoverable Fee Juice, and a malicious RPC could plant a false reset baseline.
  - Key exposure: keyed runs execute repository code with the keys in memory.
  - CSP widening on the testnet build.
  - Retry semantics under the new protocol nullifier.
- **Supply chain.** There is no single-publisher rule. The expectation is per scope and recorded in `lessons/phase-1.md`:
  - `@aztec-labs/*` is published by `charlielye` without attestations, matching `@aztec/*@5.2.0`'s publisher. A different `_npmUser` on any package is a stop-and-surface.
  - `@aztec-foundation/*` is published from GitHub Actions with provenance, verified with `npm audit signatures` after install.
  - Every tarball's `dist.integrity` is checked against the lockfile.
  - Git deps are recorded by the commit SHA each `v6.0.0-rc.1` tag resolved to, in `lessons/phase-2.md` (tags are mutable).
  - The Aztec CLI install records its version and install log.
  - Min-age excludes list only exact names still under 7 days at install time: `aztec.js` rc.1 and `@aztec/viem` 2.38.3 already clear it. They are removed in the same PR and proven with `bun install --frozen-lockfile --force`.
  - `bun audit` stays clean. None of this is provenance on its own, and the plan does not pretend it is.
- **Keys.**
  - Deployer keys (`PRIVATE_KEY` = the pinned testnet L1 signer, `SEPOLIA_RPC_URL`, `BRIDGE_DEPLOYER_SECRET_TESTNET`, `DEPLOYER_SECRET_KEY`, `DEPLOYER_SALT`) reach one process per run via `env-exec request` approved with `op-remote`. Never a `.env` with values, never the transcript.
  - Keys are supplied only after the dependency tree and source are frozen and committed (the `live-intent build` snapshot), and after the Codex pre-deploy review (phase 6). This is because keyed runs avoid persistence, not hostile code on the same UID.
  - A missing key is surfaced, never created.
  - `PLAN_PINNED_L1_SIGNERS` pins the signer.
  - An independent per-broadcast-group spend tally is kept in lessons, because balance deltas can be masked by incoming ETH.
  - No CI secret is added.
- **Deploy integrity.**
  - The FPC descriptor and address are pinned **before** `live-intent build` (which snapshots them) and never after.
  - `check-fpc-version --mode predeploy` must be green before the FPC deploy, and `require-deployed` before any funding, canary or promotion.
  - Nonce-pinned factory prediction; nothing else signs from the deployer meanwhile.
  - `verify` runs before every group and at promotion.
  - Never promote over a partial landing.
  - The wallet's v6 `PRIVATE_FPC_ADDRESS` and node host must equal this repo's before the FPC is funded (phase 5 gate).
- **CSP.**
  - The testnet `connect-src` is exactly `https://lb.drpc.live/aztec-testnet/<key>`, a path-exact source, plus the token list. `*.aztec-labs.com` and `*.aztec.network` are removed, because the wallet uses the same dRPC URL (A1).
  - CSP stops path-matching after a redirect, so phase 5 asserts the endpoint answers without redirecting (`curl -sI` shows no `3xx`).
  - Mainnet CSP is unchanged (`'self' data: blob:`).
- **Public RPC key.** The testnet dRPC key ships in the client bundle. Per A3 it is separate from mainnet and may be public. Rotation is a one-constant change.
- **Smart-contract risks.**
  - The contracts are unchanged and recompiled.
  - Retry and replay under the salt-only protocol nullifier are covered above.
  - The re-pinned HandshakeRegistry means wallet handshakes are re-established; that is wallet-side.
  - Front-running `register_token` is unchanged.

## Assumptions

**Facts** (verified)
1. The v6 testnet node (`lb.drpc.live/aztec-testnet/…`) reports `nodeVersion 6.0.0-rc.1`, `rollupVersion 2914217885`, `l1ChainId 11155111`, FeeJuicePortal `0x5bb7523a…2d7f`. The pin is `TESTNET_ROLLUP_VERSION = 1821665230` (`chain-constants.ts:22`). This is a reset.
2. The mainnet node reports `5.2.0`, rollupVersion `4248422647`. The mainnet build makes no network calls (the MAINNET_TARGET CSP).
3. Every used `@aztec/*` package exists at `@aztec-labs/*@6.0.0-rc.1`, and bb.js, noir-acvm_js, noir-noirc_abi and l1-artifacts at `@aztec-foundation/*@6.0.0-rc.1`. The `latest` dist-tag of `@aztec-labs/aztec.js` is a nightly, so exact pins are mandatory. `aztec.js@6.0.0-rc.1` depends on `npm:@aztec/viem@2.38.3`.
4. `@aztec-foundation/noir-acvm_js@6.0.0-rc.1` has `module` and no `exports`, so the exports patch is still needed.
5. `noir-contracts.js@6.0.0-rc.1` ships SponsoredFPC but not FeeJuice. `aztec.js` exports `./protocol` (`FeeJuiceContract.withWallet`), and `protocol-contracts` exports `./fee-juice` (`FeeJuiceArtifact`).
6. `@aztec-foundation/l1-artifacts@6.0.0-rc.1` ships `l1-contracts/src`.
7. `aztec-labs-eng/aztec-nr`, `aztec-labs-eng/aztec-node` and `AztecProtocol/aztec-standards` carry tag `v6.0.0-rc.1`. The standards `token_contract` depends on `aztec-labs-eng/aztec-nr` `v6.0.0-rc.1`. The aztec-node content-hash lib depends on `aztec` by in-repo path.
8. None of these appear in the repo: `returnTypes`, `decodeFromAbi`, `outputs.globals`, `TxRequest`, `DomainSeparator`, `GasPrice`, `DelayedPublicMutable`, `MultiCallEntrypoint`, `HandshakeRegistry`, removed CLI commands, `ACVM_` (recon B search trail).
9. `private-fee-juice` has only 5.0.1 (peers `@aztec/*` 5.0.1). `@alejoamiras/nulo-wallet-crypto` and `@alejoamiras/nulo-wallet-sdk-schema-patch` are at 0.1.0, peering `@aztec/*` 5.2.0. `@alejoamiras/nulo-resolve-asset` has no Aztec peers (`published-packages.test.ts` PEERS).
10. `~/.aztec/versions/6.0.0-rc.1` is incomplete. `resolveToolchain` (`local-network.ts:268-280`) requires `bin/aztec-nargo`, `bin/aztec-anvil`, `node_modules/.bin/aztec`, `internal-bin/{forge,anvil}` and `bb`.
11. `sandbox/deploy.ts:56` deploys the PrivateFPC unconditionally, and the smoke has 31 steps.
12. `live-intent.ts:299-303` snapshots `PRIVATE_FPC_ADDRESS` and the descriptor's `artifactSha256` at build. `NO_RESET_BASELINE` (`:191`) points into `archive/aztec-5.0.0-stable/lessons/intent.json`.
13. 15 files in `packages`, `apps` and `scripts` hard-code `v5.testnet.rpc.aztec-labs.com`.
14. `gen-remappings.ts:29-31` emits the forge alias `@aztec/=` and `@aztec-blob-lib/=`. `_bridge-contracts.yml:166,216,250` read the Noir tag with an `aztec-packages/` regex.

**Inferences** (to verify in the named phase)
- I1 (phase 1): the mainnet-descriptor tests assert equality with the installed artifact and turn red on v6. Fix: explicit frozen-mainnet assertions.
- I3 (phase 2): the keystone and claim_secret DOM_SEP literals are unchanged in v6. The tripwires decide. A change is a Noir source change, not a test edit.
- I4 (phase 4): `aztec start --local-network` on 6.0.0-rc.1 keeps the flags `local-network.ts` passes.
- I5 (phase 6): the L1 Fee Juice asset moved with the reset, so the pool must be re-seeded. Probe first.
- I6 (phase 6): the committed Sepolia seed tokens still exist and sort below WETH.
- I7 (phase 3): `private-fee-juice@6.0.0-rc.1` keeps the artifact layout, and its digest changes.
- I8 (phase 1): every JS retry path builds a fresh tx request per attempt.

15. `@alejoamiras/private-fee-juice@6.0.0-rc.1` was published by GitHub Actions, with peers `@aztec-labs/{aztec.js,stdlib,protocol-contracts}@6.0.0-rc.1`. It ships `canonical-deployment.json` with `aztecVersion 6.0.0-rc.1`, salt `0x…01` and `expectedAddress 0x0b3bc795b5c077b57920d590ecc163af18705554abf7164cb0f8c52850943c08`. It is under the 7-day gate, so it needs an exact-name exclude. The three wallet packages are still at 0.1.0.

**Asks** — owner answers:
- A1: **Wallet v6 values.** The wallet uses the owner's dRPC testnet URL, and the FPC is the `private-fee-juice@6.0.0-rc.1` canonical deployment. So the testnet CSP carries only the exact dRPC URL, and `*.aztec-labs.com` / `*.aztec.network` are removed. Phase 3 pins `PRIVATE_FPC_ADDRESS` and the descriptor to the package's `canonical-deployment.json`, and `private-fuel.test.ts` asserts the equality, so the two can't drift. The salt is settled by A4.
- A2: **rc→final.** Deploy on rc.1 now. 6.0.0 final is a follow-up and likely a second generation.
- A3: **dRPC key.** It is a separate key from mainnet and may be public. No origin restriction is needed.
- A4: **FPC salt.** `0x…01`, the published descriptor's salt, confirmed by the owner. The deployer is zero. The expected address is `0x0b3bc795…3c08`.

## Phases

Rules for every gate:
- Every gate includes the fast layers.
- A gate is a list of commands **each run separately**. Each must exit 0, except the entries in that phase's **expected-red list**, which names exact test files. The gate compares the runner's failing-file set to that list, and any extra or missing failure fails the gate.
- `test:all` passes only on exit 0 unless an expected-red list applies.
- `AZTEC_HOME=~/.aztec/versions/6.0.0-rc.1` for every Noir command.

### Phase 0: Preconditions ✓
- `git fetch`. If the aprime-fidelity stack has merged, rebase onto `main`. Otherwise proceed, and rebase whenever it lands, before delivery at the latest.
- Run `aztec-up install 6.0.0-rc.1`, and record the CLI version and install log in lessons.
- Re-probe the node (Fact 1) and npm (Fact 9).

**Validation gate**
- Commands:
  ```
  bun install --frozen-lockfile
  bun run lint
  bun run typecheck:all
  bun run test:all
  ```
  Plus a toolchain check that each Fact 10 path exists and is executable.
- Pass criteria: all exit 0 (baseline).
- Layers: lint, typecheck, unit.

### Phase 1: JS line on the new scopes ✓
1. Pin every package to `@aztec-labs/*` or `@aztec-foundation/*` at exactly `6.0.0-rc.1`, set `aztec-standards` to `6.0.0-rc.1`, and set `viem` to `npm:@aztec/viem@2.38.3`.
   - Run the per-scope supply-chain checks, then add exact-name excludes only for packages under 7 days old.
   - The held packages stay as they are (interim, and never a basis for any rehearsal or deploy).
2. Run the scope rewrite (explicit mapping) and commit it alone.
3. Regenerate the exports patches under the new names and update `patchedDependencies`. Update the vite dedupe, the test-wallet config, `node-json-imports.mjs`, `foundry.toml`, `gen-remappings.ts`'s package name, the four pin readers and the three Noir-tag readers.
4. Move Fee Juice to the wrapper with the runtime address assertion.
5. Fix the remaining type errors. Resolve I1. Trace the retry paths (I8). Check the v6 aztec-nr message-nullifier helper against `message-nullifier.ts`.

**Validation gate**
- Commands, each run separately:
  ```
  bun run lint
  bun run typecheck:all
  bun run test:all
  bun run test:ci-gating
  bun audit
  npm audit signatures
  ```
  Also run `rg -n --pcre2 '@aztec/(?!viem|core/|governance/|=)' --glob '*.{ts,mts,mjs,tsx,vue,json}' --glob '!**/bun.lock' --glob '!implementations-plan/**' .`. Its hits must be exactly the temporary exceptions:
  - the 5.x `patchedDependencies` keys in root `package.json` (removed in phase 3)
  - `contracts/bridge/aztec/txe-server/package.json` (phase 2)
  - the PEERS strings in `published-packages.test.ts` (phase 3)

  After phase 3 the same scan must print nothing (`rg` exits 1 on no matches, which is the pass).
- **Typecheck expected-errors.** The held packages declare old-scope types (`private-fuel.ts` passes v6 `Fr`/`AztecAddress` into `private-fee-juice@5.0.1`'s constructors, and `Fr` has private members). So phase 1's typecheck may fail **only** in files that import `@alejoamiras/private-fee-juice`, `@alejoamiras/nulo-wallet-crypto` or `@alejoamiras/nulo-wallet-sdk-schema-patch`, and their direct importers. They are listed by file in `lessons/phase-1.md` before the rewrite. **No casts or `@ts-expect-error` to manufacture green**; phase 3 must bring typecheck to 0 errors.
- Expected-red test list: `published-packages.test.ts`, `private-fuel.test.ts`, `noir-artifact-classids.test.ts`, `hub-token.test.ts`, and the deployment/manifest re-derivation tests named in `lessons/phase-1.md` at the start of the phase.
- Layers: lint, typecheck, unit.

### Phase 2: Noir line ✓
1. Create the vendored content-hash crate. Move the Nargo deps to `v6.0.0-rc.1`, and record each tag's commit SHA.
2. `compile.sh` defaults to 6.0.0-rc.1. `nargo-5.sh` becomes `nargo.sh`. The txe-server moves to `@aztec-labs/txe@6.0.0-rc.1` with its lockfile, and `run-txe-tests.sh` paths are fixed.
3. Recompile and commit `target/*.json`. Resolve I3.
4. Re-pin `noir-artifact-classids.test.ts` and `hub-token.test.ts` to the new values. This is a conscious re-pin for a new generation.

**Validation gate**
- Commands, each run separately:
  ```
  bash contracts/bridge/aztec/scripts/compile.sh --check token_bridge_hub
  (cd contracts/bridge/aztec/keystone && "$AZTEC_HOME/bin/aztec-nargo" test --force)
  bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate token_bridge_hub
  bun packages/bridge-core/scripts/gen-remappings.ts
  (cd contracts/bridge/evm && forge build)
  (cd contracts/bridge/evm && forge test --no-match-contract Fork)
  (cd contracts/bridge/evm && forge snapshot --match-test test_gas_ --no-match-contract Fork --check --tolerance 2)
  ```
  Plus the halmos step exactly as `_bridge-contracts.yml` runs it, `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh`, and the phase 1 commands.
- Pass criteria:
  - `compile.sh --check` reproduces the committed class id.
  - `ContentHash.t.sol` and the keystone content-hash vectors are green.
  - Expected-red list: phase 1's minus the two Noir pin tests.
- Layers: lint, typecheck, unit, contract suites + TXE.

### Phase 3: External packages (**blocking checkpoint**) ✓

> **Status:** ✓. The wallet packages published at 0.2.0 on the v6 line and are pinned; gate in `lessons/phase-3.md`.
1. Query each package separately (npm treats extra positional arguments as fields, not packages). Run `npm view @alejoamiras/private-fee-juice@6.0.0-rc.1 version peerDependencies --json`, then for each of the three wallet packages: `npm view @alejoamiras/<pkg> versions --json`, and `npm view @alejoamiras/<pkg>@<candidate> peerDependencies --json` on the exact candidate version.
2. **If any of them is unpublished on the v6 line:** log it in `lessons/phase-3.md`, report to the owner, and **hold**. Nothing from phase 4 onward runs on a split line.
3. When published:
   - Pin them exactly and update the PEERS map to the new scope.
   - Delete the 5.x patches and their `patchedDependencies` keys.
   - Hand-pin the FPC artifact: derive `PRIVATE_FPC_ADDRESS` with the A4 salt, and set the testnet descriptor's `aztecVersion`, `artifactSha256`, `expectedAddress` and `compatibleNodeVersions`. `private-fuel.test.ts` asserts that both the derived address and the salt equal the installed package's `canonical-deployment.json`. Identity pins wait for phase 5.
   - Resolve I7.

**Validation gate**
- Commands, each run separately: the phase 1 commands.
- A new committed guard, `scripts/ci-cd/aztec-line.test.ts`, runs under `test:ci-gating` and passes. It parses both lockfiles with `Bun.JSONC.parse`, the way `published-packages.test.ts` does, and fails on:
  - any resolved `@aztec/*` package other than `@aztec/viem`
  - any `@aztec-labs/*` or `@aztec-foundation/*` package not at the `@aztec-labs/aztec.js` pin, `aztec-standards` included

  It stays as the permanent single-generation guard.
- The unrestricted phase 1 scope scan prints nothing.
- Pass criteria: `typecheck:all` reports 0 errors. `private-fuel.test.ts` and `published-packages.test.ts` are green. The expected-red list is only the testnet identity, deployment and manifest tests that phases 5 and 6 regenerate.
- Layers: lint, typecheck, unit.

### Phase 4: Sandbox rehearsal and browser e2e (single-generation tree) ✓
> **Status:** ✓. The gate was re-run on the tree with the sandbox-reaper and wallet-store fixes. The smoke passed 31/31, the e2e 70/70 (`.vite` cleared), integration 35/35, and every run was reaped by owned pgid (`lessons/phase-4.md` § Gate re-run). I4 is resolved. The pre-existing anvil leak was root-caused and fixed.
1. Run `bun run --cwd packages/bridge-core deploy:sandbox --smoke` on the 6.0.0-rc.1 local network: all 31 steps, including the PrivateFPC and the real `register_*` publications. Resolve I4.
2. Clear `apps/tools/node_modules/.vite`, then run `bun run e2e:tools` (sharded).
3. Run `bun run --cwd packages/bridge-core test:integration`.

**Validation gate**
- Commands: the three above, each run separately.
- Pass criteria:
  - The smoke prints every step green and its calibration line.
  - The browser suite, including the journal-resume specs, and integration exit 0.
  - Every run is reaped by owned pgid.
- Layers: sandbox, e2e.

### Phase 5: Chain cascade, node constant, trust anchors ✓
1. Set `TESTNET_ROLLUP_VERSION = 2914217885` and recompute the wallet chain id. Classify every `rg 1821665230` hit (Branch B step 1), including the FPC descriptor identity pins.
2. Create `TESTNET_NODE_URL` and route all 15 literal sites through it. Add the CSP exact URL, the equality test, `deploy-config.ts`, both `.env.example` and the SKILL.md probe. Check that the endpoint does not redirect.
3. Update the L1 fork-fixture literals from the corroborated L1 reads.
4. Add `implementations-plan/aztec-v6/lessons/` to `OPERATIONAL_ALLOWLIST`. Write the reset baseline with the full corroboration (Non-obvious mechanics), re-point `NO_RESET_BASELINE`, and commit.
5. **Wallet coupling (A1, answered):** the wallet reports the dRPC URL, so the testnet CSP drops `*.aztec-labs.com` and `*.aztec.network`. `PRIVATE_FPC_ADDRESS` equals `private-fee-juice`'s `canonical-deployment.json` `expectedAddress`, asserted by test.

**Validation gate**
- Commands, each run separately:
  - the phase 1 commands
  - `(cd contracts/bridge/evm && forge test --no-match-contract Fork)`
  - `bun run build:tools && bun run --cwd apps/tools verify:build-target testnet`
  - the mainnet build and its `verify:build-target mainnet`, as `pr-quick.yml` runs them
  - `rg -n 'v5\.testnet\.rpc|1821665230' --glob '!implementations-plan/**'`, which must print nothing
- Pass criteria:
  - The expected-red list is only the deployment and manifest re-derivations that wait on phase 6.
  - The corroboration evidence is in `lessons/phase-5.md`.
  - A1 is confirmed in the transcript.
- Layers: lint, typecheck, unit, build.

### Phase 6: Pre-deploy review, then the live generation (keyed runs, authorized) ✓
> **Status:** ✓. The pre-deploy review converged in round 4, which the owner authorized. The generation went live through keyed runs on a fresh pinned signer (`0x7F42…6a9a`).
> - Tokens: USDC, USDT, EURC and GBPC. The PrivateFPC is deployed. The faucet record reproduced byte for byte.
> - `verify --candidate`, then `promote --bridge-only`. The old v5 manifest was retired first, because `assertZeroSeed` has no reset path.
> - Receipt committed; `testnet-bridge.json` equals the candidate (`345f68c0…c76f`).
> - The phase 1 commands pass with no expected-reds. Spend was 1.030 of 2.0 ETH, and the final verify is green (`lessons/phase-6.md`, `lessons/phase-7.md`).
1. **Pre-deploy Codex review.** Run `/codex high` over the phases 1–5 diff, focused on the deploy path (the FeeJuice swap, the node constant, the FPC pins, `live-intent` edits, the CSP), with the adversarial ask and the Post-implementation rules. Loop until clean (max 3 rounds) before any key is requested.
2. Then follow `bridge-generation` Branch B steps 3–9 in order:
   1. `live-intent.ts build`, then commit the intent.
   2. Check the seed tokens (I6).
   3. `deploy:generation deploy --dry-run`, then the live run.
   4. The faucet `deploy:testnet` in parallel, under its own key.
   5. `check-fpc-version --mode predeploy` → `deploy-private-fpc-testnet.ts` → `check-fpc-version --mode require-deployed`.
   6. The ETH/FJ pool per I5.
   7. `live-intent verify` before each group. The candidate smokes (`smoke-existing`, `smoke-swap-existing`, `fuel-testnet`), plus the registering sample on a third pre-created token.
   8. `calibrate`, with samples outside the repo.
   9. `verify --candidate`, then commit the intent, then `promote`.
   10. **Live window freeze.** From `build` until phase 7's final `live-intent verify`, change nothing outside `OPERATIONAL_ALLOWLIST`. That covers source, `live-intent.ts`, and also this `plan.md` (phase ✓ marks) and `index.md`. `assertTreeDiscipline` refuses them uncommitted, `assertNoSourceDrift` refuses them committed, and rebuilding the intent would reset its spend baseline. Record interim completion only in the allowlisted `lessons/`. Phases 6 and 7 get their ✓ marks after the final verify. The `NO_RESET_BASELINE` re-point waits for the close-out.
3. Every signing command is a keyed run, one signer at a time, with the spend tally kept.

**Validation gate**
- Commands: `live-intent.ts verify <intent> --candidate …` green, then `promote` writes its receipt.
- Pass criteria:
  - The receipt is committed, and `testnet-bridge.json` equals the promoted candidate.
  - The phase 1 commands pass with **no expected-reds**.
- Layers: live testnet.

### Phase 7: Canaries, docs, close the supply-chain window ✓
> **Status:** ✓. Every canary passed against the promoted manifest, the CSP preview check passed, and the owner's manual wallet check passed. The final verify is green. The docs carry the live arc's lessons. No exclude was ever committed, and the frozen install passes without one. The gate passes; `bun audit`'s red set equals the pre-bump baseline (`lessons/phase-7.md`).
1. Run the Branch B step 9 canaries against the promoted manifest:
   - `verify:l1 --strict`
   - `verify:deployments` both ways
   - `require-deployed`, then `PRIVATE_RUNS=1 fuel-testnet.ts`
   - `fee-juice-canary-testnet.ts`
   - `drip-canary-testnet.ts`
   - `TOKEN_LIST_LIVE=1` token-list test

   Then run the step 11 CSP check against the deployed preview with the v6 wallet.
2. **Final `live-intent.ts verify <intent>`** after the last live check. This ends the live window freeze. Only now mark phases 6 and 7 ✓ in this `plan.md`.
3. Update the docs (see the change map).
4. Remove the `bunfig.toml` excludes and prove the lockfile.

**Validation gate**
- Commands, each run separately:
  ```
  bun install --frozen-lockfile --force
  bun run audit:tools
  bun run test:all
  bun run test:ci-gating
  bun run lint:actions
  bun audit
  npm audit signatures
  ```
  Plus every canary.
- Pass criteria: all exit 0. Each canary's success line is quoted in `lessons/phase-7.md`.
- Layers: every layer.

## Decision ledger

| # | Decision | Chosen | Rejected and why | Source |
|---|---|---|---|---|
| D1 | Delivery | One PR | Stacked arcs: an SDK-only arc can't pass `verify:deployments` without disabling a gate | driver; both audits agree |
| D2 | Legacy v5 testnet | Cut over, follow-ups | Outline B (parallel target): `apps/tools` can't target both lines at once | owner; both audits agree |
| D3 | Content-hash lib | **Vendor** with provenance header | Git dep on aztec-node: its in-repo `aztec` path is a second crate, and `AztecAddress` is exchanged across it | **changed** after Codex #9 and Opus #6 |
| D4 | Testnet RPC | Exact-URL CSP plus a no-redirect check | `*.drpc.live`: every dRPC customer | driver; Codex #11 added the redirect check |
| D5 | Held external packages | Hold at phase 3 **before** any rehearsal | Rehearse on a split line: `instanceof` aborts, or a false green on a mixed bundle | **changed** (was hold after rehearsal) after Codex #1 and Opus #2 |
| D6 | Mainnet | Frozen placeholder, explicit frozen assertions | A 5.x island workspace | owner; Codex #5 on the assertion form |
| D7 | FPC pins | Hand-pinned in phases 3 and 5, before `live-intent build` | Re-pin after promote: `build` snapshots them and `verify` hard-stops on drift | **new**, from Codex #2 and Opus #1 |
| D8 | Node URL | One `TESTNET_NODE_URL` constant | Paste the dRPC URL into 15 files | **new**, from Opus #3 |
| D9 | FeeJuice | `withWallet` wrapper plus a runtime node-address assertion | Artifact for uniform typing; a fixture-only assertion | **changed** after Codex #10 and Opus |
| D10 | Scope rewrite | Explicit package-name mapping | Prefix `sed`: breaks the forge alias `@aztec/=` | **changed** after Codex #3 and Opus #5 |
| D11 | Supply-chain check | Per-scope publisher expectations, `npm audit signatures`, tag SHAs | "Any publisher differs = stop": misfires on legitimate packages | **changed** after Codex #6 and Opus #12 |
| D12 | Reset baseline | Full L1 cross-reads plus upstream cross-check | `cast code` presence only | **changed** after Codex #7 and Opus #8. This hardens beyond the runbook, and SKILL.md is updated. |
| D13 | Pre-deploy review | Codex pass before any key | Review only after deploy | **new**, from Opus #9 |
| D15 | Reset corroboration | Registry authenticated upstream, then the real v6 getters | Node-named, self-consistent graph; nonexistent getters | **changed** after the final pass (finding 1) |
| D16 | Held-package typecheck | Exact expected-error file set in phase 1, 0 errors from phase 3 | Casts to force an interim green | **new**, from the final pass (finding 2) |
| D17 | Baseline re-point | At close-out, after live ops | Right after promote: trips `assertNoSourceDrift` before phase 7's canaries | **changed** after the final pass (finding 6) |
| D14 | Gates | Commands run separately; expected-reds as exact failing-file sets | `&&` chains with loose "named reds" | **changed** after Codex #4 and Opus #7 |

## Audit verdicts

### Round 1, Codex (GPT-6 Astra, high)

**Verdict:** `reject (with blocking findings: rehearsal depends on unpublished packages, PrivateFPC is re-pinned after deployment, and several validation gates cannot establish the claimed pass)`.

All findings were verified against the repo and adopted:
1. Rehearsal on a split line → D5; the smoke is 31 steps.
2. FPC order → D7.
3. The rewrite breaks the forge alias → D10.
4. Invalid gates (the lookahead `rg`, `verify:build-target` without a build, a bare `aztec-nargo`, `&&` chains, missing halmos and gas snapshot) → D14 and the phase gates.
5. F9 overstated, the I1 wording, the CLI path → Facts 9 and 10, and I1.
6. The publisher rule → D11.
7. Baseline trust → D12.
8. Nullifier migration → Non-obvious mechanics, I8.
9. D3 → vendor.
10. FeeJuice → D9.
11. Asks were hidden → A1–A3. Keyed-run hostile-code and spend-tally points are in Security.

Rejected: none.

### Round 1, Opus 5.5

**Verdict:** `conditional approve (with conditions: fix findings 1–4 in the plan and re-gate before any keyed run; findings 5–10 before implementation starts)`.

Adopted:
1. FPC re-pin → D7.
2. Split-line rehearsal → D5, and e2e moved after the swap.
3. 15 files carry the v5 URL → D8.
4. `OPERATIONAL_ALLOWLIST`, and `NO_RESET_BASELINE` across the archive move → phase 5 and phase 6 step 10, plus the close-out.
5. Rewrite and gate scope → D10.
6. Vendor → D3.
7. Expected-reds → D14.
8. Baseline → D12.
9. Pre-deploy review → D13.
10. Wallet coupling earlier → A1 in the phase 5 gate.
11. Toolchain → Fact 10, phase 0, `$AZTEC_HOME` nargo.
12. `rg -P`, the CI Noir-tag regexes, publisher per scope → phases 1 and 3, the key interfaces, D11.

The assumption attack was also adopted: the F9 correction, exact pins because of the nightly `latest`, excludes only for young packages, retry paths → I8, Asks A1–A3, the UPDATE.md compare repo, and the registering calibration sample.

Rejected: none.

### Final fresh-context Codex pass (new session, full ledger)

**Verdict:** `reject (with blocking findings: reset corroboration calls nonexistent getters, the interim dependency tree cannot satisfy typecheck, and post-promotion edits invalidate the intent before canaries)`.

All findings were verified (`private-fuel.ts:14,194`; `live-intent.ts:355,562`) and adopted:
1. Getters → D15.
2. Typecheck on a held tree → D16.
3. The scope scan's temporary exceptions → phase 1.
4. The lockfile regex missed `_` and versions → the committed `aztec-line.test.ts` guard.
5. The `npm view` brace expansion → phase 3 step 1.
6. The baseline re-point → D17.
7. A3 now covers the preview origin.

Rejected: none.

### Final pass, re-review of the fixes (same session, resumed)

**Verdict:** `conditional approve (with conditions: reconcile phase-status updates and final verification with the source freeze)`.

Adopted: phase 6 step 10 now covers the live window freeze (no `plan.md`/`index.md` edits, interim status only in `lessons/`), and phase 7 step 2 adds an explicit final `live-intent verify` before the docs and the ✓ marks. Codex confirmed the other six fixes landed correctly. It noted that the lockfile guard is approved as designed, not yet implemented, which is expected at plan stage.

## Post-implementation

Run by the implementing session after phase 7 is green. `code_review` is `off`, so there is no `/code-review` step.

1. **Codex audit** (`/codex high`, GPT-6 Astra). Send:
   - the net diff from the rebased plan baseline, excluding the generated `target/*.json`, lockfiles and the deploy journal (listed by name)
   - a note that phase 6's pre-deploy review already covered the deploy path
   - this `plan.md` with its decision ledger
   - the adversarial ask: *"What could go wrong? What would an attacker target? What are we trusting that we shouldn't? Where are the supply-chain / crypto / least-privilege weaknesses?"*
   - the two rules below, verbatim
2. **Iterative fix loop.**
   - Verify Codex's factual claims against the repo first.
   - Apply the accepted fixes, commit, and log the round in `lessons/phase-7.md`.
   - **Resume the same Codex session** with the fix diff for a re-review.
   - Repeat until a round yields no new material findings. Rejected nitpicks don't count.
   - Still producing material findings after 3 rounds: stop and surface to the owner.
   - A fix that would change deployed state is surfaced, never applied in the loop.
3. **Delivery** per § Delivery. This is the first time a PR is opened.
4. **Close-out**, as the PR's final commits:
   - Write `## Outcome` directly after this front matter: status, what shipped, what was dropped, the dRPC key note, and "the `/goal` and `/loop` seeds below are retired".
   - Promote the generalizable gotchas into `implementations-plan/lessons.md`. Stay under 8 KiB, deduplicate, and retire superseded entries.
   - Add follow-ups to `implementations-plan/follow-ups.md`:
     - the mainnet ops scripts and mainnet descriptors are stale until Alpha upgrades
     - dropped v5 testnet records
     - the new `tokens[].l2Token` list for the wallet repo
     - 6.0.0 final (a second generation, per A2)
   - After every live operation has finished: `git mv implementations-plan/aztec-v6 implementations-plan/archive/aztec-v6` in its own commit. Then, in the next commit, point `NO_RESET_BASELINE` at `implementations-plan/archive/aztec-v6/lessons/intent.json` (this arc's `build` output, not the hand-made bootstrap), drop this arc's `OPERATIONAL_ALLOWLIST` entry, and repair every `git grep -n aztec-v6` link.
   - Move the `index.md` line to `archive/index.md`.
   - Report, then stop. Merging is the owner's call.

**The no-over-engineering rule** (verbatim in every post-impl Codex prompt): *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**The comment-quality rule** (verbatim in every post-impl Codex prompt): *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

## Delivery

| Arc | Phases | Stacks on | `/code-review` |
|---|---|---|---|
| the task branch — "feat!: move to Aztec 6.0.0-rc.1 and a new testnet generation" | 0–7, then the close-out commits | `main` | off |

This is a single-arc plan: one branch, one PR, `gh pr create`, and no stack.
- Push the branch for checkpointing, but open no PR until the Codex loop converges.
- After `gh pr create`, add the `e2e:tools` label, never at creation.
- Check `mergeable` if CI doesn't appear.
- Watch with `gh pr checks --watch` until `quality-status`, `tools-e2e-status` and `bridge-contracts-status` are green.

## Seeds

_Final, approved._

Recommended, `/goal`:
```
/goal All phases 0–7 marked ✓ in implementations-plan/aztec-v6/plan.md, each ✓ backed by that phase's validation gate (commands run separately, expected-red sets matched exactly) reported passing in the transcript, and for each phase `LESSONS_FILE=implementations-plan/aztec-v6/lessons/phase-N.md` printed — OR phase 3 holding with the npm output quoted and "blocked: waiting on <pkgs>" reported to the owner and nothing past phase 2 run; the phase 6 pre-deploy Codex review converged before any keyed run; /code-review NOT run (code_review: off); the post-implementation Codex loop converged, evidenced by a resumed Codex pass reporting no new material findings quoted in the transcript; one PR exists (`gh pr view` in the transcript), created only after convergence, whose final commits include the archive move (`git show --stat` in the transcript); `bun run test:all` and `bun run lint` exit 0 in the transcript; nothing merged.
```

Alternative, `/loop`:
```
/loop 15m Drive implementations-plan/aztec-v6 forward. Never idle waiting for my input. Each firing:
1. Reality check: read implementations-plan/aztec-v6/plan.md (incl. Outcome & Quality Bar) and lessons/ — authoritative, not the chat. Path gone? `git fetch -q origin && git cat-file -e main:implementations-plan/archive/aztec-v6/plan.md` → merged: STOP. Else delivered, awaiting merge: babysit CI only, STOP when green. A live plan.md with `## Outcome` = interrupted close-out: finish it. Rebuild the task list from plan.md if empty; `git status`; `git log --oneline -5`; PR open? `gh pr view --json statusCheckRollup`.
2. CI in flight: `gh run watch <id>` up to 10 min; stuck → inspect logs, log as blocked.
3. No task in hand: take the next pending step; after each meaningful edit run `bun run lint` + the touched package's tests; commit, push the branch (no PR yet).
4. Phase 3 finds a package unpublished: log it, tell me, re-check npm each firing; run nothing past phase 2.
5. Stuck or facing a decision: `/codex high` back-and-forth until a defensible call, then act; log consult + verdict in lessons/phase-N.md. Hard limits: never merge, never touch mainnet, never loosen live-intent or FPC checks, never create or print a secret (keyed runs via env-exec only), no keyed run before the phase 6 pre-deploy review converges, never expand scope beyond plan.md.
6. Same step failed 5 times: stop, reassess with codex.
7. Phase green = its plan.md gate passes: paste the result, mark ✓, write lessons, print LESSONS_FILE=…. Exception: from `live-intent build` until phase 7's final verify, touch nothing outside the allowlisted lessons/ (no plan.md ✓ marks); mark phases 6 and 7 after that verify.
8. All ✓: the Codex loop per plan.md § Post-implementation (verbatim rules, resume until clean, stop at 3 rounds) → `gh pr create` → label e2e:tools → close-out commits → push → `gh pr checks --watch` → wrap-up report explaining every contentious Codex decision plainly. Stop; merging is my call.
```
