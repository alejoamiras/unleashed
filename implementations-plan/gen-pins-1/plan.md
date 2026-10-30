---
plan: gen-pins-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
trunk: main
base: a111e8a
quality_bar: production (the bridge moves real funds on mainnet)
hardening: not scheduled
---

## Outcome

Delivered by arc a1 in one pull request (Delivers ask36).

- `contracts/bridge/generations/<network>/` holds each live generation's record and its kept artifacts: testnet's
  four L1 contracts and hub, built at the merge base `b8c2289` and checked on chain on two keyless RPCs and the node;
  mainnet a placeholder with no contracts.
- The SDK selects the record by chain (`codeOf`), binds it to the bundled manifest in `parseNetwork`, checks deployed
  code against its pins and the hub's class against its class id, and loads the hub artifact the generation deployed
  (`hubArtifact(net)`); a sandbox checks against this release's builds, and any other chain is refused.
- The app loads the testnet hub artifact on demand, which drops 2.57 MB from the testnet page's load set.
- The tooling writes and checks records (`generation-record.ts`), carries a live entry through promotion only
  unchanged, promotes the record before its manifest, and verifies a candidate against its record (`verify-l1`,
  `live-intent`). CI checks the testnet record and a compatibility gate holds every SDK and app call to the live code.
- Codex converged in three rounds (round 3: approve); an Opus review ran alongside round 1.

Known limits: #90 (D6, the SDK's off-chain math under an unchanged interface).
Open items: none.

# gen-pins-1: a committed record of the code each bridge generation runs

ask36: Each deployed bridge generation keeps a committed record of the code it runs: EVM runtime code hashes and Aztec contract class ids, taken from the deployed artifacts. The app and the SDK check a live generation against that record, not against pins rebuilt from the current contract sources. A contract source change on main then leaves the running testnet and mainnet generations working until a new generation is deployed and promoted, and the record stays a reviewed, committed trust root.

**UI impact:** none. ask36 — "Each deployed bridge generation keeps a committed record of the code it runs … the record stays a reviewed, committed trust root." No visible change. No screen, copy or row changes.

**Issues:** none. **Asks:** ask36 → arc a1.

## Outcome & Quality Bar

- **For whom:**
  1. A testnet app user on the day a contract source change merges. Workers Builds deploys `main` on every merge, so HEAD's app and SDK meet the old generation's bytecode.
  2. The owner, who promotes a generation (a keyed release step) and reviews its record in that PR, and who runs the live canaries.
  3. An integrator who passes `TESTNET_MANIFEST` to `parseNetwork`.
- **Excellent looks like:**
  1. A contract source edit on `main` leaves `parseNetwork(TESTNET_MANIFEST)`, the app's sends, claims and exits, and the live canaries working. A unit test proves it with a simulated edit.
  2. The record is one small JSON file per network, beside the artifacts it was taken from. CI proves on every run that each pin and class id derives from them, that the masks are solc-shaped, and that each bundled manifest binds its record.
  3. A live chain is never checked against HEAD's pins. When its record is missing or names other addresses, the SDK refuses with a message that names the mismatch.
  4. HEAD's SDK and app calls (ABIs, events, errors, hub functions) are checked on every unit run against the frozen artifacts.
- **Good enough:** semantic drift under an unchanged interface is a recorded known limit (D6). Mainnet's record is the empty placeholder until its fuel route is promoted.

## Architecture & Implementation

### Terms

- **Live record**: `contracts/bridge/generations/<network>/record.json`, the promoted generation's record.
- **Candidate record**: `contracts/bridge/generations/<network>.candidate/record.json`, written in a deploy arc beside the candidate manifest.
- **Kept artifacts**: the deployed artifacts next to a record.
  - `evm/<C>.sol/<C>.json` is forge's layout, so `buildPin(contract, dir)` reads it unchanged. It keeps `abi`, `bytecode` and `deployedBytecode` (`object`, `immutableReferences`). `metadata`/`rawMetadata` are dropped: they embed compiler input.
  - `aztec/TokenBridgeHub.json` is the exact Noir artifact.
- **HEAD pins**: what the sources at HEAD build: `packages/sdk/src/protocol/code-pins.json` and the hub target `contracts/bridge/aztec/token_bridge_hub/target/*.json`. The brief calls this the "candidate record for sources at HEAD". The plan keeps "candidate" for the deploy arc's record.

### Record shape (`schema: 1`, zod `.strict()`, deep-frozen)

