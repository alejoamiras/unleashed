# Phase 2 — the exit canary: `PRIVATE_HUB_EXIT_GAS` measured

Owner direction: "execute (1)" — replace the provisional exit limit (the claim's limits
reused) with a measured one. Method: extend `packages/bridge-core/scripts/deploy-sandbox.ts
--smoke` so the private exit pays the way the app pays it — the PrivateFPC's `pay_fee` from held
credit — and report what it billed.

## What the smoke does now

- **The actor is the account shape the wallet deploys**: a constructor-based Schnorr account
  under the Nulo wallet's key derivation (`deriveNuloAccountKeys`), sponsor-deployed through
  `deployAccountIfAbsent`, deterministic (fixed sandbox secret + salt) so a `--keep` re-attach finds
  the deployer that owns the generation. The genesis accounts are initializerless — a different
  entrypoint — and only the relayer still comes from them.
- **(d) private gas → one PrivateFPC credit note**: bridges Fee Juice through the router's direct
  fee-asset lane with `fuelRecipient = PRIVATE_FPC_ADDRESS` and the claimer-bound secret, then
  `FeeJuice.claim(fpc, amount, secret, leaf)` and `PrivateFPC.mint(amount, salt, leaf)`. One note of
  1.4× the exit's ceiling.
- **(e) private exit paid from one credit note**: `exit_to_l1_private` with
  `privateFeeJuicePayment(FPC)` under `PRIVATE_HUB_EXIT_GAS` at `predictedWorstMinFees` (the app's
  `privateExitFee` shape, limits clamped to the node's `txsLimits.gas`), simulated first with
  `includeMetadata` (new `simulateHubExit` in `hub-l2.ts`), the credit read before and after.
- **(d) two more notes of 0.45× the ceiling** beside the first exit's ≈0.4× change: no note and no
  pair covers a ceiling, so the next `pay_fee` must select all three — past the two the FPC reads
  first, into its recursion.
- **(e) private exit paid across three credit notes**: the same exit, the multi-note shape.
- **The sample fails closed**: missing simulated gas, landed fee, block prices or tx effects throws;
  so does a landed fee that is not `billedGas.computeFee(blockFees)`, or a deduction that is not the
  ceiling. The report prints one line per exit. The sponsored private exit is gone: the app never
  names it.
- **The note shape is asserted, not assumed**: the flows keep an inventory of the credit notes they
  minted (starting from a zero balance, so a re-attached run with prior credit fails explicitly);
  before each private exit the send prices its own ceiling and refuses unless largest-first
  selection over the inventory spends exactly the advertised count; after it, the inventory replays
  the spend and must equal the credit read back; and the landed transaction's nullifier count must
  move from the previous sample's by exactly the extra notes spent (each spent note is one nullifier).

## Runs

| run | outcome | lesson |
|---|---|---|
| 1 | `ENOENT …/contracts/bridge/evm/out/MockSwapTarget.sol/MockSwapTarget.json` before the smoke | A fresh checkout has no forge `lib/` or `out/` (both gitignored). Install the libs, `bun scripts/gen-remappings.ts` from bridge-core, `forge build`. Now in bridge-core's README row for `deploy:sandbox`. |
| 2 | `(d) private gas` — `Nullifier read request at index 0 is reading an unknown nullifier` from `PrivateFPC.mint` | `mint` does not consume the L1→L2 message: it PROVES a prior `FeeJuice.claim` by reading that claim's nullifier (package README, "two-step flow"). `mint_and_pay_fee` is the one-transaction form. The flow claims first now. The same error text on a first private bridge in production has a different cause (the wrong-account clobber). |
| 3 | `(e) private exit` — `Declared DA gas limit (100000) exceeds the maximum this network allows per tx (55882)` | The wallet-sdk's `assertGasLimitsWithinNetworkLimits` refuses any declared limit above the node's `txsLimits.gas`. Testnet admits 117,668 DA; this local network 55,882. The smoke clamps its declared limits to the node's maximum and reports them beside the constant; the app's claim constants keep testnet's 100,000 — a target network admitting less would refuse the claims outright. |
| 4 | all 16 flows green, 7.0 min; genesis actor, one note | first reading (below) |
| 5 | all 18 flows green; Schnorr actor, one-note and three-note exits | the readings below; codex round 1's two measurement gaps closed |
| 6 | all 18 flows green with the shape assertions; readings identical; the landed exits carried 5 and 7 nullifiers | two more notes = two more nullifiers = 61,600 more L2 gas, 30,800 each |

## The readings (aztec 5.2.0 local network, PrivateFPC 5.0.1; every landed fee equals the simulated billed gas at its block's `feePerL2Gas` 10,200,000, `feePerDaGas` 0; every deduction equals the ceiling)

| exit | actor | billed L2 gas | billed DA gas |
|---|---|---|---|
| one credit note (run 4) | genesis, initializerless | 826,543 | 1,696 |
| one credit note (run 5) | Schnorr under the wallet's key derivation, constructor-based | 826,543 | 1,696 |
| three credit notes (run 5) | Schnorr under the wallet's key derivation | 888,143 | 1,760 |

- The account artifact does not move the bill: identical to the gas unit. The testnet claim
  measurement (909,600, through the wallet) and these sandbox exits are therefore comparable.
- Each further note `pay_fee` selects costs ≈30,800 L2 gas and ≈32 DA gas (two extra notes: +61,600
  / +64). The exit is 9% lighter than the claim (claim_private + `FeeJuice.claim` +
  `mint_and_pay_fee`).
- "Charged = ceiling" is now asserted on every run — the first direct proof of the no-refund rule
  every ceiling comment in `private-fuel.ts` relies on. The FPC deducts `getFeeLimit`, never the fee.

## The constant

`PRIVATE_HUB_EXIT_GAS = { daGas: 50_000, l2Gas: 1_900_000 }` (was `= PRIVATE_HUB_CLAIM_GAS`,
`{ 100_000, 2_000_000 }`):

- **L2 1,900,000**: 2.3× the one-note reading, 2.14× the three-note one; the ≈1,012,000 above the
  three-note bill covers thirty-two further notes at 30,800 each (thirty-five spent in all, the
  headroom shared with the burn's token-note nullifiers) — the shape an account that keeps bridging
  accumulates (each claim's leftover is a note). The increment is the protocol's own metering, not a
  fit: 5.2.0's `meterGasUsed` charges 30,800 L2 gas per nullifier in a transaction with public
  execution and 32 DA gas per field, and private recursion adds no circuit-size charge — so no
  discontinuity waits at the FPC's next note-batch boundary.
- **DA 50,000**: 28× the three-note bill; sits under the 55,882 a local network admits, so the smoke's
  clamp is a no-op. The claim's 100,000 DA was never a measurement (its comment says DA fee 0).
- What it costs the user at testnet's `feePerL2Gas` ≈ 1.96e12: ≈3.7 FJ set aside per private
  exit, of which ≈1.6–1.7 FJ is the fee and the rest forfeited (was ≈3.9 FJ set aside).

Test pins moved with it: `useHubExit.test.ts` `EXIT_CEILING` 41,000,000 → 38,500,000 (mocked fees
10/20) and the `gasLimits` expectation.

## Codex (`/codex high`, read-only, session `01a07857-a137-7721-aa45-0f577cba314c`)

Round 1: **request changes** — MED the one-note reading does not bound `pay_fee`'s
recursion (adopted: the three-note exit, run 5); MED the genesis actor is not the wallet's account shape
(adopted: the Schnorr actor, run 5 — and the bill turned out identical); MED the sample zero-filled
missing evidence and asserted neither equality (adopted: fails closed, both asserted); LOW the
"clamp changes nothing" and "whole data footprint" wording overstated, 1,696 is simulated DA at a
zero DA price (adopted: reworded in `deploy-sandbox.ts` and `private-fuel.ts`). Fine: same FPC,
`pay_fee`, burn intent, exit arguments, zero teardown; `includeMetadata` beside witnesses and fee is
supported; held credit implies a prior transaction, so first-ever initialization is outside this
shape; no fence weakened.

Round 2: **the sizing converges**; one MED — "three notes" was advertised, not
enforced: funding and sending price the ceiling separately, and a re-attached run keeps earlier
credit (adopted: the note inventory, the send-time selection check, the credit-vs-inventory
equality and the nullifier-count delta, run 6); one LOW — the headroom arithmetic (thirty-two
beyond three, thirty-four beyond one, thirty-five in all; adopted). Codex also read the installed
5.2.0 metering: 30,800 L2 gas per nullifier with public execution, 32 DA per field, no charge for
private recursion — the readings match it, so the per-note increment is the protocol's, not a
two-point fit. The upstream Schnorr artifact the smoke deploys matches the frozen one's source; not
a sizing blocker.

Round 3: **approve, converged** — the zero-credit precondition establishes the
inventory, selection uses the send's own ceiling, credit reconciliation and the nullifier delta
corroborate the fixture, the corrected arithmetic supports the constant, the private-payer fence
is intact.

## Follow-ups (not in this arc)

- **Per-network admission limits.** `assertGasLimitsWithinNetworkLimits` is a hard refusal. The
  claim constants assume a network admitting ≥ 100,000 DA (true of testnet, not of a local network).
  If a target network ever admits less, the app has to read `txsLimits.gas` and clamp (as the smoke
  does) or size per network; today it would refuse with the wallet-sdk's message and no bridge-side
  explanation.
- **Deep fragmentation.** Thirty-two further notes is the metering model applied, not a measured
  point; an account that has bridged that many times without an exit is the case to measure before
  trusting it.
