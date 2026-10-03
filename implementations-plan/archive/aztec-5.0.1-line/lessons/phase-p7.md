# Phase P7 — delivery (lessons)

## P6-independent P7 work executed AFK (review + audit + fixes + docs)

P6 (live redeploy) awaits the user per their standing decision ("I drive P6, you supervise"), so
P7's independent items ran first: `/code-review max --fix` (3 scoped hostile reviewers over the
arc delta) + the codex post-impl audit (gpt-5.6-sol, xhigh, session `019f7644-0b80-7540-8206-5a134d5eb47b`,
targeted checklist per the plan) +
UPDATE.md 5.0.1 couplings.

### Fix commits (each finding verified against the code before fixing)
- deploy-gate batch: candidate feeJuice cross-pinned to the INTENT's corroborated L1
  set (internal readback consistency ≠ authentication); drip-canary 4→5-arg rebuild (was
  hard-red on every valid 5.0.1 manifest); promote requires + binds the RECORDED candidateSha256
  (no first-ever-verify promote, no read-gap substitution); FPC require-deployed RUNS inside
  promote; canonical-FPC digest re-checked at every verify; previous-arc L1 pin read from the
  COMMITTED blob (`git show HEAD:`); faucet candidate derivation proven BEFORE live writes;
  authContract format-validated (32-byte hex); reuse-token bound to live manifest l1.usdc;
  deploy.ts refuses direct live --output without --allow-live-output; promote tmp
  force-removed + exclusive-created.
- codex highs: the RUNTIME-imported dist/target FPC artifact is now bound core-equal
  (file_map-stripped recursive-canonical digest, negative-controlled) to the gated target
  artifact in BOTH the gate and the tripwire; the bridge L2 token deploy + candidate record
  gained the 5th auth_contract arg (was P6-blocking); --from-journal×--reuse-token consistency;
  promote crash-pair doc corrected (recovery = idempotent re-run; tree discipline does NOT see
  allowlisted live paths).

### War stories
- **Silent python-edit no-op nearly shipped a vacuous fix**: one handler
  replacement didn't match (whitespace drift) while sibling edits did — the "new" test failed
  against the OLD handler and the debug log's old format exposed it. Every scripted
  edit now gets an assert or a grep-back. Same class: my first core-digest used a JSON.stringify
  replacer ARRAY (filters keys at EVERY level → vacuous equality); caught by a negative control
  before commit. Verify a checker can FAIL before trusting that it passes.
- `bunx tsc -p tsconfig.json` missed script-only errors — packages typecheck their scripts via
  their OWN `typecheck` script (`tsconfig.scripts.json`). Use `bun run typecheck`.

### Accepted residuals (reviewed, deliberately not fixed now — with reasons)
- rpcOptional's omitted-result-as-absence in predeploy (codex #3c): countered — the deploy
  derives addresses locally + re-asserts, and require-deployed still fails; no deposit path
  greens on a forged absence.
- l2RecordSchema's `constructorArgs: z.array(z.unknown())` stays loose (the deploy writes the
  args; the address re-derivation is the binding check).

## codex GO/NO-GO resume → the one HIGH that was NOT addressed → fixed
Codex's post-fix resume returned **NO-GO** with a single remaining HIGH: `require-deployed` ran
only inside `promote()`, but `fuel-testnet.ts` (the PrivateFPC fund-mover) deposits Fee Juice +
pays fees through `PRIVATE_FPC_ADDRESS` BEFORE promotion — promotion-time enforcement is too late,
and the separate `--mode require-deployed` command was operator discipline.

**Fix**: extracted the gate to an importable `runFpcGate(mode)` (throws on RED; CLI
wrapped behind an `isMain` guard, behavior unchanged — re-verified predeploy/require-deployed/
no-mode exit codes live) and call it INLINE at the top of `fuel-testnet.main()` before any
broadcast. Confirmed `fuel-testnet` is the ONLY script that funds through the PrivateFPC — the
fee-juice + drip canaries use the SponsoredFPC and recoverable FeeJuicePortal deposits;
deposit-testnet uses the bridge token portal (recoverable claim). promote keeps its shell-out gate
too (belt + suspenders).

