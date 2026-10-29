# send-copy-1 phase 0: planning consults

## Codex audit, round 1 (gpt-6.1-sol, high, read-only)

Verdict: conditional approve. Each finding checked against the tree before triage.

- C1 a pre-grant refusal shows a false "Your wallet declined this token" banner: **demonstrated**.
  `SendWizard.vue:1345` marks `declined` whenever a send returns "" with the token ungranted. The same trace showed
  more: `runSend` (`SendWizard.vue:1317-1325`) raises the permit screen ("Confirm the request in your wallet")
  before `sendFlow.send` runs, so a gate inside `performSend` would sit under a prompt screen with no prompt.
  Accepted; resolved by moving the gate into the wizard's confirm preflight (D1).
- C2 a cached passed check lets a later send through while the node is down: **demonstrated**, consequence does
  not matter. Rejected; see D5.
- C3 a chain switch during the new reads reaches the grant unchecked: **plausible but unverified**. Resolved by D1:
  the gate now runs before `runSend`, so `performSend`'s own `assertL1Chain` still runs right before the grant.
- C4 "a hostile RPC never produces a pass" overstated: accepted; the Security section now says the checks compare
  answers and do not authenticate them.
- Asks: Activity deletions are inside P6-01 (A1 dropped as an ask, kept as D4); the outcome and Activity have no
  network branch on their refund fields, so the plan adds them with mainnet controls; no calendar date in the
  Outcome (AGENTS.md § Plans); log no raw cause (the `[bridge:send]` log admits ids, stages and hashes only).

## Opus Plan critique (on the round-1 draft)

Conditional approve. Its false-"declined" finding matches Codex C1; the permit-screen and chain-switch findings are
closed by moving the gate into the wizard's preflight; mainnet controls added for the new outcome and Activity
branches; a failed read on a working network is the P7-02 sentence's own meaning (D6). Nits taken: stub
`assertDepositsOpen` explicitly in `useSend.test.ts`, assert an empty SDK event log rather than "no wallet call"
(`depositL1` reads `getChainId` first), fix the `useActivityFeed.ts:54` comment.

## Codex final fresh pass (gpt-6.1-sol, high, new session)

Conditional approve with two conditions, both checked in the tree and adopted:

- F1 the preflight's fast paths (public token+gas, gas-only) return true before the snapshot guard, so an awaited
  gate opens a window where a superseded review still sends: **plausible but unverified**, local fix, test added.
- F2 an earlier attempt's `grantState = "declined"` survives a refusal from the new gate: **demonstrated**
  (`SendWizard.vue:1345`, `ReviewStep.vue:161-163`), local fix, test added.

Resumed on the revision: approve.
