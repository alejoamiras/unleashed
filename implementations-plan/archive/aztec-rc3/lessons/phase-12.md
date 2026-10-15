# Phase 12 — canaries and the final verify

## The first canary run (`rc3-canaries-10a3d237`, testnet-l1)

Strict `verify:l1` passed with the four runtime code hashes. `verify:deployments` matched the faucet record, the
hub and all four tokens, and the FPC gate was green. The public fuel claim settled: claim fee
1656099014975800000, FJ gained 41.10. Then the private send's `bridgeWithFuel` reverted
(`0xbc3a3408…d472`).

Root cause, from two public Sepolia RPCs: an out-of-gas revert. The transaction used its whole 1,058,108 limit
and emitted no logs. The same calldata estimates 1,058,108 at the end of block 11922865 and 1,180,262 at the end
of 11922866, where it was mined. With 1,058,108 gas it succeeds at the first and fails at the second. In 11922865
the run's own public send moved the Inbox (`0xb3B9…b209`) from 80 to 82 messages and from tree 67 to 68. The
first message of a window pays for a fresh tree, so the private send was estimated just after one had been paid
for and was mined in the next window. No other swap or Inbox message touched those blocks. viem sends a local
account's bare estimate. Nothing moved: no token pull, no swap, no deposit; only about 0.000001 ETH of gas.

That run also measured the first plain public claim of this generation, 1.656 FJ, above the calibrated
`fjPerTx` of 1.365 FJ. The owner chose to fix both inside this arc (D21, D22):

- `runSend` estimates the exact call and sends that limit plus 25 %.
- The two queued Codex findings were applied: the stricter FPC absence check and the smoke label.
- The candidate was recalibrated with the public sample added (9 samples): `fjPerTx=1987318817970960000`,
  `fjRegister=1577053752328560000`. Only those two fields differ from the live manifest; the candidate sha256 is
  `6685544cf56460017f1738dbbe6768bf079b83eb0fa438d140abdbe359783a24`. A source change since the first intent
  means a second intent, under `lessons/recalibration/`, whose receipt sits beside it.

The canary retry filed before this (`rc3-canaries-retry-5688193a`) went void with the first fix commit.

## The second intent (`rc3-recal-intent-6a5a7692`, testnet-l1)

Green at `17659a1`. Its identity, L1 addresses, signer, caps and artifact pins (the FPC address, salt and digest,
both Noir target digests) equal the first intent's, so nothing deployed moves. Starting balance 2.90357 ETH.

## The recalibrated candidate (`rc3-recal-verify-c1b9632b`, testnet-rpc)

Green. Digest `6685544c…3a24` recorded in the second intent; "L1 verification passed"; the hub's
initialization hash and class match.

A local sandbox smoke run alongside it, to rehearse the gas fix, failed at step (e) with `ENOENT` on
`contracts/bridge/evm/out/MintableERC20.sol/MintableERC20.json`. The keyed run's strict `verify-l1` rebuilt
`out/` at that minute, and both share the worktree's forge output. Every step before it passed with the new gas
limit, `runSend`'s deposits and fueled sends included. A local forge build must not overlap a keyed `verify-l1`.

## Promote, the canaries and the final verify (`rc3-recal-promote-canaries-7cf5d244`, testnet-l1)

Green with no retry used. The promotion passed the generation interlock against the live manifest. The live
`testnet-bridge.json` equals the verified candidate (`6685544c…3a24`).

- `verify:l1 --strict`: "L1 verification passed".
- `verify:deployments`: the faucet record, the hub and all four tokens match.
- The FPC gate is green.
- The fuel canary ran the public lane, then the private one, the order that ran out of gas before; both settled.
  Public claim fee 1.656 FJ; private claim fee 1.137 FJ, ceiling 2.839 FJ.
- The direct Fee Juice self-pay canary passed: 15.18 FJ landed, fee 0.824 FJ.
- The drip canary passed: SIGNAL and NOISE dripped to a fresh account.
- The final verify is green. The freeze ends.

Total Sepolia spend for the generation, over both intents: 0.0000926 ETH, against the 2.0 ETH cap.
