# Phase 7 — candidate canaries → (held) promotion

Status: ◑ IN PROGRESS. Public + private canaries PASSED live on the candidate. Promotion HELD on the
user gate. Fuel/swap/relayer canaries pending a decision (real dust money + FJ each).

## Candidate under test (Phase 6 deploy)

Portal `0xbd07…bd8b`, L2 proxy `0x2da8…62dd` / token `0x2dcb…b31c` / bridge `0x0f13…e98e`, reusing live
AZLO `0x457f…d389`. Manifest: `apps/faucet/public/testnet-bridge.candidate.json` (`privateClaimMode: salt-v2`).

## Canary results (live testnet, real proofs, dust AZLO)

| # | Canary | Command | Result |
|---|---|---|---|
| 1 | public bridge → `claim_public` | `smoke-existing-testnet.ts --config <candidate>` | ✅ PASS (2.9m, 100 AZLO, `balance_of_public` verified) |
| 2 | **PRIVATE bridge → `claim_private`** (strand-risk gate) | `… --config <candidate> --private` | ✅ PASS (4.4m, `balance_of_private` verified — recipient-commitment works LIVE) |
| 3 | **redirect-proof** (wrong recipient can't consume) | `… --config <candidate> --redirect-proof` | ✅ PASS (binding held — see below) |
| 4 | fueled bridge (Permit2 `bridgeWithFuel` + self-paying claim) | `smoke-swap-existing-testnet.ts --config <candidate>` | ✅ PASS (3.5m, token 9.75 AZLO + FJ 331 — new portal + reused router) |
| 5 | fuel-testnet: PUBLIC + 3× PRIVATE FPC-fuel legs | `fuel-testnet.ts --config <candidate>` | ✅ PASS (14.2m, all SETTLED; the `tokenClaimSalt` fix let the private leg past the F2 guard) |
| 6 | fuel-only (`router.bridge` → FeeJuicePortal) | — | ⏭ COVERED, not scripted (see below) |

### Canary 5 note
`MIN_FUEL_FJ` calibration emitted `10.67 FJ` (4× worst `getFeeLimit`). The candidate carries `minFuelFj =
29.58 FJ` from the reused live config — conservatively HIGHER than needed, so safe (not blocking). Tune
down at leisure post-promotion if desired.

### Canary 6 (fuel-only) — treated as COVERED, deliberately not scripted
Fuel-only (part b) is `router.bridge(SimpleBridgeParams, PermitParams)` → FeeJuicePortal, `isPrivate`
always false (`useFuel.ts:154-159`). It runs entirely through the **reused router `0x4c3f…4068` + the
unchanged FeeJuicePortal** — neither touched by the candidate deploy. It is already fork-tested on REAL
Sepolia (`test_fuelOnly_realFeeJuicePortal`, 12/12 green: approve Permit2 → `router.bridge` → asserts FJ
pulled + no router residue) and will be exercised in the post-promotion UI canaries (step 8). Per the
project's testing philosophy (smallest set that proves it works, no redundant tests), a scripted live
fuel-only canary would only re-validate fork-tested + unchanged infra, so it was intentionally skipped.

## Candidate validation verdict

The recipient-commitment CORE (the actual change) is proven LIVE on the deployed candidate: public claim,
private claim (strand-risk gate), and redirect-proof (wrong recipient can't consume a synced message).
The fueled paths (parts a/b via the router + Permit2) are proven live (canary 4/5) or fork-tested
(fuel-only). **Candidate READY for promotion — held on the explicit user gate.**

### Canary 3 — the redirect-proof + a PXE gotcha

Design: deposit A + a sync SENTINEL B (both to R). Claim B → the network has synced past both (B is a
later leaf), so a wrong-recipient claim on the earlier A that reverts does so for the BINDING reason,
not because A isn't synced. Live evidence (leafA 7555072 < leafB 7556097): `sentinel B claimed → network
synced` then `wrong-recipient claim threw (expected)` — the binding held on a SYNCED message. Redirect
impossible on the deployed candidate.

**Gotcha (fixed):** the first version added a redundant "correct re-claim of A" as an authoritative
check. It WEDGED — re-simulating the SAME leaf in the SAME PXE session after a failed consume attempt
loops forever (repeated `claim_private` simulates, never completing; a local-PXE limitation, NOT
on-chain state — A was never consumed). Killed the run (the two signals above already prove the binding)
and removed the re-claim: a reverted `consume_l1_to_l2_message` never nullifies the message (protocol
invariant), so A stays claimable, and canary 2 already proves a correct private claim settles. **Lesson:
don't re-claim the same leaf in the same PXE session after a deliberately-failing claim on it.**

Canary 1 also confirmed the shared SponsoredFPC has FJ (post user top-up) + the candidate wiring is
sound. Canary 2 is the load-bearing one: the recipient-committed `claim_private` (deposit commits to
`H(deriveTokenClaimSecret(salt, recipient))`, circuit re-derives) settles + mints to the recipient on
the DEPLOYED candidate — not just the sandbox. The circuit artifact is byte-identical to Phase 2/4
(keystone-pinned), so the redirect-proof + relayer behavior is guaranteed identical; canary 2 proves the
deployment + live network handle it.

## Remaining canaries (pending)

- **3 — relayer redirect-proof** (`relay-claim-testnet.ts --wrong-recipient`, mode coded): submits
  `claim_private(WRONG, salt)` directly → MUST revert. Needs a descriptor-emitting private deposit
  (deposit + skip self-claim) to leave a message for the relayer. Security-critical but circuit-proven
  in Phase 4 (byte-identical artifact).
- **4-6 — swap public / fuel private / fuel-only**: exercise parts (a)/(b) — the fueled-bridge + fuel-only
  Permit2 paths (`smoke-swap-existing-testnet.ts`, `fuel-testnet.ts` private leg, fuel-only canaries).
  Separate from the recipient-commitment core.

## Promotion gotcha — `biome format` the manifest before committing

The deploy script writes the candidate manifest with `JSON.stringify(…, "\t")`, which **fails `biome
format`** — NOT over tabs (those match biome's `indentStyle: tab`) but because `JSON.stringify` always
multi-lines arrays while biome **inlines short ones** (e.g. `"constructorArgs"`).
So a raw `cp candidate → testnet-bridge.json` + commit would **red the promotion's lint /
`audit:faucet` gate**. Promotion MUST run `bunx biome format --write apps/faucet/public/testnet-bridge.json`
after the `cp` (whitespace-only — the faucet parses the JSON identically). Surfaced by the
classics audit. NOT worth changing `deploy-manifest.ts`: matching biome's array-inlining would mean
shelling `biome` into the crash-safe atomic-write path — the post-cp format step is the clean fix.

## Promotion — HELD

Per the standing user gate + the WIPE plan: promotion = `cp candidate → testnet-bridge.json` (carrying
`privateClaimMode: salt-v2`) + `audit:faucet` + ship faucet+code as ONE release. NOT run without an
explicit second go.

## Watch-state event: base-branch conflict on the docs index (resolved in-loop)

While holding at the promotion gate, a new commit on the base branch
appended an entry to `implementations-plan/index.md` at the same spot my branch had appended the
bridge entry → GitHub flipped `mergeable` UNKNOWN → **CONFLICTING**. A trial merge
(after stashing the local-only `testnet-bridge.json` override so it
was never at risk) confirmed the ONLY conflict was `index.md` — a pure append-collision, zero code,
zero permission-semantics. Resolved by taking the UNION of both entries (the base branch's completed
line first, then my in-progress bridge line, preserving chronological-append order),
merge-committed + pushed. PR back to MERGEABLE; required checks
re-queued on the new head. The candidate/code is untouched — this was integration hygiene, not a
change to the held work. **Lesson: an index.md append-collision is the expected steady-state churn for
a long-lived branch; resolve it in-loop (union, no code review needed) rather than surfacing — it's not
a decision, and letting the PR sit CONFLICTING would block the eventual user merge.**

## `[✓]` PROMOTION EXECUTED — triggered by a CF-preview scope violation + a codex-ultra privacy fix

**What happened.** The user loaded the **Cloudflare branch preview** of the faucet and hit, at
connect time: `Scope violation: registerContract targets 0x1244fe1f…, not permitted by granted
contracts scope`. Diagnosis (all addresses computed locally, not guessed):

- The CF preview builds the **committed** branch, whose `testnet-bridge.json` still pinned the
  **pre-cutover** bridge `0x11e18…` (deployed with the OLD *bearer* artifact), while the branch
  BUNDLES the NEW recipient-commitment `token_bridge` artifact.
- The faucet's capability scope uses the **pinned** manifest address; `registerContract` uses the
  **rebuilt** instance (`getContractInstanceFromInstantiationParams`, artifact-dependent). New
  artifact → class-id change → the bridge rebuilds to `0x1244fe1f…` ≠ pinned `0x11e18…` → scope
  violation. Proxy/token don't drift (their bytecode is unchanged; only `token_bridge` changed).
- **This was NOT a new bug — it is exactly the F1/L9 condition already documented in plan.md:50**
  ("the dev faucet's connect-time bridge rebuild is *expectedly* broken against the old stack during
  the Phase 2→7 window"). The prescribed resolution is Phase 7 promotion. My local check passed
  earlier only because the working tree had the uncommitted candidate override — a reminder to test
  the diagnosis against `git show origin/<branch>:…`, not the dirty working tree.

**User go.** The user chose "point the CF branch preview at the candidate (= promote)" — the explicit
Phase 7 gate. Executed the runbook: `cp` candidate → `testnet-bridge.json` (salt-v2) → `biome format`
→ `audit:faucet` green → committed + pushed. With the candidate manifest the
rebuilt bridge matches the pinned `0x0f13…` again (verified) — the scope violation is gone.

**Codex `gpt-5.6-sol` @ ultra audit (bundled fix).** Ran on the recipient-commitment
surface. Verdict: NO Critical/High, no fund-theft/redirect (commitment binding sound). But ONE
confirmed **Medium** I verified in code: private deposits published the recipient `R` as the router's
**indexed** `Bridge`/`BridgeWithFuel` event (+ signed witness + calldata), even though the router
ignores that field on the private path — so an observer read `R` straight off L1, defeating the
salt-entropy privacy protection with zero brute-force. Prior audits mis-filed the indexed
`aztecRecipient` as "cosmetic"; under recipient-commitment it IS the protected secret. **Fix
(client-side, no redeploy):** zero `aztecRecipient` on-chain for private in both `flows.ts` paths +
both `useDeposit.ts` paths; the real `R` stays only in the local recovery record, the commitment
still binds it. Pinned by new `flows.test.ts` privacy tests. **Lesson: for a privacy feature, audit
what the L1 transcript (calldata + INDEXED events) reveals, not just the on-chain execution path — a
field the contract ignores can still be the leak.** Next-router hardening: enforce `isPrivate =>
aztecRecipient == 0` on-chain.

**Follow-ups (codex Lows/Info, none blocking testnet):** (1) guard `recipient.isValid()` before the
irreversible L1 tx (a nonzero-but-invalid Grumpkin address strands a deposit); (2) the sole-consumer
tripwire checks text-presence not dataflow; (3) relayer log redacts the salt but prints
recipient+amount+leaf (the linkage the salt protects); (4) CI runs TS tests but NOT the Noir keystone
/ sole-consumer self-test — a Noir-only drift can merge green; (5) the new Solidity fuzz/fork tests
overstate coverage (mock ignores selector/secret; `delta=1<<160` truncates an address mutation).

## `[✓]` Post-promotion: ultra follow-ups shipped + LIVE private canary re-verified

After the promotion, implemented the codex-ultra Low/Info follow-ups (all sensible ones
except the ④ CI Noir gate, deferred per owner): the `isValid()` recipient guard (flows.ts both paths +
useDeposit.ts, negative-test-pinned), the relayer log redaction (recipient/amount/leaf, not just salt),
the `SwapBridgeRouterFuzz` `delta`-truncation fix (high-bits delta was a silent no-op on address
fields), and the sole-consumer tripwire hardening (dataflow check + lower-level-primitive ban, 5
self-test regressions). Gates: bridge-core 154 + faucet 426, forge fuzz 5/256, self-test 5/5,
audit:faucet green.

**LIVE re-verification before manual smoke** — `smoke-existing-testnet.ts --private --config
testnet-bridge.json` (the PROMOTED manifest) PASSED in 3.7m: recipient-committed private deposit (100
AZLO, leafIndex 14894080) → `claim_private` settled (revertCode 0) → balance bridged. Proves the
promoted deployment's private path works end-to-end TODAY. Note the canary uses the DIRECT-portal
`depositToAztecPrivate` path, so it validates the core commitment + promoted contracts, NOT the router
`aztecRecipient`-zeroing (which is unit-pinned + behavior-preserving: the router ignores that field on
the private path, and the faucet reads only leaf/key from the event, never the recipient).
