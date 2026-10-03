## Outcome

Archived. Seeds retired.

# bridge-evm-verification

Delete the vendored upstream portal and the `verify-l1` branch that only exists to serve it, and
prove the one initialization guard on the custody contract that no test currently covers.

- Tier: `mid` (rubric: 1 HIGH — security sensitivity; novelty / blast radius / irreversibility / migration all LOW)
- Budget: recon 1 agent · `/code-review` at `low`
- `eli5_mode`: Artifact
- **Depends on a separate pin fix.** Phase 1's gate cannot pass until it lands — see §2 Fact 1.

---

## 1. Why this exists

### Scope 1 — retiring the vendored portal

`contracts/bridge/evm/upstream/TokenPortal.sol` is a 151-line pinned copy of Aztec's portal, which
Aztec ships in their **test** tree (`test/portals/TokenPortal.sol`) as example code with no
initialization guards at all.

The copy is not a reference. `@aztec/l1-artifacts` ships the compiled artifact but **not** the source,
so Etherscan verification of a canonically-deployed portal would have nothing to compile.
`placePortalSource()` (`verify-l1.ts:101`) supplies it, keccak-checking against the artifact metadata
first.

Nothing takes that branch any more. All three manifests declare `l1.portalSource: "forked-v1"`, and
both deploy conductors hardcode it. The live path is `stageForkSource()`, staging **our**
forked portal, whose source we own.

**This is a retirement, not a dead-code deletion** — the distinction matters and the first draft got it
wrong. The branch handles `portalSource` being *absent*, i.e. every pre-fork manifest in git history.
An earlier `packages/faucet/public/testnet-bridge.json` is a real one, and its portal
(`0x9c41…11ea`) was Etherscan-verified from this vendored source. After this change that deployment
can no longer be re-verified from the repo. Those portals are superseded and the owner has chosen
deletion, but the plan records it as an abandonment rather than pretending nothing is lost.

What the drift check nominally buys is covered more directly elsewhere:

| Risk | What actually catches it |
|---|---|
| Protocol interface moves | the forked portal imports `IRegistry`/`IRollup`/`IOutbox` — it stops compiling |
| L1↔L2 message format changes | the content-hash keystone vectors (TS / Solidity / Noir) |
| Wrong rollup/inbox/outbox on-chain | deploy-time readbacks + `verify:deployments` |
| Our fork edited without re-pinning | `FORKED_PORTAL_KECCAK` + `PORTAL_PIN`, now also unit-tested |

### Scope 2 — the guard nothing tests

The forked portal is a copy-fork of Aztec's example, made because Aztec marks nothing `virtual`. It adds
two guards, closing a real drain: upstream's `initialize` has no caller check and no init-once, and
derives `outbox` from the caller-supplied `_registry` — which `withdraw` trusts to authorise releases.

Mutation testing against the real contract, full hermetic suite (`lessons/phase-0.md`):

| Mutation | 62-test suite |
|---|---|
| remove `if (msg.sender != initializer) revert NotInitializer();` | **1 failed** — `test_FA_portalInitFrontRun_reverts` |
| remove `if (address(registry) != address(0)) revert AlreadyInitialized();` | **0 failed — 62 passed** |

The init-once guard is covered by nothing. `test_F001_initialize_is_once_only` passes with it deleted,
because it asserts against the portal shim — a hand-written copy of the guard, whose stated
reason for existing ("the `@aztec` tree does not resolve in this project") stopped being true when the
previous arc added the `@aztec-blob-lib` remapping.

**The constraint on any fix.** The preceding arc's defining defect was *tests and guards that cannot
fail*. Adding verification here is only defensible if each addition has been shown to fail.

---

## 2. Assumptions

### Facts

1. **The base branch's deploy path is broken and this plan is blocked on the fix.** `FORKED_PORTAL_KECCAK` and
   `PORTAL_PIN`'s hashes were bumped to a build never committed;
   `stageForkSource` throws on the live branch, killing `verify-l1` and both conductors. Fixed in
   a separate pin fix, which re-pins to what the source compiles to and adds a solc-free consistency test.
