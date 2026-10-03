# Phase 1 — devendor

## What changed

Deleted `contracts/bridge/evm/upstream/TokenPortal.sol` and, in `verify-l1.ts`, the code that existed
only to serve it: `placePortalSource()`, `requireLegacyForgeInputs()`, the `obj()` helper they shared,
and the `PORTAL_SOURCE_REL` / `VENDORED_PORTAL` constants. `L1_ARTIFACTS_ROOT` stays — the surviving
branch uses it at both call sites.

The two-way branch collapsed. Every manifest now goes through `parseCandidateManifest`, whose schema
already declares `portalSource: z.literal("forked-v1")`, so the rejection needed no new guard code —
the branch was what let a legacy manifest bypass the strict schema in the first place.

`biome check --write --unsafe` removed the imports that fell out (`copyFileSync`, `mkdirSync`,
`keccak256`, `evmAddress`); `tsc` alone did not flag them.

## Gate result

| Check | Result |
|---|---|
| `bun --bun vitest run` (bridge-core) | 267 passed, 1 skipped — was 265, +2 new |
| `bun run --filter @unleashed/bridge-core typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `verify-l1 --config …/testnet-bridge.json --dry-run` | all four contracts build their standard-json |
| residual references | none, except one deliberate (below) |

## Mutation verification of the new tests

The plan's rule is that a guard nothing exercises is worth nothing, so the two schema tests were
checked the same way the proofs will be. Weakening the schema —

```
- portalSource: z.literal("forked-v1"),
+ portalSource: z.string().optional(),
```

— turns **exactly** the two new tests red and leaves the other 14 in that file green:

```
× rejects a manifest whose portalSource is not the fork
× rejects a pre-fork manifest that omits portalSource entirely
Tests  2 failed | 14 passed (16)
```

Restored, all green again. They fail for their own reason, not a neighbouring one.

## The comment left deliberately stale

The forked portal's provenance comment still points at the file this phase deleted, and its header still
mentions the shim that Phase 2 removes. Both are wrong, and both stay.

solc folds a hash of the source — comments included — into the deployed bytecode. Editing either line
would move `FORKED_PORTAL_KECCAK`, `PORTAL_PIN` and the committed artifact, and leave the live mainnet
and testnet portals unverifiable until every pin was regenerated and re-reviewed. Two stale comment
lines are the cheaper cost, and the reason is recorded here rather than in the file, precisely because
writing it in the file would trigger the thing it warns about.

## Note

The plan called for a `verify-l1.test.ts`. It was dropped during review: `verify-l1.ts` exports nothing,
runs on import, writes `remappings.txt` at module scope and exits via `process.exit`, and no unit-test
job installs Foundry — so a spawn-based test would pass on `"forge not found"` rather than on the
behaviour it names. The assertion belongs in `candidate-schema.test.ts`, where the rejection actually
lives.

## Arc-1 quality loop

`/code-review` in this repo is an interactive guided tour, not an automated fixer — it sends one stop
per message and waits for a human. Its judgment step was performed directly instead (the
`requireLegacyForgeInputs` field-by-field comparison above), and the codex brief said so, so the audit
knew there were no separate code-review commits to distinguish.

**Round 1 — "The arc is sound. I found no functional or validation regressions."**

It independently confirmed the removal question: *"Nothing previously validated on a still-reachable
path became unvalidated. The strict schema covers all removed checks and imposes additional structural
and semantic validation."* It also checked something not asked — that discarding `parseCandidateManifest`'s
return value is safe, because the schema has no coercions, defaults or transforms — and that the
operator-facing failure is legible: a real pre-fork manifest fails with
`l1.portalSource: Invalid input: expected "forked-v1"`, not a buried zod dump.

Two low-severity comment findings, both adopted:

1. The schema-test comment was long *and wrong*. It said that without the rejection forge is handed "a
   contract path that does not exist"; forge would actually receive the **fork's** path against a
   canonical portal address — a worse failure, and worth naming accurately.
2. Two comments still said "legacy manifests fall back to Sepolia", which no longer parse at all. The
   surviving behaviour is narrower: a valid manifest that omits `l1ChainId`.

**Round 2 — converged. "No new findings."**

## Forward answer that reshaped Phase 2's framing

Asked whether the planned harness could pass for a reason other than the guard holding, codex named the
decisive mechanism, which is *not* the seven-value comparison:

> "Any successful second initialization executes `assertTrue(false)`. Therefore deleting
> `AlreadyInitialized` fails the proof even if candidate values equal existing values."

That matters because it means the proof cannot be defeated by a candidate argument that happens to
equal what is already bound — the unwanted-success branch fires regardless.

On `FakeRollup.getVersion()` being `pure` and returning a constant: harmless. The assertion still
correctly checks that a rejected initialization left every binding untouched; it simply is not an
independent rebind witness. Registry, rollup, inbox and outbox ARE concretely distinct between A and B.
The plan's wording must therefore say *those four* are distinct sentinels, not all seven.
