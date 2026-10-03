# Phase 9 — focused red-team re-audit (final)

Status: ✓ (gate green)

## Method

Three independent adversarial auditors on the changed surface only:
- **Codex xhigh** (session 019f385d-cbfd-7a23-b2bb-b2d58ad3ffaa) — full-surface.
- **Crypto/circuit subagent** — DS collision, field/type edges, sole-consumer, in-circuit re-derivation.
- **Client/cutover subagent** — deleted-path residue, salt leak, L9 downgrade, phishing, cutover durability.
Plus the main agent's own read + the full-stack gate re-run. Report: `audit/security/recipient-commitment/`.

## Verdict

**SHIP-FOR-TESTNET · DO-NOT-SHIP-FOR-VALUE.** All three found **no Critical**. The recipient-commitment
circuit is cryptographically sound — redirect-impossible (protocol enforces `secret_hash` membership;
wrong recipient → wrong derived secret → consume fails), cross-consume-impossible (public/private content
hashes differ), degenerate-recipient-guarded. Codex's nominal "DO-NOT-SHIP" rests on the locked A-1
(generic `tokenPortal`) + a non-theft documented private-fuel item — both already recorded as value-token
hard-blockers (Phase 8). Nothing new blocks the testnet scope.

## The one that mattered — M2 (my own tripwire was broken)

The crypto auditor **proved** `check-sole-consumer.sh` was bypassable: its raw-secret regex
`fn claim_private\([^)]*secret[^)]*:` is line-oriented, but the real signature is multi-line, so it never
matched — a crafted multi-line bearer regression passed the guard (exit 0). The `derive_claim_secret`
presence check also matched the bare `use …` import. **Only `count==2` had teeth.** This is the classic
"the verification exists but doesn't verify" failure (same family as red-team F-003).
- **Fix:** analyse a newline-flattened copy; assert the `claim_private` param list carries `claim_salt`
  and no `secret` substring (catches `raw_secret`); assert `derive_claim_secret(` is CALLED in the
  `claim_private` body (a `(`, not the import) next to its consume.
- **Landed a test:** a `--self-test` mode that rebuilds the exact bearer regression the old guard accepted
  (+ import-only-no-call, + 3-consumers) and asserts rejection. Wired into the Phase 9 gate.
- **Lesson:** a grep-based static tripwire over multi-line source MUST flatten first; and a tripwire needs
  its OWN adversarial test (feed it the regression it's meant to catch) or it silently rots to a no-op.

## Other fixes (each with a test)

- **CX-L1** — `fuel-testnet.ts` private leg was missing `tokenClaimSalt` (F2 guard made it fail-closed
  before signing). Injected a per-deposit salt; `runSwapBridge` echoes it as `tokenSecretHex` and
  `claim_private` re-derives. Verified by `packages/bridge-core` typecheck.
- **CL-L1** — the `TODO seal salt` comment (`useDeposit.ts`) was stale/misleading. Rewrote to the accurate
  invariant (fuel secret claimer-committed → plaintext is privacy-linkage not theft; recovery via
  whole-record backup; envelope carries only the token salt). Pinned by the Phase 8 durability test.

## Relayer deliverable (closed Phase 3's last offline item)

Wrote `packages/bridge-core/scripts/relay-claim-testnet.ts` + the unit-tested pure core
`src/relay-claim.ts` (13 tests: key fail-closed, salt never echoed, salt-v2 refusal, descriptor
validation). Key-handling review: `findings/relayer-review.md`. `assertSaltV2` correctly **refuses the
current live testnet** (`privateClaimMode: undefined`) — usable only after the Phase 6/7 cutover.

## Accepted / deferred (rationale in report.md triage table)

- CX-H1 generic `tokenPortal` → locked A-1, client never sources it from user input, value-token blocker.
- CX-H2/M1 private-fuel plaintext + unsealed fuel salt → claimer-committed (non-theft), Phase 8 documented.
- CX-M2/I1 no uint128 bound → fail-safe strand, faucet caps via `maxWholePerTx`, L1 require = future.
- H1 no-CI (keystone + tripwire) → red-team F-003, split into a separate CI follow-up plan (Phase-0 decision).
- L1/I2/INFO-2/3/4 → non-theft, happy-path-safe, latent-only.

## Gate — all green

| Layer | Command | Result |
|---|---|---|
| L1 fork (HIGH-3 named-leg) | `SEPOLIA_RPC_URL=<public> forge test --match-contract SwapBridgeRouterPermit2ForkTest` | 12 PASS, 0 skipped |
| L2 Noir | `aztec-nargo test` (keystone) | 6/6 |
| A2 tripwire | `check-sole-consumer.sh` + `--self-test` | real upheld; 3 regressions rejected |
| TS unit | `bun run --cwd packages/bridge-core test` | 149 pass (+13 relay-claim) |
| Faucet full | `bun run audit:faucet` | exit 0 (426 tests, verify-deployments matched, build OK) |
| Repo | `bun run lint && bun run typecheck:all` | lint 0; typecheck 8/8 |

## Wrap-up code-review pass (loop terminal step, `/code-review max --fix` in spirit)

The local `code-review` skill is an interactive guided-tour reviewer (no `max`/`--fix` mode); the billed
cloud `ultra` is user-only. So the wrap-up was honoured directly: a rigorous fix-oriented read of the
NEWEST un-audited code — the relayer LIVE wrapper (`relay-claim-testnet.ts`), which was written AFTER the
Phase 9 audit subagents ran and is live-only (untestable offline). Reading it against the proven
`fuel-testnet.ts:110-165` pattern found real wiring bugs that would have failed the first Phase 7 run:

- `createSchnorrAccount` returns a **manager**, not a wallet/account — the original used it directly as
  both the tx `from` and the contract wallet. Fixed: `manager.getAccount().getAddress()` for `from`,
  contracts bound to the `EmbeddedWallet`.
- No account **deploy** step — added the deploy-if-needed gate (`node.getContract(addr)` → sponsored-FPC
  deploy, fixed `Fr.ZERO` salt for a deterministic persistent-relayer address).

**Lesson:** code written after the audit fan-out completes escapes the audit — review the diff's tail
(post-audit commits) explicitly. Live-only scripts get their ONLY validation from a static read against a
proven sibling; do that read deliberately, don't assume typecheck+lint covers runtime wiring. A codex
xhigh pass on the corrected wrapper is the final insurance (it can't be integration-tested until Phase 7).

## Toolchain note

`nargo`/`forge` are installed (Phase 0) but not on the non-interactive shell PATH. Reach them with
`export PATH="$HOME/.foundry/bin:$PATH"` (forge) and the rc.2 aztec PATH (`$HOME/.aztec/versions/5.0.0-rc.2/{bin,node_modules/.bin}`)
for `aztec-nargo`. The public Sepolia RPC (`ethereum-sepolia-rpc.publicnode.com`) needs no key for the fork legs.