```jsonc
{
  "schema": 1, "network": "testnet", "l1ChainId": 11155111,
  "evm": {   // exactly the manifest's pinned contracts; {} for a placeholder
    "DepositRouter": { "address": "0x…", "artifactSha256": "…", "pin": CodePin,
                       "build": { "commit": "<40-hex>", "tag": null } },
    "PortalFactory": {…}, "TokenPortalImpl": {…}, "TestnetFuelSwapper": {…}   // FuelOnlyGate on a fuel route
  },
  "aztec": { "TokenBridgeHub": { "address": "0x…", "classId": "0x…", "artifactSha256": "…", "build": {…} } }
  // "aztec" present exactly when the manifest has a bridge
}
```

- `pin` is the existing `CodePin`. The SDK checks code without loading bytecode. CI holds `pin === pinOfBuild(kept artifact)` and holds the masks to solc's shape: 32-byte immutable spans, each at a `PUSH32` operand, non-overlapping, and a CBOR trailer of at most 64 bytes (53 today).
- `build` lives on each entry and is carried byte for byte with it (D3). The Token class stays the manifest's `tokenClassId`, from the pinned npm package. A standards bump is still a new generation (`UPDATE.md`).
- Kept runtimes equal the deployment only under the mask (immutables and the metadata trailer). An exact redeploy also needs the constructor arguments (manifest, journal) and the toolchain at `build.commit`.

### Selection and checks (SDK)

- New `packages/sdk/src/protocol/generation-record.ts`: the schema, the parser, `assertRecordBinds`, the integrity helper, `LIVE_RECORDS` (static imports of `generations/testnet/record.json` and `generations/mainnet/record.json`), and `codeOf(m)`. `codeOf` returns `{ pins, record?, hubArtifact(): Promise<ContractArtifact> }`. Each artifact sits behind a TS wrapper module (as `artifacts.ts` does), so `stage.ts` rewrites it and Node gets the JSON import attribute.
- Rule, keyed by `m.l1ChainId` (D4):
  - A bundled manifest's chain (1, 11155111) uses its live record.
  - `SANDBOX_LIFI_CHAIN_IDS` (31337, 31338) use HEAD pins and the hub target. This is the exemption route-auth-1 uses.
  - Any other chain is refused (`invalid-network`, "no committed record for chain N").
- `assertRecordBinds(record, m)` requires the same `network` and `l1ChainId`. The set of pinned contracts the manifest names (router, factory or gate, implementation, swapper when listed) equals the record's, address for address. A hub is present exactly when `m.bridge` is, at the same address. `parseNetwork` runs it before `networkBindings`.
- `trust-roots.ts`: `codeBindings` and `networkBindings` take the pins as a parameter. `CODE_PINS` stays the HEAD pins export.
- Hub artifact:
  - `deriveManifestHub(b, artifact)`, `hubAt(wallet, hub, artifact)` and `hubBindingAt(node, hub, erc20, artifact)` take it. The `token_of` slot comes from the selected artifact.
  - `parseNetwork` loads `codeOf(m).hubArtifact()` only when `m.bridge` is set. It checks the derived instance's class against the record's `classId`, then stores the artifact in a module `WeakMap<Network, ContractArtifact>`, as `verified` does. The public `Network` type does not change.
  - Published `hubArtifact()` becomes `hubArtifact(net)` (D8). `@unleashed/sdk/artifacts` keeps the HEAD target for HEAD-deploying tools.

### Writer, promotion, verification (bridge-core)

- New `packages/bridge-core/scripts/generation-paths.ts`:
  - The per-network table (candidate and live manifest and record paths), which `live-intent.ts` imports in place of its own `NETWORKS` paths.
  - Two separate lookups. `recordFor(m)` returns the record that binds `m`, read from the working tree: the candidate directory for a candidate manifest, the live one for the live manifest. `liveBaseline(network, rev)` returns the live directory as committed at git `rev`, and nothing else.
  - `codeFor(m)`: `recordFor(m)` with its hub artifact. A sandbox chain gets HEAD pins; a live chain that binds no record is refused.
  - `BUILD_INPUTS`: the D3 input list, one constant.
- New `packages/bridge-core/scripts/generation-record.ts`:
  - `write <network>` reads the candidate manifest and writes `<network>.candidate/`.
    - An entry whose address is in `liveBaseline(network, merge-base HEAD origin/main)` is carried byte for byte, `build` included.
    - A new address takes its trimmed artifact from `contracts/bridge/evm/out`, the build the conductor deployed. A new hub is copied from the hub target with its class id.
    - `build` follows D3.
  - `write <network> --first` writes the live directory from the live manifest. It refuses when a live record exists (bootstrap only).
  - `check <network> [--candidate] [--rpc <url>]… [--node <url>] [--build-out <dir>]`:
    - always: integrity, mask shape and binding;
    - `--rpc`: deployed code against the pins on each RPC;
    - `--node`: the hub instance class against `classId`;
    - `--build-out`: per entry, "equals this build" or "differs: rebuild at `build.commit`".

    All reads are keyless.
