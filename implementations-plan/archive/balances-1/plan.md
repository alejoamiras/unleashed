---
plan: balances-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: closed, shipped in #72
base: main a111e8a
budget: "recon: 1 Sonnet explorer + driver checks; code-review: off; Codex gpt-6.1-sol at high"
---

## Outcome

- **Status: closed, shipped** in #72 (arc a1, Delivers ask35). Phase 1 is ✓.
- **Shipped.** The token rows and the selected token's Ethereum balance read through the build's pinned keyless reader,
  keyed by the connected address alone, so a wallet on Base Sepolia shows them. The rows go out as one `eth_call`, and a
  refused call keeps the figures already read instead of showing zeros (D4). The wallet keeps resolution, chain checks
  and signing.
- **Not done, by decision.** Resolution while the wallet is elsewhere (D1); `batchSize: 0` inside the SDK (D2); a
  post-mint receipt wait (D3). No lesson promoted: `lessons.md` is at its budget, and #73 owns the SDK fix.
- **Known limits:** #74.
- **Open items:** #73.
- The `/goal` and `/loop` seeds below are retired; they are not instructions.

# balances-1: Ethereum balances on the token list whichever chain the wallet is on

Over the 150-line light target (about 195): the review rules inlined for the implementer, the ledger's traces, the seeds.

## Summary

The token rows and the selected token's Ethereum balance read through the wallet's provider and blank on another
chain (F1, F2). Both move onto the build's pinned keyless reader, keyed by the connected address alone. The rows go
out as one `eth_call` (D2). The wallet keeps resolution, chain checks and signing.

## Requirements map

ask35 → arc a1. Issues: none (no open issue; no `known-limit` issue on balances). **Claims checked.** "As the source-chain balances already are" does not hold: `useSourceChain` reads each token with
its own `readContract` (recon.md); batching them is not this ask. "One batched multicall" did not hold past 28 rows:
viem splits a multicall at 1,024 calldata bytes (D2).

## UI impact

The whole visible budget: **ask35** — *"balances now show where they were blank. No new words."* Surfaces: the token
list's Ethereum rows (`TokenTile` balance, "—" today on another chain) and the amount step's Ethereum balance line.
The amount step's existing check ("That's more than your balance.") now runs with that balance; no words change.
Tapping an Ethereum row while the wallet is elsewhere keeps today's chain message (resolution is unchanged).

## Outcome & Quality Bar

- **For whom**: a testnet user whose wallet sits on Base Sepolia, choosing what to send from the token list.
- **Excellent**: (1) every Ethereum row shows the account's Sepolia balance on any wallet chain, the same figure as
  on Sepolia; (2) a switch of the wallet's chain never blanks or re-reads a row.
- **Good enough**: rows read on the existing triggers (list or account change, mint, finished send); no polling.

## Assumptions

**Facts** (evidence in recon.md)
- F1. `SendWizard.vue:148-153,162-166` read rows and the selected token through `l1.publicClient`, owner `l1Reader`
  (`undefined` while `wrongChain`); `watch(l1Reader)` (line 898) re-reads the selected token.
- F2. `useTokenSelection.ts:182-194` reads the selected Ethereum balance through the client that resolved the token.
- F3. `useEthHeld.ts` and `useSourceChain.ts` already read through `readClientFor`, by address alone: unchanged.
  `readClientFor(11155111)` is the keyless publicnode URL, already in the testnet CSP; no URL or origin is added.
- F4. Multicall3 is at the viem-named address on Sepolia and Base Sepolia (same bytecode, checked live) and on the
  sandbox L1 (`deploy.ts:110-111`, `network.ts:39`).
- F5. Mainnet pins no read RPC and renders only the placeholder (`App.vue:16`): no mainnet surface reads rows.
- F6. Balance keys carry their chain (`logoKeyOf`), so a pinned Ethereum figure never lands on a source row.
- F7. `assertL1Chain` asks the wallet's client; resolution, mint, exit and send keep it.
- F8. `L1WalletPanel.vue:13-15` treats a source chain as signable: no switch prompt shows there.

