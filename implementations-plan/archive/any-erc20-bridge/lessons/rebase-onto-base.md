# Rebase onto the base branch — the stack meets the tools rename and the journal fixes

## Situation

The stack was submitted on a base 22 commits behind the base branch.
In between, the base branch had merged the `apps/faucet → apps/tools` rename,
the faucet-tab → Drip rename, two complexity decompositions of the very files the
stack rewrote (`backup.ts`/`promotion.ts`/the fuel composables, `live-intent.ts`), the
"justified" baseline format, and four journal/fuel bug fixes.
`git merge-tree` reported ~340 conflict lines. Every arc's loops had converged on the old base, so
the rebase was treated as new code: strategy consulted with codex first, resolutions recorded here,
the full gate battery re-run, and one scoped verification pass afterwards.

## Strategy (codex consult, fresh session, verdict quoted)

"Rebase a five-commit scratch chain onto the base branch, but 'my rewrite wins' would currently reintroduce
several confirmed journal bugs." Adopted: per-arc squash (the PRs squash-merge; each arc's history
is preserved on local backup refs and in the phase lessons), one
rebase of the five-commit chain onto the base branch with `merge.directoryRenames=true`, `rerere` on, and a
port list derived from the base branch's diffs rather than a policy of "mine wins". Rejected: merging the base branch into
each arc (five merge commits, five conflict sets), rebasing 59 commits one by one (the same
conflicts resolved eleven times over).

## Resolution policy and what was ported

- **Retired surfaces stay retired (D19).** Files the base branch renamed or fixed that the wizard replaced
  (`BridgeForm*`, `FuelForm*`, `BridgeAddToken*`, `MintFuelAsset*`, `MintTestUsdc`, `useWithdraw`,
  `useDeposit*`, the v1 manifests + journals, `deploy-bridge-*`, `restore-swap`,
  `smoke-existing-mainnet`) are deleted, plus the Fuel-tab modules the base branch ADDED after the base
  (`useFuel.ts`, `useL1FeeAsset.ts`, `router-bridge-leg.ts`, their pins tests,
  `useWithdraw.pins.test.ts`) — nothing surviving imports them.