- `live-intent.ts`:
  - `OPERATIONAL_ALLOWLIST` gains the four record directories.
  - `verify --candidate`:
    - records `recordSha256` (the candidate `record.json`, whose digests cover its files);
    - runs integrity, mask shape and `assertRecordBinds`;
    - runs the carry rule against `liveBaseline(network, intent.source.commit)`, as `assertFuelRouteScope` reads the manifest. The candidate itself comes from the digest-checked working-tree buffers: it does not exist at that commit. An entry at a live address must be identical to the live entry.
  - `candidateOf`/`assertFaucetCandidateShape` (`parseManifestV2Strict(raw, artifact)`) and `reportHubBindings` derive with the candidate record's hub artifact.
  - `promote`:
    - `lstat`s the directories and files, reads the candidate directory once and re-checks its digest;
    - writes the record files first and the manifest last, each atomically;
    - deletes only names from the closed file set: `record.json`, `evm/<the five>.sol/<…>.json`, `aztec/TokenBridgeHub.json`;
    - `verifyWritten` re-runs integrity and the binding on the live pair. A re-run after a partial write converges.
  - The receipt gains `recordSha256`.
- `verify-l1.ts`: `verifyL1Manifest(m, rpc, { strict, record?, baseline? })`.
  - With a record: deployed code against its pins. `--strict` adds integrity, and "fresh build pin = record pin" for each entry absent from `baseline`.
  - The CLI loads `record` with `recordFor(m)` and `baseline` with `liveBaseline(network, "HEAD")`. `live-intent` passes the candidate buffers and `liveBaseline(network, intent.source.commit)`.
  - With no record: the function itself refuses chains 1 and 11155111. It also refuses every chain outside `SANDBOX_LIFI_CHAIN_IDS`. On a sandbox (`router-only.integration.test.ts`) it runs as today: a fresh build plus `sameBuild` against the HEAD pins, which is what `parseNetwork` checks there.
- `script-l2.ts`: `deriveHubInstance` and `registerHub` take the artifact. The live canaries and smokes (`fuel-testnet`, `lifi-canary-l2`, `smoke-existing-testnet`, `smoke-fuel-existing-testnet`, `deposit-testnet`, `relay-claim-testnet`) and the router-only pre-create (`generation.ts`) pass `codeFor(manifest)`'s artifact. A new hub's deploy keeps the hub target.
- `apps/tools`:
  - `verify-deployments.ts` derives with `codeFor`.
  - `bridge-generation.ts` exports a cached `hubArtifact()` from `codeOf(MANIFEST)`, used by `useWalletConnection`, `useSend`, `useHubExit` (whose `hubOf` awaits it) and `hub-binding.ts`.
- CI: the contracts job (`_bridge-contracts.yml`, step "ABI and code pins") adds `generation-record.ts check testnet --build-out contracts/bridge/evm/out`, and fails only on integrity, mask or binding errors. In this PR it proves every bootstrap entry equals the fresh build.

### File map

- **Added:**
  - `contracts/bridge/generations/testnet/` (`record.json`, `evm/{DepositRouter,PortalFactory,TokenPortalImpl,TestnetFuelSwapper}.sol/*.json`, `aztec/TokenBridgeHub.json`, the same blob as the target today);
  - `contracts/bridge/generations/mainnet/record.json` (placeholder: `evm: {}`, no `aztec`);
  - in `packages/sdk/src/protocol/`: `generation-record.ts` (+ test), `abi-shape.ts` (extracted from the two ABI tests), `generation-compat.test.ts`;
  - `packages/bridge-core/scripts/generation-record.ts` (+ test) and `generation-paths.ts`.