2. `upstream/TokenPortal.sol` is referenced only by `verify-l1.ts` (lines 38, 39, 104, 112, 114) and a
   provenance comment in the forked portal's header.
3. All three manifests (`testnet`, `mainnet`, `mainnet-…candidate`) set `portalSource: "forked-v1"`;
   both conductors hardcode it and never read it back. The deleted branch is the handler for the field
   being **absent**.
4. `@aztec/l1-artifacts@5.2.0` ships `out/TokenPortal.sol/TokenPortal.json` but no
   `l1-contracts/test/portals/` directory.
5. The forked portal contains zero occurrences of `virtual`, so `initialize` cannot be overridden in
   a subclass. (Composition or a proxy exist in principle; both are wrong for a contract whose
   deployed bytes are the reviewed artifact.)
6. `placePortalSource`, `PORTAL_SOURCE_REL`, `VENDORED_PORTAL` and `requireLegacyForgeInputs` are all
   module-private and reachable only from the non-`forked-v1` branch. **`L1_ARTIFACTS_ROOT` is used by
   the surviving branch at both `:190` and `:215`** and must stay.
7. `candidate-schema.ts:43` declares `portalSource: z.literal("forked-v1")` inside `.strict()`, but the
   schema is applied only inside the forked branch (`verify-l1.ts:154`), so the legacy branch bypasses it.
8. `candidate-schema.test.ts` has **no** `portalSource` coverage today.
9. **Editing the forked portal — even a comment — changes its bytecode.** solc's metadata hash covers
   the source; `portal-artifact.ts:30-32` documents it. Any edit invalidates `FORKED_PORTAL_KECCAK`,
   `PORTAL_PIN`, and the committed artifact, and makes the live portals unverifiable until regenerated.
10. Baseline, clean worktree: `forge build` exit 0; `forge test --no-match-contract Fork` → 62 passed;
    `halmos --contract FormalRouterTest` → `4 passed; 0 failed` in 6.25s.
11. `contracts/bridge/evm/lib/` is gitignored, empty on a fresh checkout, and provisioned by a pinned
    `forge install` that also **stages `.gitmodules` and three gitlinks** — they must be unstaged.
    `bun packages/bridge-core/scripts/gen-remappings.ts` must run before any forge invocation.
12. The real portal compiles and instantiates in-project (`BlackhatAudit.t.sol:306`,
    `PortalRoundtripFuzz.t.sol:32`). The shim's stated rationale is stale.
13. Mutation results as tabulated in §1.
14. halmos silently truncates: `--loop` defaults to `2`, `--default-array-lengths` to `0,1,2`. It reports
    `[PASS]` with exit 0 on a demonstrably false property; the warning reaches neither the summary nor the
    exit code. **`--width` and `--depth` already default to `0` (unlimited)** — passing them changes nothing.
15. halmos hard-wraps its warning mid-phrase, so a grep for the full sentence matches nothing. The stable
    `#loop-bound` URL fragment does not wrap.
16. `halmos --contract X` compiles to `^X$`. It prints `Running N tests for <path>:<Contract>` and
    `Symbolic test result: …` **per contract**, with no grand total.
17. The halmos CI step short-circuits `exit 0` when `test/FormalRouter.t.sol` is absent
    (`_bridge-contracts.yml:83`).
18. Symbolic `vm.prank` works under halmos 0.3.3 here — `FormalRouter.t.sol:140-151` uses it and was
    mutation-verified. Its header also documents the masking hazard: a zero-address path "trip[s] sweep's
    own `to != address(0)` require, producing a legitimate revert that reaches the catch branch and masks
    every unauthorized success."
19. `packages/bridge-core`'s test script is `bun --bun vitest run`; root `typecheck`
    never sees `verify-l1.ts`.
20. `contracts.yml` triggers on `pull_request` and `workflow_dispatch` only; `contracts-status` is not a
    required check.
