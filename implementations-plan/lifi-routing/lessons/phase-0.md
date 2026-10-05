# Phase 0: testnet rail feasibility

**Verdict: path A (all LI.FI).** `LifiTestnetRailFork` passes both cases against the deployed contracts. On the
Base Sepolia fork, the bytes from `across-v4.ts` go through LI.FI's Diamond and the SpokePool emits exactly the
deposit we described. On the Sepolia fork, the real `fillRelay` runs ReceiverAcrossV4 → Executor → a direct
`depositToAztecPublic` on the USDC clone. When the step reverts (deposits paused), the whole delivered amount goes
to the user. Neither LI.FI contract keeps any residue in either case.

## Facts the next phases rely on

- **The Across fill logs `FilledRelay` before it runs the message.** In the recovered fill, `FilledRelay` is
  log 0, then USDC transfers and approvals, then `LiFiTransferRecovered` (log 6), then a final approval.

  So on Across, the outcome marker (`LiFiTransferCompleted` / `LiFiTransferRecovered`) comes after the transport
  event. The test pins this order in both cases.
- **`FilledRelay` is indexed** by origin chain id (topic 1) and deposit id (topic 2). I5 holds for Across.
- **`LiFiTransferCompleted` and `LiFiTransferRecovered` index the transaction id** (topic 1). The Executor emits
  Completed; ReceiverAcrossV4 emits Recovered.
- **`FundsDeposited` indexes** destination chain id, deposit id and depositor (topics 1–3). Through the facet, the
  depositor is the user, not the Diamond. `LiFiTransferStarted` is emitted by the Diamond and has only topic 0.
- **No archive state on PublicNode.** It returns "state at block … is pruned" well within a day. A pinned fork
  block therefore stays usable for minutes only, so `lifi-fixtures.ts testnet-rail --run` records the blocks and
  runs the suite at once. A committed fixture only re-runs against an archive RPC, which the gate does not need.
  The recorder pins 3 blocks behind the head.
- **The test needs file access.** It reads the fixture and writes receipts, which needs `fs_permissions`
  read-write on `test/fixtures/lifi` in `foundry.toml`. Without it, `vm.readFile` is refused.

## Toolchain (this machine)

- **Pinned toolchain is local, not system-wide.** CI pins Foundry 1.7.1, the system `forge` is 1.4.1, and halmos
  was absent. Both were installed into user-local caches:
  - Foundry, with `FOUNDRY_DIR=~/.cache/foundry-1.7.1 foundryup --install v1.7.1`;
  - halmos, in a venv with `python3 -m venv ~/.cache/halmos-0.3.3 && …/pip install halmos==0.3.3`.

  The system Foundry is untouched. Point `FORGE_BIN` at the private forge for `lifi-fixtures.ts --run`.
- **The baseline was green before any change:** 157 hermetic forge tests, the gas snapshot, 12/12 halmos proofs,
  lint, typecheck, and 2,354 unit tests.
- **The `lifi` profile does not exist yet.** Until Phase 1 adds it, `FOUNDRY_PROFILE=lifi forge build` silently
  builds the default profile, so that G0 line proves nothing yet.

## Attempts

1. The first run failed one assertion: I had assumed the message runs before `FilledRelay`. The recovered case's
   log order showed the reverse. I corrected the assertion and re-recorded, since the first fixture's blocks were
   already being pruned. Second run: 2/2 pass.
