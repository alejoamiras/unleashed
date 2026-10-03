# Lessons — Phase 2 (consumer correctness under switching)

## Outcome
Green: typecheck ✓ · lint exit 0 · test:faucet 556/556 (54 files). Account-keyed TokenCards, BridgeForm account-change stand-down, `useOpsInFlight` registry wired into the session's `isSwitchBlocked`, 8 op spans wrapped, D-1 remount proof + D-18 wiring tests.

## D-19 coverage sweep (grep over `sendTx|registerToken|createAuthWit|simulateTx|.request(`)

Wrapped (prompt/send spans): drip sendTx (`useFaucetDrip` return-site wrapper), withdraw incl. `createAuthWit` (`useWithdraw` return-site), deposit (`useDeposit` return-site), fuel deposit (`useFuel` return-site), add-token `registerToken` (`useFaucetAddToken` return-site; covers TokenCard AND BridgeAddToken), journal continuations (`runDepositClaim`/`runWithdrawConsume` — the single entry points for card retries, `resumeSessionWork`, and fuel's claim leg; wrapped INSIDE their try so `surfaceRunFailure` still owns errors).

Exempt by the invariant ("account-sensitive wallet prompt/send"): `useL1Wallet` (EVM provider — the Aztec account switch doesn't touch it), `useTokenBalance` reads + `fuelClaim.simulateTx` (read-only, no prompt), `createAztecWalletSession` connect-time calls (status ≠ connected → selectAccount already rejects).

## Gotchas worth remembering

1. **Wrap the RE-EXPORTED surface, not the inner body.** Return-site wrappers (`deposit: (...args: Parameters<typeof deposit>) => withOperation(() => deposit(...args))`) gave one-line diffs per composable and kept the long function bodies untouched. For the journal, the thin public `runDepositClaim` → `runDepositClaimInner` split meant wrapping ONE await covered every spawn point — codex R3's "wrap the spawned promise, not the void dispatcher" fell out naturally from the existing structure.
2. **The journal already had the account-safety spine**: `connectedAztec` live-getter mismatch guard on private claims is characterization-pinned at `useBridgeJournal.test.ts:546` ("wrong connected AZTEC account ⇒ mismatch before anything runs") — the plan's journal re-scope item was VERIFY, not build.
3. **BridgeForm's `onBackground()` was the reset path codex asked for** — releaseForeground + ownedId=null + clearFlowErrors + stage reset. The account-change watcher calls it + clears receiptSnapshot/amount; only on connected→connected account CHANGE (`prev?.[1] && account && prev[1] !== account`), so connect/disconnect don't spuriously reset.
4. **D-1 remount proof without heavy mocks**: a TokenCard stub that records `props.account` in its `setup()` — a new captured entry proves Vue tore down and re-created the instance (i.e. the real card would re-bind `useFaucetDrip`). Keyed by `${symbol}:${account}`, one `nextTick` after switching is enough.
5. FaucetView's `accountAddress` computed uses `AztecAddress.fromStringUnsafe` — test fixtures must be 32-byte addresses here too (same Phase 1 lesson, new surface).