**Inferences**
- I1. Requests per trigger move from the wallet to publicnode: before, 1 `eth_call` per row read (2 past 28 rows)
  and 1 per selected-token read on the wallet; after, 1 and 1 on publicnode, beside its existing `eth_getBalance`.
  Triggers are user actions only. PublicNode's limits are unknown (none published; 20 parallel calls answered 200).
- I2. A mint's receipt is awaited on the wallet's provider and the refresh reads publicnode. A publicnode backend
  behind that block reads the pre-mint balance, and nothing re-reads until the next trigger; the stale selected
  balance can also refuse the minted amount until the token is picked again. Plausible but unverified: no trace, 40
  samples never showed publicnode behind another keyless Sepolia RPC, and the Ethereum native row has the same
  exposure today. Disposition D3.

**Asks**: none open (D1).

## Architecture & Implementation

- **Reuse**: `readClientFor` and `readErc20Balances` unchanged; `bridgeL1` (`SendWizard.vue:1613`) hoisted and
  reused. No new module; the SDK changes only in a doc comment.
- **One call**: `useRowBalances` hands `readErc20Balances` a fresh `Erc20Client` whose `multicall` forwards to the
  reader with `batchSize: 0` and whose `call` forwards unchanged, beside `MAX_ROWS` (50 rows: about 11 KB of
  calldata). The shared reader is untouched.
- **Interface**: `TokenSelectionDeps` gains `balanceReader: () => PublicClient | undefined`; `loadBalances` and
  `refreshBalances` read through it, and with no reader the Ethereum balance stays unset. `pub` stays the wallet.
- **Flow**: `l1.address` → `useRowBalances({ pub: bridgeL1, owner })` → multicall on publicnode → `TokenStep`. A pick
  resolves through the wallet (chain asserted), then `loadBalances` reads through `bridgeL1`.
- **Not taken**: a wallet fallback where no pinned reader exists (two read paths for mainnet, which has no wizard;
  `lessons.md`: chain facts come through pinned reads); `batchSize: 0` inside the SDK (D2).

## Security & Adversarial Considerations

- **Keys**: none; the reader uses a committed keyless URL and this change adds no URL. The guards' real reach:
  `network-targets.test.ts` pins testnet origins and CSP, `verify:build-target` the built CSP, `node-keys.test.ts`
  keyed dRPC URLs in the tree. None scans the bundle for an arbitrary key.
- **Trust**: a lying RPC can only mis-show a balance and mis-gate the amount check; the chain enforces the transfer.
  The wallet's RPC can do the same today. No guard reads the pinned client's chain as the wallet's (F6, F7). One
  aggregate now carries up to 50 rows: a pasted token whose `balanceOf` burns the call's gas can starve the rows after
  it, which read 0 (plausible, self-inflicted, display only; chunks limited it to 28 rows before).
- **Privacy**: publicnode already sees the address; it now also sees which Ethereum tokens are asked, a pasted one
  included. Testnet only.
- **Supply chain**: no dependency change.

## Phase 1 — Ethereum reads move onto the pinned reader (arc a1) ✓

Steps:
1. In `SendWizard.vue`, hoist `bridgeL1` above `useRowBalances` and delete `l1Reader`. Give `useRowBalances`
   `pub: bridgeL1` and `owner: () => l1.address.value ?? undefined`.
2. Give `useTokenSelection` `balanceReader: bridgeL1` and `l1Account: () => l1.address.value ?? undefined`. Keep `pub`.
3. Replace `watch(l1Reader, …)` with a watch on `l1.address.value` that calls `selection.refreshBalances()`.
4. In `useTokenSelection.ts`, add the `balanceReader` dep and read the Ethereum balance through it.
5. In `useRowBalances.ts`, read through the one-call adapter. In `packages/sdk/src/protocol/erc20.ts`, make the doc
   say one logical `multicall`, which the client may split into several `eth_call`s.
6. Add the tests below. Run lint, typecheck and the touched unit files after each step.
7. Take the after shots with a throwaway `specs/zz-balances-shots.spec.ts` (browser README § Screenshot tours): the
   token step, wallet on the sandbox source chain, light and dark, 1280×900. Save them under the lane's scratch
   directory, never in the repository. Delete the spec before the full run.

