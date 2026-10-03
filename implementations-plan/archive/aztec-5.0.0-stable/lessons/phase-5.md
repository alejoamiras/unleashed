# Phase 5 — Coupled testnet redeploy under intent tooling

Live arc executed against Sepolia + `v5.testnet.rpc.aztec-labs.com` (rollupVersion `1821665230`,
wallet chainId `1816023401`), signer plan-pinned `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5`, caps
≤0.5 ETH total spend / ≤0.25 WETH seed. Intent snapshot at `lessons/intent.json`.

## What landed (in broadcast order)

| Step | Result |
|---|---|
| L1 fuel (DeployFuelLive, dry-run first) | swap `0x9c3cf20639a1a1f3fec1db8e6fa3199910db6dba`, router `0x78365a471dfce304f25d0382cdbd65b2b7935820` |
| PrivateFPC (canonical salt `0x…01`) | LIVE at pinned `0x257aa8701e8801b2c03a6b03cdf385c4fa9200efda1dc41f94a905980efc86e9` |
| Bridge candidate | AZLO L1 `0xb8ebd156dc94cde08ec9e7ef0501232b2dbedece`, portal `0x7e733201683bb43acb863bb4725c268998f9bb91`, l2 proxy `0x1e61813d…`, token `0x0e563f88…`, bridge `0x1a67aa02…` |
| Pool seed | 0.22 WETH explicit (within the 0.25 cap) |
| Faucet deploy | dripper `0x08699952…` — EXACTLY the Phase-4 predicted address (universal deploys don't embed deployer identity); `verify:deployments` GREEN |
| Candidate digest | `55a74fb3f1184339368248385cfc44c15de4b848822170dcf0e387c695d827a1` recorded into intent.json; privileged readbacks agree |

## Pre-promotion candidate proofs (plan step 8)

1. **verify-l1**: 4/4 Etherscan-verified (AZLO, portal, swap, router).
2. **Candidate smoke**: PASSED — deposit→claim bridged 100 AZLO in 2.0m.
3. **Fueled candidate smoke**: PASSED — deposit+swap→self-paying claim in 4.5m; token balance
   9.75 AZLO, FJ gained ~320 FJ.
4. **Private settle canary** (`fuel-testnet --config candidate PRIVATE_RUNS=1`): PASSED —
   public + 1 private-FPC run SETTLED in 8.3m through the canonical PrivateFPC.
   Private actual fee `1856102971236550624`, FPC ceiling (getFeeLimit) `2812277244077861486`.
5. **Direct Fee-Juice canary** (`fee-juice-canary-testnet.ts`, new — final-pass F4): exercises the
   `l1.feeJuice` lane fuel-testnet never touches (handler mint → `depositToAztecPublic(minFj)` →
   `claim_and_end_setup` paid by the sponsored FPC). Result recorded below when it completes.

## War story #3 — the ONE salt-0 site the canonical-salt sweep missed

The first settle-canary run died on fuel-testnet's OWN drift tripwire: its inline PrivateFPC rebuild
still used `salt: new Fr(0)`, deriving `0x09d0aeb6…` ≠ pinned `0x257aa870…`. The Phase-2 sweep had
covered the wallet's discovery, the tripwire test and the deploy script — but not this
script's local rebuild. Two lessons:

- **The tripwire design worked exactly as intended**: a stale derivation could not silently register
  a wrong-address FPC; it hard-stopped with both addresses in the message.
- **Sweep rule**: when a constant changes meaning (salt 0 → canonical), grep for the CONSTRUCTION
  pattern (`new Fr(0)` near FPC artifacts), not just the constant's import sites.

Fix: `fuel-testnet.ts` now imports `PRIVATE_FPC_SALT`; the fueled-smoke result
above is from the re-run after the fix.

## minFuelFj calibration — raise-only rule applied

The settle canary suggested `11249108976311445944` (4× the worst observed getFeeLimit). The
candidate carries `29580299742031535464` (the rc.2-era floor). The one-sample calibration may only
RAISE the floor, never lower it → **no change**. Follow-up (Phase 6): re-calibrate with
`PRIVATE_RUNS≥3` before considering a lower floor.

## Gate hardening added mid-arc

`live-intent.ts verify` now enforces the operational-file allowlist on the working tree (was
build-only): a non-allowlisted dirty file fails every verify — before each broadcast group and at
promotion. Trigger: the salt fix + the new canary script were legitimate mid-arc source changes and
the gate should be forced to SEE such changes (commit-or-fail) rather than pass silently. Both were
committed as fix-forward before the next broadcast.

## Faucet deployer env recovery (recorded for ops)

`apps/faucet/.env` (DEPLOYER_SECRET_KEY + DEPLOYER_SALT) was lost. The
key's provenance showed it equals the surviving bridge-core PRIVATE_KEY;
the salt is non-secret and worthless across a network reset. Rebuilt with user approval: key piped
file-to-file (never printed), fresh random salt. **The predicted-address match of the dripper deploy
confirmed the recovery was correct.** Reminder issued to back the file up off-machine.

## War story #4 — the direct-FJ canary caught a REAL product bug (F4 vindicated)

The first canary runs sat in the claim-retry loop for 25+ minutes while the chain advanced and the
message witness was PROVABLY available (`node_getL1ToL2MessageMembershipWitness` returned index
1395712). Root cause: the canary — copying the faucet's own `fuelClaim.ts` public branch — called
`FeeJuice.claim_and_end_setup` as an APP-phase call under a sponsored fee. That variant calls
`end_setup()` and is only valid as the fee payload (where `FeeJuicePaymentMethodWithClaim` places
it, in the setup phase); the sponsored FPC's payment had already ended setup, so it asserted on
every attempt. **The same pattern existed in production code**: `fuelClaim.ts` (the direct-Fuel
public claim) and `useDeposit.ts sendStandaloneFjClaim` (the "CLAIM YOUR GAS" recovery). Both fixed
to plain `claim` (identical signature, no phase side-effect), with capability
scopes + label map + test pins updated. Lessons:

- **A swallowed persistent assert is indistinguishable from a slow message sync.** The retry loop
  now prints the caught error on its log cadence. Debugging cost: the error surfaced only after
  independently proving the witness existed (cast log → message key → membership-witness RPC).
- **The upstream naming is a trap**: `claim_and_end_setup` reads like "the claim for bridged FJ";
  it is really "claim AS the fee payment". The rc.2 arc shipped it in two app-phase paths and the
  claim lanes' e2e never exercised them against a live sequencer.
- Two 16-FJ deposits from the failed runs are stranded (their in-memory claim secrets died with the
  processes). Testnet fee-asset, freely mintable, zero value — accepted.

## Direct Fee-Juice canary result

**PASSED** (3.5m end-to-end): coherence reads OK → deposit of EXACTLY `minFj` (16 FJ, leaf
1426432) → sponsored `FeeJuice.claim` landed the FULL 16 FJ as public balance ~2.5 min after the
deposit (genuine message-sync latency, matching the other smokes). Mint step legitimately skipped:
the signer's fee-asset balance covered `minFj`; the handler + asset are L1 contracts UNCHANGED
across the rollup reset (`mintAmount` 1000 FJ ≥ floor, read-verified).

## Promotion + post-promotion canaries (plan steps 9–10)

- **Promotion**: verify-intent re-run GREEN immediately before the copy (identity + signer + Noir
  digests + candidate digest + privileged readbacks + tree gate). Candidate → `testnet-bridge.json`
  byte-identical, digest `55a74fb3f1184339368248385cfc44c15de4b848822170dcf0e387c695d827a1` ==
  the intent pin. No other consumer re-pins needed: the old-address sweep found zero stale copies
  in live code, and the sponsored FPC re-derives to the accelerator's funded instance
  (`0x0628377e…3fe1`) unchanged at 5.0.0 — it is derived from `SPONSORED_FPC_SALT` everywhere,
  never pinned.
- **verify:deployments**: GREEN on the promoted state (dripper `0x08699952…`, the first and second faucet tokens all
  rebuilt == committed).
- **Drip canary** (`drip-canary-testnet.ts`, new — mirrors the UI's `drip_to_public` + sponsored
  fee): PASSED in 0.7m — 1,000 of the first faucet token landed on a fresh account.
- **Balance reconciliation**: signer `0xFcc2…F6F5` 8.761 ETH pre-arc → 8.5276 ETH post-promotion
  ⇒ **0.233 ETH total spend ≤ the 0.5 cap**; WETH seed 0.22 ≤ the 0.25 cap. (FJ/AZLO test balances
  are testnet-mintable and uncapped.)
- **CSP `_headers`**: no-op confirmed — `connect-src` already allows `https://*.aztec-labs.com`
  (covers `v5.testnet.rpc.aztec-labs.com`); wasm/worker directives unchanged.
- **Client note**: wallet reinstall required for local dev profiles (pre-production reset — no
  storage migration by policy; compat-epoch 3 hard-rejects rc.2-era full backups).