- **Modified:**
  - SDK: `network.ts`, `execution/trust-roots.ts`, `protocol/manifest-v2.ts`, `execution/hub-l2.ts`, `bridge/{claim,token,index}.ts`, `scripts/stage.ts`, `scripts/pack-check.ts`, `test/consumer/consumer.ts`, the seven test files that mock `CODE_PINS`;
  - bridge-core: `verify-l1.ts`, `live-intent.ts`, `src/promotion.ts`, `script-l2.ts`, the six scripts above, `generation.ts` (+ tests);
  - apps/tools: `bridge-generation.ts`, `useWalletConnection.ts`, `useSend.ts`, `useHubExit.ts`, `hub-binding.ts`, `src/lib/capabilities.test.ts` (the app half of D5), `verify-deployments.ts`;
  - CI and docs: `_bridge-contracts.yml`, the runbook, `UPDATE.md`, `packages/sdk/README.md`.

### Decisions

- **D1 A separate record, not a manifest field.** It is an independent trust root, selected by chain and bound to the manifest's addresses, so a hostile manifest cannot bring its own pins. Both auditors agree.
- **D2 Location `contracts/bridge/generations/`**, not beside the manifest in `apps/tools/public/`: `public/` ships to Workers static assets. The record and its artifacts move in one promotion change.
- **D3 Each entry's `build.commit` is durable: an ancestor of `origin/main`, or the commit an existing owner tag named in `build.tag` peels to.**
  - Carried entries keep their `build`.
  - For a new entry, the writer uses `git merge-base HEAD origin/main` when every build input is unchanged between it and HEAD and clean in the working tree. This covers the bootstrap, router-only arcs and a new generation on an unchanged network.
  - `BUILD_INPUTS` is the list `setup-forge` digests for its cache key, minus `test/`:
    - `contracts/bridge/evm/{src,lifi-build,foundry.toml}`;
    - `.github/actions/setup-forge/action.yml` (the `forge install` pins and Foundry);
    - `bun.lock`;
    - `packages/bridge-core/scripts/gen-remappings.ts`;
    - for the hub, `contracts/bridge/aztec/` minus `txe-server`.
  - Otherwise (a reset arc whose Noir line moves in-arc), the writer refuses until `--tag <name>` names a tag peeled to HEAD, checked locally (`<tag>^{commit}`) and on `origin` (`git ls-remote origin refs/tags/<name>^{}`). The owner pushes it before the deploy: a release step the runbook adds.
  - The tag keeps the commit reachable. It authorizes nothing: the record is authorized by the promotion PR's review and its signed commits.
  - No branch commit and no null is ever written. Kept artifacts make the build replayable either way.
- **D4 Selection by chain, with no fallback for live chains** and no option, environment variable or argument that picks a record. Tests reach the seam through `vi.mock` only.
- **D5 The pairing check is a static compatibility gate, not a frozen-artifact sandbox suite.** For every live record:
  - an explicit contract → SDK ABI map is checked: `DepositRouter` → `DEPOSIT_ROUTER_ABI`; `PortalFactory` → `PORTAL_FACTORY_ABI`; `TokenPortalImpl` → `TOKEN_PORTAL_ABI` and `PORTAL_IMPL_CONSTANTS_ABI`; `TestnetFuelSwapper` → `FUEL_SWAPPER_QUOTE_ABI` and the `FEE_ASSET` getter. Every entry (functions, events, errors) must have an identical-shape entry in the kept artifact;
  - every hub function in the wallet grant must exist in the kept hub artifact (`functions` and `nonDispatchPublicFunctions`) with the same parameters, return type, kind and staticness as in HEAD's. The grant is the SDK's `HUB_SENDS`/`HUB_DRY_RUNS`, checked in the SDK, and the app's hub lists in `capabilities.ts`, checked in an app test. A wallet refuses any call outside its grant, so the grant names every call.

  Why the gate wins:
  - It runs in seconds in the unit job, with no forge build.
  - A frozen sandbox suite adds a boot and a deploy to a job at 43 of 45 minutes, and it duplicates the HEAD run whenever frozen equals HEAD (today, and after every promotion).
  - Token derivation drift is caught too: CI's `verify:deployments` derives the live manifest with the record's artifact.
  - Rule for later lanes (the runbook gets it): a PR that adds an SDK call the live generation lacks keeps a record-selected path until promotion. Otherwise the gate stays red.
- **D6 Known limit: what the SDK computes off-chain under an unchanged interface.** This covers the L1→L2 content hash, the register hash, amount math, and how the `token_of` value is packed (`hub-l2.ts:42-45`). File it as a closed `known-limit` issue at close-out. Reopen it when a contract change keeps the ABI but changes one of these. The escalation is then the frozen sandbox suite, through `vi.mock` of the selector in the integration suite.
- **D7 One arc.** If records landed before the promotion swap, a router-only promotion in between would move the manifest's router without its record. `parseNetwork` would then refuse testnet. The writer is also needed for the bootstrap.
- **D8 `hubArtifact(net)`** in `@unleashed/sdk/bridge`. A no-argument accessor cannot know the generation, and the SDK is 0.1.0. The README, `pack-check` and the consumer fixture move with it.