**Updated P6 operator flow**: the `require-deployed` gate is now UNSKIPPABLE for the PrivateFPC
canary (inline in fuel-testnet). The operator still runs `check-fpc-version --mode predeploy`
before the FPC deploy, and `--mode require-deployed` is additionally enforced by both the canary
and promote.

## four gpt-5.6-sol ULTRA audits commissioned (running)
At the user's request ("very solid thing"), four independent xhigh audits of the whole arc as
COMPOSED FLOWS (not per-file): (1) fund-moving deploy chain end-to-end (sequencing/resume/operator
error); (3) supply-chain + artifact byte-identity (what pins BYTES vs versions); (2) and (4) covered
the wallet's own code. Findings of (1) and (3) triaged in the next entries.

## four gpt-5.6-sol ULTRA audits: full triage

Each finding was VERIFIED against the code before acting; accepted residuals carry reasons.

### Audit 1 — fund-moving deploy chain (composed flow).
- HIGH require-deployed ran only in promote → **inline `runFpcGate("require-deployed")` at the top of
  fuel-testnet** (the only PrivateFPC fund-mover); gate extracted to importable (`isMain`-guarded CLI).
- HIGH verify not coupled to broadcast → **the L1 broadcast scripts assert deployer ==
  PLAN_PINNED_L1_SIGNER** before spending; a wrong key in the broadcast shell now hard-stops.
- HIGH intent mutable / source not re-checked → **verify diffs HEAD vs intent.source.commit** and
  STOPs on any deploy-relevant change since build.
- MED remaining 4-arg canaries (smoke-existing, smoke-swap, faucet dry-run) → 5-arg swept.
- Residuals (compensated by the SUPERVISED per-group-verify flow the user drives): the canary→pin→
  promote A/B digest binding (promote already re-derivation-proves the faucet + re-hashes the bridge
  vs recorded digest); deposit-canary crash-recoverability (testnet, capped ≤0.5 ETH); default-to-live
  --config omission; secrets-in-argv (LOW).

### Audit 3 — supply-chain + artifact byte-identity.
- HIGH four residual 4-arg constructor sites (incl. faucet's connect-time bridge rebuild) → 5-arg.
- HIGH committed Noir artifacts unbound to source → **class-id + version tripwire** (proxy/bridge).
- HIGH FPC digest didn't cover the fee-payment SDK JS → **private-fuel.test pins each emitted call's
  (to, selector)**.
- MED standards artifacts unanchored → **Token/Dripper class-id tripwire** (defense beyond lockfile).
- Residuals: compat-map human-editable (by design; canary backstop); stale @alejoamiras/aztec-standards
  @5.0.0 in node_modules (nothing imports it; fresh install clears).

**Full gate after all four**: typecheck:all 0; bridge-core 156,
faucet 428.

## Post-live source-mutation classification (per-commit, intent build → merge)

Rule: after the P6 intent build, every commit classifies its files — deploy-affecting
(bridge-core src/scripts, contracts/, faucet deploy surface, canary scripts) invalidates the
intent; client-only/docs re-runs the standard suites only.

| Files | Class | Consequence |
|---|---|---|
| intent.json (candidate digest) | P6-flow artifact (intent revision, in-flow) | none — part of the supervised deploy |
| live manifests + promotion receipt | P6-flow artifact (receipted promotion output) | none — the promotion itself |
| plan.md + phase-p6 lessons | docs | none |
| phase-p7 lessons (this table) | docs | none |

No deploy-affecting source mutation since the intent build → intent remains valid; standard
suites ran green.

## P7 CLOSED — merged

Squash on the base branch. Merge was blocked twice past green checks:

1. **`required_signatures` blocked the self-authored squash** — all 104 branch commits were
   unsigned; with unsigned branch commits the classic protection refuses even the API squash. Fix
   (user-approved): the branch commits were re-signed, tree verified byte-identical pre-push,
   full CI re-run on the signed head. Lesson: on a signature-protected base, unsigned
   commits defer the merge to a user decision — budget for backfill + one extra CI cycle.
2. **One more network flake** on the byte-identical
   signed tree — re-ran failed jobs only, green, merged.

Gate: merged ✓; the base branch green ✓ (no push workflows exist for it — verified by trigger scan; the PR's
three required aggregators are the binding gate and were green on the final head).