Change map: `apps/tools/src/components/send/SendWizard.vue`, `apps/tools/src/composables/useTokenSelection.ts`,
`apps/tools/src/composables/useRowBalances.ts`, their tests, `apps/tools/tests/browser/specs/tokens.spec.ts`, and the
doc comment in `packages/sdk/src/protocol/erc20.ts`.

Tests (the smallest set):
- `SendWizard.test.ts`: rewrite "reads no Ethereum balance on the wrong chain…": with the wallet on another chain
  the row and selection owners stay `L1_ADDRESS`, and the row and balance readers return the pinned client, never
  `l1.publicClient` (never-happens); an account change re-reads the selected token once (control).
- `useRowBalances.test.ts`: 29 distinct rows through the real `readErc20Balances` (`vi.importActual`) on a viem
  client over a counting `custom` transport that answers `aggregate3`: exactly one `eth_call` (never-happens: a
  second) and every row's balance mapped (control). Take the chain from `@/lib/network`, never `viem/chains`.
- `useTokenSelection.test.ts`: one case with distinct clients: both the first load and `refreshBalances` read the
  Ethereum balance through `balanceReader`, and the resolving client's `multicall` is never called.
- Browser cell 37 (`tokens.spec.ts`), at its end: move the wallet to the sandbox source chain, reload, reconnect,
  and assert the USDC tile shows exactly the post-mint figure. The reload forces a fresh read while the wallet is
  elsewhere, so a cached figure cannot pass it. Failure mode: rows blank, or read the wallet's chain. Only a browser
  proves the real reader reaches the L1 node under the app's CSP while the wallet's reads go to another anvil.
  Estimate +10 s on the cell.

**Validation gate**
- Commands: `bun run lint`; `bun run typecheck:all`; `bun run test:all`; `bun run --cwd apps/tools test:e2e`;
  `bun run audit:tools`; `bun run e2e:tools -- specs/tokens.spec.ts specs/drip.spec.ts specs/deposit-token.spec.ts`
  (retries are 0 by default).
- Pass: every command exits 0; the three spec files pass at retry 0; `tokens.spec.ts` wall-clock recorded before (one
  run on the base) and after.
- Layers: lint, typecheck, unit, vitest smoke, build, browser e2e.

## Delivery

One arc, one PR, on `worktree-balances-1` (it carries this plan): `fix(tools): read the token list's ethereum
balances through the build's rpc on any wallet chain`. Merge `origin/main` first (PR #59 edits `SendWizard.vue` and
its test). Body: what and why, gate outcomes, `tokens.spec.ts` wall-clock before and after, the shots' paths,
`Delivers ask35`. The close-out lands as the PR's final commits. No lanes.

## Post-implementation

1. Codex fix loop: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file> <worktree> high read-only gpt-6.1-sol`
   on the arc's diff against its merge base, with this plan, the adversarial ask and the two rules below verbatim. Fix,
   commit, then `~/.claude/skills/codex/scripts/resume-codex.sh <session-id> <prompt-file> <codex-dir> high` with the
   fix diff, until a round has no new material finding; stop after three. One Opus `general-purpose` review runs
   beside round 1. Log rounds in `lessons/phase-1.md` and the ledger.
   - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code works and is clear, leave it alone."*
   - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does, restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have. Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and exact."*
2. Run the gate again on the final head, push, `gh pr create`, then `gh pr checks <n> --watch` (bounded).
3. Close-out (the repository has no `implementations-plan/README.md`, so this list is the standard): the `## Outcome`
   block after the front matter (Status, Shipped with the PR, `Known limits:` for D3, `Open items:`, the seeds
   retired; no calendar date, per `AGENTS.md`); promote a lesson only if one generalizes; file D3 as a `known-limit`
   issue closed as not planned; delete `STATUS.md`; merge `origin/main` and read `archive/index.md` and `lessons.md`; then
   `git mv implementations-plan/balances-1 implementations-plan/archive/balances-1` in its own commit and add one line
   to `archive/index.md`. No row in `implementations-plan/index.md`.
4. After the orchestrator's merge: `agent-worktree done balances-1 --merged`.

## Decision ledger and audit verdicts