### Alternatives not taken

- **Outline B, the record inside the manifest** (`bridge.l1.code`, `fuelRoute.code`, `bridge.l2.hub.classId`). Promotion, the build digest and route-auth-1's freeze would cover it for free. Rejected (D1): the manifest would certify itself on sandbox chains, the published `ManifestV2` changes, the 3 MB artifact still needs a home and a promotion path, and the live manifest would need a hand edit.
- **Copy-on-diverge hub artifact.** Rejected: it needs conditional loading and a later process step, and the copy costs no git storage today.
- **Frozen artifacts as the sandbox default.** Rejected: CI would lose end-to-end runs of HEAD's contract sources.
- **Git tree ids instead of a commit in `build`** (Opus F4). Rejected in favour of D3: the guidance names the commit, and an owner tag keeps a reset's build commit durable.

## Security & Adversarial Considerations

- **Threat model.** The record says which code the SDK sends funds through on a live chain. The attackers:
  - a contributor or compromised account that lands a PR;
  - a hostile manifest given to `parseNetwork`;
  - a lying RPC;
  - a test or sandbox path that leaks into production selection.
- **A swapped or forged record.** It needs a reviewed, signed PR to `main`: the same capability as editing the SDK to skip the check. Review is the boundary, and the plan makes it mechanical:
  - CI holds every pin and class id to the kept artifacts, the masks to solc's shape, the digests to the files, and the addresses to the bundled manifest.
  - CI's `check --build-out` proves the entries that equal HEAD's build. A reviewer reproduces the rest at `build.commit`.
  - At promotion, `verify-l1 --strict` holds each entry deployed in the arc to a fresh build and every entry to the chain. The carry rule reads the live record at the intent's build commit, never the allowlisted working tree. `verify --candidate` digest-pins the candidate record, and `promote` refuses changed bytes.
  - A record edit outside `promote` is a protocol change, reviewed as one (AGENTS.md § Security).
- **A promoted manifest that disagrees with its record.** `assertRecordBinds` refuses in `parseNetwork`, so nothing is sent. CI's binding test goes red, and `live-intent` refuses at `verify --candidate` and `promote`.
- **A lying RPC.**
  - On a live chain the manifest (route-auth-1) and the record are both bundled and reviewed. Code at an address is immutable, so after promotion a lying RPC can fail the check (a denial of service). It cannot make the SDK send to an address the frozen manifest does not name. The app reads chain facts through the build's pinned RPCs.
  - The trust boundary is promotion. `verifyL1Manifest` reads one RPC, so a compromised promotion RPC could vouch for a candidate.
  - The runbook therefore adds `generation-record.ts check <network> --candidate --rpc <PublicNode> --rpc <Tenderly gateway> --node https://aztec-testnet.drpc.org` before `verify --candidate`. It is keyless and reuses the planned operation. This PR's bootstrap runs the same check.
- **A sandbox or test path that weakens the live check.**
  - HEAD pins apply only to `SANDBOX_LIFI_CHAIN_IDS`. A live chain without a record is refused: a never-happens test, with a success control.
  - No runtime input selects a record.
  - The sandbox keeps HEAD pins, so e2e and integration still prove "deployed = HEAD build", and `verify-l1` keeps its fresh-build path there.
  - Synthetic pins exist only in `vi.mock`.
- **Least privilege.** The lane signs and deploys nothing. Live reads are keyless. No workflow permission changes: the CI step reuses the job's `contents: read`.
- **Cryptography.** viem `keccak256` (2.57.1, exact), Node `crypto` sha256, `@aztec-labs/aztec.js` 6.0.0 class ids. Nothing new.
- **Supply chain.** No new dependency. The kept EVM artifacts drop compiler metadata, and the absolute-path guard runs on them.
- **Domain risks.** Replay, reorg and pausing are unchanged. The Permit2 witness stays checked on chain.

## Assumptions

**Facts** (at `a111e8a`; traces in `recon.md`):
1. `parseNetwork` checks code through `codeBindings` against `CODE_PINS` (`trust-roots.ts:161-170`, `network.ts:121-127`).
2. The HEAD target serves the hub everywhere today:
   - derivation: `manifest-v2.ts:312-322`, `script-l2.ts:78`;
   - calls: `hub-l2.ts:19-20`;
   - the storage slot: `hub-l2.ts:32`;
   - promotion checks: `live-intent.ts:852,957`, `promotion.ts:15`.
