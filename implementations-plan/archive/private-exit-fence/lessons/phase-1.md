# Phase 1 — the private-exit fence

Owner's directive after the deposit fence: "fix (1)" — (1) being the codex
informational from the deposit fence's review: private exits are wallet-paid, so a private exit can name a
public payer.

## Built

- `packages/bridge-core/src/private-fuel.ts`: `PRIVATE_HUB_EXIT_GAS` = the claim's measured limits,
  an upper bound for the lighter exit (one private burn + the hub's pause check); a measured value
  is a canary follow-up, noted at the constant.
- `apps/tools/src/composables/useHubExit.ts`: `privateExitFee` reads the credit at the PrivateFPC
  and the predicted worst fees, computes the ceiling (`privateFpcFeeLimit` over the exit limits),
  and returns `{ paymentMethod: pay_fee, gasSettings }` or throws `ExitNeedsPrivateGasError`
  (`none` / `short` / `unverifiable`, each with its own message). Read in `readOnlyPreflight`, so a
  refusal happens before any authwit exists; the private exit's simulate and send both carry the
  fee; a refusal discards the provisional record like a pause does. `buildExitSendOpts` stays
  fee-less for the public exit and the public authwit transaction.
- `apps/tools/src/components/send/SendWizard.vue`: `exitBlocked` gains the private reason (through
  the same `heldGasSource` the token-only gate uses, `privateBridge: true`); `preflight` re-reads the
  credit at confirm for a private exit and stands the review down with the same reasons; the
  review's fee line for a private exit names the private gas set aside.
- Pins: `useHubExit.test.ts` (a public exit carries no fee; a private exit carries the FPC fee at
  the ceiling on both the simulate and the send; short / none credit refuses before the authwit,
  opens no record, says why); `SendWizard.test.ts` (a private exit is blocked without credit,
  released by enough, priced on the review, stood down at confirm when the credit is gone; a
  public exit with the same balances is not blocked).

## Test-harness note

The exit test's wallet stub serves ONE value for every utility read, so the token balance and the
FPC credit were the same number; the "no credit" case needed a `fpcCredit` override on the harness
so the balance check (which runs first) passes and the fence is what refuses.

## Gate

| line | result |
|---|---|
| `<frozen>` (diff --quiet over the nine step files) | exit 0 |
| `<lint>` | exit 0 (30 pre-existing warnings; complexity baseline OK) |
| `<typecheck>` | exit 0 |
| `<unit>` | 96 files, 1246 tests |
| `<smoke>` (jsdom) | 3 files, 29 tests — the exit case now asserts the FPC fee on the send; a sibling asserts the block without credit |
| `<bc>` | 46 files, 436 tests; typecheck exit 0 |

Smoke-harness note: the real `readPrivateFeeJuiceBalance` lazily imports the 2.2 MB PrivateFPC
artifact, which outlasts the harness's zero-delay `settle()`; the harness now answers the credit
read from its held-gas stub, as the wizard's unit harness already did.

`LESSONS_FILE=implementations-plan/archive/private-exit-fence/lessons/phase-1.md`
