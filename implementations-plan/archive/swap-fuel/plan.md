## Outcome

Archived. Seeds retired.

# swap-fuel — bridge-and-fuel on the live Sepolia ↔ Aztec testnet bridge

**Status:** implementation complete (P1-P6 ✓), awaiting P7 manual testnet validation. Tier:** `deep` — Security HIGH (atomic multi-step value flow, Permit2 witness, owner-settable swap target, public pools) + External coupling HIGH (Uniswap V4, FeeAssetHandler, Permit2, canonical FJ portal). Novelty burned down by the faucet-bridge mega-deep research. Aztec pinned **4.2.0**. Testnet only. Playwright = separate future arc.

**Goal:** during an L1→L2 deposit of AZLO, atomically swap a slice into FeeJuice via Uniswap V4 on Sepolia (two-hop AZLO→WETH → unwrap → native-ETH→FJ), producing a second L1→L2 message so the recipient lands on L2 with gas. Fuel is a toggle inside the existing deposit form: one flow, one journal record, the stepper gains a FUEL phase. Full privacy parity (`isPrivate` in the witness; token stays private, FJ claim is public-to-user). Paying gas FROM private FJ notes is out of scope.

---

## What already exists (verified; don't rebuild)

- `packages/bridge-evm/src/SwapBridgeRouter.sol` — Permit2 witness-bound `bridgeWithFuel` (pull → swap → FJ deposit → token deposit public/private, atomic), `setSwapTarget` (Ownable2Step), `sweep`.
- `packages/bridge-evm/src/UniswapFuelSwap.sol` — V4 unlock-callback swapper; settlement Case C (multi-hop, last pool native) is exactly our route; `_validateRoute` enforces hookless pools + WETH↔native unwrap ONLY at the final boundary (`UniswapFuelSwap.sol:258-273`, pinned by `RouteValidation.t.sol`).
- Fork suite green vs Sepolia: `DeployBridge.fork.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol` (real Permit2 + real V4 two-hop incl. private variant, nonce replay, expiry, witness tamper).
- `packages/bridge-core`: `l1.ts` witness typed-data + `hashRoute` byte-pinned to the router (`l1.test.ts` ↔ `WitnessHash.t.sol`); `flows.ts` `runSwapBridge` (persists BOTH secrets pre-broadcast; parses `BridgeWithFuel` → secrets + leaf indices) pinned by `swap.test.ts`; `fee-juice.ts` `publicFeeJuicePayment` (= `FeeJuicePaymentMethodWithClaim`) + `feeJuiceClaimArgs`.
- **The wallet already supports dApp-embedded fjwc fee payment end-to-end**, with a 1.0× cap written for `FeeJuicePaymentMethodWithClaim`. No dApp has exercised it yet — the faucet is first.
- Live AZLO (`MintableERC20` @ `0xa40a2fe147b7e96325d7c7d974b1f11c3ed82c68`, Etherscan-verified source): **pre-approves canonical Permit2 for every holder** via the `allowance()` override (`MintableERC20.sol:46-50`) — NO approve tx in the fueled flow; permissionless mint capped 1000 whole/call.
- The **live ETH/FJ V4 pool already exists** (Holonym-seeded — `DeployBridge.fork.t.sol:68-72` documents it; the helper's `initialize` no-ops on it).
- Faucet: deposit engine (`useDeposit.ts` — claims currently hardwired to `SponsoredFeePaymentMethod` at `:85-110`), stepper with monotonic-latch steps (`bridge-steps.ts`), journal + sealed backup/restore (schema-versioned, strict parsing), manifest scopes (`lib/capabilities.ts`), `testnet-bridge.json` → `bridge-deployments.ts` config, `verify:l1` Etherscan pipeline.

What does NOT exist: a live deployment of router/swapper, an AZLO/WETH pool, quoting/route helpers, journal/backup fuel fields, manifest scope for the FJ claim, any frontend fuel surface.

---

## Decision ledger

| # | Decision | Source | Status |
|---|---|---|---|
| L1 | **Harden the router BEFORE deploying — TWO requires** in `bridgeWithFuel`: (a) `fuelReceived >= p.minFuelOutput` (the user's SIGNED floor enforced by the router, not the owner-replaceable target); (b) the router's own TOKEN balance delta across the swap call equals `p.fuelAmount` (the slice actually left). Without (b), a hostile owner-set target can prefund FJ (free on testnet via FeeAssetHandler) to satisfy the floor WITHOUT pulling the AZLO — the slice strands in the router as owner-sweepable residue: a THEFT path, not availability (codex double-audit CRITICAL). Witness typehash untouched. | fable + codex double-audit CRITICAL | **ADOPTED** — P1, pre-deploy |
| L2 | **Budget: TOP-UP APPROVED (gate decision)** — the user funds the deployer (~0.4-0.5 Sepolia ETH total) before P2 so pools are seeded DEEP enough to absorb routine 200-500 FJ fuel purchases without constant re-hydration (the gate's stated requirement). Depth target: ≥ 20 max-fuel (500 FJ ≈ 0.05 ETH-equivalent) purchases absorbed before a re-seed is needed; the live ETH/FJ pool gets `SEED_ETH_FJ` top-up (FJ side free via FeeAssetHandler batching, ETH side from the top-up) if P1's probe shows thin depth at our volume. P2 ABORTS if the deployer balance < seed+gas with margin. (Original no-top-up default and codex's depth concern both superseded by the gate decision — codex's position effectively won on product grounds.) | gate decision (user) over fable | **DECIDED at gate** |
| L3 | **Fuel secret is NOT a bearer credential** — the FJ content hash binds `(to = user, amount)`; the secret only gates who *triggers* the claim. It stays plaintext in the journal (same trust class as public deposit secrets) and OUT of the sealed envelope — seal UX (1-2 signatures) untouched. Main's draft (seal it) rejected as wrong threat model. | fable over main | **ADOPTED** |
| L4 | **Stepper FUEL = fact-anchored phase** (latches on persisted `rec.fuel.received`), not narration. Follows the existing monotonic-latch architecture, survives reload. Codex's "narration, not a phase" rejected: it under-models the journal's failure honesty (token claim failing ≠ fuel consumed). | fable over codex | **ADOPTED** |
| L5 | **New `script/DeployFuelLive.s.sol`**; keep `DeployBridge.s.sol` as the fork fixture. Editing in place would invalidate fixtures other tests build on. Constants derived from ONE human price input + fork-test-gated (codex's "magic numbers rot" argument folded in). | fable + codex | **ADOPTED** |
| L6 | **Dual-path deposits**: fuel OFF keeps the proven portal-direct path byte-for-byte; only fuel ON goes through the router. "Unify everything through the router" rejected: symmetry bought with reliability. | codex (explicit) + fable + main | **ADOPTED** (unanimous) |
| L7 | **One L2 claim tx pays for itself**: token claim embeds the FJ claim as its fjwc fee payment via `publicFeeJuicePayment` (zero-FJ bootstrap for the CLAIM tx — the account itself must already exist; fresh-account DEPLOYMENT still rides the sponsored FPC, as the P5 script documents. `claim_and_end_setup` is a private SETUP-phase call → composes under `claim_public` AND `claim_private` — privacy parity free). Plus fable's honesty machinery: setup phase is non-revertible, so an included-but-app-reverted claim CONSUMES the FJ message — persist `fuel.consumed` on inclusion (success OR app-revert) and retry on the sponsored-FPC ladder; never re-embed a consumed claim. | converged (main, codex, fable); consumed-latch = fable | **ADOPTED** |
| L8 | **Fuel UX = exact-input AZLO slice with quoted FJ estimate**, never "target FJ output" (inverse quoting = more failure modes). Gate decision: presets denominated in the 200-500 FJ band (≈ 2-5 AZLO at the L10 rate), prefilled editable; quote at submit; REFUSE to proceed without a quote (`minFuelOutput` of 0/1 signs away the slice); `MIN_FUEL_FJ` floor calibrated in P5 against a real claim fee (L15 ordering). | codex + fable + gate | **ADOPTED** |
| L9 | **The regrant landmine**: the wallet's field-diff re-consent exists for the `contracts` capability ONLY — adding FJ to `transaction.scope` does NOT re-prompt existing grants, which would refuse the FJ claim forever. This arc DEPENDS on the wallet extending its field-diff to `transaction`/`simulation` scope lists, unconditionally (follows the contracts precedent) — a wallet change. Do not silently fall back to the testnet-manual alternative (users disconnect/reconnect once). (Contradiction-check fix: was "adopted yet optional".) | fable; firmed by codex contradiction-check | **ADOPTED (firm)** |
| L10 | **Pool parameters — CHEAP FJ (gate decision)**: target rate **100 AZLO per WETH** (NOT the draft's 10,000, for which it derived `AZLO_WETH_SQRT_PRICE = floor(2^96 / 100) = 792281625142643375935439503`) so the route yields ≈ **100 FJ per AZLO** (ETH/FJ pool is fixed at ~10,000 FJ/ETH; FJ-per-AZLO = 10,000 / R). A normal 200-500 FJ fuel purchase costs ≈ 2-5 AZLO + fees — pocket change against the faucet's 100-AZLO mints. Derivation requirement unchanged: AZLO (`0xa40a...`) < WETH (`0xfFf9...`) by address ⇒ currency0 = AZLO (runtime-asserted); price currency1/currency0 = 1/100 ⇒ `sqrtPriceX96 = floor(2^96/10)`, init tick ≈ −46054, band = wide multiples-of-60 straddling it; liquidity sized for the L2 depth target (~0.25+ WETH side). ALL derived constants fork-test-gated (initialize + production-route round-trip), never trusted bare. | gate decision (user) over fable | **DECIDED at gate** |
| L11 | `record.amount` = token claim amount (total − fuel): the journal engine claims with `BigInt(rec.amount)` and the private envelope seals `amount` and is cross-checked by `envelopeMatchesRecord`, so the existing claim path and envelope sealing keep working UNCHANGED; fuel is an optional versioned block on the record (per-record `schema: 2`); journal container + backup envelope formats unchanged; schema-1 fixtures must load byte-identically. | fable | **ADOPTED** |
| L12 | App inlines the fueled flow in `useDeposit.ts` mirroring how it already inlines the direct path; `runSwapBridge` stays pinned and is live-exercised by the headless P6 script. | fable + codex | **ADOPTED** |
| L13 | Main's P0 spike phase dissolved: P0.1 (wallet fee control) answered during drafting (fact above); remaining live probes live in P1's fork test + P2's cast probes. Its router-surface item named the EXISTING canonical TokenPortal (`0x9c41…11ea`) + FJ portal: the router must orchestrate the same portal the bridge already uses; no new token portal. | main | superseded |
| L14 | **Ladder reachability — RECORD-SPECIFIC TRIGGERS ONLY** (v3; v1's differential-simulation probe was lag-conflated, v2's aggregate-balance probe was not attributable to THIS record — final-gate codex CRITICAL: a user already holding FJ false-positives it, orphaning the record's message). The sponsored ladder fires only on per-record ground truth: (1) the journal-first `fuel.claimAttempt` + persisted `claimTxHash` whose receipt reads INCLUDED ⇒ `consumed=true` — closes the crash window; (2) FEE-INSUFFICIENCY: `fuel.received < currentMinClaimFee × margin` (both record-specific quantities) ⇒ sponsored claim of the token + a standalone `claim_and_end_setup` for the FJ (non-destructive: the fuel still lands as balance) — closes the fee-spike path; (3) the third-party-early-trigger edge (requires a LEAKED secret) gets NO automation: after N persistent fjwc simulate-failures the UI surfaces an explicit "Claim without fuel" user action (sponsored; the FJ message, if unconsumed, remains claimable later — non-destructive by construction). Optional P3 stretch, not load-bearing: a message-nullifier consumption probe IF the pinned aztec.js/stdlib exposes the L1→L2 message-nullifier helper (verified during P3, dropped silently if absent). NEVER infer from aggregate balance or from simulate-failure alone. `decideFuelClaim` inputs are thereby fully specified: `{ attempt, receiptStatus, fuelReceived, currentMinFee, persistentFailureCount, userOverride }`. | fable CC + both double audits + final-gate codex | **ADOPTED (v3)** |
| L15 | **Calibration ordering** (contradiction-check blocker, codex): `MIN_FUEL_FJ` was enforced by the UI (old P5) but calibrated only by the live headless run (old P6). Fix: the headless live validation MOVES BEFORE the UI phase — new order P5 = headless script + calibration, P6 = UI (ships the calibrated floor), P7 = manual checklist. P2 writes `minFuelFj` as an explicitly PROVISIONAL config value; P5 finalizes it. | codex contradiction-check | **ADOPTED** |

**Unresolved disputes:** none blocking. Codex's pool-depth worry and fable's no-top-up are reconciled via the evidence gate (P1 probe) + Ask 2.

---

## Phases

### P1 ✓ — Router hardening + live-shape deploy script + fork proof (bridge-evm)
**Goal:** the exact bytes we will deploy, proven on a Sepolia fork against the REAL PoolManager/Permit2/FeeJuice/live-AZLO.
- `src/SwapBridgeRouter.sol`: the L1 `require(fuelReceived >= p.minFuelOutput, ...)` (one line, witness untouched).
- `script/DeployFuelLive.s.sol` (new): env-driven token (default live AZLO), deploys `UniswapFuelSwap` + `SwapBridgeRouter`, seeds AZLO/WETH with L10 constants, `SEED_ETH_FJ` flag (default false), runtime `require(AZLO < WETH)`, sweeps leftovers.
- Tests: unit (malicious target returning < minFuelOutput reverts in the ROUTER; malicious target that prefunds FJ without pulling the AZLO slice reverts on the token-delta require — the residue-theft pin), `DeployFuelLive.fork.t.sol` (mint live AZLO permissionlessly, seed with production constants, assert band straddles init tick + both sides consumed, run the production two-hop `bridgeWithFuel` incl. `isPrivate=true`, assert AZLO's Permit2 allowance override, probe the LIVE ETH/FJ pool with a production-size quote — the L2 evidence gate).
**Gate MET:** `forge test` 38/38 (unit + fork); `WitnessHash.t.sol` unchanged; bridge-core 81 green. Live findings folded: FJ tier moved to fee 987 (fee-500 key squatted at ~8e9 FJ/ETH on live Sepolia; shared fee-3000 pool drifted to ~191 FJ/ETH), fills are product-sized 0.25 AZLO ≈ 500 FJ (P6 gains a MAX fuel cap), ~4.5%/fill decay at the chosen depth with 5 consecutive fills clearing a 380-FJ floor.

### P2 ✓ — LIVE Sepolia deployment + pool seeding + verification + config
**Goal:** router/swapper live, AZLO/WETH seeded, everything verified and recorded.
- **Pre-flight (user dependency)**: deployer `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` topped up to ~0.5 Sepolia ETH (gate decision). ABORT the broadcast if balance < seed+gas margin.
- Broadcast `DeployFuelLive.s.sol` (budget per L2: `WETH_SEED≈0.25+`, liquidity sized to the ≥20-purchase depth target; `SEED_ETH_FJ` per P1's probe — free FJ batching + ETH as needed). Deployer key from `packages/bridge-core/.env`, never printed.
- **Idempotent split modes** (codex + fable double audits): env-reusable addresses (`ROUTER_ADDRESS`/`FUEL_SWAP_ADDRESS` set ⇒ skip deploy, seed only) so deploy-ok+seed-fail re-runs don't strand orphan routers; partial-failure runbook recorded in `deployments.md`.
- **Pool-init front-run guard** (fable double audit): V4 `initialize` is permissionless — the script ASSERTS pre-seed that the pool is uninitialized OR initialized within tolerance of the target sqrtPrice; far-off price ⇒ abort with runbook note (never seed into a garbage-priced pool); post-seed on-chain assertion of sqrtPrice + currency ordering.
- `verify-l1.ts`: add SwapBridgeRouter + UniswapFuelSwap (our foundry root, constructor args from config).
- `testnet-bridge.json` gains `l1.fuel = { router, swapTarget, poolManager, quoter, weth, feeJuice, pools: { azloWeth, ethFj }, slippageBps, minFuelFj }` — `minFuelFj` is PROVISIONAL until P5 calibrates it (L15); `bridge-deployments.ts` exports; bridge footer gains the router link; `deployments.md` records addresses/tx-hashes/seed amounts/sweeps.
**Gate MET:** UniswapFuelSwap `0xE223…823e` + SwapBridgeRouter `0x8394…2206` deployed, both pools seeded at target prices (guards passed), both Etherscan-verified; wiring probes exact; live quote 0.25 AZLO → 487.67 FJ (band [450,510]); spend ≈0.45 ETH, leftover ≈9.67. Record: [deployments.md](deployments.md).

### P3 ✓ — bridge-core fuel plumbing (route/quote/persistence)
**Goal:** framework-agnostic helpers + versioned persistence, fully unit-tested.
- `src/route.ts`: `buildFuelRoute(azlo, weth, feeJuice, fee, tickSpacing)` — address-sorted PoolKeys + zeroForOnes (both hops `zeroForOne=true` for live addresses). Route is FIXED two-hop (user-fixed scope) — no smart routing, no direct AZLO/FJ pool this arc.
- `src/quote.ts`: chained V4 Quoter `quoteExactInputSingle` per hop (Holonym recipe); slippage math (`minFuelOutput = quote × (1 − 300bps)`); revert mapping to honest copy.
- `journal.ts`: per-record `schema: 1 | 2`; optional `fuel` block `{ amount, secret, secretHashHex, minOutput, leafIndex?, received?, claimAttempt?, claimTxHash?, consumed? }` — `received` comes ONLY from the `BridgeWithFuel` event (content-hash law); `claimAttempt` latches journal-first before any fjwc-embedded wallet call (L14); schema-1 records load untouched.
- `backup.ts`: schema-2 validation branch (strict; malformed fuel rejects restore); backup file stays `v:1`; schema-1 golden fixture still restores.
**Gate MET** (pulled ahead of P2, which waits on the deployer top-up): 97 tests + typecheck + lint; schema-1 records load untouched beside schema-2 (modulo the upsert's updatedAt stamp) and the pre-arc backup fixtures still restore.

### P4 ✓ — Wallet manifest scope + scope-delta re-consent (faucet manifest; the re-consent is the wallet's)
**Goal:** the FJ claim passes scope enforcement for new AND existing grants.
- `capabilities.ts`: `{ contract: FEE_JUICE_L2 (feeJuiceAddress), function: "claim_and_end_setup" }` in `transaction.scope` AND `simulation.transactions.scope`; consent copy names the gas claim. (The v2 balance-probe utility scope is NOT needed — L14 v3 uses no balance reads.)
- the wallet: field-diff re-consent extended to `transaction`/`simulation` scope lists — unconditional per L9; the re-consent popup renders the DELTA prominently, a superset re-prompts, equal/subset doesn't, and approval replaces the stored grant. HONESTY NOTE (fable double audit): `simulation` scope is NESTED (`transactions`/`utilities`/`privateEvents`) — bigger than the flat contracts diff; grants union monotonically with no revocation surface, so incremental diffs are a fatigue/creep vector.
- Expect NO `contracts` registration for FeeJuice (protocol contract pre-known to PXE) — manual smoke confirms; registration is the documented fallback.
**Gate MET** (code-side): faucet 284 (manifest pins). The manual smoke (fresh + pre-existing grant) is P7 item 1 — the wallet's popup renders the DELTA as the consent subject, existing grants as context.

### P5 ✓ — Live headless validation + MIN_FUEL_FJ calibration (moved before UI per L15)
**Goal:** the whole loop proven on live testnet — and the floor calibrated — before any UI ships.
- `packages/bridge-core/scripts/fuel-testnet.ts` (modeled on `deposit-testnet.ts`): mint live AZLO → `runSwapBridge` against the live router (live-validates the pinned flow) → EmbeddedWallet with real proofs: fresh account deployed via sponsored FPC, then `claim_public` paid via `publicFeeJuicePayment` (the claim pays for itself from the claimed FJ), assert L2 AZLO + FJ balances; repeat the private variant.
- Calibrate `MIN_FUEL_FJ` from the observed claim fee (≈ 2× a real claim's max fee); finalize the provisional config value from P2.
**Gate MET:** BOTH variants passed in 6.7m (far under budget — the live testnet was fast). The self-paying claim is REAL: fresh account, one tx claims fuel (as fee) + tokens; private variant banked 462.5 FJ after fees. Observed claim fees: public 5.50 FJ, private 3.03 FJ ⇒ `minFuelFj` finalized at 11.0 FJ (2× worst); a 487-FJ design fill carries ~88× headroom.

### P6 ✓ — Faucet UI: fuel toggle, fueled deposit, claim tail, stepper
**Goal:** the one-flow fuel experience.
- Pure `lib/fuel-claim-state.ts` (codex modularity): `decideFuelClaim({ attempt, receiptStatus, fuelReceived, currentMinFee, persistentFailureCount, userOverride }) → "fjwc" | "sponsored" | "sponsored+standalone-fj" | "wait"` — the L14 v3 ladder as a unit-pinned pure function (record-specific evidence only; aggregate balance is NOT an input), consumed by the engine. The N-failure threshold surfaces the manual "Claim without fuel" action; it never auto-fires.
- `useDeposit.ts`: fueled branch (journal-first: record + both secrets persisted BEFORE any signature; allowance assert — no approve leg; quote-required; witness sign with random 256-bit unordered nonce + 30-min deadline; `bridgeWithFuel`; parse event → persist `leafIndex`/`fuel.leafIndex`/`fuel.received`); claim builder selects per `decideFuelClaim` (fjwc default; sponsored on positive evidence; `MIN_FUEL_FJ` read from CONFIG so P5's calibration propagates without code edits).
- `BridgeForm.vue`: fuel toggle (deposit direction only), prefilled editable AZLO slice, net-bridged display, debounced quote line ("≈ N FJ, min M") with loading/error/no-route states, `0 < fuel < total ≤ balance` validation, `MIN_FUEL_FJ` floor; fuel UI identical public/private.
- `bridge-steps.ts`: fuel keys `[seal?, sign, deposit, fuel, sync, claim, confirm]` (SIGN replaces APPROVE; FUEL latches on `fuel.received`); CLAIM copy: "one transaction claims your tokens and your gas."
- Receipt/stepper/journal cards: fuel line (slice → received FJ); testids for everything new.
**Gate MET:** `audit:vue` green. Pins delivered: `decideFuelClaim` truth table (11 cases incl. the no-balance-input structural pin), floor-from-config + quote-refusal + oversize-cap + toggle-off-legacy (BridgeForm.fuel.test.ts, 7), fueled rails post-reload (bridge-steps, 6), schema-2 persistence (bridge-core). fjwc payment SELECTION is engine code exercised live by P5 (both variants) — its in-wallet path is P7 item 2 by design (the wallet popup can't run under vitest). Privacy-linkability disclosure added to the private+fuel quote line (pinned) after the user's question about private FJ; journal cards carry the fuel line + the explicit CLAIM WITHOUT FUEL escape (L14 trigger 3); receipts stamp the landed FJ.

**Chosen bridge design — privacy presets (direction B), private by default.** The legal bridges: Private (default) — tokens + gas land hidden, fully private, no leak; Public — tokens + gas visible, cheapest, simplest; private tokens + public gas — forbidden, it would write your Aztec address on L1. With the rule in place, gas privacy follows the token, so the cards carry the whole privacy decision; fuel is a separate add-on underneath. Shipping private gas needs the deferred private-FeeJuice path (the PrivateFPC); until that lands, the honest interim is: Private = no gas yet, Public = gas works. Also considered: A two-destinations · C two-toggles · D segmented dial. B won for guided clarity with only two postures.

### P7 — Manual testnet validation

**NEEDS MANUAL TEST** (faucet app + the Nulo wallet, live testnet). Item 2 is the FIRST-EVER exercise of wallet-fjwc by a dApp (codex flagged the inference) — if it breaks, the sponsored ladder IS the shipping path (graceful degradation; fuel still lands as balance) and the fjwc gap becomes a wallet follow-up:
1. Regrant: existing grant gains the FJ scope via the P4 mechanism; fresh connect works.
2. Public deposit + fuel: one typed-data signature + one tx; stepper SIGN → DEPOSIT → FUEL (received FJ) → SYNC → CLAIM → CONFIRM; recipient lands with AZLO + FJ.
3. Private deposit + fuel: seal UX unchanged; token arrives private, FJ public; claim pays itself.
4. Fuel OFF regression: legacy path identical; old pending records resume.
5. Failure drills: reject witness signature (record discarded); kill tab post-router-tx and resume from journal; backup/restore a fuel record on a fresh browser and claim from it.
6. Quote edge: oversize slice shows the liquidity error and blocks submit.

---

## Security & Adversarial Considerations

Threat model: L1 funds in flight during `bridgeWithFuel`; L2 claims; local persistence; the wallet trust boundary.

- **Owner-settable `setSwapTarget`** (headline trust knob): post-L1 hardening, a hostile target can no longer under-deliver below the user's SIGNED `minFuelOutput` (router-enforced) nor leave the slice unconsumed (token-delta require). Residual — stated plainly (final-gate codex): a malicious owner-set target can still SKIM THE SPREAD between the real swap output and the signed floor (bounded extraction ≤ the slippage margin, ~3% of the fuel slice), and can grief by revert (DoS; atomic refund). That bound is what the user signs; tightening it is the slippage parameter, not more code. Owner = deploy EOA via `Ownable2Step` (no single-tx hijack); custody recorded in `deployments.md`. The witness binds `routeHash` — relayers can't re-route; only OWNER threatens the route, only within the signed bound. Mainnet would need timelock/multisig (recorded, out of scope).
- **Public pools / permissionless AZLO mint**: an attacker can mint AZLO (1000/tx cap raises gas cost) and dump into AZLO/WETH to extract the seeded WETH — the seed (~0.068 ETH) is the explicit bounded bounty. Consequence is availability-only: skewed pool → quote collapses → `minFuelOutput` reverts the WHOLE tx; user funds never move. Sandwiching bounded to 300bps of the fuel SLICE. Mitigations: quote-at-submit, `MIN_FUEL_FJ` floor, honest no-route copy steering to fuel-off bridging, re-seed runbook.
- **Witness replay/tamper**: Permit2 unordered random 256-bit nonce + 30-min deadline + full-field witness binding (`token portal, amounts, recipients, secrets, routeHash, isPrivate`) — already fork-tested against real Permit2 (replay, expiry, tamper). `fuelRecipient` derives from the connected account, never from input.
- **Content-hash mismatch = silent fund loss**: the FJ message binds `(to, amount=fuelReceived)`. Claiming with the QUOTED amount strands the FJ forever. Hard rule: `fuel.received` comes only from the `BridgeWithFuel` event, persisted before the claim tail, used verbatim; recovery = re-read the event by `depositTxHash`.
- **Setup-phase fee consumption vs app revert**: an included-but-reverted claim consumes the FJ message (gas paid) without minting tokens. The `fuel.consumed` latch + sponsored ladder prevents infinite-retry stranding and double-embedding. Simulate-first gate makes it rare; the ladder makes it survivable.
- **Refund paths**: every pre-claim failure is atomic L1 revert (pull, swap, both deposits one tx). Post-deposit, funds exist only as the two L1→L2 messages (token recipient-bound or sealed-bearer as today; FJ recipient-bound). `sweep` = owner-only dust recovery; zero inter-call balances via forceApprove-to-zero.
- **Local persistence**: fuel secret plaintext like public deposit secrets — tampering/theft never redirects funds (the FJ content hash binds the recipient, L3). Precision from the contradiction-check: a LEAKED secret+leafIndex does let a third party TRIGGER the claim early (griefing, not theft) — the FJ still lands in the user's public balance, but the fjwc self-paying claim then fails. Per L14 v3 this edge is handled MANUALLY: after N persistent failures the UI surfaces the explicit "Claim without fuel" action (non-destructive); no automated detection (it requires compromise of material already inside the local trust boundary). Backup stays strict: malformed fuel rejects restore.
- **Wallet scope, least privilege**: exactly one new function on one protocol contract in tx + tx-sim scopes; no wildcards; `canCreateAuthWit` unchanged; scope-delta re-consent (L9) keeps grants honest.
- **Input validation at boundaries**: contract (`0 < fuelAmount < totalAmount`, hookless route, final-hop-only unwrap, BOTH L1 requires), flow (quote-required, minFuelOutput floor, deadline), UI (`0 < fuel < total ≤ balance`, 18-dec `parseAmount`, never `Number`).
- **Frontend-trust boundary** (fable double audit): `minFuelOutput` is the SIGNED value; nothing on-chain enforces economic sanity — a compromised frontend could sign a dust floor. The swap is exact-input, so the slice converts regardless. Standard dApp trust boundary; stated, not mitigated in-arc (CSP/harden arc covers frontend integrity).
- **Permissionless pool-init front-run**: handled by the P2 pre/post-seed price assertions (abort, never seed into a garbage price).
- **Supply chain / creds**: no new deps; deployer key env-only, never printed/persisted beyond `.env`; no CI secrets (script runs locally).

## Assumptions

**Facts** (verified — main re-verified fable's boldest in source):
- Router does NOT enforce `minFuelOutput` itself; target enforcement + balance-delta only (`SwapBridgeRouter.sol:189-195`; `UniswapFuelSwap.sol:109`); `setSwapTarget` owner-only (`:142-147`).
- Live AZLO pre-approves Permit2 for every holder (`MintableERC20.sol:46-50`); mint permissionless capped 1000/tx; deployed source = repo source (Etherscan exact-match).
- Live ETH/FJ pool exists, Holonym-seeded (`DeployBridge.fork.t.sol:68-72`).
- fjwc end-to-end: the wallet already supports the dApp-embedded payment.
- Faucet claims hardwired to Sponsored today (`useDeposit.ts:85-110`); journal-first discipline at `:196-199`.
- `runSwapBridge` persists both secrets pre-broadcast; leaf indices event-sourced (`flows.ts`); witness byte-pinned (`l1.test.ts` ↔ `WitnessHash.t.sol`).
- Unwrap only at final route boundary (`UniswapFuelSwap.sol:258-273` + `RouteValidation.t.sol`).
- FJ deposits always public; no `depositToAztecPrivate` on the FJ portal at 4.2.0 (research: `aztec-4.2.0-portals-fees.md`); FJ content hash binds `(to, amount)`, secret not submitter-bound (`holonym-l2-and-fee-juice.md:86-92`).
- The wallet's scope enforcement covers every `exec.calls` entry incl. fee-method calls; its field-diff re-consent is `contracts`-only today.
- `deploymentMatches` binds `(chainId, portal, bridge)` — none change → no stale-record wave.
- Recon (still valid): FeeAssetHandler permissionless, mintAmount 1000 FJ; V4 PoolManager `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`; old deploy constants 6-dec-shaped with `ETH_SEED=0.5` defaults.

**Inferences** (attack these):
- L10 pool math (sqrtPrice, ticks, ~684 AZLO + ~0.068 WETH at L=1e19) is derived arithmetic — DEFAULTS gated by the P1 fork test, never trusted bare.
- FeeJuice needs no `contracts` registration (protocol contract pre-known to PXE) — P4 manual smoke gates; registration fallback documented.
- The live ETH/FJ pool retains usable liquidity near the reference price — P1 fork probe (historical state) + P2 LIVE quoter probe at broadcast time (fable: fork state ≠ live depth).
- The V4 Quoter (`0x61b3f2011a92d183c7dbadbda940a7555ccf9227`, research doc) answers chained quotes — P2 cast probe gates.
- Deployer balance ~0.168 ETH (re-read on-chain before P2).
- fjwc works when the tx's MAIN call is the token claim (the wallet's fee strategy was built for it; no dApp has exercised it) — P7 item 2 is the first real exercise. Degradation contingency: the sponsored path + standalone FJ claim (record-specific, v3) — NOT the withdrawn balance probe.

**Asks — ALL RESOLVED at the approval gate** (plan APPROVED):
1. **Budget**: TOP-UP — user funds the deployer to ~0.5 ETH; pools seeded deep (≥20 max-fuel purchases between re-seeds).
2. **Pool rate + fuel preset**: CHEAP FJ — 100 AZLO/WETH ⇒ ~100 FJ per AZLO; presets in the 200-500 FJ band (≈2-5 AZLO).
3. **Owner + frontend trust acceptance**: ACCEPTED, deploy EOA stays owner — SwapBridgeRouter owner stays the deploy EOA, vs a multisig now (not recommended on testnet). Accept explicitly what's being trusted: the owner can re-point the swap target (post-hardening: bounded to skimming at most the signed slippage spread, ~3% of fuel slices) and `sweep` router/swapper residue; the frontend + `testnet-bridge.json` config are trusted for quote/floor sanity (a compromised frontend can sign a dust floor — mitigation belongs to the CSP/harden arc). Recorded in `deployments.md`.

**Verdict: APPROVED** at the gate; seeds finalized below.

## Post-implementation hardening
The CSP/harden pass already sits on the backlog as its own arc; no `/harden` scheduled from this plan. The L1 hardening (minFuelOutput) lands IN this arc pre-deploy.

## Seeds

Drafts (finalized after the approval gate). Recommended: `/goal` keyed on P1-P7 ✓ markers in this file + deployments.md + the three suite commands + the printed P7 checklist, constrained to the task branch/testnet/key-hygiene/P2-budget-abort. Alternative: `/loop 15m` driving phases with per-gate validation, codex consults on decisions, 5-failure stop rule.

---

## Audit verdicts

- Contradiction-check (codex): **fail** → 2 blockers (L9 adopted-vs-optional; minFuelFj P2/P6 ordering) — **both fixed in this revision** (L9 firm; L15 phase reorder).
- Contradiction-check (fable): **fail** → 2 blockers (consumed-latch ladder-reachability; missing claim-tail test pins in the UI gate) + griefing-vector precision on L3 — **all fixed in this revision** (L14; P6 gate pins; security note).
- Double audit (codex): **reject** → CRITICAL owner-target residue-theft path (router lacked a token-delta check) + HIGH probe-vs-PXE-lag unsoundness — **both fixed**: L1 gained the token-delta require; L14 redesigned to positive-evidence triggers (v2). MEDs adopted: P2 idempotent split, owner-Ask reworded (Ask 3), pure claim-state helper.
- Double audit (fable, fresh): **conditional approve** → conditions all adopted: L14 v2 (drops the differential probe the private variant invalidated; non-destructive fallback by construction), P2 pool-init front-run assertions, P2 partial-failure runbook, P4 nested-scope honesty + delta-prominent consent copy. Its "slice always consumed" claim was WRONG (codex's CRITICAL disproves it) — noted.
- Final fresh-context codex pass (session 019eb8cc, fresh): **reject** → CRITICAL: the v2 balance probe was aggregate, not record-attributable (false-positive for FJ-holding users ⇒ premature fallback could orphan the record's message); HIGH: owner-skim-to-floor understated; HIGH: P6 under-specified. **All folded as L14 v3** (record-specific triggers: own receipt, fee-insufficiency, explicit user override; no balance reads; `decideFuelClaim` inputs fully specified), Security owner-skim plainly stated, Ask 3 widened to owner+frontend trust acceptance. Re-verdict: see below.
- Final gate re-verdict (same session, on v3): **conditional approve** — "v3 closes the orphaning path… ambiguous states stay at wait… leaked-secret manual-only is the right place to stop automating… P6 now implementable without inventing rules." Condition (align the stale Security leaked-secret bullet to v3 manual-only semantics): **done in this commit**. Gate complete.
- **Post-implementation codex audit** (session 019ebcc3, 5 rounds): initial REJECT → 2 HIGH (consumed latched at PROPOSED; standalone fire-and-forget strands silently). Both fixed, then a SECOND reject (PROPOSED-latch moved onto standaloneClaimed; happy fjwc never set consumed). After **3 misses on the same fuel-settlement state machine**, stopped and DESIGN-reassessed with codex (the loop's escalation): the engine's own inclusion confirmation + probing `fuel.claimTxHash` directly is the correct signal; `claim_and_end_setup` is idempotent-safe so recovery self-corrects. codex validated the design (with one refinement: latch on any INCLUDED receipt incl. app-revert, not success-only) → implemented → **conditional approve** (residual: conservative false-positive CLAIM YOUR GAS, safe never strands). Condition satisfied by the self-settle commit (an already-consumed message claim settles instead of erroring). **Net: no hide-while-stranded hole; the dangerous direction is closed.**
