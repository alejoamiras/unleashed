# Phase P4 — Identity generation: standards swap + fee-payment 5.0.1 + Noir. STATUS: ◑ trust STOP-gate CLEARED; swap + fee-payment + Noir remain.

## Trust STOP-gate (conditional Ask #1) — CLEARED, not a stop
The audit-hardened provenance gate for adopting `@aztec-foundation/aztec-standards@5.0.1` PASSES on
every dimension (verified read-only via npm registry + attestation API, no install):

- **Provenance present**: two attestations — npm publish v0.1 + `https://slsa.dev/provenance/v1`.
- **Subject binds the package**: `pkg:npm/@aztec-foundation/aztec-standards@5.0.1`.
- **Source repo binding**: SLSA `workflow.repository = https://github.com/AztecProtocol/aztec-standards`,
  `workflow.ref = refs/tags/v5.0.1`, buildType GitHub-Actions-workflow, invocation
  `github.com/AztecProtocol/aztec-standards` Actions run `29506443626`.
- **PEELED COMMIT RECORDED** (later movement fails the build): resolvedDependency
  `git+https://github.com/AztecProtocol/aztec-standards@refs/tags/v5.0.1` →
  **gitCommit `c74541f7cf2bb23b704e96fd326ea95d98252669`**.
- **Reverse anchor**: the published package's own `name` @ 5.0.1 = `@aztec-foundation/aztec-standards`
  (matches the intended target).
- **NO install scripts**: `npm view …@5.0.1 scripts` is EMPTY (no pre/post/install hooks).
- Published versions: `5.0.1-rc.1`, `5.0.1`.

⚠️ **FLAG for the swap step**: unpacked size is **102 MB across 81 files** (`unpackedSize
102544762`) — far larger than a pure-source standards package; almost certainly bundled compiled
circuit/contract artifacts. Do a layout diff vs the old `@alejoamiras/aztec-standards` at swap time
and confirm what those 102 MB are before pinning (a min-age exclude will be needed too — the package
is fresh, and `@aztec-foundation/aztec-standards` is NOT yet in `bunfig.toml` excludes).

Since the attestation is PRESENT and correctly bound, this is NOT the conditional-ask STOP — P4
proceeds to the swap.

## Remaining P4 work (the swap + fee-payment + Noir)
- Swap the 5 `package.json` + ~22 import sites `@alejoamiras/aztec-standards` →
  `@aztec-foundation/aztec-standards`; add the new name to `bunfig.toml`
  `minimumReleaseAgeExcludes` (dated, removal follow-up); zero-`@alejoamiras/aztec-standards` sweep;
  layout diff vs old package (resolve the 102 MB flag).
- **fee-payment → 5.0.1**: the FPC identity re-pin + compat map (`@alejoamiras/aztec-fee-payment`
  currently HELD at 5.0.0 from P1). This shifts FPC identity → coordinate with the P6 live redeploy.
- **Noir 5.0.1 recompile**: needs the noir toolchain (nargo/bb) — a build step that may not be
  runnable on this host; the recompiled artifacts gate the faucet build (`verify:deployments`).
- Full P1-style install ritual (rm bun.lock → provenance re-verify → frozen-lockfile).
- Suggest `npm deprecate @alejoamiras/aztec-standards` to the user (their npm auth — NOT AFK).

## Gate (per plan)
Trust STOP-gate green (DONE — above); swap complete + zero-old-name sweep; `test:all` + lint green;
Noir artifacts recompiled + `verify:deployments` green. The fee-payment identity shift couples to P6.

`LESSONS_FILE=implementations-plan/archive/aztec-5.0.1-line/lessons/phase-p4.md`

## CI failure taxonomy CORRECTED (again): tests RUN and FAIL; "Address already in use" is benign noise

**What the reruns actually show** (evidence: `gh run view --log-failed`, all 6 failing jobs):
- Every shard reached `Local Aztec node is ready` AND `Test contracts deployed` — the sandbox boots
  fine everywhere. `[aztec-node] Error: Address already in use (os error 98)` appears exactly ONCE per
  boot, on CI and locally, immediately before the node banner — it is a benign internal message the
  node emits every boot, not a failure. (Third mis-read of this string; it must never again be
  treated as a boot-failure signal without checking for `node is ready` AFTER it.)
- The REAL failures are test-level, in the wallet's network e2e, and deterministic on CI
  too. The standards swap killed `0x0193c31b`, but a SECOND bug stalls the wallet's token import.
- Correction on the port-allocator fix: the below-ephemeral-floor allocation is real
  hardening (the resolve→build→bind TOCTOU window exists), but it was NOT the cause of these red
  runs — the commit message over-attributes. Keep the fix; drop the narrative.

## ✅✅ The wallet's token-import "hang" ROOT-CAUSED + FIXED: crate-prefixed struct paths broke descriptor matching

**Root cause** (proven by running the pure matcher against the real installed artifact): the
5.0.1 `@aztec-foundation/aztec-standards` Token artifact namespaces AztecAddress params by the
artifact's import chain — `authorization_contract::aztec::protocol_types::…::AztecAddress` — while
the wallet's predicates exact-matched `aztec::protocol_types::…::AztecAddress`. Six kinds
(both balances + all four transfers) resolved ZERO candidates, so the wallet could not detect the
token's interface. The wallet now compares struct paths crate-prefix-tolerantly.