- **The base branch's journal fixes carried into the surviving engine.** `patchRecordWhen` + the expected-hash
  guards (a terminal revert clears the claim hash only while the persisted hash is still the reverted
  one; a superseded hash stops quietly) and `currentRecord` landed by auto-merge in
  `useBridgeJournal.ts`; the malformed-claim-hash terminal fault (`isWellFormedTxHash` →
  `reportMalformedClaimHash`, `TERMINAL_ATTENTIONS` + `FAILED_ATTENTIONS` gain `malformed-record`)
  was merged by hand into the send lane's guard order; `patchFuel` (every fuel write merges into
  the PERSISTED block, never an await-stale captured spread) was ported into `deposit-flow.ts` and
  applied to all eight fuel-write sites (`recoverSendLeg`, the gas-only claim latches, both fee
  ladders' `consumed` latch, the hub-claim latches, the standalone claim) and to
  `fuel-recovery.ts`'s reconcile (which now reads the persisted record, not the reactive copy);
  the malformed-FUEL-hash stop guards both ladders before `fuelReceiptStatus`. Well-formed 64-hex
  fixture hashes replaced the `"0xconsumetx"`-style literals the base branch's tests had already moved off.
- **The base branch's identities adopted.** `tl-` testid prefix + `tabDrip`, `DripView`, `useDrip`,
  `useAddDripToken`, `ToolsTarget`/`resolveToolsTarget`, `buildDripManifest`/`DripManifestInput`,
  the wallet-facing app name (and the legacy-key migration the base branch added in
  `useWalletConnection`/`createAztecWalletSession` — both describe blocks kept), the `@unleashed/tools`
  package + `test:tools`/`build:tools`/`_build-tools.yml`; every `apps/faucet` path in the stack's
  code and docs re-pointed (`git grep` clean outside historical audit reports).
- **Mine kept where the base branch's change was a decomposition of code the arc replaced**: `backup.ts`
  (the arc's version is the superset — full optional-field validation, schema 3, the send-record
  branch; the base branch's `backup.pins.test.ts` passes against it unchanged), `promotion.ts`, `capabilities.ts`
  (+ the base branch's renames), `bridge-steps.ts` (+ the base branch's terminal attention), `build-integrity.ts`,
  `vite.config.ts`, `App.vue` (the async shell), the bridge-core scripts (the base branch's edits there were the
  path rename), and `live-intent.ts`.
- **Dropped, recorded as a follow-up**: `live-intent.pins.test.ts` (a 39-case harness) pins
  byte-exact event traces of the OLD verifier — the retired Noir artifact list, the v1 manifest's
  `l1.feeJuice`/`fuel.core` shape, `UNDERLYING()`/`FEE_ASSET()` readbacks — none of which the
  generation verifier has. Its harness (fs overlay, scripted `run`/`fetch`, one ordered event
  stream) is worth re-targeting at `verifyGenerationBindings` + the gate ladder; that is a port,
  not an adaptation, and it is the first item in the follow-ups below.
- **The complexity baseline regenerated at EVERY commit of the chain** (each PR's CI checks its own
  tree): `baseline:rescore` clean, `baseline:complexity` 35 → 29 acceptances (the stack removed
  accepted functions and added none — the generator inserts nothing).

## Verification (codex, resumed strategy session)

**Round 2** on the resolutions: "structurally sound, but not merge-ready" — two ports were incomplete
and two arcs could not pass their own CI. Fixed, all in the chain: (1) `priorFuelClaimStop` (the
gas-only re-claim gate: consumed/included/pending/malformed prior claim → stop, dropped → rebuild) had
been dropped with the old builder — restored in `buildFeeJuiceClaimDep`, reading the persisted block;
(2) `reconcileFuelSalt` still replaced the nested block from a captured copy — now `currentRecord` +
`patchFuel`; (3) arc 3's `verify-deployments.ts` parsed v2 unconditionally while arc 3's committed
manifests were still v1, and arc 4's manifests were v2 `bridge: null` before the placeholder
acceptance arrived in arc 5 — so `_build-tools.yml` would have failed both PRs. Arc 3 now carries
BOTH verifiers behind a `schema === 2` dispatch (the v1 artifacts still exist there), arc 4 drops the
v1 branch with the retirement and keeps the placeholder acceptance; (4) two values the
key rename left behind (`fa-emoji-cell-*`, `tl-tab-faucet`) and two doc paths. Per-commit gates
extended to the exact `_build-tools.yml` verify command for both targets + `test:ci-gating`.

**Round 3**: "the production resolutions are correct, and the deferred v2 live-intent harness is not
testnet-blocking; one regression-coverage gap remains" — the restored gas-only gate and the
persisted-over-captured merge had no focused tests (the base branch's cases left with the retired
characterization suite). Added to `deposit-flow.test.ts` (arc 4): consumed / included / pending /
unreachable / dropped / malformed, and the latch carrying a persisted field the captured copy never
saw. **Round 4** (scoped), quoted: "the arc-4 tests cover every prior-claim branch and
persisted-over-captured merging, and propagate unchanged to the top; the rebased stack is
resolution-clean. no new material findings."

Lesson: after a rebase that replaces a subsystem, diff the OTHER side's fix commits against the
surviving code by BEHAVIOUR, not by file — the re-claim gate lived in a builder the arc had deleted, and
"the file merged cleanly" said nothing about it.

## Gates (rebased chain)

Per commit (each PR's own tree): lint 0 · `typecheck:all` 0 · `BRIDGE_MANIFEST=public/{testnet,mainnet}-bridge.json verify:deployments` 0 · `test:ci-gating` 0 — × 5. Top of chain: bridge-core 423
(+1 live-gated), tools 1080, e2e 20, `test:all` and `lint` below.

## Follow-ups

1. Port the live-intent pins harness to the generation verifier (`verifyGenerationBindings`,
   the digest/tree/commit/spend ladder).
2. The intent tooling items from phase 9 (runtime schema for the intent JSON, commit from the
   first verify, `bootstrap-baseline`).
