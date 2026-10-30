---
plan: sdk-reads-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
quality_bar: production (the bridge moves real funds on mainnet)
trunk: main
---

# sdk-reads-1: two SDK reads fail closed

`readErc20Balances` reports zero balances when the aggregate call itself failed (#73). `findDepositTx` drops a logged
candidate whose transaction or receipt reads `null`, so it can answer `"none"` where it should answer `"incomplete"`
(#89). Both start to fail closed, and the app goes back to the SDK's balance read. One arc, one PR.

| Issue | Arc | Claim check |
|---|---|---|
| #73 | a1 | Holds as filed (an RPC refusal: 429, 5xx, timeout, any JSON-RPC error). Narrower than it reads: under the issue's own rule, an aggregate answered `0x`, `null` or truncated still reads as zeros (recon.md, viem table). Closing that changes what the app shows: `OWNER-ASKS.md` ask-1. |
| #89 | a1 | Holds for the SDK's declared client (`ReconcileL1Client` allows `null`). Unreachable through viem 2.57.1: its `getTransaction`/`getTransactionReceipt` reject on `null`, which the search already reads as `"incomplete"`. The fix is local and makes the code match its contract. |

Lane asks: none. Owner asks: ask-1, which does not block a1. UI impact: none (D5).

## Outcome & Quality Bar

- **For whom**: an integrator calling `@unleashed/sdk/protocol` or the claim entries, and the app user whose token rows
  and amount step read L1 balances.
- **Excellent**: (1) no balance is reported for a read the RPC refused or for a token address viem cannot encode,
  and one bad token still costs the caller nothing but its own row; (2) a deposit search answers `"none"` only after every
  candidate the logs named was read in full.
- **Good enough**: a rejected balance read carries the client's own error; no new error type.

## Architecture & Implementation

**D1. Which failures reject.** `readErc20Balances` rejects with an entry's error when that error's chain holds viem's
`CallExecutionError`: only the aggregate's own `eth_call` makes one, so every RPC refusal is covered. Any other failure
stays `0n`. A success whose result is not a `bigint`, or a missing entry, rejects; only a non-viem client can produce
either. The chain is walked through `cause` and matched by `name`, never `instanceof`, because a published SDK can
meet a second viem copy (`crosschain-discovery.ts:296-299` does the same). This is the app's rule, moved.
- Alternative B (keep `0n` only for an error whose `functionName` is `balanceOf`). Codex, Opus and the planner all
  judge it the stronger rule: it lists the one shape that may read `0n` and rejects the unknown. Its only extra effect
  in the app is visible (an aggregate answered `0x`, `null` or truncated), so it is ask-1. What ships now is D1.
- Rejected C (reject when the error names `aggregate3`): fail-open for shapes it does not know, and visible like B.

**D2. Token addresses.** `readErc20Balances` rejects before it calls when any token fails `isAddress` at viem's
default strictness, the check viem's encoder applies. Otherwise a bad token address fails `aggregate3`'s encoding
outside `readContract`'s `try` (`readContract.ts:118-122`) and every token reads `0n`. The app lowercases every
manifest, list and pasted address (`useTokenCatalog.ts:57,73,189`, `bridge-core/src/token-list.ts:138`), so the
check never fires there.
- Deferred to ask-1: the same check on the owner. A bad owner makes viem substitute `0x` calldata for every
  `balanceOf` (`multicall.ts:217-235`, `:315`), so every token reads `0n`. The app's owner is the wallet's account
  string as the provider gave it (`useL1Wallet.ts:58,84`), so a provider that hands over a bad-checksum account would
  see its rows change: visible, the owner's call.

**D3. #89.** `isRecordCall`: `if (!tx) throw new ScanIncomplete("a logged transaction was not served")` before the
calldata checks. `landed`: `if (!receipt) throw new ScanIncomplete("a logged transaction has no receipt")` before the
status check; a receipt whose status is not `success` stays a real negative. Same idiom as
`crosschain-discovery.ts:416`; `findDepositTx` already maps `ScanIncomplete` to `"incomplete"`.

**D4. The app.** `readBalancesOn` keeps its adapter only for `batchSize: 0` (one `eth_call`; balances-1 D2 kept it out
of the SDK) and loses its own walk and the `BaseError`/`CallExecutionError` imports.

**D5. Pure refactor.** The SDK's walk rejects exactly when the app's did: one viem copy is installed, so `name` and
`instanceof` agree, and every viem error is a `BaseError`. D2 and the `bigint` check never fire for the app (its token
addresses are lowercase; its viem decodes `uint256` to a `bigint`). No copy, row or format changes.

**Change map.** `packages/sdk/src/protocol/erc20.ts` (D1, D2; the TSDoc states each rejection) and `erc20.test.ts`;
`packages/sdk/src/execution/deposit-reconcile.ts` (D3) and its test; `apps/tools/src/composables/useEthereumReader.ts`
(D4 and its doc comment).

**Found, left out.** `readErc20Metadata`'s `rawCall` (`erc20.ts:140-146`) reads a refused `name()`/`symbol()` as an
empty word and a refused `decimals()` as "cannot be bridged" (`bridge/token.ts:51`, retry `never`). Path (plausible;
traced, not reproduced): first-time token, the RPC refuses `name()` → `nameRaw` empty → `resolveToken` derives an L2
address from an empty word, which the hub would not derive. A fix must tell a revert (the factory's empty word) from a
transport failure inside viem's `call` errors, and it changes token resolution, which users see. The close-out
reproduces it, then files an issue, or a private draft advisory if it proves exploitable (no duplicate found).

## Security & Adversarial Considerations

- **Threat model.** A token the user lists or pastes; an RPC that refuses, lags, answers `null` or lies. The RPC is
  trusted for values and completeness; this plan only stops a *failed* read from becoming a value.
- **A refusing or `null` RPC.** Before: an SDK caller got zeros (the app guarded itself), and a `null` read of a
  logged candidate could end in `"none"`, whose app note suggests discarding a record that holds a claim secret.
  After: the balance read rejects (the app keeps what it read, or shows the balance as unknown), and the search is
  `"incomplete"` ("try again later").
- **Still read as absence** (existing limits, not widened): well-formed failing entries, an aggregate answer that
  does not decode, or an owner viem cannot encode (both ask-1), read `0n`; omitted logs or a stale head read `"none"`. Checking an RPC's completeness
  independently is new trust machinery outside this lane.
- **No endless retry.** Nothing here adds a retry. Every search runs under `budgetedReads` (`maxReads` 200,
  `deadlineMs` 45 s, `chain-scan.ts:27-46`); a balance read makes one call. A persistently `null` RPC yields
  `"incomplete"` on each pass the existing callers make; row reads fire only when the owner or the visible rows change.
- **A hostile token.** Its revert or garbage returndata fails its own entry only (`0n`). A token that burns the call's
  gas fails the aggregate with an RPC error, which the app already rejects; a denial reaches only lists the user builds.
- **Supply chain / crypto / privilege.** No dependency, key, workflow or permission changes; viem stays at 2.57.1.

## Assumptions

**Facts**
1. viem 2.57.1: an RPC refusal of the aggregate (HTTP 429, JSON-RPC -32603 with or without data, code 3) gives every
   entry an error whose chain holds `CallExecutionError`, with batching on or off; a token's own failure never does;
   a `0x` or truncated answer carries none (reproducers in recon.md; `multicall.ts:282-333`).
2. viem `getTransaction`/`getTransactionReceipt` reject on `null` (`getTransaction.ts:151`, `getTransactionReceipt.ts:66`).
3. `findDepositTx` maps `ScanIncomplete` to `"incomplete"` (`deposit-reconcile.ts:133-135`); `fakeChain` serves every
   hash its logs name (`deposit-reconcile.test.ts:134-151`), so no existing `"none"` test rests on a `null` read.
4. Both app callers of `readBalancesOn` handle a rejection (`useRowBalances.ts:49`, `useTokenSelection.ts:149`).
5. `useRowBalances.test.ts` "a call the node refuses leaves what was read standing, never zeros" runs the real SDK
   function through the real `readBalancesOn` and real viem.

**Inferences** (attack these)
- I1. viem keeps `CallExecutionError` in a refused aggregate's chain across versions. The SDK's tests pin its exact
  copy; the app takes `^2.52.2` and its own real-viem refusal test (Fact 5) covers whichever copy it resolves.
- I2. No `Erc20Client` other than viem's exists in this repository; D1 adds no obligation to one.

**Asks**: none for the plan. If the owner declines ask-1, the close-out files it as a closed `known-limit` issue.

## Phase 1: both fixes and the app on the SDK read (arc a1) ✓

Warning: start only after PR #88 merges; then merge `origin/main`.

1. Write the tests first and see each new case fail on the current code:
   - `erc20.test.ts`: one `describe` with a real `createPublicClient` over `custom` (the shape of
     `useRowBalances.test.ts`'s `nodeClient`), each case with multicall batching off and on: an `eth_call` that throws
     a 429 rejects; one success and one reverting entry resolve `{a: 5n, b: 0n}` (the control). With the existing
     fake: a bad-checksum token rejects without a call; a non-`bigint` success rejects. The existing fake test of a
     failing token (`0n`) stays.
   - `deposit-reconcile.test.ts`: one `it.each` over `getTransaction` and `getTransactionReceipt`: a `null` answer for
     the logged hash → `"incomplete"`; the same chain unmodified → `{ txHash }`.
2. Apply D1 and D2 in `readErc20Balances`, and D3 in `deposit-reconcile.ts`.
3. Apply D4 in `useEthereumReader.ts`.

**Validation gate**
- Commands: `bun run lint`; `bun run typecheck:all`; `cd packages/sdk && bun --bun vitest run src/protocol/erc20.test.ts
  src/execution/deposit-reconcile.test.ts`; `cd apps/tools && bun --bun vitest run src/composables/useRowBalances.test.ts`;
  `bun run test:all`; `bun run audit:tools`; `bun run e2e:tools -- specs/tokens-hostile.spec.ts --retries=0`.
- Pass: every command exits 0; step 1's new cases were red before step 2; the `useRowBalances` refusal test passes
  unchanged.
- Layers: lint and typecheck; unit (stub and real-viem); browser e2e: one existing spec that paints row balances from
  the sandbox's real Multicall3 (35 s recorded); no new scenario.

## Delivery

Single arc, single PR against `main` from `worktree-sdk-reads-1`, carrying this plan. Title: `fix(sdk): reject a
balance read that never ran and an unserved reconcile read`. Body: what and why, gate outcomes, `Closes #73`,
`Closes #89`. Open it only after the gate passes and the Codex loop converges. Publishing the SDK is the owner's step.

## Post-implementation

- Comments: invariants and reasons only, never a plan, phase, issue or review. Log attempts in `lessons/phase-1.md`;
  `agent-worktree status sdk-reads-1 "<state>"` at each gate. Stop after 3 failures on one step.
1. **Codex audit**: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with
   the diff from the plan commit, this plan, the adversarial ask, blueprint's no-over-engineering and comment-quality
   rules verbatim, and the line forbidding any read of `.env`/`*.env` files and of `~/.agents/orchy/`.
2. **Fix loop**: verify each finding against the tree, fix, commit, log, resume the same session with the fix diff.
   Stop when a round has no new material finding; still churning after 3 rounds → stop and surface. A fix that adds
   state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change: stop for approval.
3. **Delivery**: `gh pr create`, then `gh pr checks --watch` (bounded).
4. **Close-out** as the PR's final commits: an `## Outcome` block after the front matter (date, status, shipped,
   `Known limits:`, `Open items:`, seeds retired); promote gotchas to `lessons.md` (dedupe, 8 KiB); file the
   metadata-read item above. Homes: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`;
   an exploitable weakness → a private draft advisory; unsupported conditions → a closed `known-limit` issue. Merge
   `origin/main`, then `git mv implementations-plan/sdk-reads-1 implementations-plan/archive/sdk-reads-1` in its own
   commit and add one line to `archive/index.md`; no row in `index.md`.
5. **Teardown after the merge** (the orchestrator merges): `git fetch -q origin main && git cat-file -e
   FETCH_HEAD:implementations-plan/archive/sdk-reads-1/plan.md`, then `agent-worktree done sdk-reads-1 --merged`;
   relay a refusal, never force.

## Audit

**Codex audit 1** (gpt-6.1-sol, high), first draft with B as D1: `conditional approve` (resolve D5 with the owner;
narrow D1's claims; cover scheduled multicalls).
- C1 Medium, demonstrated: B changes the app's rows and amount step when an aggregate answer does not decode, so D5
  was not a pure refactor. **Adopted**: D1 is the app's rule, moved; B is ask-1.
- C2 Medium, demonstrated: a malformed owner reads `0n` for every token. **Adopted**: D2.
- C3 Low: B beats A and C; test batching on and off. **Adopted** (tests); B deferred per C1.
- C4 Low: well-formed failures, omitted logs or a stale head still read as absence. **Adopted** as Security wording.
- C5 Low: "unpublished" proves nothing about external clients. **Adopted**: I2 is scoped to this repository.
- C6 Low: reproduce the metadata sibling before choosing issue or advisory. **Adopted** in the close-out.

**Opus critique** (Plan agent), same draft: `conditional approve`.
- O1 Medium: the tests could not tell B from C. **Moot** with A; the control and the 429 case bound A on both sides.
- O2 Medium, demonstrated: B's D5 delta is visible (`0x`, `null`, truncated). **Adopted** as C1. Opus would accept B
  as the #73 fix; that call is the owner's, not the panel's.
- O3 Low, traced: a bad owner, and a bad-checksum token, read `0n` everywhere. **Adopted**: D2 checks both.
- O4 Low, needs a non-viem client: a non-`bigint` success reads `0n`. **Adopted** (one branch, no app delta); a missing
  entry takes the same branch, so the draft's separate length check is dropped.
- Also adopted: the gas-burning-token wording (the app's walk already rejected it) and I1's minor-drift note.

**Codex final pass** (fresh session, gpt-6.1-sol, high), consolidated plan: `conditional approve` (surface D2's owner
check, defer it unless approved).
- F1 Medium, demonstrated (offline reproducer): the app's owner is the provider's account string
  (`useL1Wallet.ts:58,84`); a bad-checksum account reads `0n` today and would reject under D2, changing the rows and
  the amount step. **Adopted**: the owner check moves into ask-1; D2 keeps the token check, which never fires in the
  app. Everything else (D1, D3, D4, tests, Security, the B and C dispositions) it found sound.
- Resumed on the revision: **`approve`**. It traced every path into `readBalancesOn` (catalog rows, list and cached
  entries, pasted tokens, selection, prefill, source-chain rows) and found no non-lowercase token address.

Size: over the 150-line `light` target because the ledger records three review rounds; nothing is restated.

### Implementation review (arc a1)

**Codex round 1** (gpt-6.1-sol, high, diff `5b1315a..ae83621`+`03780e4`): `findings: 0`. It reproduced 429, transport,
-32603 (with and without data) and code 3 refusals with batching on and off, and the `{5n, 0n}` controls.
- Optional, **adopted**: the reconcile comment named only a lagging backend; a reorg also yields `null`. Reworded.
- Optional, **adopted**: a -32603 refusal case, since viem wraps it in a revert error, a different chain from a
  transport failure's (`erc20.test.ts`, the refusal table).
- Noted: `aggregateFailed` loops on a self-referencing `cause` (needs a non-viem client that builds one). Settled by
  the Opus finding below.

**Opus diff review** (general-purpose, beside round 1): `findings: 1`.
- O1 Low, demonstrated (`bun -e` reproducer hung under `timeout 5`): a cyclic `cause` from a non-viem client freezes
  the thread. **Adopted**: the walk stops at depth 8, as `isUserRejection` (`errors.ts:72`) already does; a test pins it.
- Nits, **adopted**: a fake refusal from "another viem copy" pins the name match; the `rejects %s` cases assert their
  messages; the bad-checksum test gains a valid mixed-case control; the TSDoc says a token can still cost the list
  when it makes the aggregate call itself fail.
- Fixes in `5794361`.

**Codex round 2** (resumed, fix diff `03780e4..5794361`): `findings: 0`. Loop converged in 2 rounds.

## Seeds (draft; not run by this planner)

```
/goal Phase 1 of implementations-plan/sdk-reads-1/plan.md is marked ✓ with its validation gate passing in the transcript; LESSONS_FILE=implementations-plan/sdk-reads-1/lessons/phase-1.md printed; the Codex fix loop converged (a resumed pass with no new material findings quoted); one PR against main exists, opened after the loop, carrying the archive-move close-out commit; bun run test:all and bun run lint exit 0.
```
```
/loop 15m Drive implementations-plan/sdk-reads-1 forward per its Phase 1, Post-implementation and Delivery sections; never merge; stop once delivery is green.
```
