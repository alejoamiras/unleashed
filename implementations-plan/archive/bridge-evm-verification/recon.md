# Recon — bridge-evm-verification

Read-only sweep of the surfaces this plan touches, run against the base branch.
Verified: `git diff HEAD` against the base branch over `contracts/bridge/evm`, `packages/bridge-core`,
and both contracts workflows is **empty**, so this tree is faithful to the base for every file below.

> **Caveat on absence claims.** The recon agent lost shell access partway through and completed the
> sweep with file reads only. It did not exhaustively list `contracts/bridge/evm/src/mocks/`,
> `src/interfaces/`, or the root `scripts/` directory — contents reported for those are inferred from
> imports rather than a listing. Absence claims about those three paths are weaker than the rest and
> are re-checked below where they matter.

## Reuse map

| Capability | What exists | Verdict |
|---|---|---|
| Halmos proof conventions | `test/FormalRouter.t.sol` — symbolic args as plain function params + `bound()`; `check_*` prefix (halmos-only, unused elsewhere); mocks imported from `BlackhatAudit.t.sol` | **reuse-as-is** |
| Failure signalling in proofs | `assertTrue(false, …)` inside the unwanted-success branch of a `try/catch`; never `revert(string)` — documented in the file's own header | **reuse-as-is (mandatory)** |
| Mutation verification | No script, target, or CI step. A documented manual convention only | **absent — follow by hand** |
| Route-grammar coverage | `RouteGrammarFuzz.t.sol` (fuzz, 256 runs, shapes capped at 1–3 hops), `RouteValidation.t.sol` (9 concrete vectors, one 3-hop) | **gap is narrow — see below** |
| Portal mocks | Three near-duplicate fake sets; the most complete is `PortalRoundtripFuzz.t.sol:85-151` (`FakeRegistry`, `FakeRollup`, `CapturingInbox`, `CapturingOutbox`) | **reuse-as-is (import, don't copy)** |
| `verify-l1` deletion surface | `placePortalSource`, `PORTAL_SOURCE_REL`, `VENDORED_PORTAL`, **and `requireLegacyForgeInputs`** — none exported, all reachable only from the non-`forked-v1` branch | **clean delete** |
| Unsupported-config idiom | `verify-l1.ts`'s own `fail(message): never` helper (`:48`), already used for four other bad-config cases in the same file | **reuse-as-is** |
| CI halmos gate | `_bridge-contracts.yml:76-98` — `--contract FormalRouterTest`, hardcoded count `4` | **adapt** |
| Test conventions | flat `test/`, `*.t.sol`, `<Subject>Test`; `packages/*` use **vitest** under Bun (`bun --bun vitest run`), colocated `*.test.ts` | **reuse-as-is** |

## Findings that change the plan

**1. `requireLegacyForgeInputs()` is part of the same dead path.** `verify-l1.ts:56-91`, called once at
`:160`, only when `portalSource !== "forked-v1"`. The original draft's change map missed it. It goes
with the rest.

**2. The strict schema already encodes the target state.** `candidate-schema.ts:43` declares
`portalSource: z.literal("forked-v1")` inside a `.strict()` object. Today that schema is applied only
*inside* the forked branch (`verify-l1.ts:154`), so the legacy branch bypasses it. Removing the branch
routes every manifest through the strict schema, which already rejects anything else — the explicit
guard is close to free, and should use the file's existing `fail()` helper rather than a new pattern.

**3. `L1_ARTIFACTS_ROOT` must survive.** It is used by the forked branch at `:215`, not just the legacy
one. Deleting it with its neighbours would break the surviving path.

**4. `verify-l1.ts` has no test file at all.** The `packages/bridge-core/scripts/*.test.ts` set contains
no `verify-l1.test.ts`. The deletion is currently guarded only by `tsc` and a manual `--dry-run`. This
is why Phase 1's gate adds one — an unsupported-config guard nothing exercises is the same
unfalsifiable shape this plan exists to remove.

**5. The CI invocation names exactly one contract.** `halmos --contract FormalRouterTest` — a new proof
contract that compiles would silently never run, while the `4 passed` assertion still reads green.
Independent confirmation of the per-contract-invocation design.

**6. The portal shim's stated rationale is stale.** Its header claims the real portal's
`@aztec` transitive tree (`IRollup → FeeLib → BlobLib`) "does NOT resolve in the bridge-evm Foundry
project". It resolves now: `BlackhatAudit.t.sol:29` and `PortalRoundtripFuzz.t.sol:7` both import and
instantiate the real portal, and `forge build` succeeds in a clean worktree. The
`@aztec-blob-lib/` remapping added during the previous arc fixed precisely that tree.

Two consequences. First, codex's requirement for target B — *prove against the real contract, because
"using the shim proves only that the shim resembles the custody contract"* — **is achievable**. Second,
`PortalReinit.t.sol` currently proves the guard against a hand-written copy of the guard; whether the
real one is covered by anything always-on is settled by mutation in `lessons/phase-0.md`.

**7. Three duplicate fake-registry sets** (`BlackhatAudit.t.sol:191-235`, `PortalReinit.t.sol:12-36`,
`PortalRoundtripFuzz.t.sol:85-151`), none canonical. Real drift, but **out of scope** — noted for a
follow-up rather than folded into this plan.

## Route-grammar gap, stated precisely

Both existing files cap path length at 3 via hand-picked shapes, and both draw addresses from the
fixed `USDC`/`WETH`/`FJ` constants. A symbolic proof's genuine addition is therefore **full-domain
coverage of addresses and directions at bounded lengths**, not unbounded length — halmos bounds
dynamic arrays anyway (`--default-array-lengths` is `0,1,2`). Scoping the proof as "unbounded route
coverage" would overclaim; scoping it as "exhaustive over sides and addresses for lengths ≤ N" is
honest and is what §4 of the plan states.