3. Live testnet code equals today's pins on two RPCs. The live hub's class is the HEAD target's, and that file's sha256 equals the archived 6.0.0 intent's.
4. The sandbox, the e2e app and integration deploy HEAD and pass `parseNetwork` on 31337 with no code-pin exemption.
5. `code-pins.test.ts` skips without `out/`. The contracts job builds and guards the skip.
6. Mainnet has no deployed bridge contract.
7. `promote` (`live-intent.ts:1177-1225`) writes the candidate bytes `readPromotionBytes` (`:1094`) pinned at `verify --candidate`.
8. The hub functions called are the grant lists (`packages/sdk/src/capabilities.ts:26-27`, `apps/tools/src/lib/capabilities.ts:124-140`).
9. Every immutable span in today's pins is 32 bytes at a `PUSH32` operand of the live code (18, 9, 17 and 8 spans), and every trailer is 53 bytes.

**Inferences:**
1. route-auth-1 lands as briefed. D4 holds on its own either way, and the implementer re-reads `network.ts` after merging `origin/main`.
2. Wrapper modules with dynamic `import()` keep a live build to one fetched hub chunk. The dist still emits both, and the npm tarball carries two 3 MB copies. Phase 3 measures it.

**Asks** (no owner ask; technical calls settled by the panel): D2 location, D3 provenance, D5 gate, D8 signature.

## Phases (arc a1)

### Phase 1: the record and the writer
1. Add SDK `generation-record.ts` (schema, parser, binding, integrity, mask shape) and bridge-core `generation-paths.ts` and `generation-record.ts`.
2. Install the forge libraries with the README's pinned `forge install … --no-git` lines (`lessons.md`). Run `bun packages/bridge-core/scripts/gen-remappings.ts`, then `forge build`.
3. Run `write testnet --first`, then `check testnet --rpc https://ethereum-sepolia-rpc.publicnode.com --rpc https://sepolia.gateway.tenderly.co --node https://aztec-testnet.drpc.org --build-out contracts/bridge/evm/out`.
4. Commit `mainnet/record.json`. Log the output in `lessons/phase-1.md`.
5. Add T1: every record parses, is intact and solc-shaped, and every bundled manifest binds its record. Add the writer's tests: carry with `build`, the D3 rule and its tag refusal, `--first` over a live record.

**Validation gate:** `bun run lint && bun run typecheck:all && bun run --cwd packages/sdk test && bun run --cwd packages/bridge-core test`. The live `check` reports every entry equal on both RPCs, the node and the build. Layers: lint, typecheck, unit, live read-only.

### Phase 2: the SDK reads the record
1. Add `codeOf`, the binding in `parseNetwork`, the pins parameter, the artifact parameters, the `WeakMap`, `hubArtifact(net)`, the stage ASSETS, `pack-check` and the consumer fixture.
2. Move the seven `CODE_PINS` mocks to the selector.
3. Add T3. A simulated source edit mocks the HEAD pins, the HEAD hub artifact and its `token_of` slot to differ. With that edit, `parseNetwork(TESTNET_MANIFEST)` and `resolveToken` still resolve over the kept runtimes. Control: the same world on 31337 is refused. Never-happens: a live chain with no record is refused, and so is an unknown chain.
4. Add T2 (`generation-compat.test.ts`, `abi-shape.ts`).

**Validation gate:** `bun run lint && bun run typecheck:all && bun run test:all && bun run --cwd packages/sdk pack:check`. With `out/` present, also `bun run --cwd packages/sdk test -- factory-abi deposit-router-abi code-pins`. Layers: lint, typecheck, unit.

### Phase 3: the app
1. Switch `bridge-generation.ts`, `useWalletConnection`, `useSend`, `useHubExit`, `hub-binding.ts` and `verify-deployments.ts`.
2. Add the app half of D5 and one test: the testnet build's hub artifact is the record's.
3. Note the testnet dist and the fetched chunks, before and after.

**Validation gate:** `bun run audit:tools && bun run test:all && bun run e2e:tools`, every spec green at retry 0. The e2e wall-clock before and after goes in `lessons/phase-3.md`. No e2e scenario is added. Layers: lint, typecheck, unit, build, e2e.

