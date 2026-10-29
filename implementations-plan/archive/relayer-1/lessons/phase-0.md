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

## Revision for ask13 (hosted Worker)

The lane gained ask13 after the plan converged: an always-on Cloudflare Worker holding a dedicated relayer key as
its secret. The orchestrator's steer set the defaults (one-minute cron, a stateless bounded-window scan with
`fillStatuses`, a Worker-safe fill core in bridge-core's `src`, a testnet-only config, the dedicated key as the new
exclusive filler, the canary kept for canaries and manual fills, the two-anvil test driving the scheduled handler).
Arc a1 stopped at a clean point after Phase 1 (`8cfea22`).

Facts the revision rests on, checked against the tree: `fill-testnet.ts` and `scripts/sandbox/relayer.ts` load
Node and Aztec modules, so the Worker cannot import them as they stand; the relay leg, `fillSourceDeposit`, the gas
terms and `retried` are viem-only once moved. The attempt cap and the cursor rescan of option A need memory a
stateless run lacks; a write-free pre-simulation of `[approve, fillRelay]` replaces the cap, and a whole-window rescan
replaces the cursor. Moving `TESTNET_FILLER` needs the owner's key first, so the pin is its own arc (a2).

### Codex on the ask13 revision (gpt-6.1-sol, high, fresh session, then two resumes)

Fresh: reject (blocking: queue starvation; the pre-simulation alone does not replace the attempt cap). Six findings,
all verified against the tree and adopted (plan.md § Audit verdicts): `fill-reverted` had been logged as a write-free
skip; a write-free refusal of the largest deposit blocked the queue; the 1,000,000-gas fee pre-check let the ceiling
refuse a fill after its approval (fixed by pricing the gas cap; a live Sepolia read put the fee about seven orders of
magnitude under it); the nonce check is no lock; per-deposit status reads let dust exhaust a run; the canary-pinned
CLI cannot rescue relayer-key deposits. First resume: reject on a new path: dropping filled deposits by `depositId`
lets a stranger's fill of another relay suppress a real one; fixed by moving discovery's full-identity check into
`across-relay.ts` (`fillsRelay`). Second resume: approve, no new material finding.

## Consults after the revision

- Fix loop round 1 on a1's diff (Codex gpt-6.1-sol, high, read-only): reject, four findings adopted (`faac3c8`).
  Beside it, an Opus general-purpose diff review: eight findings adopted (`9dfc0a8`).
- Round 2 (resumed): approve; two non-blocking items adopted (`a02ac14`).
- Arc a3's plan (the owner's answer to OWNER-ASKS #2; a Sonnet research agent on Circle's faucet API, its facts
  re-fetched by the lead): Codex reject, four findings adopted; resumed: approve.