- **Codex audit** (gpt-6.1-sol, high): `conditional approve`. Adopted: no switch prompt shows on a source chain, so
  the browser check waits on a reload (F8); cell 37 must force a fresh read, or a cached figure passes with the wallet
  reader still wired; the key guards' real reach; I1 per trigger; the selection test covers load and refresh.
- **D1** (Codex agreed): resolution stays on the wallet. It is not a balance read, and moving it changes what a tap
  does on another chain, which ask35 does not cover.
- **D2** (Codex: Medium, demonstrated, reproduced on viem 2.57.1: 28 rows → 1 call, 29 and 50 → 2): ask35 says one
  batched multicall, so the rows read as one `eth_call`. First draft: a known limit (testnet shows about 9 rows). The
  final pass showed a fix with no SDK contract change, so it is adopted. Where it lives: Codex picked the app adapter
  over `batchSize: 0` in the SDK. The SDK takes unbounded lists, and unchunked, one failing aggregate zeroes every
  balance for every caller; the bound (`MAX_ROWS`) lives in the app; a published behaviour change needs the owner.
  The adapter is a fresh object on the SDK's own `Erc20Client` seam, not a patch of the shared reader.
- **D3** (Codex: Medium, plausible but unverified; it preferred an open issue): post-mint freshness (I2) stays a known
  limit. A receipt wait on the pinned reader adds a timeout and failure policy to the mint path and makes a mint
  depend on publicnode; a read at the receipt's block still needs a retry. Reopen on a user report or an observed
  stale row after a testnet mint.
- **Final fresh Codex pass** (new session): `conditional approve` (D2 enforced; the resume invocation, `<prompt-file>`,
  no `Date`). All adopted; D1 and D3 held. Verification round (resumed): `approve`, no material findings.
- **Deviations in a1.** `useCrossChainSend.ts` changed too: it is a second caller of `useTokenSelection`, and the
  `balanceReader` dep is required. The one-call adapter became `readBalancesOn` in `useEthereumReader.ts`, shared by
  the rows and the selection (D4).
- **Fix loop, round 1** (Codex, new session): `findings: 1`, Low: the `pub` doc said "the wallet's own client", but
  the cross-chain caller passes the pinned reader. Fixed. **Opus review beside it**: Medium (D4), Low (the SDK doc's
  split rule: only `batchSize: 0` stops the split), two nits (a false spec comment; `useSourceChain` repeated the
  owner getter). All fixed in one commit.
- **D4** (Opus: Medium, demonstrated in viem 2.57.1 `multicall.ts`; Codex confirmed 429, 503 and timeouts): with
  `allowFailure: true` a refused `eth_call` comes back as every entry failing, and `readErc20Balances` maps each to
  `0n`, so a publicnode refusal showed every row as 0 and made the amount step refuse every amount. Fix: one helper,
  `readBalancesOn`, sends one call and rejects when an entry's error walks to `CallExecutionError` (only the
  aggregate's own RPC call makes one); the rows keep what they read and the selection leaves `l1` unset. The SDK
  function keeps the same flaw for other callers: filed as an issue at close-out, not changed here (a published
  behaviour change).
- **Fix loop, round 2** (Codex, resumed): `clean`.

## Seeds

Drafts, never run in this program (the orchestrator drives the lane). Recommended: `/goal`.

```
/goal Phase 1 marked ✓ in implementations-plan/balances-1/plan.md, backed by its validation gate reported passing in the transcript, with LESSONS_FILE=implementations-plan/balances-1/lessons/phase-1.md printed; /code-review NOT run (code_review: off); the Codex fix loop on gpt-6.1-sol converged, evidenced by a resumed pass with no new material findings quoted in the transcript; one PR against main opened only after that (gh pr view output in the transcript) carrying the close-out's archive-move commit (git show --stat in the transcript); bun run test:all and bun run lint exit 0 in the transcript.
```

```
/loop 15m Drive implementations-plan/balances-1 forward from plan.md (not the chat): if the plan path is gone and FETCH_HEAD:implementations-plan/archive/balances-1/plan.md exists on origin/main, run agent-worktree done balances-1 --merged and stop; else take the next pending step, run the fast layers after each edit, run the phase gate before marking ✓, then the Post-implementation section in order. Decide with /codex high (gpt-6.1-sol), never merge, never push to main.
```
