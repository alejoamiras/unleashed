# Phase 0: planning consults

## Consult 1: Codex plan audit (gpt-6.1-sol, high, fresh session)

- Verdict: `conditional approve` (resolve D5 with the owner; narrow D1's claims; cover scheduled multicalls).
- Its reproducer confirmed the recon table and found one more path: a malformed `owner` fails `encodeFunctionData`,
  viem substitutes `0x` calldata and the decode error names `balanceOf`, so D1 would read 0n for a call that never ran.
- Its key point: under D1 the app's rows and amount step change when the RPC answers the Multicall3 call with bytes
  that do not decode, whether or not the app's copy is deleted, because the app's helper calls the SDK function.

## Consult 2: same-family lens (Opus 5.5, Plan agent, first draft)

- Verdict: `conditional approve`. It argued A and B and chose B on the merits, but found B's app delta visible, as Codex did.
- New trace adopted: a bad-checksum token address fails `aggregate3`'s encoding outside `readContract`'s `try`
  (`readContract.ts:118-122`), a raw `InvalidAddressError` with no `CallExecutionError`: every token reads `0n` under A.
  The app lowercases every address, so only SDK callers can hit it; the plan validates inputs before the call.
- Decision after both consults: ship A (the app's rule, moved) plus input and result checks with no visible change;
  B goes to the owner as ask-1, because both reviewers found its only extra effect visible in the app.

## Consult 3: Codex final pass (fresh session, gpt-6.1-sol, high)

- Verdict: `conditional approve`: D2's owner check changes the app's rows when a wallet provider hands over a
  bad-checksum account (`useL1Wallet.ts:58,84` stores it unchecked); offline reproducer showed today's guard reads `0n`
  and D2 would reject. Adopted: the owner check joins ask-1; D2 keeps only the token check.
- Resumed on the revision: `approve`; no app path passes a non-lowercase token address to `readBalancesOn`.
- Lesson: "the app passes X, so nothing changes" needs the call site read, not inferred; the first two drafts each
  claimed a pure refactor that a reviewer then broke with a concrete input.
