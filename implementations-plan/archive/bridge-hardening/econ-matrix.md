# Economic-parameter matrix — bridge + faucet

Authoritative inventory of every economic knob in the bridged-faucet surface: where it is
defined, who can change it, what breaks if it is wrong, and what pins it. Produced by the
certainty-hardening arc (plan.md Arc 6); update this file when a value or its home moves.

Legend for "pins": test file / schema / canary that fails when the value drifts beyond its
stated envelope.

## Swap + deposit legs (L1)

| Parameter | Value | Defined | Mutator | If wrong | Pins |
|---|---|---|---|---|---|
| `slippageBps` | 300 (3%) — mainnet + testnet manifests | `l1.fuel.swap.slippageBps` | operator, via deploy → candidate → promote | ≥10000 ⇒ zero floor ⇒ the fuel slice is signable away; schema rejects that (`candidate-schema.ts` refinement) | `candidate-schema.test.ts`; `quote.test.ts` |
| `minOutputForSlippage(quote, bps)` | `quote·(1−bps/10⁴)`, clamped to ≥1 wei | `packages/bridge-core/src/quote.ts` | code only | n/a (pure fn) | `quote.test.ts` (haircut, never-zero, bps-range throws) |
| Permit deadline | **600 s** (was 1800) | `PERMIT_DEADLINE_SECONDS`, `packages/bridge-core/src/l1.ts`; consumed at all three signing sites — two in `useDeposit.ts`, one in `useFuel.ts` | code only | Long window = signed intent stays executable against a moved market. Loss per execution is bounded by the slippage floor; the deadline bounds how long that exposure persists. Re-signing is free, so tight is cheap | `l1.test.ts` value pin (60 s ≤ d ≤ 900 s) + `permit-deadline.test.ts` reachability guard |
| Manifest `swap.minFuelFj` | ~15.7e18 mainnet / ~29.6e18 testnet (canary-recalibrated) | manifest | operator via deploy env | Quote below floor refuses to bridge (fail-CLOSED direction — wrong-low is safe, wrong-high is spurious rejection) | candidate-schema decimalString; frontend pre-trade check `useDeposit.ts` |
| MintableERC20 per-tx cap | 1000 whole tokens (testnet deploy) | `DeployBridge.s.sol` ctor arg | deploy-time only | Cheap depth manipulation of the thin seeded pools — capped per tx BY DESIGN; permissionless mint otherwise unlimited by intent | testnet-only token; no pin (documented here) |
| Seeded pool tick ranges | ±6000 / ±30000 bands, L≈1e18–6e13 | `DeployBridge.s.sol` | deploy-time only (testnet seeds; mainnet rides canonical liquidity, probed by `_probeRoute`) | Thin bands ⇒ wider effective spread; bounded on mainnet by the quoter dust-probe failing closed | `DeployBridgeMainnet._probeRoute` |

## Claim legs (L2 fee self-pay)

| Parameter | Value | Defined | Mutator | If wrong | Pins |
|---|---|---|---|---|---|
| `feeJuice.minFj` (a.k.a. `FUEL_MIN_FJ`) | default 16e18 both nets | deploy env / manifest → re-exported to the faucet | operator via deploy env | The claim REFUSES when bridged FJ < floor (fail-closed): too low ⇒ user's claim can revert post-claim (recoverable retry); too high ⇒ spurious refusals | `fuelClaim.test.ts`; `useBridgeBackup.test.ts` fixture |
| `FUEL_FEE_MARGIN` | 2× | `apps/faucet/src/lib/fuel-claim-state.ts` | code only | Fee-spike misclassification between fjwc and sponsored-plus-standalone — a routing-quality issue, never a fund-safety one | `fuel-claim-state.test.ts` ladder cases |
| `PUBLIC_CLAIM_GAS` | daGas 3_000 / l2Gas 1_500_000 (canary-calibrated, ~2.3× margin) | `apps/faucet/src/composables/fuelClaim.ts` | code only | Oversized ⇒ getFeeLimit exceeds bridged amount ⇒ fail-closed refusal (safe); undersized ⇒ protocol-side revert, recoverable by retry after account init | documented KNOWN GAP: first-ever-tx init shape unmeasured (fable H1, bounded) |
| `PRIVATE_CLAIM_GAS` | daGas 100_000 / l2Gas 4_000_000 | same | code only | Same two-sided failure as above; teardownGas=0 keeps max_gas_cost within the bridged amount | `fuelClaim.test.ts`; live private-fuel canary |
| `clearsFeeLimit(received, gas, maxFees)` | received ≥ Σ gasLimit·maxFee | `fuelClaim.ts` | code only | Fail-closed guard BEFORE send; skipping `maxFees` (pre-V5) disables it | `fuelClaim.test.ts` |

