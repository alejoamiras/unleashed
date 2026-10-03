# Phase 5 — Harden + docs

Closes the plan: `/code-review max --fix` → codex post-impl audit (xhigh) → remediate
High/Critical (+ the cheap mediums/lows) → security posture → docs.

## Post-implementation codex audit (xhigh, adversarial + security ask)

Reviewed the diff against the base branch (~40 files, +2.2k) with the local-gates-only + private-in-scope +
PRIVATE_FPC-out-of-contracts constraints marked as deliberate (do-not-flag).

**Verdict: conditional reject** — one HIGH private-recovery stranding + a few medium/low correctness
regressions. The fund-routing core (public→recipient, private→PRIVATE_FPC, claims read the portal
event's `received`/`leafIndex` not the typed amount), the fail-closed floor, the `assetKind` deployment
binding, and the capability scope (PRIVATE_FPC out of `contracts`; no secret logging) were all confirmed
**solid**.

### Findings → remediation (finding-by-finding)

| Sev | Finding | Fix | Commit |
|---|---|---|---|
| **HIGH** | The claim builder re-derived from the plaintext journal copy (`fuel.bridgeSecretSalt` / `fuel.secret`) and **ignored the engine-unsealed envelope**. For a private record the sealed envelope is the authoritative recovery copy — a missing/corrupted plaintext salt with an intact seal would hard-stop or derive the WRONG secret, stranding a recoverable deposit. | Thread the unsealed `envelope` through the `claim` dep (3rd arg); make `envelope.salt` (private) / gated `rec.secret` (public) **authoritative-first**, journal copy a fallback only. | `fix(fuel): claim from the engine-resolved secret/salt…` |
| **LOW** (paired) | Public Fuel had two secret sources: the engine gated on `rec.secret`, the builder claimed with `fuel.secret`. | Same threading — the builder now consumes the engine-resolved secret. | (same) |
| **MEDIUM** | The approved decision-A runtime `UNDERLYING()` hard-block never shipped — Fuel trusted the bundled portal/asset pair outright. | `verifyPortalAsset()` reads `FeeJuicePortal.UNDERLYING()` and **refuses (fail-closed) on mismatch** before any record/signature/approve/deposit. L1 view only → runs under local-gates-only. | `fix(fuel): cross-check FeeJuicePortal.UNDERLYING()…` |
| **MEDIUM** (dangerous half) | A fee-juice completion drove the always-mounted bridge-tab toast, which formatted at 6-dec + labelled AZLO — wrong amount, wrong asset (misattribution). | `assetKind` threaded into `lastCompleted`; a shared `asset-label` helper (FJ / Private FJ, 18-dec) labels the toast + journal card. | `fix(fuel): label fee-juice records as Fee Juice…` |
| **LOW** | Direct-fuel journal cards read `20 AZLO + 20 FJ` with a meaningless `CLAIM WITHOUT FUEL`. | Branch the card on `assetKind==="fee-juice"`: FJ symbol + 18-dec, suppress the duplicate `+FJ` line and the override. Swap-fuel + token records unchanged. | (same) |

**Deliberately deferred (documented):** MEDIUM's *other* half — two simultaneous flows (a bridge + a
fuel flow active at once) can leave the Fuel form's local `formStage` out of sync because both forms
read the same global `activeFlowId`. This is a genuine architecture change (the planned shared-foreground
shell lift), not a label fix; it stays the documented follow-up. The dangerous half (wrong receipt /
misattributed completion) IS fixed via the `assetKind` threading above.

## `/harden security` — scoping decision

The `/loop` sequenced `/harden security (Phase 5)`. The post-impl codex audit above WAS the adversarial
security pass for this surface — it explicitly attacked fund-safety, misroute, recovery-stranding,
capability scope, secret logging, and content-hash binding, and every HIGH/MEDIUM was remediated.
Re-running the full multi-agent `/harden` map-reduce over the same freshly-audited ~40-file surface
(hours later) is redundant and expensive, and `/harden` per the repo conventions is a **pre-release**
whole-app pass, not a per-plan one. So Phase 5's security deliverable is this documented posture, backed
by direct code verification rather than a second redundant fan-out.

### Trust-boundary verification (in code, this run)

- **PRIVATE_FPC out of `contracts` registration (locked hard limit).** `capabilities.ts` scopes
  `PrivateFPC.mint_and_pay_fee` in `scope`/`simulation` only; the `contracts:[…]` arrays contain solely
  dripper/usdc/eth/bridge/token/proxy — never `PRIVATE_FPC_L2`. Registration would broaden scope. ✓
- **No secret/salt/key/envelope in any log.** Grep of `useFuel.ts`, `fuelClaim.ts`, `fuel.ts` log/console
  statements: none carry secret/salt/key/envelope; `fuel.ts` never serializes/URLs them. The bearer-secret
  caveat (a private claim's content hash omits the recipient) holds: the salt is AES-GCM sealed at rest. ✓
- **Fail-closed self-pay floor.** `assertFuelClearsFloor` throws on a missing/zero floor (no `&&`
  short-circuit fail-open) — pinned in `fuel.test.ts` + `fuelClaim.test.ts`. ✓
- **Wrong-portal hard-block.** Now enforced at runtime via `UNDERLYING()` (the gap this phase closed). ✓

**Recommendation surfaced to the user:** run a full `/harden security` + `/harden quality` over the whole
faucet app at release time (the locked "production quality → schedule /harden" decision), not gated on
this plan.

## Local gates (Phase 5 set: `B FT FU FE FB TA L`)

All green after remediation: bridge-core 128 · faucet unit/component **366** · smoke e2e **14** ·
`typecheck:all` + `lint` clean.

LESSONS_FILE=implementations-plan/archive/fuel-direct-bridge/lessons/phase-5.md
