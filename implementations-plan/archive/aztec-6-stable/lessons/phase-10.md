# Phase 10: canaries, the preview, the final verify

## The canaries (`keyed/step10-canaries.sh`, testnet-l1, from the window's stash)

Green with no retry, against the promoted `testnet-bridge.json`:

- `forge --version` on the keyed PATH: `forge Version: 1.4.1-v1.4.1`, the binary of Phase 9 step 1. Nothing else
  built forge during the run.
- `verify:l1 --strict`: "L1 verification passed", with the four runtime code hashes and the fee-juice coherence
  reads (`router.feeJuicePortal`, `swapTarget.feeJuice` against `feeJuice.asset`).
- `verify:deployments`: "All committed addresses match the rebuilt instances" (catalog, Dripper, SIGNAL and NOISE,
  both minters).
- The FPC gate: "FPC gate green — compat + identity + digest + live class all agree."
- `PRIVATE_RUNS=1 fuel-testnet.ts` with `FUEL_SLICE_UNITS=1500000`: "2 fueled runs SETTLED in 1.5m". Public
  claim fee 1656099014975800000, 39.60 FJ gained; private self-paying claim fee 1137202681952400000, ceiling
  2838685858590000000.
- `fee-juice-canary-testnet.ts`: "DIRECT Fee-Juice SELF-PAY canary PASSED — mint→deposit(minFj)→self-pay-claim
  landed 15176096118175400000 FJ-wei (fee 823903881824600000) in 1.0m." The signer's fee-asset balance (952 FJ)
  covered `minFj`, so it minted nothing.
- `drip-canary-testnet.ts`: "DRIP canary PASSED — SIGNAL + NOISE dripped to a fresh account in 0.7m."

`token-list.test.ts` with `TOKEN_LIST_LIVE=1`, keyless: 15 passed (without the flag the live case skips: 14
passed, 1 skipped).

## The preview

The Workers Builds preview of `63f02a0` (`fc52f37e-unleashed-testnet…workers.dev`), loaded in Chromium: page 200,
`crossOriginIsolated` true, 0 CSP violations, and the boot `node_getNodeInfo` POST answered 200 from
`aztec-testnet.drpc.org` with rollupVersion 679261766.

The preview of the commit before promotion refused to boot ("build integrity check failed — refusing to load:
bundled manifest chain (l1=11155111, wallet=3415328944) != testnet target (l1=11155111, wallet=685146337)"): the
rc.3 manifest against the 6.0.0 target, failing closed as designed. Workers Builds still reports that build
green, because the check runs in the page, not in the build.

## The final verify

`live-intent verify` (testnet-rpc): "verify green — rollupVersion 679261766, spend 0.000110/2 ETH". The freeze
ends. The stash was dropped right after (`keyed/drop-window-env.sh`), and no PXE store from the window is left in
`/dev/shm`.

Total Sepolia spend for the generation: 0.000110 ETH by the tool's balance delta, against the 2.0 ETH cap; the
gross tally in `phase-9.md` adds the canaries' 0.000003.