21. The in-project Foundry build (`solc 0.8.28`, `via_ir`) differs from the deployed portal
    (`solc 0.8.30`, no via_ir). The proof exercises **the real source under the in-project toolchain**,
    not the deployed bytes.

### Inferences (attack these)

1. *Abandoning pre-fork manifest verification is acceptable.* The affected portals are superseded, and
   the owner chose deletion knowing this. Not provable from the repo — recorded as a decision.
2. *Routing every manifest through the strict schema is safe.* `.strict()` also rejects unknown keys, so a
   legacy-shaped manifest yields a zod error rather than a targeted message. Only reachable by hand.
3. *The `try/catch` + state-unchanged shape generalises from the router to the portal.* Reused structure,
   not yet exercised on this contract.

### Asks — resolved

| Ask | Resolution |
|---|---|
| Scope-1 replacement | delete, no replacement; unsupported `portalSource` rejected by the schema |
| **Pre-fork manifest verification** | **intentionally abandoned** — recorded, not assumed |
| Proof scope | codex's verdict decided; owner confirmed **B2 only** |
| `contracts-status` → required | out of scope; stays advisory |
| Validation layers | forge + halmos + mutation; vitest + lint + typecheck |
| The base-branch pin break | fixed separately; this plan stacks on that fix |

---

## 3. Verification scope

Three candidates went through three adversarial codex rounds plus a fresh-context pass and an
independent audit. Two were cut, then a third:

| Candidate | Verdict |
|---|---|
| `initialize` — init-once (**B2**) | **SHIP.** The only guard no test covers. Against the real contract: *"using the shim proves only that the shim resembles the custody contract. That is not acceptable evidence."* |
| `initialize` — deployer-only (**B1**) | **CUT.** `test_FA` already mutation-detects it; the guard is a single address equality, so exhaustive enumeration adds nothing over one wrong address. |
| `_validateRoute` | **CUT.** "Almost a restatement of the guard… its incremental value does not justify expanding this arc." |
| `withdraw` | **CUT.** "No Halmos property establishes its actual authorization boundary without assuming the answer in `outbox.consume`." |

**Net: one proof.** Plus deleting the shim that made the existing regression unable to fail, and
repairing that test against the real contract.

### The proof

```solidity
// The test contract is the portal's initializer, so this call clears the deployer-only guard and
// reaches the init-once guard — the one under test. No symbolic caller: admitting non-initializers
// would let every path exit through NotInitializer, leaving the proof green with init-once deleted.
function check_initializedBindingsCannotChange(address candidateUnderlying, bytes32 candidateBridge) public
```

Against `locked` — a real forked portal already initialized against registry A — it re-calls
`initialize` with registry B and symbolic passive arguments, and asserts all seven bound values are
unchanged: `registry`, `underlying`, `l2Bridge`, `rollup`, `outbox`, `inbox`, `rollupVersion`.

**Why no symbolic caller.** The first draft reused the router's `vm.assume(caller != owner)` shape and
was caught by the audit: with init-once deleted and deployer-only intact, every admitted caller exits
through `NotInitializer`, so the proof stays green while the guard it names is gone. The decisive caller
is the initializer, and it must be the *only* one.

**What makes the proof decisive** is the unwanted-success branch, not the value comparison: any second
`initialize` that returns normally executes `assertTrue(false)`, so deleting the guard fails the proof
*even if every candidate argument happens to equal what is already bound*. The seven-value assertion is
the secondary check — that a rejected call left state untouched.

**Registry B must be operational** — a second real rollup mock — so that with the guard deleted the
second `initialize` genuinely *succeeds* rather than reverting for an unrelated reason, which would
make the mutation merely look caught. Registry, rollup, inbox and outbox are concretely distinct
between A and B; `rollupVersion` is **not** an independent witness (the reused `FakeRollup.getVersion()`
is `pure` returning `4242`), so it is asserted as part of "nothing changed" but must not be described as
a distinct sentinel.