### Phase 4: tooling, CI, documentation
1. Update `verify-l1.ts`, `live-intent.ts`, `promotion.ts`, `script-l2.ts` and its callers, `generation.ts`, with tests:
   - the carry rule against the baseline at the build commit, with a candidate absent from that commit and the live files already partly overwritten;
   - a router-only candidate whose carried hub differs from HEAD;
   - `verifyL1Manifest` with no record: refused on a live manifest, run on a sandbox one (control);
   - promote's file set, interrupted at an artifact write and at a deletion, then re-run.
2. Add the CI step. Update the runbook:
   - Branch B steps 4 and 7, router-only steps 4–7, Branch F steps 3 and 6;
   - replace the "frozen sources" paragraph;
   - the D3 tag step, the D5 rule, the reviewer's rebuild, and the keyless two-RPC `check --candidate` before `verify --candidate`.
3. Update `UPDATE.md` and the SDK README.

**Validation gate:** `bun run lint && bun run typecheck:all && bun run test:all && bun run audit:tools && bun run lint:actions && bun run test:ci-gating`. Then `BRIDGE_INTEGRATION=1 bun run --cwd packages/bridge-core test:integration -- sdk-flows router-only` green on a local sandbox. Layers: lint, typecheck, unit, CI, integration.

## Delivery

| Arc | Phases | Stacks on | `/code-review` |
|---|---|---|---|
| a1 `worktree-gen-pins-1` (Delivers ask36) | 1–4 | `main` after route-auth-1 merges | off |

- Single arc, one PR (`gh pr create`). The close-out lands as its final commits.
- Before Phase 1, check `gh pr list --search "route-auth-1 in:head" --state merged`. Not merged: stop at the gate and report it. Merged: `git merge origin/main`, then re-read `network.ts`.
- Merge `origin/main` again before the PR. No parallelism: the phases share files.
- **Owner's steps:** promotions, the D3 tag, any keyed run.

## Post-implementation

1. **Codex fix loop** over the net diff from the plan commit, with `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol`.
   - The prompt carries the diff, this plan and its ledger, the adversarial and security ask, the no-over-engineering and comment-quality rules verbatim, and the no-`.env` and no-`~/.agents/orchy/` lines.
   - Verify each finding's path. Commit, log the round in `lessons/phase-4.md`, and resume the same session.
   - Stop at a round with no material finding. Hard stop at 3 rounds, then surface.
   - A fix that adds state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop.