## Recovery ladders

| Parameter | Value | Defined | If wrong | Pins |
|---|---|---|---|---|
| `MANUAL_OFFER_THRESHOLD` | 3 consecutive failures | `fuel-claim-state.ts` | Premature manual offer = UX only; late = longer wait | `fuel-claim-state.test.ts` |
| `PRIVATE_ATTEMPT_STALE_MS` | 15 min | `fuel-claim-state.ts` | Retry re-open gated by the engine's simulate authority (double-spend safe regardless) | `fuel-claim-state.test.ts` |
| `decideNoFuelClaimGate` null-semantics | null = failed read ⇒ `unverifiable` | `fuel-claim-state.ts` | Fabricated balance or false "no gas" — neither reachable | `fuel-claim-state.test.ts` |

## Consistency notes

- The quote is DISPLAY + floor-input only; the claim side must always use event-sourced
  `fuelReceived` (enforced by `fuelClaim.ts` taking `rec.fuel.received`). A drifted quote can
  therefore never corrupt a claim — worst case is a bad trade bounded by the signed floor.
- Both manifests currently carry `slippageBps: 300`; the schema ceiling (<10000) is what makes
  a "zero floor" config impossible, not operator discipline.
- The deadline was the one UNTIGHTENED knob at audit time (30 min, unpinned); now 600 s with a
  CI tripwire. If congestion ever makes 600 s too tight, raise BOTH the constant and the pin.

## Frontend review findings (Arc 7)

Line-review of `useDeposit`/`useWithdraw`/`fuelClaim` against this matrix:

- **Round-trip integrity holds**: quote (T0) → `minOutputForSlippage` → witness-bound
  `minFuelOutput` + `routeHash` + `swapTarget` → router call re-passes the same values; claims
  consume only the event-sourced `BridgeWithFuel.fuelAmount`, never the quote.
- **Quote-before-approval staleness**: when a first-time Permit2 approval tx sits between the
  quote and signing, the floor can be minutes old. Loss stays bounded by the slippage floor and
  the window by the 600 s deadline — accepted, documented here rather than re-quoted.
- **Fuel-target invariant now pinned**: `fuelRecipientFor` (public → user address, private →
  canonical PrivateFPC) extracted and unit-tested; `useDeposit` consumes it. Previously inline
  with zero coverage despite being the leak-or-strand headline.
- **Withdraw fee policy verified**: all three withdraw sends route through one builder that has
  no fee field by construction (`buildWithdrawSendOpts`) — nothing to drift.
- `fuelSlice >= amount` and quote-vs-`minFuelFj` guards match the router's own requires; the UI
  cannot sign an intent the router would reject on those bounds.

## Codex round-1 outcomes

- **Partial-fill hardening (High)**: V4 may return early with unconsumed input when the price
  limit is reached; `unlockCallback` now asserts per-hop input consumption EXACTLY equals the
  requested amount (`UniswapFuelSwap: partial fill`), so a drained pool can no longer strand
  the remainder inside the swap contract while the router's slice check passes.
- **One-directional unwrap (Medium)**: `_validateRoute` now sanctions ONLY WETH→native at the
  final boundary; the reverse (native out → WETH sold, nothing wraps the owed WETH) is
  rejected. Regression test added to RouteGrammarFuzz.
- **Immutable-aware portal verification (Medium)**: constructor-patched `initializer` makes raw
  runtime-code-hash equality impossible; conductors now use `assertRuntimeMatchesTemplate`
  (diff confined to zero-words encoding the broadcaster) + explicit initializer==broadcaster
  assert. The old check would have aborted every future deploy AFTER spending gas.
- Accepted/corrected: "circularity" claim corrected — direct-CREATE addresses are predictable
  from EOA+nonce, so constructor-init remains a cleaner end-state option for the operator.
  Vacuous-`should_fail` and mock-blindness caveats already documented in lessons.