**A positive control keeps that honest.** A plain `test_` — running in the hermetic suite forever, not
just once at mutation time — asserts the initializer *can* fully initialize `fresh` against registry B
and that the bindings land on B's sentinels. If registry B ever stops being operational, that reds
instead of the proof going silently vacuous.

**Failure signalling** is `assertTrue(false, …)` inside the unwanted-success branch — never
`revert(string)`, which halmos cannot observe. That mistake shipped two green proofs over an unguarded
fund-drain primitive in the previous arc.

---

## 4. Architecture & Implementation

Two arcs. Arc 1 is pure subtraction; Arc 2 is additive and touches disjoint files.

**Arc 1 — devendor.** The branch collapses; `requireLegacyForgeInputs` goes with it, and every manifest
routes through `parseCandidateManifest`, whose schema already demands `forked-v1`:

```
before:  const forkedPortal = config.l1.portalSource === "forked-v1"
         if (forkedPortal) stageForkSource(L1_ARTIFACTS_ROOT)
         else placePortalSource()
         const portalTarget = forkedPortal ? "…<forked-portal>" : "…TokenPortal"

after:   parseCandidateManifest(config)      // rejects anything but forked-v1
         stageForkSource(L1_ARTIFACTS_ROOT)
         const portalTarget = "<forked-portal>"
```

The rejection is tested where it lives — ~6 lines in `candidate-schema.test.ts`, which has no
`portalSource` coverage today. **No new `verify-l1.test.ts`**: that module exports nothing, executes on
import, writes `remappings.txt` at module scope, and exits via `process.exit`. A spawn-based test would
need Foundry, which no unit-test job installs — so it would either pass on the wrong error or fail in CI.
Exactly the shape this plan removes.

**The forked portal is not touched at all** (Fact 9). Its header's references to the deleted file and
to the shim become stale, and that is the cheaper cost: editing them would move the bytecode and force
regenerating the trust anchor for a live custody contract. A note in the plan records why the staleness
is deliberate.

**Arc 2 — the proof.** `FormalPortal.t.sol` beside `FormalRouter.t.sol`, following the house conventions:
`check_*` prefix (halmos-only here), symbolic inputs as plain parameters, and mocks **imported** from
`PortalRoundtripFuzz.t.sol`. The rewritten `PortalReinit.t.sol` imports the same set — otherwise this
deletes one duplicate (the shim) and leaves the fake-registry duplication at three.

**The CI gate binds counts to contract names, in one invocation.** The first draft proposed
per-contract invocations on the premise that a combined total could be satisfied by the wrong mix; the
audit showed halmos prints per contract with no grand total (Fact 16), so a single run is both simpler
and stronger:

```sh
set -o pipefail
halmos --match-contract '^Formal' 2>&1 | tee halmos.log
grep -qE '^Running 4 tests for .*:FormalRouterTest$' halmos.log
grep -qE '^Running 1 tests for .*:FormalPortalTest$' halmos.log
[ "$(grep -c '^Symbolic test result: ' halmos.log)" = 2 ]
! grep -qE '^Symbolic test result: [0-9]+ passed; [1-9]' halmos.log
```

That catches a vanished file, a renamed-away `check_`, and a failed proof. The
`test/FormalRouter.t.sol` existence escape hatch (Fact 17) goes — it made deleting the proofs a green build.

**No loop-truncation gate.** It was in the draft as insurance; both final reviewers said cut it, and they
are right — nothing in scope loops or takes a dynamic array, `--width`/`--depth` already default to
unlimited (Fact 14), and the ritual of building a throwaway looping property to prove the grep fires is a
sub-phase of work for a hazard no shipped proof can reach. The finding stays in `lessons/phase-0.md` so
the next proof over a loop inherits it.

### File-level change map