**Method lesson (the one that ended a 9-misdiagnosis streak): when a pipeline "hangs", sample the
UI's own state machine** (button label + rendered error) — it names the stuck stage instantly and
distinguishes "stuck" from "cleanly errored with no toast". And when an ABI consumer misbehaves
after a package swap, run the PURE matcher against the REAL artifact before theorizing about
runtime/sync/eviction.

## CI CONFIRMATION: the wallet's descriptor-path fix clears its ENTIRE network suite
P4's remaining open items: deploy-script 5-arg arity + descriptor regen (P6-coupled), Noir
recompile against 5.0.1 toolchain, fee-payment tarball source-binding diff.

## fee-payment SOURCE BINDING PROVEN + Noir recompile on 5.0.1

**Source binding (the audit's "the diff is the review"):**
- Publish tag resolved: the npm `@alejoamiras/aztec-fee-payment@5.0.1` tarball's `package.json`
  byte-matches `ecosystem-tooling@v5.0.1` (NOT `v5.0.1-revision.1`, which differs only in
  TS/tests/docs/audit files — the FPC Noir source is untouched between the tags).
- `canonical-deployment.json`: byte-identical across tarball, v5.0.1, and v5.0.1-revision.1;
  salt/aztecVersion/expectedAddress match our `private-fpc-canonical.json` (the published file has
  no `deployer` key — our ZERO-deployer pin is bound via the address re-derivation instead).
- Tarball artifact sha256 == our descriptor pin (`94fa4c71…`).
- **Rebuild-compare**: fresh `aztec compile` of the FPC at `ecosystem-tooling@v5.0.1` with the
  5.0.1 toolchain → raw digests differ ONLY via the debug `file_map` (machine-local paths);
  stripping `file_map`, the core digests (bytecode+ABI+VKs) are EQUAL: `e35b7bb75687a5dc…` both
  sides. The published package IS its tagged source. (Gotcha: the 5.0 CLI shells out to bare
  `nargo`; export `NARGO=$AZTEC_HOME/bin/aztec-nargo` + `BB=…/bb` or compile dies ENOENT — same
  wiring our compile.sh already documents.)

**Noir recompile (tags → v5.0.1 ×3, upstream token dep, toolchain already installed):**
- `aztec-packages` deps → `v5.0.1` (peeled `b97ff8c3e88f…`); token dep moved
  `alejoamiras/ecosystem-tooling → AztecProtocol/aztec-standards @ v5.0.1` (peeled
  `c74541f7cf2bb23b704e96fd326ea95d98252669`; `src/token_contract` path verified via API at the
  tag before edit). compile.sh → 5.0.1. All three compile clean; artifacts path-scrubbed
  (no home/abs paths — verified).
- Class-id table (address shifts follow at the P6 redeploy):

| contract | old class id | new class id |
|---|---|---|
| TokenMinterProxy | `0x055b5878e732a09a…` | `0x07689a539bf0a60a…` |
| TokenBridge | `0x0aea399e74e99a55…` | `0x2206e145ab6054f1…` |
| keystone (bin) | artifact byte-identical (`402be972…`) | unchanged |

- keystone `nargo test` 3/3 ✓; bridge-core suite 136/136 ✓ (tripwire + derivation pins green
  against the new state).

## P4 CLOSED: FPC gate redesign verified live; gate green end-to-end
- **Gate redesign**: `--mode predeploy|require-deployed` REQUIRED (predeploy green on
  clean absence; require-deployed red until the P6 deploy — mandatory before funding/canary/
  promotion); digest-keyed human-curated compat map (`94fa4c71… → ["5.0.0","5.0.1"]` — missing
  entry fails closed, compat never inherited across digests); hard l1ChainId=11155111 +
  rollupVersion=1821665230 pins (re-verified live).
- **Live-node RPC gotcha**: the v5 testnet encodes `node_getContract` ABSENCE by OMITTING the
  `result` key from a well-formed success envelope (JS `undefined` doesn't serialize). The old
  "no result = malformed" guard would deadlock predeploy forever. `rpcOptional` accepts exactly
  that envelope shape as absence; HTTP/RPC-error/non-JSON still throw. Deployed-branch verified
  against canonical FeeJuice (0x…03) and the LIVE SponsoredFPC (0x1441491b — deployed on testnet
  with class `0x2015e1c6…`, matching our 5.0.1-derived class).
- **Gate outputs (real)**: predeploy rc=0; require-deployed rc=1; no-mode rc=1; tripwire 8/8 incl.
  new compat-coherence pins; bridge-core 136/136; `test:all` rc=0. Drift detectors (CI Build
  Faucet / verify:deployments) EXPECTED red until P6's redeploy — recorded as evidence.
- Remaining coupling for P6: deploy-script 5-arg `constructor_with_minter` arity + descriptor
  regen (deploy.ts / deploy-bridge-testnet.ts / deposit-testnet.ts / deployments.ts) + the first faucet
  token + PrivateFPC live redeploys + require-deployed re-run.
