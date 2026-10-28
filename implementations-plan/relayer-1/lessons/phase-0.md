# relayer-1 phase 0: planning consults

## Recon (Sonnet, 3 agents)

- Reuse sweep, two-anvil harness map, external facts. Findings persisted in `recon.md`.
- The parent fetched docs.across.to/chains-and-contracts itself: "relayer settlement does not occur on the testnet
  and unfilled deposits are not automatically refunded". Two lane claims did not hold: the 25 % fee keeps no
  inventory stocked (nothing is repaid), and an expired testnet deposit is not refunded on the source chain.

## Consults

(one entry per Codex and same-family consult, with its verdict)

### Codex round 1 (gpt-6.1-sol, high, read-only; fresh session)

Verdict: reject (with blocking findings: incomplete message validation, an unbound receipt re-read, repeated gas on
permanent failures, insufficient integration coverage). Seven findings; the parent verified each against the tree:
1 (classify misses step fields) holds against `acrossDepositFor`; 2 (log and receipt unbound) holds as a code gap;
3 (retries re-approve forever; `no-receipt` never reaches the deadline check) holds; 4 (rescan vs an unbounded
deadline) holds; 5 (the anvil test never runs the message) holds as a gap, disposition differs; 6 (custody wording)
holds; 7 (`reserveSandboxPorts` is not in the sandbox barrel) holds. Dispositions are in plan.md § Audit verdicts.

### Opus Plan agent round 1 (same-family leg)

Verdict: conditional approve (C1 deadline check and attempt cap, C2 classify checks and ordering, C3 overlap rescan,
C4 custody, C5 fixtures from the app's builders, C6 the barrel export). Nine findings, verified against the tree;
`checkMessage` (`lifi-decode.ts:660-680`) and `acrossDepositFor` confirmed the app's exact step shape, and
`useCrossChainRoute.ts:233` confirmed `minReceived` = `maxPull` = the output. Dispositions in plan.md § Audit verdicts.

### Codex final pass (gpt-6.1-sol, high, fresh session, then one resume)

Fresh: conditional approve (gas-ceiling accounting, intent validity, the recorded fixture, rescan between fills).
The parent verified all four against the tree (the fixture's receipt has no exclusive relayer and a 10 % fee;
`DepositRouter._checkShape` reads chain state). Three adopted; intent mirroring rejected with its consequence path.
Resumed: approve, no new material finding.