| File | Change |
|---|---|
| `contracts/bridge/evm/upstream/TokenPortal.sol` | **deleted** |
| `packages/bridge-core/scripts/verify-l1.ts` | remove `PORTAL_SOURCE_REL`, `VENDORED_PORTAL`, `placePortalSource()`, `requireLegacyForgeInputs()`; parse unconditionally; collapse `portalTarget`; rewrite the header comment. **Keep `L1_ARTIFACTS_ROOT`** |
| `packages/bridge-core/src/candidate-schema.test.ts` | **+~6 lines** — a non-`forked-v1` manifest is rejected |
| the forked portal's source | **untouched** (Fact 9) |
| `contracts/bridge/evm/test/FormalPortal.t.sol` | **new** — the proof + the positive control |
| the portal shim | **deleted** |
| `contracts/bridge/evm/test/PortalReinit.t.sol` | rewritten against the real portal, trimmed to init-once, importing the Roundtrip fakes |
| `.github/workflows/_bridge-contracts.yml` | name-bound counts in one invocation; escape hatch removed |

### Alternatives not taken

- A version-pin assert, or fetching the canonical source on demand (owner chose outright deletion).
- Proving `_validateRoute`, `withdraw`, or the deployer-only guard (§3).
- Editing the forked portal's stale comments (Fact 9 — costs a live trust anchor).
- Per-contract halmos invocations (rejected on a false premise; see above).
- Promoting `contracts-status` to required (owner-deferred).

---

## 5. Security & Adversarial Considerations

**Threat model.** The asset is USDC held by the forked portal between an L1 deposit and its L2 claim.
Attackers: anyone who can initialize before the deployer or re-point an initialized portal, thereby
owning the outbox that authorises withdrawals; a supply-chain attacker moving `@aztec/l1-artifacts`.

**What this changes.** No production bytecode — the forked portal is untouched by design. Arc 1
removes a deploy-time verification branch; Arc 2 adds tests. The value is epistemic.

**The risk the plan itself carries.** A green proof that proves nothing adds *false* confidence to a
money contract. Five live mechanisms, each with a mitigation that is itself checkable:

- **Proving the wrong artifact.** `PortalReinit.t.sol` demonstrates it in merged code. → the proof
  instantiates the forked portal's own source, and the acceptance evidence is a mutation of *that file*.
- **Excluding the decisive caller.** The draft's own bug: a symbolic caller with `vm.assume` lets every
  path exit through the other guard. → no symbolic caller; the initializer is the only one.
- **Fixture masking.** A mutation "caught" by an unrelated revert reads as success. → registry B must be
  operational, enforced permanently by the positive-control `test_`, not just once at mutation time.
- **Invisible failure signalling.** `revert(string)` is not observable to halmos. → `assertTrue(false, …)`
  only; the review passes grep proof bodies for `revert(`.
- **A gate that passes while running nothing.** Facts 16–17 are live today. → name-bound counts, escape
  hatch removed.

**Scope of the claim.** The proof exercises the real source under the in-project toolchain, which is not
the deployed compiler (Fact 21). It establishes a property of the code, not of the deployed bytes; the
deployed bytes are covered by the artifact pins and the pin fix's consistency test.

**Least privilege / supply chain.** Unchanged — no new dependencies, credentials, or workflow permissions.
Pre-existing weaknesses noted but out of scope: mutable action tags in `_bridge-contracts.yml`, unhashed
`pipx` install, and staging into a shared installed package tree.

**Not addressed.** V4 delta semantics; the live-pool capacity verifier; `contracts-status` promotion; the
`lib/` gitlink-vs-CI-pin divergence.

---

## 6. Phases

### Phase 0 — environment baseline ✓

Complete; baseline and both mutation experiments are in `lessons/phase-0.md`.

**Validation gate** — `bun install` · pinned `forge install` · `gen-remappings.ts` · `forge build` ·
`forge test --no-match-contract Fork` · `forge build --ast --force && halmos --contract FormalRouterTest`.
Pass: build exit 0, `62 tests passed`, `4 passed; 0 failed`.
**Then `git restore --staged .gitmodules contracts/bridge/evm/lib/`** — `forge install` stages them, and
committing them would ship the CI-pin divergence.

