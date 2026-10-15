---
plan: aztec-rc3
tier: deep
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: artifact
eli5_source: implementations-plan/aztec-rc3/eli5.html
eli5_url: https://claude.ai/artifact/2JWCkJhmQm2cmEBtejh5xT
budget: "recon: 3 Sonnet agents; code-review: off; Codex on gpt-6.1-sol at high; Claude leg on Opus 5.5"
status: draft
base: main (aecf311); the lifi-routing stack (#7–#14) lands after this plan, rebased onto it
---

# aztec-rc3: Aztec 6.0.0-rc.3, a new testnet generation, and split dRPC keys

## Summary

The Aztec testnet reset to 6.0.0-rc.3. The new rollupVersion is `3409706519`, and the FeeJuicePortal moved. This
plan does three things.

1. **It splits the dRPC keys (PR A, first).** The testnet bundle gets one origin-filtered browser key. Scripts
   read a second key that exists only in 1Password. The mainnet URL leaves the bundle, and a CI guard allows
   exactly one committed key.
2. **It moves the repository to the rc.3 line (PR B).** `@aztec-labs/*` goes to 6.0.0-rc.3. `@aztec-foundation/*`
   goes to 6.0.0-rc.6, except `aztec-standards`, which goes to 6.0.0-rc.3. `@alejoamiras/private-fee-juice` goes to
   6.0.0-rc.3, and aztec-nr goes to `v6.0.0-rc.3`. The PrivateFPC gets its new address, and nothing deploys it.
3. **It deploys a new testnet bridge generation (PR B).** The deploy follows the `bridge-generation` runbook
   (Branch B, today's Uniswap shape). It runs now, from the branch, through keyed runs. The app switches when PR B
   merges. `@nulo-sh/*` 0.2.0 is on npm, so PR B pins it from the start.

Length: about 900 lines against the deep tier's 600, because two arcs, a frozen live window and three audit
rounds' verdicts each need their own text.

## Owner decisions (Phase 0)

| Question | Answer |
|---|---|
| Tier | `deep`: four high dimensions (irreversibility, migration cost, external coupling, security sensitivity); novelty low |
| Fee-juice exemption | The owner's decision, relayed in the brief: `@alejoamiras/private-fee-juice` becomes a standing exemption, recorded in `bunfig.toml`, `SECURITY.md` and `AGENTS.md`. `SECURITY.md` says "Add no other name this way", so Phase 6 amends that line to name both exemptions. The owner confirms the wording at the gate |
| Q1 Order vs `lifi-routing` | rc.3 first, on today's `main`, in the Uniswap shape. Do not stack on lifi. Its testnet deploy is void; it rebases onto rc.3 later |
| Q2 Success | The testnet app works end to end on rc.3 against the new generation. Every runbook canary is green. The new keys are live, scripts use a key that exists only in 1Password, and the old keys are disabled |
| Q3 Quality bar | Production rigor. Gates: lint+typecheck+unit · contract suites · sandbox smoke + browser e2e · live canaries. `/harden` not scheduled; revisit before the mainnet bridge |
| Q4 PrivateFPC | Remove the testnet FPC deploy and the `require-deployed` absence gate. Keep the address, version, digest and identity checks before any Fee Juice moves. The sandbox stops publishing the FPC. The mainnet FPC scripts stay, minus their key. The Nulo wallet confirmed it never needs the instance published; its condition is the salt-1, deployer-zero derivation |
| Q5 Browser key | The agent commits a placeholder that fails a test. The owner replaces it in a one-line edit. The agent never receives a key |
| Q6 Script key | The owner mints an unfiltered key and stores the full URL as field `AZTEC_NODE_URL` in `Keyed-Runs/Unleashed-Testnet`. Scripts stop writing and printing the node URL |
| Q7 Mainnet key | Remove the mainnet URL from the bundle now; mint the mainnet key at mainnet launch |
| Q8 Allowlist | Approved; the key split is its own PR, first. The owner sets the allowlist and a daily CU limit |
| Q9 Deploy now | Approved. (a) The `deriveNuloAccountKeys` vector matches between 0.1.0 and npm 0.2.0: **met** (F12). (b) The swap-after-promotion rule existed only because 0.2.0 was not published. It is now, so this plan pins 0.2.0 in Phase 6, before the deploy (D12). Signer `0x7F42…6a9a`, cap 2.0 Sepolia ETH |
| Legs | Claude Opus 5.5 · Codex GPT-6.1 Sol at high · `/code-review` off · explainer off |

## Outcome & Quality Bar

**For whom.**
- The owner, who operates the testnet bridge and faucet and pays for the dRPC account.
- A tester on `testnet.app.unleashed.systems` with an rc.3 Nulo wallet who bridges, exits or drips.
- The next maintainer, who bumps Aztec again or rotates a key.

**Excellent looks like:**
1. **The testnet app works on rc.3 against a proven generation.** It bridges publicly and privately, with and
   without fuel, exits and drips. Every runbook canary passes against the promoted manifest. A private self-paying
   claim settles through the PrivateFPC, which no script publishes.
2. **No key can be lifted from this repository and used freely.** `node-keys.test.ts` finds at most one dRPC key
   in the tracked tree: the origin-filtered, capped testnet browser key (none under A0). No intent, journal or log
   holds the script key. A keyed probe shows the script key differs from the browser key. The two abused keys are
   disabled.
3. **The next bump is cheaper.** `aztec-line.test.ts` holds the two-version line in code. A vector test pins the
   deployer derivation across `@nulo-sh` versions. `UPDATE.md` and the runbook describe the keyed node URL and the
   FPC that is never deployed.

**Good enough.**
- Mainnet operator scripts stay stale until Aztec Alpha upgrades. They only lose their literal key.
- Testnet records from the rc.1 generation stay withheld at boot, with no new UI.
- A distributed attacker can exhaust the browser key's daily cap and stop the testnet app for that day.

## Architecture & Implementation

### Proposed architecture

Two arcs, two PRs, on existing tooling (`recon.md` holds the reuse map).

- **Arc 1, the key split (PR A).**
  - One helper, `requireAztecNodeUrl()`, joins the existing `packages/bridge-core/scripts/script-bootstrap.ts`.
    It replaces `process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL` in every script, and the two mainnet literals.
  - `packages/bridge-core/src/testnet-node.ts` and its barrel export go. The one browser literal stays in
    `apps/tools/src/lib/network-targets.ts`.
  - `live-intent.ts` stops recording a node URL. `verify` and `promote` read the node from the keyed run. The
    committed template, `op://Keyed-Runs/Unleashed-Testnet/AZTEC_NODE_URL`, fixes which endpoint a run uses.
    Templates are not allowlisted, so a mid-arc template edit is source drift that `verify` refuses.
  - `scripts/ci-cd/node-keys.test.ts` allows one committed key. The four archived copies of the old testnet key
    are scrubbed to `<KEY>`.
  - **If the owner picks the keyless endpoint at the gate (A0)**, the browser constant becomes
    `https://aztec-testnet.drpc.org`. Then no browser key exists: no placeholder, no owner key commit, no allowlist,
    and the guard allows zero keys. Everything else stays.
- **Arc 2, rc.3 and the generation (PR B).** It follows the runbook: pins, Noir, FPC, chain cascade, reset
  baseline, sandbox rehearsal, then the live arc under `live-intent`. The one structural change is the FPC gate:
  `check-fpc-version.ts` has one behaviour. Absence at the pinned address is green, and a published instance must
  carry the expected original and current class. Anyone may publish the initializerless instance, so only the
  fresh sandbox requires absence; live accepts either state.

### Key interfaces

```ts
// packages/bridge-core/scripts/script-bootstrap.ts
/** The Aztec node a live script talks to. Never defaulted: the URL embeds an unfiltered dRPC key that reaches a
 *  run only from 1Password through a keyed-run template. Throws, naming the variable, when unset. */
export function requireAztecNodeUrl(): string
// packages/bridge-core/scripts/check-fpc-version.ts
export async function runFpcGate(): Promise<void> // no mode: absence green, presence class-checked
```

- Every caller reads the URL at operation entry, never at module scope. `deploy-seed-tokens.ts`, `pause-factory.ts`,
  `fpc-dust-canary-mainnet.ts` and `live-intent.test.ts` import `live-intent.ts` for its pure exports.
- `DeployIntent` loses `primaryRpc`. `secondEndpoint` keeps `{ agreed: true }` or the posture string, without a URL.
  `rpc()` errors name the method and `AZTEC_NODE_URL`, never the value; a unit test feeds a sentinel key through a
  failing fetch and asserts the error text excludes it. Old intents still parse, because the JSON is type-cast.
- `apps/tools/scripts/deploy-config.ts` requires `AZTEC_NODE_URL` for `testnet` and `mainnet`. `local-network`
  keeps its loopback default.
- `ToolsTarget.nodeUrl` stays a `string`; mainnet's is `""`. The mainnet build never calls a node
  (`main.ts` skips the probe on `IS_MAINNET`), and its CSP blocks one.
- **Visible surfaces: none.** No `.vue` file reads `nodeUrl`, so neither mainnet's `""` nor A0 changes layout,
  copy or formatting. A0 changes availability only (public-tier limits, no SLA), which the owner decides at A0.
  The new generation changes addresses, not screens.

### Data and control flow (the critical path)

1. Arc 1 code, then its quality loop. The owner mints both keys and commits the browser key on the branch. A
   probe proves the filter. PR A opens and merges.
2. Arc 2 starts from arc 1's code and runs its local phases while PR A is in review. After PR A merges, arc 2
   rebases onto `main`, so its tree holds the real browser key. Arc 2's quality loop converges **before**
   `live-intent build`: a source change after `build` voids the intent.
3. Live window (keyed runs): `build` → generation → faucet → FPC gate → smokes and samples → calibrate →
   `verify --candidate` → retire the old manifest → `promote --bridge-only` → canaries → preview check → final
   `verify`. Only allowlisted paths change inside the window.
4. After the final verify: docs, ✓ marks, the final cross-arc pass, PR B, close-out.

### File-level change map

| Arc | Area | Files |
|---|---|---|
| 1 | Node URL | `scripts/script-bootstrap.ts` (+ test); the 11 testnet scripts that default to `TESTNET_NODE_URL` (recon § dRPC keys); `deploy-private-fpc-mainnet.ts`, `fpc-dust-canary-mainnet.ts`; `apps/tools/scripts/deploy-config.ts` + `deploy-config.test.ts`, `deploy.ts` (stop logging the URL); `check-fpc-version.ts` (stop logging); delete `src/testnet-node.ts` and its line in `src/index.ts` |
| 1 | Intent | `live-intent.ts` (no `primaryRpc`, no `secondEndpoint.url`, lazy URL, errors without the URL) + `live-intent.test.ts` (the sentinel-key error test) |
| 1 | Bundle | `network-targets.ts` (placeholder, mainnet `""`, the `TESTNET_NODE_URL` comment and "the wallet reports the same one" corrected), `network-targets.test.ts` (drops the `TESTNET_NODE_URL` import in Phase 1) |
| 1 | Key guard | `scripts/ci-cd/node-keys.test.ts` (new); scrub `archive/aztec-v6/lessons/{intent.json,reset-baseline.json,phase-5.md}` and `archive/protocol-labels/lessons/intent.json` |
| 1 | Templates | `AZTEC_NODE_URL=op://Keyed-Runs/Unleashed-Testnet/AZTEC_NODE_URL` in `testnet-l1`, `testnet-generation`, `testnet-rpc`, `apps/tools/testnet-faucet`; `# op: import` and the line in `testnet-provision`; the plain `apps/tools/.env.example` and `packages/bridge-core/.env.example` lose the keyed URL |
| 1 | Docs | `AGENTS.md` § Security, `SECURITY.md`, `apps/tools/README.md`, `UPDATE.md` (Testnet node ↔ CSP), the skill (pre-flight, Phase 0 probe as a keyed run, step 11) |
| 2 | Pins | `apps/tools`, `packages/bridge-core`, `txe-server` `package.json`; root `patchedDependencies`; `patches/@aztec-foundation%2Fnoir-{acvm_js,noirc_abi}@6.0.0-rc.6.patch`; `bunfig.toml`; both `bun.lock` |
| 2 | Line guards | `scripts/ci-cd/aztec-line.test.ts` (per scope, patch keys); `packages/bridge-core/scripts/deployer-keys.test.ts` (derivation vector, vitest) |
| 2 | Noir | six `Nargo.toml` tags; re-vendored `token_portal_content_hash_lib`; `compile.sh`, `nargo.sh`, `run-txe-tests.sh`; `token_bridge_hub/src/test/utils.nr` (`immutables_hash`); `target/*.json` |
| 2 | Class ids, vectors | `noir-artifact-classids.test.ts`, every Token class-id copy, `hub-token.test.ts` + `keystone.nr`, `fixtures/sandbox-manifest.json` |
| 2 | PrivateFPC | `private-fuel.ts`, `private-fpc-canonical.json`, `private-fuel.test.ts`, `check-fpc-version.ts`, `fuel-testnet.ts`, `live-intent.ts`, `script-l2.ts` (shared registration), `sandbox/{context,deploy,flows}.ts`; delete `deploy-private-fpc-testnet.ts`; `deploy-private-fpc-mainnet.ts` (its stale "Next:" line); `fpc-dust-canary-mainnet.ts` and `apps/tools/src/contracts/private-fpc.ts` (comments); `UPDATE.md` (Canonical PrivateFPC) |
| 2 | Identity | `chain-constants.ts` and its literal tests (recon § Identities); `contracts/bridge/evm/.env.example`, `DeployFuelLive.s.sol`, `DeployFuelLive.fork.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`; `live-intent.ts` (`NO_RESET_BASELINE`, `OPERATIONAL_ALLOWLIST`); `lessons/reset-baseline.json` (new) |
| 2 | Faucet record | `apps/tools/src/contracts/deployments.json`, reproduced by the sandbox and committed before `build` |
| 2 | Live output | `testnet-bridge.json`, `deploy-journal/`, `lessons/intent.json`, `lessons/promotion-receipt.json` |
| 2 | Docs | `UPDATE.md`, the skill (step 6), `AGENTS.md` (Nulo table row, dependency policy), `SECURITY.md`, `contracts/bridge/aztec/README.md`, `apps/tools/tests/browser/README.md`, `follow-ups.md`, `lessons.md` |

### Non-obvious mechanics

- **Two versions, one line.** `aztec-line.test.ts` reads three pins and writes none.
  - `@aztec-labs/*` sit at the aztec.js pin in `packages/bridge-core/package.json`.
  - `@aztec-foundation/*` sit at the version that the lockfile's `@aztec-labs/aztec.js` entry requires for
    `@aztec-foundation/l1-artifacts`.
  - `@aztec-foundation/aztec-standards` sits at its own declared pin.
  - The test also holds every root `patchedDependencies` key at the foundation version. A patch whose file name
    names another version stops applying with no error (UPDATE.md).
- **The derivation vector.** `deployer-keys.test.ts` pins `deriveNuloAccountKeys` for seed `0x…42` to the wallet
  repository's reference values (F12). A changed derivation would orphan the hub's `guardianL2` and the deployer's
  Fee Juice (`script-l2.ts`, `apps/tools/scripts/deploy.ts`).
- **`@nulo-sh/*` 0.2.0 from the start.** Its peers are exact rc.3 (F12), so `published-packages.test.ts` is green
  from Phase 6, and the deploy runs on the tree that ships. The scope is already a standing exemption, so the pin
  needs no temporary exclude. This removes the post-window pin swap, the 0.1.0 peer warnings, and a dependency
  change after the deploy.
- **The live window freeze.** From `live-intent build` to the final `verify`, change nothing outside
  `OPERATIONAL_ALLOWLIST`. That covers `bunfig.toml`, templates, `plan.md` and `index.md`. Interim status goes only
  to this plan's `lessons/`. No rebase and no merge inside the window.
- **env-exec and the tree.** env-exec refuses untracked files when a request is filed and again when it runs, and
  a commit made while a request is pending voids it. So commit the plan folder before the first keyed run, and
  commit each run's output (journal, intent, receipt) between requests. The candidate is gitignored; the intent
  records its digest.
- **The temporary exclude** for `aztec-standards` leaves right after the install, so the committed `bunfig.toml` is
  final before `build`. A frozen install never re-gates. A later `package.json` edit re-gates the young package:
  add the exclude locally, uncommitted, and never inside the live window.
- **The faucet record is chain-independent.** Universal deploys with fixed salts give the same addresses on the
  sandbox and the testnet. Separator V3 moves them, and the browser suite's global setup needs the new record. So
  the sandbox's `deployments.json` is committed in Phase 9, the testnet faucet deploy must reproduce it byte for
  byte, and promotion is `--bridge-only` (as in aztec-v6).
- **Reset baseline.** `build` refuses a reset by design (`assertNoResetPins`). The baseline is hand-written into
  `lessons/reset-baseline.json` from L1 evidence that does not trust the node (F5, F6). `NO_RESET_BASELINE` points
  at it before `build`, and at this arc's archived `intent.json` at close-out.
- **Pools persist.** Sepolia did not reset, so the rc.1 TOKEN/WETH pools and the ETH/FJ pool persist. The
  conductor runs with `SKIP_POOL_SEED=1`, because a seed on an existing pool adds liquidity again.
- **TXE arity.** aztec-nr rc.3 `txe_oracles::deploy` takes a seventh argument, `immutables_hash`. The hub's test
  helper calls it twice (`token_bridge_hub/src/test/utils.nr`). `main.nr` declares `mod test;` unconditionally, so
  the old arity breaks `compile.sh` too. Pass `0`, which matches the hub's own `derive_token`.
- **PR A's preview dies at boot**, and so does production after PR A merges. Both run rc.1 code against the reset
  node, and the boot identity check refuses it. The deployed app is already dead for the same reason, so nothing
  regresses.
- **Old keys stay in git history forever.** Only disabling them in dRPC removes them. Nothing here rewrites
  history.

### Trade-offs and alternatives not taken

The decision ledger below records each fork with its source and the rejected alternative.

## Security & Adversarial Considerations

- **Threat model.**
  - A third party lifts a committed key and runs traffic on the owner's dRPC account. This already happened.
  - A leaked script key gives the same capability with no origin filter.
  - A wrong PrivateFPC address loses every Fee Juice deposit sent to it.
  - A tampered dependency runs inside the keyed runs, with the script key and the signer in its environment.
  - A malicious or stale node RPC names contracts that agree with each other.
- **The browser key is public by construction.**
  - Any client outside a browser can set the Origin header, so the filter stops only embedding by other sites.
  - The daily CU cap is the control that bounds abuse, with dRPC's per-IP rate limit beside it.
  - The fallback allowlist entry `*.alejo-amiras.workers.dev` admits only hosts this Cloudflare account serves.
  - `http://localhost:5176` (Ask A4, the dev server's port) adds no embedding risk: no public site can make a
    browser send it as Origin.
  - Phase 4 probes the filter: a forged foreign Origin is refused, our Origin is served, and the CORS preflight
    echoes our Origin.
  - The alternative is the keyless public endpoint (A0). It puts no key in the bundle and spends none of the
    owner's CU. It costs the public tier's rate limits and has no SLA.
- **The script key.**
  - It reaches only keyed-run processes. env-exec masks its value in the run's log, not in files a run writes
    (F11). The writers are the intent (fixed here), forge's broadcast cache (deleted after every live
    `forge script`), and any new writer. `node-keys.test.ts` catches a committed one.
  - `requireAztecNodeUrl` has no default. A script outside a keyed run fails instead of falling back.
  - Ask A3: an IP allowlist on the script key, if this host has a stable egress IP. Unlike Origin, a client
    cannot forge its IP.
  - A daily cap on the script key needs headroom. A cap that trips mid-conductor leaves a partial landing, which
    only the journal's resume recovers.
  - A keyed probe proves the script key differs from the browser key. This catches the owner pasting the
    unfiltered key into the public bundle.
- **No URL redaction helper.** Keeping only the origin leaks providers that put the key in the subdomain. The
  scripts print nothing about the node instead.
- **Residual: the Aztec node client prints the full URL on a failed call** (`@aztec-labs/foundation`
  `json-rpc/client/fetch.js`, its error text and retry label). Repository code cannot stop that, so keyed-run logs
  rely on env-exec's masking (F11). Lessons quote only masked output, and a failing keyed command is never re-run
  outside env-exec.
- **Tests never print a key.** URL assertions compare booleans, and the key guard prints paths and counts only.
- **CSP.** `connect-src` keeps its shape: the exact testnet node URL and the token-list file. Only the key segment
  changes, and it follows the constant. Mainnet keeps `'self' data: blob:`.
- **The owner's key commit.** Before arc 2 adopts it, check that it changes exactly one line of
  `network-targets.ts`. A placeholder cannot reach production: its test fails, `quality-status` is required on
  `main`, and Workers Builds deploys production only from `main`.
- **PrivateFPC address.** `private-fuel.test.ts` and `runFpcGate` re-derive the address from the installed
  artifact with salt `0x…01` and deployer zero. They do not rest on the package's JSON. The Nulo wallet pins the
  address from the same tarball, so it is not independent evidence. A failed unpublished path is recoverable,
  because anyone may publish the initializerless instance later. Only a wrong address is unrecoverable.
  - F4's kernel side is inferred, not read (`recon.md`). Phase 9's sandbox smoke on rc.3 circuits is the proof that
    the JS derivation and the protocol circuits agree, before any live Fee Juice moves.
- **Supply chain.**
  - Exact pins; frozen lockfiles in CI; `bun audit` against `main`'s baseline; `npm audit signatures
    --include-attestations` in a scratch npm project.
  - Provenance: `aztec-standards` rc.3 is attested by `AztecProtocol/aztec-standards` at tag `v6.0.0-rc.3`
    (`f7bf63d5…`), the same commit the hub's Noir `token` dep resolves. `private-fee-juice` rc.3 is attested by
    `alejoamiras/ecosystem-tooling` on its main branch, so the exact pin and the lockfile integrity are its control.
    Labs rc.3 carries no attestation, as rc.1 did not.
  - `private-fee-juice` becomes a standing exemption on the owner's decision: trusted publishing with provenance
    from one repository, and exact pins, so a new version enters only through a reviewed bump.
  - `@nulo-sh/*` 0.2.0: the npm tarballs hash to the wallet repository's `approved-digests.json`, and their
    provenance names `nulo-sh/nulo` (F12). Phase 6 re-checks both before pinning.
  - `aztec-up` resolves its npm installs live, with no age gate. Keep its install log in `lessons/`.
- **Live deploy.** The existing controls stay: the signer pin, caps and tree gate; the conductor's nonce
  prediction and journal; one signer at a time; L1 corroboration of every node claim; the hub's
  initialization-hash readback.
  - Residual: one L2 node operator. The keyless public endpoint is also dRPC, so it is not independent. The L1
    anchoring and the caps bound the exposure.
  - `verify` compares `nodeVersion` exactly. A mixed fleet behind the load balancer can flap it. On a flap, stop
    and ask the owner; never loosen the check.
- **Known limit: the rc.1 factory stays unpaused.**
  - Path: a direct contract caller deposits a test token into an rc.1 portal. The rc.1 rollup is no longer
    canonical, so no L2 claim exists, and the token stays locked.
  - The live rc.1 app usually dies at boot on the reset node, but not always. It mounts before the check, a
    failed fetch only warns, and a tab opened before the reset never re-checks.
  - Consequence: lost Sepolia test tokens only. Disposition: no pause, unless the owner says so at the gate (A7);
    `pause-factory.ts` stays available.
  - It goes in the Outcome's `Known limits:` line. Reopening condition: a user reports a stranded deposit.
- **Smart-contract risks** (reorg, replay, front-running) do not change in kind. Every derived address is new under
  separator V3, so no old authwit or record can target the new contracts. The journal withholds old records.

## Assumptions

### Facts

- **F1.** `@aztec-labs/*@6.0.0-rc.3` exist and depend on `@aztec-foundation/*@6.0.0-rc.6`. Foundation publishes
  rc.1, rc.2, rc.4, rc.5 and rc.6, and no rc.3. All of them cleared the 7-day gate at plan time (npm `time`).
- **F2.** `@aztec-foundation/aztec-standards@6.0.0-rc.3` has no dependencies and carries SLSA provenance. It had not
  cleared the gate at plan time; `npm view @aztec-foundation/aztec-standards time` says when it does.
- **F3.** `@alejoamiras/private-fee-juice@6.0.0-rc.3` carries SLSA provenance and exact labs rc.3 peers. Its
  `canonical-deployment.json` names salt `0x…01` and address
  `0x2e189d0c28cb86234a17951a94131e19620cda595fa8f9c5c10c24268ceb6db4`.
- **F4.** The rc.3 FPC artifact has no initializer and no public function of its own. The PXE accepts a locally
  registered instance the node does not know. The Nulo wallet registers it locally and never needs it published
  (`recon.md` § PrivateFPC; the wallet repository at `dev 479ba56d`, `fpc/service.ts`).
- **F5.** Sepolia, read through two public RPCs:
  - The registry `0xa0bf…c6ba` maps `3409706519` to the canonical rollup `0xEd1e…089d`.
  - The rollup reports version `3409706519`, fee portal `0x6974…Ce59` and fee asset `0x762c…3c18`.
  - The portal's `ROLLUP()` and `UNDERLYING()` point back.
  - The handler `0x5602…bfc9` reports `FEE_ASSET()` equal to the fee asset.
- **F6.** Upstream `AztecProtocol/networks` `network_config.json`, the source `@aztec-labs/cli` rc.3 reads, names the
  same registry and handler for testnet.
- **F7.** The keyless public node `aztec-testnet.drpc.org` reports nodeVersion `6.0.0-rc.3`, l1ChainId `11155111`,
  rollupVersion `3409706519`, and the L1 addresses of F5. The wallet chainId is `3415328944`.
- **F8.** On that node, the SponsoredFPC `0x2adf…2130` and the rc.3 `STANDARD_AUTH_REGISTRY_ADDRESS` `0x2ba8…3a9c`
  are published with their rc.3 class ids. The rc.3 PrivateFPC address is not published.
- **F9.** The changelog's Noir and TS migrations have no hit in hand-written source (`recon.md` § Bump surface). The
  upstream breaking commits are separator V3 and the TXE immutables hash, which does hit (`utils.nr`).
- **F10.** `aztec-line.test.ts` holds every `@aztec-(labs|foundation)/*` package at the single aztec.js pin, so it
  fails on the rc.3 line as written.
- **F11.** env-exec masks each secret value in a keyed run's log. It does not touch files the run writes.
- **F12.** Scratch installs outside the repository show the following:
  - The three `@nulo-sh/*` 0.2.0 tarballs on npm hash to the three values in the wallet repository's
    `approved-digests.json`. They carry SLSA provenance from `nulo-sh/nulo`, and their Aztec peers are exact
    rc.3. A pack from the wallet repository at `dev c1919e22` gave the same hashes.
  - The wallet's reference vectors (seeds `0x…42` and `0x…1337`) give the same keys on 0.1.0 and on npm 0.2.0.
- **F13.** The pinned signer `0x7F42…6a9a` holds about 2.90 Sepolia ETH, above the 2.0 cap.
- **F14.** Six modules import `live-intent.ts`. `deploy-private-fpc-mainnet.ts` imports
  `deploy-canonical-private-fpc.ts`. `assertSignerUnmoved` skips when `PRIVATE_KEY` is unset.
- **F15.** The `lifi-routing` stack commits two intents that carry `primaryRpc` with the old testnet key.
- **F16.** The keyless node answers an `OPTIONS` preflight from `https://testnet.app.unleashed.systems` with 204
  and that Origin echoed in `access-control-allow-origin`, with no redirect.
- **F17.** `minFuelFj` is the source constant `MIN_FUEL_FJ` in `deploy-generation.ts`. `calibrate` writes only
  `fjPerTx` and `fjRegister`. `pre-create` needs `BRIDGE_DEPLOYER_SECRET_TESTNET`, and `fuel-testnet.ts`
  defaults `--config` to the live manifest.

### Inferences

- **I1.** dRPC's allowed domains accept the testnet hosts, or the `*.alejo-amiras.workers.dev` fallback. Phase 4's
  probe proves it.
- **I2.** The embedded test wallet accepts an unpublished FPC instance, as the Nulo wallet does. Phase 9's sandbox
  smoke and browser suite prove it; Phase 12's private canary proves it live.
- **I3.** `aztec-up install 6.0.0-rc.3` installs a complete toolchain. Phase 5 proves it.
- **I4.** The re-vendored content-hash lib keeps its vectors. The Solidity, Noir and TS cross-checks prove it.
- **I5.** The node reports one `nodeVersion` across its fleet. Every `verify` re-checks it.

### Asks (answered at the approval gate)

- **A0. Browser endpoint.** Keep the plan (a new origin-filtered, capped browser key), or point the testnet bundle
  at the keyless public `https://aztec-testnet.drpc.org` (F7, F16)? Keyless puts no key in the bundle, spends none
  of the owner's CU, and makes A4 moot. It costs the public tier's rate limits and has no SLA. Recommendation
  (moderate confidence): keyless, because a lifted browser key is the abuse that started this work, and the testnet app's traffic is
  small.
- **A1. Live authorization (runbook Q2).** Authorize the scripted testnet redeploy: L1 broadcasts, L2 deploys, the
  faucet, promotion and canaries. Every run that signs on L1 chains `live-intent verify` ahead of it in one
  `bash -c`, because the signer re-check runs only where `PRIVATE_KEY` is present (F14). The one exception is A7's
  pause, which runs before any intent exists; its own chain, signer, owner, factory and finalized-nonce checks
  are its gate. It uses these templates:
  - `packages/bridge-core/testnet-generation.env.example` for `deploy:generation` and both `pre-create` runs;
  - `packages/bridge-core/testnet-l1.env.example` for `build`, the smokes, `fuel-testnet` and the fee-juice canary;
  - `apps/tools/testnet-faucet.env.example` for `deploy:testnet`;
  - `packages/bridge-core/testnet-rpc.env.example`, which carries no persistent signing credential, for the probes,
    `check-fpc-version`, `verify --candidate`, `promote`, the final `verify` and `verify:l1`. The drip canary also
    runs on it: it writes to L2 with a fresh random account, paid by the SponsoredFPC;
  - if A7 is "pause": `testnet-l1` for `pause-factory.ts`, dry run first, before `live-intent build`.
  The agent creates no credential. The owner adds the `AZTEC_NODE_URL` field.
- **A2. Merge.** May the agent squash-merge PR A, and later PR B, once their required checks are green?
- **A3. Script key IP allowlist.** Restrict the script key to this host's egress IP, if it is stable?
- **A4. Local development.** Add `http://localhost:5176` (the dev server's port) to the browser key's allowlist?
  Without it, `bun run dev` against testnet fails at the first node call. `dev:local` (the sandbox) is unaffected.
- **A5. Old keys.** Nothing depends on them now: the deployed testnet app is dead on the reset network, and the
  mainnet build never calls a node. Disable both now, or after PR A's deploy as first decided?
- **A6. Manual wallet check.** Is an rc.3 Nulo wallet build available for the manual check on PR B's preview?
- **A7. The rc.1 factory.** Leave it unpaused (the known limit in § Security), or pause it with
  `pause-factory.ts`? Recommendation: leave it; only Sepolia test tokens are at stake.

## Phases

Every gate runs from the repository root. "The fast layers" means `bun run lint`, `bun run typecheck:all` and
`bun run test:all`, each judged by its own exit code. "Both builds" means `bun run --cwd apps/tools build:testnet`,
then `bun run --cwd apps/tools verify:build-target testnet`, then the same pair for `mainnet`, in that order. An
expected-red test is named by file in that phase's lessons before the phase starts.

### Arc 1 — the key split (PR A, branch `worktree-aztec-rc3`)

#### Phase 1: Scripts take the node from the keyed run only

1. Commit this plan folder (`plan.md`, `recon.md`, `lessons/`) and `implementations-plan/index.md`.
2. Add `requireAztecNodeUrl` to `script-bootstrap.ts`, with a unit test: unset and empty throw, naming the variable.
3. Replace every `TESTNET_NODE_URL` default and both mainnet literals with `requireAztecNodeUrl()`, called at
   operation entry. In `deploy-config.ts`, require `AZTEC_NODE_URL` for `testnet` and `mainnet`.
4. In `live-intent.ts`, drop `primaryRpc` and `secondEndpoint.url`. `verify` and `promote` take the node from
   `requireAztecNodeUrl()`. Errors name `AZTEC_NODE_URL`, never its value.
5. Stop printing the node URL in `check-fpc-version.ts` and `apps/tools/scripts/deploy.ts`. Add the sentinel-key
   error test to `live-intent.test.ts`. The sentinel uses a non-dRPC host (`https://node.invalid/<sentinel>`), so
   the key guard never counts it.
6. Add the `AZTEC_NODE_URL` reference to the templates. Correct the `testnet-l1` and `testnet-rpc` headers to
   D15. Remove the keyed URL from the two plain `.env.example` files. Correct the header comments that become
   false: `check-fpc-version.ts` ("no keys"), `deploy-generation.ts` ("defaults to the public testnet RPC") and
   `fuel-testnet.ts` (keys from `.env`).
7. Delete `src/testnet-node.ts` and its export. In the same commit, drop the `TESTNET_NODE_URL` import from
   `network-targets.test.ts`, its mention in the `network-targets.ts` comment, and its uses in
   `deploy-config.test.ts`.

**Validation gate**
- Commands: the fast layers; `bun run test:ci-gating`;
  `rg -n 'TESTNET_NODE_URL|primaryRpc' packages apps scripts --glob '!**/node_modules/**'`.
- Pass criteria: the fast layers and `test:ci-gating` exit 0. The search prints nothing and exits 1.
- Layers: typecheck/lint, unit.

#### Phase 2: One browser key, and the guard

1. Set the testnet node in `network-targets.ts` to the `aztec-testnet` load-balancer URL with the key segment
   `REPLACE-WITH-BROWSER-KEY`. No other tracked file may spell that URL out, this plan included, or the guard counts
   it.
   Set mainnet `nodeUrl` to `""`, with a one-line reason. Correct the CSP comment.
2. In `network-targets.test.ts`, assert with booleans: the testnet URL matches
   `^https://lb\.drpc\.live/aztec-testnet/[A-Za-z0-9_-]+$` and does not contain the placeholder (red until Phase 4);
   the CSP names that URL; mainnet's `nodeUrl` is `""`.
3. Add `scripts/ci-cd/node-keys.test.ts`. It reads `git ls-files` and matches
   `lb\.drpc\.live\/[a-z0-9-]+\/[A-Za-z0-9_-]{12,}`. It requires exactly one hit, the `aztec-testnet` line of
   `network-targets.ts`, and prints paths and counts only. The placeholder matches the pattern, so the guard is
   green before the owner's commit.
4. Scrub the four archived copies of the old testnet key to `<KEY>`.

Under A0 (keyless): step 1 sets `https://aztec-testnet.drpc.org`, step 2 asserts that exact URL with no
placeholder test, and step 3 requires zero hits.

**Validation gate**
- Commands: the fast layers; `bun run test:ci-gating`; both builds.
- Pass criteria: only the placeholder assertion fails (none under A0). The key guard passes, and both builds pass.
- Layers: typecheck/lint, unit, build.

#### Phase 3: Docs for the split

1. `AGENTS.md` § Security and `SECURITY.md`: the browser key is public, origin-filtered and capped. The script key
   exists only in 1Password and reaches a run only as a keyed run. For a leak: disable the key in dRPC, then replace
   the constant or the 1Password field.
2. `apps/tools/README.md`, `UPDATE.md` (Testnet node ↔ CSP) and the runbook: `AZTEC_NODE_URL` comes from the
   templates; the runbook's Phase 0 probe becomes a keyed run on `testnet-rpc`.

**Validation gate**
- Commands: `bun run lint`; `bun test scripts/ci-cd/node-keys.test.ts`.
- Pass criteria: both exit 0.
- Layers: lint, unit.

#### Phase 4: Arc 1 quality loop, the owner's keys, PR A

> **Warning:** request no keyed run before the owner confirms the `AZTEC_NODE_URL` field exists.

1. Run the arc 1 quality loop (§ Post-implementation, step 1). Push the branch.
2. Ask the owner, through main, to do these steps in order:
   1. Mint the browser key. Set its allowlist and a daily CU cap (and A3, A4 if approved).
   2. Mint the script key. Store its full URL as `AZTEC_NODE_URL` in `Keyed-Runs/Unleashed-Testnet`.
   3. Replace the placeholder on the branch in one commit titled
      `chore(tools): set the origin-filtered testnet node key`. The GitHub web editor signs it.
3. Fetch the branch. Check that the commit changes one line of `network-targets.ts`, then adopt it with
   `git merge --ff-only origin/worktree-aztec-rc3`, before the probes and the gate.
4. Probe the browser key. Print status codes and `rollupVersion` only. If this host refuses an agent reading the
   key, ask the owner to run the two commands.
   - `node_getNodeInfo` with `Origin: https://testnet.app.unleashed.systems` answers 200 with rollupVersion
     `3409706519`, and no redirect.
   - The same request with `Origin: https://example.invalid` is refused.
   - A preview-shaped Origin (`https://<label>-unleashed-testnet.alejo-amiras.workers.dev`) is served (I1).
   - A request with no Origin header: record the answer. A served answer is expected (dRPC cannot filter what is
     not sent), and it confirms the daily cap is the real bound.
   - An `OPTIONS` preflight with `Access-Control-Request-Method: POST` and
     `Access-Control-Request-Headers: content-type` answers 2xx, for the production and a preview Origin. Its
     `access-control-allow-origin` equals that Origin, and `access-control-allow-headers` admits `content-type`.
     A browser sends this first; a wrong answer found here costs a commit, while one found in Phase 12 is drift
     inside the window.
5. File a keyed run on `testnet-rpc`. It prints the node's `nodeVersion` and rollupVersion, and `distinct` or
   `SAME` for the script key against the browser key. `verify` compares `nodeVersion` exactly through the script
   key, so Phase 10 checks that Phase 8's compatibility entry (from F7) equals this value.
6. Open PR A (§ Delivery) and add the `e2e:tools` label. Merge it under A2.
7. Tell main the old keys may be disabled now (A5).

**Under A0 (keyless)** the owner only mints the script key (step 2.2); steps 2.1, 2.3 and 3 drop. Step 4 probes
the keyless URL: our Origin is served, and the preflight echoes it. It also runs the app's heaviest reads there
once: `getBlocks` with transactions (exit recovery), a tx receipt, and a nullifier membership witness. Step 5
prints `nodeVersion` and rollupVersion, without the key comparison. The public tier's rate limits and lack of SLA are recorded as accepted testnet
limits. The CSP names the exact keyless URL; no wildcard and no fallback host. The branch the owner does not pick
is deleted from this plan at the gate.

**Validation gate**
- Commands: the fast layers; `bun run test:ci-gating`; both builds; the probes in steps 4 and 5;
  `gh pr checks --watch`.
- Pass criteria: every command exits 0, the placeholder test included. `quality-status`, `tools-e2e-status` and
  `bridge-contracts-status` are green.
  - With a browser key: the guard counts exactly one key. The foreign origin is refused, ours is served, and the
    preflight echoes ours. The keyed probe prints `distinct`.
  - Under A0: the guard counts zero keys. Ours is served, the preflight echoes it, and the heavy reads answer.
- Layers: typecheck/lint, unit, build, live (read-only).

### Arc 2 — rc.3 and the generation (PR B, branch `aztec-rc3-line`)

#### Phase 5: Preconditions

1. Create `aztec-rc3-line` from arc 1's tip. The rebase fork is later `git merge-base aztec-rc3-line
   worktree-aztec-rc3` (the local arc 1 branch), so no commit id is written down.
2. Run `aztec-up install 6.0.0-rc.3`. Check that `~/.aztec/versions/6.0.0-rc.3` is complete. Keep the log.
3. Copy or `forge install --no-git` the gitignored `contracts/bridge/evm/{lib,out}`. Never copy `cache/`: forge's
   broadcast cache holds the keyed `SEPOLIA_RPC_URL`. Delete `contracts/bridge/evm/lib/v4-core/.env`.
4. Re-read F5, F7 and F8 from the keyless node and two public Sepolia RPCs. Record them in `lessons/phase-5.md`.
   F13 is superseded by the balance `live-intent build` reads.
5. Record the `bun audit` baseline in `lessons/phase-5.md`: the advisory groups on `main` (it exits 1 today).

**Validation gate**
- Commands: `bun install --frozen-lockfile`; the fast layers.
- Pass criteria: every command exits 0, except the placeholder test while arc 2's base predates the owner's key
  commit. The reads equal F5, F7 and F8.
- Layers: typecheck/lint, unit.

#### Phase 6: The JS line

1. Set the pins. Labs goes to `6.0.0-rc.3`. Foundation `bb.js`, `l1-artifacts`, `noir-acvm_js` and
   `noir-noirc_abi` go to `6.0.0-rc.6`. `aztec-standards`, `private-fee-juice` and `@aztec-labs/txe` go to
   `6.0.0-rc.3`. `@nulo-sh/*` goes to `0.2.0`, after re-checking the npm tarballs' sha256 and provenance (F12).
2. Regenerate the two Noir wasm patches as `@6.0.0-rc.6` and update `patchedDependencies`.
3. Add `@alejoamiras/private-fee-juice` as a standing exemption. Write the reason next to `@nulo-sh`'s, in
   `bunfig.toml`, `SECURITY.md` and `AGENTS.md`.
4. Add a temporary exclude for each name still under the gate. Run `bun install` at the root and in `txe-server`.
   Then remove the temporary excludes.
5. Rewrite `aztec-line.test.ts`, and add the derivation vector to `deployer-keys.test.ts`
   (§ Non-obvious mechanics).
6. Fix the type and API breaks that the typecheck reports.

**Validation gate**
- Commands: `bun install --frozen-lockfile --force`; the fast layers; `bun run test:ci-gating`; `bun audit`;
  the provenance check of `SECURITY.md` for `aztec-standards`, `private-fee-juice` and the three `@nulo-sh` 0.2.0
  packages: exact versions into a scratch npm project outside the repository with `npm install --ignore-scripts`,
  then `npm audit signatures --include-attestations` there. Run bare in this Bun tree, it passes vacuously.
- Pass criteria: `bun audit` is advisory in this repository (`AGENTS.md`), so it passes when it reports no advisory
  group beyond the Phase 5 baseline. An advisory on a package this bump moves is named in `lessons/phase-6.md`.
  Remediating the baseline is a follow-up, not this plan. Every other command exits 0, except the expected reds in
  `lessons/phase-6.md`:
  - the class-id, vector and FPC tests that phases 7 and 8 re-pin;
  - the testnet-manifest case in `bridge-generation.test.ts`, until promotion;
  - the placeholder test, while arc 2's base predates the owner's key commit.
  `aztec-line.test.ts`, `published-packages.test.ts` and the vector test are green.
- Layers: typecheck/lint, unit.

#### Phase 7: The Noir line

1. Move the six `Nargo.toml` tags to `v6.0.0-rc.3`. Spell the URL exactly as the standards spell it.
2. Re-vendor `token_portal_content_hash_lib` from `aztec-labs-eng/aztec-node` at `v6.0.0-rc.3` (`c5cf1822…`), and
   update its header.
3. Move the `AZTEC_HOME` defaults in `compile.sh`, `nargo.sh` and `run-txe-tests.sh`.
4. Pass `immutables_hash: 0` at both `txe_oracles::deploy` calls in `test/utils.nr`. Re-check the
   `should_fail_with` strings in `register.nr` and `exits.nr`.
5. Recompile and commit `target/*.json`. Re-pin the class ids, every Token class-id copy, the derived-address
   vector in `hub-token.test.ts` and `keystone.nr`, and `fixtures/sandbox-manifest.json`.

**Validation gate**
- Commands, as `_bridge-contracts.yml` runs them:
  - `bash contracts/bridge/aztec/scripts/compile.sh --check token_bridge_hub`;
  - `bash contracts/bridge/aztec/scripts/nargo.sh contracts/bridge/aztec/keystone test --force`;
  - `bash contracts/bridge/aztec/scripts/nargo.sh contracts/bridge/aztec/token_bridge_hub test --force keystone`,
    whose output must report at least one passed test. The wrapper pins the toolchain; the shared `current` one
    may differ;
  - `bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate token_bridge_hub`;
  - in `contracts/bridge/evm`, after `bun packages/bridge-core/scripts/gen-remappings.ts`: `forge build`,
    `forge test --no-match-contract Fork`, and
    `forge snapshot --match-test test_gas_ --no-match-contract Fork --check --tolerance 2`;
  - halmos as the workflow runs it, with its proof-name checks;
  - `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh`;
  - the fast layers.
- Pass criteria: every command exits 0, and each name-filtered run proves it ran tests. The expected-red set
  shrinks by the re-pinned files.
- Layers: contract suites, unit.

#### Phase 8: The PrivateFPC

1. Set `PRIVATE_FPC_ADDRESS` and the descriptor from F3: `aztecVersion`, `expectedAddress`, the installed
   artifact's `artifactSha256`, a compatibility entry with the node's `nodeVersion`, and its `$comment`. The
   network pins wait for Phase 9.
2. Give `check-fpc-version.ts` one behaviour (`runFpcGate()`), and update both callers.
3. Move `registerPrivateFpc` from `fuel-testnet.ts` to `script-l2.ts`. Make the sandbox use it instead of
   `ensurePrivateFpc`. At the end of the smoke's flows, before teardown, assert that the node reports no contract
   at `PRIVATE_FPC_ADDRESS`; an RPC error fails the assertion.
4. Delete `deploy-private-fpc-testnet.ts`. Keep `deploy-canonical-private-fpc.ts` and its test: the frozen mainnet
   script imports them. Fix that script's stale "Next:" line.
5. Fix the AGENTS.md Nulo table row, runbook step 6, `UPDATE.md` § Canonical PrivateFPC and the header of
   `fpc-dust-canary-mainnet.ts`: neither repository deploys the testnet FPC, and the gate has no mode. A re-pin is
   announced to the wallet's repository.

**Validation gate**
- Commands: the fast layers; `bun run --cwd packages/bridge-core test -- src/private-fuel.test.ts`;
  `rg -n --hidden 'require-deployed|deploy-private-fpc-testnet' --glob '!implementations-plan/**' --glob '!.git/**' --glob '!**/node_modules/**'`.
- Pass criteria: the FPC test re-derives F3's address. The search prints nothing and exits 1. The expected-red set
  shrinks by the FPC tests.
- Layers: unit.

#### Phase 9: Chain cascade, trust anchors, local rehearsal

1. Set `TESTNET_ROLLUP_VERSION = 3409706519`. Update every old-identity literal (recon § Identities), the
   `live-intent.test.ts` fixtures included, and the FPC descriptor's network pins.
2. Move the L1 fork fixtures and `contracts/bridge/evm/.env.example` to the portal `0x6974…Ce59`.
3. Write `lessons/reset-baseline.json` from F5 and F6, with no URL field. Point `NO_RESET_BASELINE` at it. Add
   `implementations-plan/aztec-rc3/lessons/` to `OPERATIONAL_ALLOWLIST`.
4. Retire `deploy-journal/testnet-generation.jsonl`: delete it in its own commit. Git history keeps it.
5. Run the sandbox smoke. Copy the faucet record it writes, `packages/bridge-core/sandbox-deploy/deployments.json`,
   to `apps/tools/src/contracts/deployments.json`, and commit it. The browser suite's global setup refuses a
   difference.
6. Clear `apps/tools/node_modules/.vite`. Run the browser suite and the integration suite.

**Validation gate**
- Commands: `bun run --cwd packages/bridge-core deploy:sandbox --smoke`; `bun run e2e:tools`;
  `bun run --cwd packages/bridge-core test:integration`; the fast layers; both builds;
  `rg -n -i --hidden '2914217885|2904119610|0x5bb7523a' --glob '!.git/**' --glob '!**/node_modules/**' --glob '!implementations-plan/**' --glob '!bun.lock'`
  (case-insensitive, because the Solidity files spell the portal checksummed).
- Pass criteria:
  - Every command exits 0, except the testnet-manifest case and the placeholder test.
  - The smoke runs all its steps, the PrivateFPC credit flows included, and the FPC is absent at its end.
  - The search hits only `apps/tools/public/testnet-bridge.json`, which changes at promotion. Phase 11's gate
    re-runs it and expects nothing (exit 1). Each run is reaped by its own process group.
- Layers: unit, contract suites, sandbox smoke, browser e2e.

#### Phase 10: Rebase, then the arc 2 quality loop (before any key)

1. Wait for PR A to merge. Fetch `origin/main`, and rebase `aztec-rc3-line` onto it from the fork
   (§ Delivery). Check that Phase 8's FPC compatibility `nodeVersion` equals Phase 4's keyed probe. Re-run the
   Phase 9 gate.
2. Run the quality loop over arc 2's diff (§ Post-implementation, step 1), focused on the deploy path.
3. Commit every fix. Check `git status --porcelain` is empty.

**Validation gate**
- Commands: the Phase 9 gate, re-run after the last fix.
- Pass criteria: the placeholder test is gone from the expected reds. The loop's last round yields no material
  finding, quoted in `lessons/phase-10.md`.
- Layers: all local layers.

#### Phase 11: The live generation (keyed runs, A1)

> **Warning:** from step 1 until Phase 12's final verify, change nothing outside `OPERATIONAL_ALLOWLIST`. Record
> progress in `lessons/` only. Run one signing command at a time. Commit each run's output before the next request.

0. Only if A7 is "pause", before `build`: `pause-factory.ts --config apps/tools/public/testnet-bridge.json
   --factory <rc.1 factory> --deposits paused --dry-run`, then the live run (testnet-l1). It needs the signer's
   nonces finalized. `build` then reads the balance after the pause, so the 2.0 ETH cap covers the rest.
1. `live-intent.ts build implementations-plan/aztec-rc3/lessons/intent.json` (testnet-l1). Commit the intent.
2. Check the four Sepolia tokens: code, `decimals()`, `maxMintPerTx()`, and sorted below WETH. Read back each
   TOKEN/WETH pool and the ETH/FJ pool: liquidity, and a quote for a quarter token.
3. `SKIP_POOL_SEED=1 SEED_TOKENS=<USDC>,<USDT> deploy:generation deploy --dry-run`, then the live run
   (testnet-generation, `verify` chained ahead). Delete forge's broadcast cache.
4. `deploy:testnet --output <outside the repository>` (testnet-faucet). Its output must equal the committed
   `deployments.json` byte for byte. Serialize it with the conductor.
5. `check-fpc-version.ts` (testnet-rpc). It must be green before any Fee Juice moves. It reports the FPC absent,
   or published with the expected classes; this plan publishes nothing.
6. Chain `verify` ahead of each signing run (A1). Every `fuel-testnet.ts` run takes
   `--config apps/tools/public/testnet-bridge.candidate.json` and a `FUEL_SLICE_UNITS` whose live quote clears the
   carried `minFuelFj` floor (runbook step 9).
   1. `smoke-existing-testnet.ts` and `smoke-swap-existing-testnet.ts` on the candidate;
   2. `pre-create --no-register --token <EURC>`, then `fuel-testnet.ts --token <EURC>`, for the paid public
      first-registration sample;
   3. `pre-create --no-register --token <GBPC>`, then `PUBLIC_RUNS=0 fuel-testnet.ts --token <GBPC>` with
      `PRIVATE_RUNS` unset, for three private runs that start with the private first claim. This is the full
      calibration the `minFuelFj` follow-up asks for.
7. `calibrate --samples <path outside the repository>`. The candidate is final. `minFuelFj` keeps the carried
   floor, because it is a source constant (F17) and a source edit inside the window is drift. Step 6.3's measured
   ceiling goes into `lessons/phase-11.md` and a follow-up.
   > **Stop:** if step 6.3's worst measured private ceiling exceeds `MIN_FUEL_FJ`, stop before `verify --candidate`
   > and ask the owner. The floor is what keeps a user's fuel above the private claim's cost (`gas-share.ts`); a
   > floor below the ceiling would ship green and strand Fee Juice.
8. `verify --candidate` (testnet-rpc). Commit the intent. Delete the old `testnet-bridge.json` in its own commit.
   `promote --bridge-only` (testnet-rpc). Commit the promoted manifest and the receipt.
9. Send main the four `tokens[].l2Token` addresses for the wallet's repository.

**Validation gate**
- Commands: `live-intent.ts verify <intent> --candidate <candidate>`, then `promote`; the Phase 9 identity search.
- Pass criteria: the receipt is committed. `testnet-bridge.json` equals the promoted candidate. All four tokens
  are registered. The spend tally stays under 2.0 ETH. The search prints nothing and exits 1.
- Layers: live testnet.

#### Phase 12: Canaries and the final verify

1. Run the canaries of runbook step 9 against the promoted manifest:
   - `verify:l1 --strict`;
   - `verify:deployments` on the live manifest;
   - `check-fpc-version.ts`, then `PRIVATE_RUNS=1 fuel-testnet.ts --config apps/tools/public/testnet-bridge.json`
     with a quote-validated `FUEL_SLICE_UNITS`;
   - `fee-juice-canary-testnet.ts`, `drip-canary-testnet.ts`;
   - the token-list test with `TOKEN_LIST_LIVE=1`.
2. Push `aztec-rc3-line`. Load its Workers Builds preview in Chromium. Check that no CSP violation appears, and
   that the network log shows the boot `node_getNodeInfo` POST answered 200 with rollupVersion `3409706519`. The
   app stays mounted when that call fails, so a loaded page alone proves nothing.
3. Ask the owner for the manual Nulo wallet check on the preview (A6).
4. Run the final `live-intent verify` (testnet-rpc). The freeze ends.
5. Mark phases 5–12 ✓ in this file.

**Validation gate**
- Commands: the canaries above; the final `verify`.
- Pass criteria: every canary exits 0, and the private self-paying claim settles. The preview loads with no CSP
  violation. The final verify is green. Each success line is quoted in `lessons/phase-12.md`.
- Layers: live testnet.

#### Phase 13: Docs and the final gates

1. Update `UPDATE.md` (current line, couplings) and the runbook. Add to `follow-ups.md`:
   - lifi-routing rebases onto rc.3, scrubs its two intents (F15), adopts the per-scope line rule, and redeploys
     its router over this generation's factory;
   - `MIN_FUEL_FJ` moves to Phase 11's measured private ceiling, in a source change before the next generation;
   - rc.1 testnet records stay withheld;
   - mainnet stays on its line;
   - Aztec 6.0.0 final will need a new generation.

**Validation gate**
- Commands: the fast layers; `bun run test:ci-gating`; `bun run audit:tools`; `bun run lint:actions`; `bun audit`;
  `bun run e2e:tools`; both builds.
- Pass criteria: every command exits 0, with **no expected reds**, except `bun audit`, judged as in Phase 6.
- Layers: all local layers.

## Decision ledger

Sources: **M** the lead's draft, **C** Codex's draft (`gpt-6.1-sol`), **F** the Claude leg's draft (Opus 5.5).

| # | Decision | Source | Rejected alternative and why |
|---|---|---|---|
| D1 | Two PRs. PR A (keys) merges alone first; PR B carries rc.3, the generation and the close-out | owner, M, C, F | A docs-only third close-out PR: arc 1 merges long before the plan can close |
| D2 | One browser literal, in `network-targets.ts`; `testnet-node.ts` deleted | M, F | C: keep `testnet-node.ts` behind a subpath export. It is also one literal, but it keeps an export that no script uses after the split |
| D3 | `requireAztecNodeUrl` in the existing `script-bootstrap.ts`, called at operation entry | F | M: a new `node-url.ts` subpath (an extra module for one function). Module-scope resolution (C): it breaks the six importers of `live-intent.ts` |
| D4 | The intent records no node URL and no origin; the template reference pins the endpoint | F | M: record the origin (it leaks keys in a subdomain, and it adds nothing to the identity re-probe). A hash of the URL (no gain) |
| D5 | Tests compare node URLs with booleans; the key guard prints paths only | C, F | Plain equality, which prints both values on failure |
| D6 | `node-keys.test.ts` covers the whole tree; the four archived copies are scrubbed | F | M: exclude `archive/` from the guard. That would let a future archived record with a key pass, as lifi's intents would (F15) |
| D7 | `check-fpc-version.ts` has one behaviour | M, C, F | Keep `--mode` for mainnet (C): mainnet's FPC is published, so the single behaviour checks it the same way |
| D8 | `SKIP_POOL_SEED=1`, after reading back the persisting pools | C | Seed as on a fresh network: a seed on an existing pool adds liquidity again |
| D9 | EURC for the public first-registration sample; GBPC for the full private calibration | C | Register all four in the deploy: it spends both first-registration samples |
| D10 | The lead recommends leaving the rc.1 factory unpaused (known limit); the owner decides at A7 | M | C, F: pause it. Only test tokens are at stake. The old app usually dies at boot, but not in a stale tab, so the limit is real, and small |
| D11 | PR A merges, and arc 2 rebases onto it, before `build`. No fallback | F | M: build on arc 1's unmerged tip. A late PR A fix, or the owner's key commit, would then be drift inside the window |
| D12 | `@nulo-sh/*` 0.2.0 pinned in Phase 6, before the rehearsal and the deploy; a vector test pins the derivation | owner (Q9), M, C, F | Deploy on 0.1.0 and swap after promotion: the order existed only while 0.2.0 was unpublished, and it put a dependency change after the deploy |
| D13 | The temporary exclude leaves right after the install | F | M: remove it at Phase 13. Both work; removing it early makes the committed `bunfig.toml` final before `build` |
| D14 | Sandbox-reproduced `deployments.json` committed in Phase 9; `promote --bridge-only` | F (aztec-v6 phase 4) | Promote the faucet candidate: the browser suite needs the record earlier |
| D15 | Runs that sign nothing use `testnet-rpc`, which has no signer. Each signing run chains `verify` ahead on its own template | F, contradiction-check | `testnet-rpc` for every `verify`: the signer re-check skips without `PRIVATE_KEY`, so signing groups would lose it. `testnet-l1` for everything: it puts `PRIVATE_KEY` into runs that sign nothing |
| D16 | `aztec-line.test.ts` reads the foundation version from labs' own lock entry and checks the patch keys | F | Hard-coded expected versions (C): the next line would need a test edit |
| D17 | The browser endpoint: a new filtered key (the plan's default) or the keyless public endpoint, the owner's call (A0) | contradiction-check (F) | The lead recommends keyless; the default stays the key because the owner's brief named it |
| D18 | `minFuelFj` keeps the carried floor this arc; the measured private ceiling becomes a follow-up | contradiction-check | Set it inside the window: a source edit there is drift, and a hand edit of the candidate is forbidden |

Still disputed after consolidation: none.

## Audit verdicts

**Contradiction-check.** Codex (`gpt-6.1-sol`, high): *revise before approval*. Claude leg (Opus 5.5):
*conditional approve*. Each claim was checked against the repository before adoption.

| Finding | Leg | Disposition |
|---|---|---|
| `pre-create` needs `BRIDGE_DEPLOYER_SECRET_TESTNET`, which `testnet-l1` lacks | both | Adopted: A1 routes it to `testnet-generation` |
| Candidate fuel runs default to the live manifest, and a quarter-token slice can miss the floor | C | Adopted: Phase 11 step 6 |
| Phase 1 deletes `TESTNET_NODE_URL` while two tests and a comment still use it | both | Adopted: Phase 1 step 7 |
| The placeholder fails the key guard's pattern | C | Rejected: `REPLACE-WITH-BROWSER-KEY` matches `[A-Za-z0-9_-]{12,}`; `<KEY>` is the archive scrub, not the bundle |
| Phase 8 runs vitest through `bun test`; the hub keystone filter runs in the wrong crate; `rg` exit codes | C | Adopted: Phases 7–9 |
| Phase 9's identity search hits the live manifest and this plan | both | Adopted: excluded the plan; the manifest is expected until Phase 11 re-runs the search |
| `minFuelFj` is a source constant, so "set it in the window" is drift | F | Adopted: D18 |
| D15 drops the signer re-check before signing groups | F | Adopted: D15 revised |
| The browser path is first proven inside the window | F | Adopted: the Phase 4 preflight probe |
| Phase 8's search misses `UPDATE.md`, the mainnet canary header, and hidden directories | F | Adopted: Phase 8 step 5 and `--hidden` |
| Live FPC absence cannot be required, because anyone may publish it | C | Adopted: § Architecture, Phase 11 step 5 |
| D10's boot guarantee is overstated | C | Adopted: § Security, D10, A7 |
| The Delivery fallback contradicts D11 | C | Adopted: deleted |
| Removing URL logs does not prove error text is key-free | C | Adopted: the sentinel-key test |
| The keyless endpoint is a missing alternative | F | Adopted: A0, D17 |
| Copying `cache/` copies the keyed RPC URL | F | Adopted: Phase 5 step 3 |
| A4's port is 5176, the placeholder wording, D3's attribution | both | Adopted |

**Double audit.** Codex (resumed): *conditional approve*, high confidence in the structure, moderate in A0's
recommendation. Claude leg (fresh Opus 5.5): *conditional approve*, moderate confidence. Both confirmed the
placeholder rejection, the 0.2.0-first order, and that no window edit leaves the allowlist.

| Finding | Leg | Disposition |
|---|---|---|
| A0's branch left the key-only probes and owner steps unconditional | C | Adopted: Phase 4 and Delivery split by branch; the unpicked branch is deleted at the gate |
| A0's evidence covers boot, not the app's heavy reads | C | Adopted: Phase 4 runs them on the keyless URL; limits recorded as accepted |
| `bun audit` exits 1 on `main` today, so "exits 0" can never pass | both | Adopted: Phase 5 baseline; judged against it (repository policy makes it advisory) |
| `npm audit signatures` run bare in this tree passes vacuously | F | Adopted: the scratch-project check from `SECURITY.md` |
| The fee-juice exemption contradicts `SECURITY.md`'s "no other name" | F | Adopted: recorded in Owner decisions; Phase 6 amends the line |
| Local Noir gates use the shared toolchain | C | Adopted: `scripts/nargo.sh` |
| The drip canary writes to L2 | C | Adopted: A1 wording |
| A7 "pause" had no step | C | Adopted: Phase 11 step 0 |
| F8 not re-read; F13 goes stale | C | Adopted: Phase 5 step 4 |
| The identity search is case-sensitive and skips hidden files | F | Adopted: `-i --hidden`; the test fixtures move too |
| No stop if the measured private ceiling exceeds `MIN_FUEL_FJ` | F | Adopted: Phase 11 step 7 stop |
| The Aztec node client prints the URL on a failed call | F | Adopted: named as a residual in § Security |
| `nodeVersion` read only from the keyless node; I1 and no-Origin untested | F | Adopted: Phase 4 steps 4–5 |
| A dRPC-shaped sentinel would trip the guard | F | Adopted: a `node.invalid` host |
| The candidate is gitignored | F | Adopted: § Non-obvious mechanics |
| A test path, four stale comments, `index.md` uncommitted | F | Adopted: change map, Phase 1 |
| Visible surfaces unstated | F | Adopted: "Visible surfaces: none" |

**Final pass.** Codex (`gpt-6.1-sol`, high, fresh session): **`VERDICT: conditional approve`, high confidence.**
Its six conditions are all adopted:

| Finding | Disposition |
|---|---|
| The owner's key commit is fetched but never adopted; the Phase 10 rebase may use a stale `origin/main` | Phase 4 step 3 fast-forwards; Phase 10 fetches and rebases from the merge-base fork |
| The sandbox gate cannot see FPC absence, because the CLI stops the node first | Phase 8 step 3 asserts absence inside the smoke, before teardown |
| The preflight probe omits `content-type`; a mounted page does not prove the node call | Phase 4 step 4 asks for the header, on production and preview Origins; Phase 12 reads the network log |
| A0 dropped the `nodeVersion` that Phase 10 compares | A0's step 5 keeps it |
| The sandbox writes its faucet record under `sandbox-deploy/`, not the app's path | Phase 9 step 5 copies it |
| A7's pause runs before any intent, so A1's chained `verify` cannot apply | A1 names the exception and its own gate |

Resumed on the revised plan, the same session returned **`VERDICT: approve`, high confidence**: all six conditions
met, no new contradiction or broken command, no window edit outside the allowlist.

## Post-implementation

This section is the execution contract. `code_review` is `off`, so there is no `/code-review` step.

1. **Quality loops.** There is one loop per arc, plus a final cross-arc pass:
   - **Arc 1** at Phase 4 step 1, over `git diff origin/main...worktree-aztec-rc3`.
   - **Arc 2** at Phase 10, over arc 2's diff from `origin/main` after the rebase. It excludes `target/*.json`,
     lockfiles and the retired journal, by name.
   - **The final cross-arc pass** after Phase 13, in a fresh Codex session, over PR B's net diff. It covers the
     post-window commits.

   Each loop runs these steps:
   1. Call `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with the
      diff, this plan and its ledger, the adversarial ask, and the two rules below, verbatim. The adversarial ask:
      *"What could go wrong? What would an attacker target? What are we trusting that we shouldn't? Where are the
      supply-chain / crypto / least-privilege weaknesses?"* The cross-arc pass asks instead for seams between the
      arcs, duplication across them, and drift from this plan.
   2. Verify Codex's factual claims against the repository.
   3. Apply the accepted fixes, commit them, and log the round in `lessons/phase-N.md`.
   4. Resume the same session with `resume-codex.sh` and the fix diff.
   5. Repeat until a round yields no new material finding. Rejected nitpicks do not count.
   6. If findings are still material after 3 rounds, stop and surface them to the owner.

   A fix that adds persistent state, a lifecycle, a coordination protocol, a recovery policy or a public contract
   is a plan change: stop for the owner. A fix that would change deployed state is surfaced, never applied in a
   loop.
2. **Delivery** per § Delivery. This is the first time each PR opens.
3. **Close-out**, as PR B's final commits:
   1. Write `## Outcome` after the front matter. It records the status, what shipped with PR numbers, and the
      deployment record (addresses, digests, caps; no timestamps, no commit ids). It also records what was dropped
      and why, `Known limits:`, `Open items:`, and one line retiring the seeds below.
   2. Promote the generalizable gotchas into `implementations-plan/lessons.md`. Stay under 8 KiB, deduplicate, and
      retire what they supersede.
   3. Add the open items to `implementations-plan/follow-ups.md`. This repository keeps open work there
      (`AGENTS.md` § Plans).
   4. Strip timestamps and commit ids from `lessons/intent.json` and the receipt.
   5. `git mv implementations-plan/aztec-rc3 implementations-plan/archive/aztec-rc3`, in its own commit.
   6. In the next commit:
      - point `NO_RESET_BASELINE` at `implementations-plan/archive/aztec-rc3/lessons/intent.json`;
      - replace the allowlist entry with the archived path;
      - repair every `git grep -n aztec-rc3` link;
      - move the `index.md` line to `archive/index.md`.
   7. Watch the checks with `gh pr checks --watch`. Report, then stop unless A2 allows the merge.
4. **Teardown after PR B merges.** The trigger is
   `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/aztec-rc3/plan.md`.
   In this run the coordinating session tears down: this session reports the merge and stops. A session that owns
   the teardown runs `ExitWorktree` with `keep` if it entered through `EnterWorktree`, then
   `agent-worktree done unleashed/aztec-rc3 --merged`, and relays a refusal without forcing past it.

**The no-over-engineering rule** (verbatim in every post-impl Codex prompt): *"Report bugs and small, targeted
improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites
— the smallest change that fixes each real problem. If code works and is clear, leave it alone."*

**The comment-quality rule** (verbatim in every post-impl Codex prompt): *"Audit the comments for value per
character. Flag any comment that narrates what the code visibly does, restates its line, references
implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a
non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every
future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*

**While implementing:**
- Write comments to the bar as the code is written.
- Log each meaningful attempt in `lessons/phase-N.md`.
- At each gate, run `agent-worktree status unleashed/aztec-rc3 "phase N green: <next>"`.
- Stop and reassess after 3 failures on one step, or 5 in a `/loop` run.

## Delivery

| Arc | Phases | Branch → base | PR title | `/code-review` |
|---|---|---|---|---|
| 1 | 1–4 | `worktree-aztec-rc3` → `main` | `fix: move the drpc keys out of the repository and origin-filter the browser key` | off |
| 2 | 5–13 + close-out | `aztec-rc3-line` → `main` | `feat!: move to aztec 6.0.0-rc.3 and deploy a new testnet generation` | off |

- Two plain branches; no `gh stack`. PR A merges first and alone.
- Arc 2 runs phases 5–9 while PR A is in review. At Phase 10, after PR A merges, it rebases:
  `git fetch origin main`, then `git rebase --onto origin/main <fork> aztec-rc3-line`, where `<fork>` is
  `git merge-base aztec-rc3-line worktree-aztec-rc3`. Then `git push --force-with-lease` to this branch
  only. Never rebase inside the live window (D11). If PR A cannot merge, the deploy waits.
- The close-out is PR B's final commits, not a third PR (D1).
- Each PR opens with `gh pr create` only after its quality loop converges. Add the `e2e:tools` label after it opens,
  never at creation. Check `mergeable` if no CI appears.
- Parallelism: arc 2's local phases overlap PR A's review, as above. Nothing else runs in parallel: both arcs edit
  `live-intent.ts`, `check-fpc-version.ts` and `fuel-testnet.ts`.
- Owner steps, in order:
  1. Mint the script key and store it (Phase 4). With a browser key (not A0): also mint it, set its allowlist and
     cap, and commit it (Phase 4).
  2. Confirm the `AZTEC_NODE_URL` field exists, before any keyed run.
  3. Disable the old keys (A5).
  4. Approve each keyed run (Phases 4, 11, 12).
  5. Fund the signer if the tally runs short.
  6. Run the manual wallet check (Phase 12).
  7. Merge, or let the agent merge under A2.

## Seeds

Draft until the approval gate.

**Recommended: `/goal`** (completion is visible in the transcript):

```
/goal All phases of implementations-plan/aztec-rc3/plan.md marked ✓ in that file, each backed by its validation gate reported passing in the transcript; for each phase the agent printed `LESSONS_FILE=implementations-plan/aztec-rc3/lessons/phase-N.md`; `/code-review` was NOT run (code_review: off); the Codex loop converged for arc 1, for arc 2 before `live-intent build`, and for the final cross-arc pass, each shown by a resumed Codex pass reporting no new material findings, quoted in the transcript; PR A and PR B exist on GitHub (`gh pr view` output in the transcript), each opened only after its loop converged, and PR B's final commits include the archive move (`git show --stat` in the transcript); `bun run test:all` and `bun run lint:actions` both exit 0 in the transcript. Never broadcast outside the live authorization, never print a secret, never merge without the owner's A2 answer.
```

**Fallback: `/loop`**

```
/loop 15m Drive implementations-plan/aztec-rc3 forward. Never idle waiting for input. Each firing: (1) Reality check: read plan.md and lessons/ (authoritative), including its Outcome & Quality Bar; if the plan path is gone, check `git fetch -q origin main && git cat-file -e FETCH_HEAD:implementations-plan/archive/aztec-rc3/plan.md`: success means merged, so report it and stop; failure means delivered and awaiting merge, so babysit CI only. Otherwise rebuild the task list from plan.md, run `git status`, `git log --oneline -5`, and `gh pr view --json statusCheckRollup` when a PR exists. (2) Waiting on CI or on an owner step (key, keyed-run approval, wallet check) is fine: report the wait once and prepare the next phase. (3) No task in hand: take the next pending step; after each edit run `bun run lint` and the touched package's tests; commit and push the branch. (4) A decision you would bring to the owner: consult Codex (`run-codex.sh … high read-only gpt-6.1-sol`), log it in lessons/, then act — except the hard limits: no merge without A2, no broadcast outside A1, no secret handled, no scope beyond this plan. (5) The same step failed 5 times: reassess with Codex. (6) Phase gate green: paste it, mark ✓ (never inside the live window), print LESSONS_FILE, advance; at an arc boundary run that arc's quality loop first. (7) All phases ✓: run § Post-implementation from where it stands, then report and stop.
```

Use exactly one per session; they do not compose.
