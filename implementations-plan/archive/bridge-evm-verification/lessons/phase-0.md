# Phase 0 — environment baseline & halmos truncation probe

## Baseline (clean worktree off the base branch)

`contracts/bridge/evm/lib/` is gitignored and empty on a fresh checkout — the forge dependencies are
provisioned by a pinned `forge install` that until now only ever ran in CI:

```
forge install \
  foundry-rs/forge-std@bf647bd6046f2f7da30d0c2bf435e5c76a780c1b \
  OpenZeppelin/openzeppelin-contracts@cab19933c33c2ad1d4c7a84864a3601dddfd16f3 \
  Uniswap/v4-core@e50237c43811bd9b526eff40f26772152a42daba
```

`bun packages/bridge-core/scripts/gen-remappings.ts` must run before any forge invocation (the repo
uses bun's isolated linker; the generated `remappings.txt` is what resolves `@aztec/`).

Recorded baseline: `forge build` exit 0 · `halmos --contract FormalRouterTest` →
`Symbolic test result: 4 passed; 0 failed; time: 6.25s` · local halmos 0.3.3 matches `halmos.version`.

## Finding: halmos reports PASS on a state space it silently truncated

Codex claimed the `--loop` bound can leave a proof green while the counterexample sits outside the
explored space, and that the pass/fail summary does not promote the warning. Verified empirically with
a throwaway contract whose assertion is false only at ≥3 loop iterations (probe deleted after; the
transcript below is the artifact).

At the **default** bound:

```
[PASS] check_countNeverReachesThree(uint256) (paths: 3, time: 0.01s, bounds: [])
WARNING  check_countNeverReachesThree(uint256): paths have not been fully
         explored due to the loop unrolling bound: 2
Symbolic test result: 1 passed; 0 failed; time: 0.03s
```

Exit code 0. At `--loop 5` the same property fails on the witness `n = 0x03`:

```
[FAIL] check_countNeverReachesThree(uint256) (paths: 9, ...)
Symbolic test result: 0 passed; 1 failed
```

**A demonstrably false property passes, and the count assertion the CI gate uses cannot see it.** The
warning is printed to stdout but is reflected in neither the summary line nor the exit code.

Two truncation knobs, both silent by default, both confirmed against the local CLI:

| Flag | Default | Effect if left alone |
|---|---|---|
| `--loop` | `2` | loops unroll twice; anything reachable only on iteration 3+ is invisible |
| `--default-array-lengths` | `0,1,2` | dynamic arrays are only ever length 0, 1, or 2 — a "3-hop route" is never constructed |

The second matters as much as the first for `_validateRoute`, whose loop is bounded by `path.length`.
A proof claiming to quantify over 3-hop routes, written without `--array-lengths`, never sees one.

### Consequence for the existing gate

The four merged `FormalRouterTest` proofs emit **no** truncation warning — they contain no loops and
take no dynamic arrays, so today's `grep "4 passed; 0 failed"` gate is sound. It is sound by luck, not
by design: the trap arms itself the moment a proof over `_validateRoute` lands.

### Resulting gate design

Pin `--array-lengths` to the intended set, set `--loop` strictly above the maximum length so the loop
is fully unrolled, and **require the truncation warning to be absent** — fail on a hit, alongside the
exact count. A proof that can only be trusted when a warning is absent must have that absence enforced
mechanically, not read by a human scrolling a log.

> **Do not grep the warning's prose.** The obvious pattern — `paths have not been fully explored` —
> matches nothing, because halmos wraps mid-phrase; that is the next finding in this file, and it was
> written after this paragraph. Match the stable `#loop-bound` URL fragment instead.

## Finding: the real portal's init-once guard is covered by nothing

`PortalReinit.t.sol` exercises the portal shim, not the forked portal. The shim's
header justifies itself by claiming the real portal's `@aztec` transitive tree
(`IRollup → FeeLib → BlobLib`) "does NOT resolve in the bridge-evm Foundry project". That is **stale**:
`BlackhatAudit.t.sol:29` and `PortalRoundtripFuzz.t.sol:7` both import and instantiate the real
contract, and `forge build` succeeds from a clean worktree. The `@aztec-blob-lib/` remapping added in
the previous arc fixed exactly that tree.

Verified by mutating the real contract and running the full hermetic suite (62 tests):

| Mutation applied to the forked portal | Result |
|---|---|
| remove `if (msg.sender != initializer) revert NotInitializer();` | **1 failed** — `test_FA_portalInitFrontRun_reverts` (`BlackhatAudit.t.sol`, real portal) |
| remove `if (address(registry) != address(0)) revert AlreadyInitialized();` | **0 failed — 62 passed** |

So the deployer-only guard is covered by exactly one concrete test, and **the init-once guard is
covered by nothing at all**. `test_F001_initialize_is_once_only` passes with the real guard deleted,
because it asserts against a hand-written copy of the guard in the shim.

This is the arc's own defect class sitting in merged code, and it sizes the verification work: target
B's second proof closes a real hole rather than restating an existing test. It also means the shim now
costs more than it earns — it carries a name that implies coverage it does not provide.

## Note: committed `lib/` gitlinks disagree with the CI pins

`contracts/bridge/evm/lib/` is listed in `.gitignore` yet the three libraries are **tracked as
gitlinks**, with no `.gitmodules` registering them. The recorded SHAs are not the ones CI installs:

| Library | committed gitlink | CI `forge install` pin |
|---|---|---|
| forge-std | `da5b326f` | `bf647bd6` |
| openzeppelin-contracts | `0a76a615` | `cab19933` |
| v4-core | `46c68346` | `e50237c4` |

CI never checks out submodules (there are none registered) and overwrites the trees via `forge install`,
so CI is self-consistent — but a developer restoring the gitlinks builds against different libraries
than CI does. That is the same mismatch class that previously produced halmos `Unsupported cheat code`
failures.

**Out of scope for this plan** (it is not what either branch set out to do) — recorded as a follow-up.
Practical consequence while implementing: keep the working tree at the CI-pinned SHAs so local runs
match CI, and **never stage `contracts/bridge/evm/lib/`**.

## Finding: halmos wraps its warning text, so the obvious grep matches nothing

Writing the truncation gate, the first pattern tried was the warning's own sentence,
`paths have not been fully explored`. It matched **zero** lines against output that visibly contains
the warning — halmos hard-wraps to a fixed column and splits the phrase:

```
WARNING  check_countNeverReachesThree(uint256): paths have not been fully
         explored due to the loop unrolling bound: 2
```

A gate written the obvious way would therefore never fire — a fail-open guard, inside the gate built
to stop fail-open guards. Use a short fragment that cannot straddle the wrap: `unrolling bound:` for
loop truncation, `--width`/`--depth` for the `incomplete execution due to the specified limit:`
variants. Whatever pattern is chosen must itself be verified against a deliberately-truncated run
before it is trusted — the same rule the proofs are held to.

Stream note: with stderr discarded the full output still appears on stdout, so the existing
`halmos … | tee halmos.log` does capture the warning. `2>&1 | tee` is still worth using, so the gate's
correctness does not depend on which stream halmos chooses.

## Review finding: the live portals are the build before the deployer-only guard — the pins describe an undeployed one

The pin fix was written as "the source, the artifact and the pins agree with each other and
with what is deployed". The last clause was never checked. Fetched both live portals' runtime code
over public RPC:

| | bytes | runtime keccak | `initializer()` getter (`0x9ce110d7`) |
|---|---|---|---|
| mainnet `0x3c32f16f…` | 3170 | `0x851a507b…` | absent |
| testnet `0xe0fd81b5…` | 3170 | `0x851a507b…` | absent |

`0x851a507b…` is byte-exact the `runtimeCodeHash` from **before the deployer-only guard** (the
previous revision of `portal-artifact.ts`), which is consistent with the sequence: both portals were
deployed, then the deployer-only guard was added, and the redeploy (Arc 8 / L-5) is still pending.
The absent `initializer()` selector is the direct symptom — that getter only exists once the
immutable does.

What follows, and what does not:

- **The pin fix is still the right fix.** `loadForkedPortalArtifact` feeds the *next* deploy, and the next
  deploy must ship the reviewed build with the front-run guard. Re-pinning to the live bytes
  instead would have silently dropped that guard from the next deployment.
- **No live risk.** The deployer-only guard only matters at the first `initialize`; both live portals
  are already initialized and carry the init-once guard (the source before the deployer-only guard has `revert
  AlreadyInitialized()`).
- **One path does compare the live mainnet portal to the new artifact, and fails closed.** The first
  version of this note said nothing did; the codex re-review corrected it.
  `apps/faucet/public/mainnet-bridge.journal.jsonl` is *committed* (the testnet journals are
  gitignored) with `portal` confirmed at the live address, so a no-flag run of
  `deploy-bridge-mainnet.ts` resumes it, reuses that portal, and `assertRuntimeMatchesTemplate`
  rejects it on length before anything else. Correct behaviour — a completed deployment cannot be
  resumed onto a different artifact — with one operational consequence: **the redeploy must
  begin from a fresh journal.** `verify:deployments` never reads portal bytecode, so the faucet build
  is unaffected.
- **`verify-l1` cannot re-verify the live portals from this source**, and never could since the deployer-only guard was added —
  Etherscan holds their verification and forge short-circuits with "already verified" without
  compiling the staged source. The script used to print the same ✓ for that as for a real
  verification, which made it a gate that could vouch for the wrong bytes; it now labels the outcome
  as an existing Etherscan verification that the staged source was not checked against. A post-deploy
  step, not a source-identity check.

Heuristic note for the next person doing this: substring-searching runtime hex for a *custom error*
selector is unreliable — `0x0dc149f0` (`AlreadyInitialized()`) is absent from the current artifact
too, which certainly reverts with it. Getter selectors sit in the dispatch table and are reliable;
the exact runtime keccak is the authoritative evidence.