### Phase 1 — devendor ✓

Delete the vendored file, `placePortalSource()`, `requireLegacyForgeInputs()` and the two constants; parse
every manifest through `parseCandidateManifest`; collapse `portalTarget`; rewrite the `verify-l1.ts`
header comment. Add the schema rejection test. Do not touch the forked portal.

**Validation gate**
- `bun run --filter @unleashed/bridge-core test` · `bun run --filter @unleashed/bridge-core typecheck` ·
  `bun run lint` ·
  `bun packages/bridge-core/scripts/verify-l1.ts --config apps/faucet/public/testnet-bridge.json --dry-run`
- Pass: tests green **including the new schema rejection case**; typecheck and lint exit 0; the dry-run
  emits standard-json for all four contracts (this requires the pin fix — Fact 1).
  `grep -rn "upstream/TokenPortal\|placePortalSource\|VENDORED_PORTAL\|requireLegacyForgeInputs"` returns
  nothing outside this plan directory **except the forked portal's header**, which is left
  stale deliberately (Fact 9 — editing it moves the bytecode). That one match is expected; any other is
  a failure.
- Layers: lint/typecheck · unit · script-level integration (no network)

### Phase 2 — the proof and the repaired regression ✓

Write `FormalPortal.t.sol` (the proof + the positive control). Delete the portal shim; rewrite
`PortalReinit.t.sol` against the real portal, trimmed to init-once, importing the Roundtrip fakes.

**Validation gate**
- `forge build --ast --force` · `forge test --no-match-contract Fork` · `forge build --ast --force` ·
  `halmos --contract FormalPortalTest`
  — the AST build repeats because `forge test` recompiles without it and halmos requires it.
- Pass: `Symbolic test result: 1 passed; 0 failed`; **and** the matrix below holds, with every diff and
  both outputs in `lessons/phase-2.md`.

  On the forge side the total is **degenerate and must not be the assertion**: dropping
  `PortalReinit`'s front-run test (−1) and adding the positive control (+1) leaves 62 either way, so a
  count cannot distinguish the intended swap from a silently dropped test. Verified: `forge test --list`
  shows 0 of `FormalRouter`'s 4 `check_` functions, so proofs never enter the forge total. Assert by
  name instead, from `forge test --list`:

  | Name | Expected |
  |---|---|
  | `test_F001_initialize_is_once_only` | present, passing, and now against the real portal |
  | `test_F001_initialize_frontRun_reverts` | **absent** — deliberately dropped; `BlackhatAudit` covers it |
  | the positive control | present and passing |
  | total | 62 |

  | Mutation to the forked portal | Must fail | Must still pass |
  |---|---|---|
  | remove `AlreadyInitialized` | the proof **and** the rewritten `PortalReinit` | — |
  | remove `NotInitializer` | `test_FA_portalInitFrontRun_reverts` | the proof (it does not test this guard) |

  Re-run `forge build --ast --force` after each apply **and** each restore, before halmos — a stale-AST run
  reads identically to "the mutation was not caught" and could get a good proof deleted.
  **A mutation that fails for the wrong reason counts as not caught**: the counterexample must implicate
  the init-once guard, not an unrelated revert.
- Layers: unit · symbolic · mutation

### Phase 3 — CI gate ✓

Name-bound counts in one halmos invocation; remove the existence escape hatch.

**Validation gate**
- `bun run lint:actions` · `gh workflow run contracts.yml --ref <branch>` (Fact 20 — `contracts.yml` has no
  `push` trigger, and §7 forbids opening a PR this early)
- Pass: `lint:actions` exit 0; the dispatched run is green; **and** a local check that moving either proof
  file aside makes the step *fail* rather than skip, pasted into `lessons/phase-3.md`.
- Layers: workflow lint · CI run · mutation on the gate itself

---

## 7. Delivery