2. **Delivery:** run the gates on HEAD, then `gh pr create`. Title: `feat(sdk): check each live generation against its committed code record`. The body has what and why, the validation results, the dist and e2e numbers, `Delivers ask36` and the trailer.
3. **Close-out** (the PR's final commits, after `git merge origin/main` and a read of `index.md`/`lessons.md`):
   - an `## Outcome` block after the front matter, with `Known limits: #N` (D6) and `Open items:`; the seeds retired;
   - lessons promoted (deduped and pruned);
   - open items filed as issues, or as private draft advisories if exploitable;
   - `git mv implementations-plan/gen-pins-1 implementations-plan/archive/gen-pins-1` in its own commit, plus one line in `archive/index.md`. No `index.md` row. `STATUS.md` is deleted.
4. **Checks:** run `gh pr checks <n> --watch` in a bounded loop. The orchestrator merges.
5. **Teardown after the merge:** `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/gen-pins-1/plan.md`, then `agent-worktree done gen-pins-1 --merged`. Relay any refusal.

Stop and reassess after 3 failures on one step. Comments state invariants only.

## Decision ledger

| # | Question | Chosen | Rejected | Disputed |
|---|---|---|---|---|
| L1 | Where the record lives | separate, `contracts/bridge/generations/<net>/` (D1, D2) | in the manifest (B); `apps/tools/public/` | Codex: B "viable, not clearly better" |
| L2 | Build provenance | per-entry durable commit, owner tag for a reset (D3) | merge-base for the whole record (wrong for carried entries); null commit plus a later tag; tree ids | Opus preferred tree ids |
| L3 | Pairing check | static gate + D6 known limit (D5) | frozen sandbox suite; frozen-by-default e2e | — |
| L4 | Chains | record on live chains, HEAD on sandbox ids, refuse others (D4) | HEAD for every non-live chain | — |
| L5 | Arcs | one (D7) | records first, promotion later | Opus: split optional |
| L6 | The hub artifact at the tooling's registration sites | `hubArtifactFor(m)`: the kept artifact of the live or candidate record naming that hub, else the hub target | `codeFor(m)`: a router-only pre-create runs before its candidate record exists, so it would refuse | — |
| L7 | How bridge-core maps a chain to its network | a static table in `generation-paths.ts` | `LIVE_RECORDS`: `write --first` runs before any record exists | — |
| L8 | Where the SDK binds the record | inside `codeOf(m)`, wrapped by `parseNetwork` as `invalid-network`; `hubArtifactOf` beside the `WeakMap` in `network.ts`, re-exported as `hubArtifact(net)` | a separate binding step | — |
| L9 | Interface changes the plan did not name | `@unleashed/bridge-core/generation-paths` export (for `verify-deployments.ts`); `preCreateToken({ hubArtifact })`; `SWAPPER_ABI` exported for the D5 map; `writeLiveRecord(dir, files, root)` and `candidateOf` exported for tests; the consumer fixture loads through `protocol.codeOf` | — | — |
| L10 | A fuel-route candidate in `candidateOf` | `parseManifestV2`: the placeholder has no hub to derive | `assertFaucetCandidateShape` | — |
| L11 | CI path filters | `contracts/bridge/generations/**` added to `pr-quick.yml`'s `tools` and `sdk-pack`, which the gating test requires once the SDK bundles the records | — | — |
| L12 | Phase order | phases 2–4 built together: the artifact parameters cross package boundaries, so one typecheck covered them; each gate ran on the result | one phase per commit | — |
| L13 | The e2e "before" run | a `git archive` of the merge base in the scratch directory, run alongside "after" so both share one load window | sequential runs, whose wall-clock tracks the host's load | — |

### Audit verdicts

- **Codex** (`gpt-6.1-sol`, high): `conditional approve` (anchor carry checks to the intent commit, preserve actual build provenance, complete artifact selection through promotion and storage reads).
  - Adopted:
    - F1 thread the record artifact through `candidateOf` and `reportHubBindings`;
    - F2 the slot from the selected artifact, and slot equality dropped from D5;
    - F3 a hub-less fuel-route record;
    - F4 the carry baseline at `intent.source.commit`;
    - F5 per-entry `build`;
    - F6 wording: the masked runtime;
    - F7 no null commit (D3).
- **Opus** (Plan agent): `conditional approve` (tooling artifact, mask bounds, mainnet placeholder, per-entry build, verify-l1 record option).
  - Adopted:
    - F1 `script-l2` and the canaries;
    - F2 mask-shape bounds plus CI `check --build-out`;
    - F3 the mainnet placeholder record, and T1 over bundled manifests;
    - F4 per-entry `build` (the tree-id form was rejected, see L2);
    - F5 `verifyL1Manifest({ record })`, the sandbox fresh-build path, and router-only in the gate;
    - F6 promote order, file set, `lstat`, re-verify and re-run test;
    - F7 `hubArtifact(net)` via a `WeakMap`;
    - F8 the explicit ABI map, errors, `nonDispatchPublicFunctions`, `token_of` packing in D6, the `verify:deployments` credit;
    - F9 HEAD pins on sandbox ids only;
    - fact fixes (promote lines, hub calls, file map, forge layout).
- **Codex final fresh pass** (new session): `conditional approve` (separate candidate and baseline lookup, complete D3's build inputs, enforce the verifier's live-chain guard, correct the RPC assurance). Adopted:
  - F1 `recordFor` and `liveBaseline` as separate lookups;
  - F2 `BUILD_INPUTS` aligned with `setup-forge`'s digest, clean-tree check, peeled tag check, the tag authorizes nothing;
  - F3 `verifyL1Manifest` refuses no-record live chains;
  - F4 the second-endpoint claim removed, and a keyless two-RPC `check --candidate` added to the runbook.
  - Resumed for verification: **`approve`** (no remaining material findings, no regression).
    - its point that the D5 sandbox-seam argument was overstated (`vi.mock` works in the integration suite): that argument is dropped.
  - Rejected: none.
- **Implementation review** (the branch's diff from the merge base; detail in `lessons/phase-4.md`):
  - Codex round 1 (`gpt-6.1-sol`, high): `reject`. Adopted: F1 a fresh build reproduces a record's pin only whole (`samePin`), F2 `promote` re-checks the buffered record files' integrity before any live write (`promotableRecord`), F3 the testnet swapper's swap call joins D5, compared without parameter names.
  - Opus diff review: `conditional approve`, the same three plus: masked spans must be zero-filled in the kept build, the sandbox control holds the L1 pins, `check` redacts the endpoints it was given, stale wording. All adopted.
  - Codex round 2 (resumed): `conditional approve`. Adopted: redact the longest endpoint first.
  - Codex round 3 (resumed): **`approve`**, no findings.

## Seeds (retired)

Retired at close-out: arc a1 delivered the plan in one pull request.
