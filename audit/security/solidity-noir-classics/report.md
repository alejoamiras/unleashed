# Solidity + Noir classics audit — report

**Method:** codex xhigh + fable subagent (Solidity) + fable subagent (Noir) +
main-agent read (`context.md`). Classics-focused sweep of the whole contract surface, complementing the
Phase 9 changed-surface re-audit.

## Verdict

**No new Critical / High / Medium — on either surface.** All four lenses independently confirm:
- **The Permit2 witness is FULLY bound** (all 12 fund-flow params signed incl. `swapTarget` + the route
  hash; cross-entrypoint replay closed; fuzz-pinned by `testFuzz_witnessTamperChangesHash`). No steerable
  parameter escapes the signature.
- **The recipient-commitment is cryptographically sound** — fable-Noir traced it into the rc.2 protocol
  sources: nullifier replay-protection binds `message_hash`+`leaf_index`; cross-consumer isolation is
  enforced by the content selector (a private message is consumable ONLY by `claim_private`); DS
  `3140354885` is absent from the entire protocol constants table; `to_field()` is injective; consumed-for
  ≡ minted-to by construction.
- Reentrancy guarded, approvals zeroed, hostile-swap-target + hostile-portal residue theft closed and
  fuzz-pinned, ownership is 2-step.

The findings below are **Low/Info only** — forward-looking, owner-trust, privacy-defense-in-depth, or
value-token hardening. **None is a fund-theft path against the current deployment.**

## New findings — triage

| ID | Sev | Surface | Title | Disposition |
|---|---|---|---|---|
| **FS-L1** | Low | Sol | `bridgeWithFuel` doesn't enforce `minFuelOutput > 0` at the router — the sanity floor lives only in the owner-replaceable swap target (contradicts the `:196-198` design intent) | **ACCEPT (testnet)** → current swapTarget HAS the guard; fix = one-line `require` on the **next router redeploy** (router is reused/deployed, so not a hot-fix) |
| **FN-L1** | Low | Noir | owner `set_paused` is an unbounded single-key liveness switch (freezes all 4 value paths; funds frozen, not stolen; separate from F-002) | **ACCEPT (testnet)** → operator-trust; value-token = timelock / bounded pause / guardian unpause |
| **CX-L1** | Low | Sol | vendored portal over-mints a fee-on-transfer/rebasing underlying (direct-call only; router paths self-revert) | **ACCEPT (testnet)** → AZLO is vanilla OZ ERC20 (not exploitable); value-token = balance-delta accounting |
| **FN-I1 / FS-I3** | Info (privacy) | Noir+Sol | recipient de-anonymization via a **weak/deterministic salt** (the L1-public `secret_hash` = `H(derive(salt,recipient))` + public amount is brute-forceable pre-claim); AND a private token bridge always emits a **public** fuel deposit revealing `fuelRecipient` | **FIXED (docs+test+comment)** → see below; production already safe (`Fr.random()` + client FPC-enforcement) |
| **FS-I1** | Info | Sol | native-**first** route shape passes `_validateRoute` but `_settle` can't settle it → validate-then-revert (fail-safe; witness-bound) | **ACCEPT** → self-DoS only; tighten validation on next redeploy |
| **FS-I2** | Info | Sol | `renounceOwnership` inherited + not disabled → renounce bricks `sweep`/`setSwapTarget` | **ACCEPT** → owner-only footgun; override-to-revert on next redeploy |
| **FS-I4** | Info | Sol | events emit `aztecRecipient` for private bridges where it's unused (indexer accuracy) | **ACCEPT** → cosmetic |
| **FS-I5** | Info | Sol | no assertion that `_permit2` is the canonical Permit2 (deploy hygiene) | **ACCEPT** → candidate uses canonical `0x…78BA3` (verified); assert the constant on next redeploy |
| **CX-I1** | Info | Sol | `MockSwapTarget` ignores ERC20 bool returns (test-only) | **ACCEPT** → test hygiene |

## What was FIXED this pass — the salt-entropy privacy invariant (FN-I1 / FS-I3)

Both fable lenses surfaced the same forward-looking privacy gap, distinct from the already-documented
salt-**leak** → linkage risk: because the private deposit's `secret_hash = computeSecretHash(deriveTokenClaimSecret(salt, recipient))`
is **L1-public** and the amount is public, an observer can brute-force `(salt, recipient)` to
**de-anonymize the recipient pre-claim** — *iff the salt is low-entropy*. Production is safe today
(`Fr.random()`, ~254-bit), but nothing pinned the requirement, so a future "deterministic/recoverable
salt" refactor would silently break recipient-privacy for every private deposit with no tripwire.

Fix (this pass): a loud invariant comment beside `deriveTokenClaimSecret`, a README rewrite distinguishing
the two salt risks (leak→linkage vs weak→de-anon), and a **test** asserting two private deposits to the
SAME recipient produce DIFFERENT `secret_hash`es (a future deterministic-salt refactor turns that test
red). The related linkability (a private token bridge emitting a public fuel deposit) is already enforced
client-side (`flows.ts` requires `fuelRecipient == PRIVATE_FPC_ADDRESS` for private) — documented as
client-enforced, router-unenforced (value-token hardening).

## Value-token / hardening backlog (carried forward — none blocks testnet)

`bridgeWithFuel` router-side `minFuelOutput > 0`; portal balance-delta accounting for FoT tokens; pause
timelock/guardian; `_validateRoute` native-first rejection; `renounceOwnership` override; canonical-Permit2
assertion; private-fuel `fuelRecipient == FPC` on-chain enforcement. These join the existing value-token
blockers (A-1 on-chain portal-binding, INFO-1 `MintableERC20`) in `contracts/bridge/evm/README.md`. A
router redeploy is the natural place to land the Solidity one-liners.

## Per-pitfall-class coverage (checked → holds)

**Solidity:** reentrancy/CEI/callbacks; access control (modulo known F-001/F-002 + new I-2 renounce);
arithmetic/`unchecked` (none present)/default-values; external-call returns (SafeERC20 everywhere, modulo
mock CX-I1); no delegatecall/proxy/tx.origin; **Permit2 EIP-712 domain/nonce/deadline/malleability/replay
+ cross-entrypoint replay**; approval race (paired forceApprove-to-zero); MEV/slippage (F-006 + new FS-L1);
oracle (none read); DoS/return-bomb (typed returns, revert-only); fee-on-transfer (fail-safe on router,
CX-L1 direct); force-fed/stuck ETH (sweep); rounding (exact split, fuzz-pinned); events (FS-I4);
timestamp (none).

**Noir:** L1→L2 replay/double-consume/cross-consumer; nullifier soundness; recipient-commitment soundness;
DS reuse; access-control/visibility (`only_self`/`assert_bridge`, exactly-2 consume sites, one-shot
`set_bridge`/`set_token`); pause atomicity (private→enqueued-public reverts wholesale); degenerate inputs
(zero recipient/amount guarded, max-u128 keystone-pinned); private/public leakage (modulo FN-I1);
mint accounting/reentrancy; 2-step ownership.