| Arc | Phases | Stacks on | `/code-review` |
|---|---|---|---|
| `devendor` | 0, 1 | the base branch (after the pin fix lands) | `low` |
| `proofs` | 2, 3 | `devendor` | `low` |

`gh stack init --adopt` on the task branch, then `gh stack add` at the boundary. PRs open
only in the post-implementation Delivery step. **`gh stack merge` is the owner's call.**

---

## 8. Post-implementation

**Per arc, at its boundary — before `gh stack add`:**

1. **`/code-review low --fix`** on the arc's diff; skim; **commit separately**.
2. **Codex audit** (`/codex xhigh`) with the arc's diff, a summary of the code-review commits, this plan
   and the ledger, the arc map, an adversarial/security ask, **plus: grep every proof body for `revert(`
   used as a failure signal, and confirm each mutation's counterexample implicates the guard under test.**
   Include verbatim:
   > *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra
   > configuration surface, new layers, or rewrites — the smallest change that fixes each real problem.
   > If code works and is clear, leave it alone."*

   and verbatim:
   > *"Audit the comments for value per character. Flag any comment that narrates what the code visibly
   > does, restates its line, references implementation plans / phases / reviews, or spends a paragraph
   > where a sentence works — and flag places where a non-obvious invariant or constraint deserves a
   > comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to
   > re-read: they must be few, dense, and exact."*
3. **Iterative fix loop.** Verify codex's factual claims against the repo first. Apply, commit, log the
   round in `lessons/`, then **resume the same session** with the fix diff. Loop until a round yields no
   new material findings. Still material after 3 rounds → stop and surface.

**After both arcs:** one **final cross-arc pass** — a *fresh* codex session over the net diff plus the
code-review summaries, asking for cross-arc issues, same two rules, same loop. `/code-review` is not repeated.

**Then Delivery** (§7).

**Failure-retry:** human-driven, 3 failures; autonomous `/loop`, 5.

**Hardening:** `/harden` not scheduled — no trust boundary, credential, or publishing surface added.

---

## 9. Decision ledger

### Competing outline — "deepen the gate, don't widen the proofs"

Scope 1 only, then make the existing gate un-cheatable instead of adding proofs. Premised on the prior
verdict that this surface was "at the verification ceiling."

**Rejected because the premise was false:** mutation testing found the init-once guard on the custody
contract covered by nothing. That is information, which no amount of gate-hardening surfaces. Its best
ideas were absorbed — escape-hatch removal and name-bound counts are Phase 3.

### Resolved

| Decision | Choice | Source |
|---|---|---|
| Scope-1 replacement | delete, no replacement | owner |
| Pre-fork manifest verification | intentionally abandoned, recorded | fresh codex → owner |
| `withdraw` proof | killed | codex r1 |
| `_validateRoute` proof | dropped | codex r2 |
| Deployer-only proof (B1) | **cut** — already mutation-proven by `test_FA` | fresh codex + fable → owner |
| Init-once proof | **ship** — the only uncovered guard | codex r1–r3 |
| No symbolic caller on the proof | adopted — a symbolic caller lets every path exit through the other guard | fresh codex |
| Registry B operational + positive control | adopted; distinct *version* dropped (fixture returns a constant) | codex r2 + fable |
| Shim deleted, `PortalReinit` repaired | adopted — "repairs a test whose stated security target and actual target differ" | codex r3 |
| The forked portal untouched | adopted — comment edits move bytecode | fable |
| Schema test instead of `verify-l1.test.ts` | adopted — the module is unimportable | fresh codex + fable |
| CI: name-bound counts, one invocation | adopted — per-contract invocations rested on a false premise | fable |
| Loop-truncation gate | **cut** — nothing in scope loops; finding kept in lessons | fresh codex + fable |
| Phase 1 gate commands | corrected — package test script, package typecheck | fresh codex + fable |
| `contracts-status` → required | no, stays advisory | owner |
| `lib/` gitlink divergence | out of scope, recorded | main |

### Disputed

Nothing outstanding. The two reviewers disagreed once — codex r3 wanted the loop-truncation gate shipped,
its fresh-context pass and fable wanted it cut. Cut, on the anti-expansion mandate.

### Audit verdicts

- Codex (fresh context): **reject** → blocking findings all adopted.
- Fable: **two Critical, three High** → all adopted.
- Both rejections were of the *draft*; this revision addresses every blocking finding. Neither has
  re-reviewed the revision — that is what the approval gate is for.

---

## 10. Seeds

> Draft until the approval gate. Use exactly ONE per session — they do not compose.

**Recommended — `/goal`:**

```
/goal All phases marked ✓ in implementations-plan/archive/bridge-evm-verification/plan.md (the per-phase headers in the file, not just the chat), each ✓ backed by its phase's validation gate as written in plan.md reported passing in the transcript — including, for Phase 2, the FULL mutation matrix: the init-once mutation reported FAILING both the proof and the rewritten PortalReinit with a counterexample implicating that guard, the deployer-only mutation reported failing test_FA while the proof still passes, and every restore returning to green, all pasted into lessons/; for each phase the agent has printed `LESSONS_FILE=implementations-plan/archive/bridge-evm-verification/lessons/phase-N.md` in the transcript; `/code-review low --fix` complete per arc with findings applied and committed separately; the codex fix loop converged for every reviewed diff — each arc at its boundary plus the final cross-arc pass — each convergence evidenced by a resumed codex pass reporting no new material findings, quoted in the transcript; the Delivery section's PR topology exists on GitHub, created only AFTER all loops converged (`gh stack view` output in the transcript); `bun run --filter @unleashed/bridge-core test` and `bun run lint` both report exit 0 in the transcript.
```

**Alternative — `/loop`:**

```
/loop 15m Drive implementations-plan/archive/bridge-evm-verification forward. Never idle waiting for my input. Each firing:
1. Reality check: read plan.md and lessons/ (authoritative state — not the chat); run `git status` and `git log --oneline -5`. Never stage contracts/bridge/evm/lib/ or .gitmodules. If a PR exists, `gh pr view --json statusCheckRollup` (no --watch; `gh stack view` for the stack).
2. Waiting on CI is fine — confirm it is progressing (`gh run watch <run-id>` up to 10 minutes). Use the wait to review the diff or tighten the proof.
3. No task in hand? Take the next pending step from plan.md. After each meaningful edit run the fast layers (`bun run --filter @unleashed/bridge-core test` + `bun run lint`, or `forge build && forge test --no-match-contract Fork`). Then commit → push (`gh stack push`; `gh stack sync` if trunk or a lower arc moved).
4. Stuck, or facing a decision you would bring to me? Call `/codex xhigh` with full context, go back and forth until you reach a defensible decision, act on it, log the consult + verdict in lessons/phase-N.md. Hard limits stay hard: never merge to main, never publish or deploy, never expand scope beyond plan.md.
5. Same step failed 5 times? Stop retrying; reassess with codex, then continue down the agreed path.
6. Phase green? "Green" means THAT PHASE'S validation gate in plan.md passes — for Phase 2 that means the whole mutation matrix, with `forge build --ast --force` re-run after every apply and every restore before halmos. Run the full gate, paste the result, mark ✓ in plan.md, file the lessons entry, print `LESSONS_FILE=implementations-plan/archive/bridge-evm-verification/lessons/phase-N.md`. Arc boundary crossed? Run that arc's quality loop FIRST (`/code-review low --fix` → commit separately → codex loop with the arc map and plan.md's no-over-engineering + comment-quality rules until a round yields nothing material) THEN `gh stack add <next-arc-branch>`.
7. All phases ✓? Close out per plan.md's Post-implementation section: the final cross-arc pass (FRESH codex session over the net diff), then Delivery — the FIRST time any PR is opened. Then write the wrap-up: what shipped, every contentious decision codex and I debated with ELI5 context, and open items. Surface and stop.

Keep an ASCII checklist visible each firing (human readability only; plan.md is the source of truth).
```
