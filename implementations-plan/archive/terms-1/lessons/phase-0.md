# terms-1 phase 0: planning log

## E1. Does a mainnet-only dynamic import leave the testnet bundle? (vite 8.2.1, rolldown)

- Today's app: built testnet from `fb90e36` into a scratch directory. The placeholder's text
  ("Bridging is being upgraded") is in `assets/index-*.js`. `IS_MAINNET` comes through
  `resolveToolsTarget()` and does not fold.
- Minimal project, `define` of `import.meta.env.VITE_TOOLS_TARGET`:
  - `const X = import.meta.env.VITE_TOOLS_TARGET === "mainnet"` in the importing module, then
    `if (X) await import("./legal.js")`: testnet emits no `legal-*.js` chunk and has no sentinel;
    mainnet emits the chunk.
  - The same `X` exported from `flag.js` and imported: the dead branch goes, but the `legal-*.js`
    chunk is still emitted into the testnet dist.
- Conclusion: the literal test must sit in the module that holds the dynamic import, and a dist
  content check must prove it on every build.

## Consults

### C-A1. Codex plan audit, round 1 (gpt-6.1-sol, high, fresh session)

Verdict: conditional approve. Nine findings; the disposition of each is in plan.md § Audit verdicts.
Verified in the tree before acting: the journal keeps plaintext `recipient`/`amount` display copies for
private records and plaintext fuel secrets (`bc/journal.ts:9-11,86,116`); invalid entries are parked
under a quarantine key (`journal.ts:445-451`); completed records are pruned after 7 days
(`journal.ts:629-631`).

### C-A2. Same-family Plan audit, round 1 (Opus 5.5, Agent tool)

Verdict: conditional approve. Thirteen findings; dispositions in plan.md § Audit verdicts. Verified before
acting: the pause and sweep powers (`PortalFactory.sol:62`, `token_bridge_hub/src/main.nr:57-63`,
`DepositRouter.sol:190-195`); `new URL("data:").origin === "null"` under Bun; bb.js's `keyval-store` and the
CRS hosts in the testnet chunk `contract-instance-registry-*.js`. Rejected one claim: unused `TESTIDS`
keys are not dropped (`tl-add-token-status` has no caller and ships in `bridge-generation-*.js`), which
confirms Codex's finding 5.

### C-F. Final fresh Codex pass (gpt-6.1-sol, high, new session with the ledger)

Round 1: conditional approve, seven findings, all accepted (plan.md § Audit verdicts). It reproduced that
a `{ updated, digest }` pin passes when only the digest is updated, so that test was dropped. Resumed
round 2: conditional approve, one finding (the Post-implementation `gh pr create` lacked `--draft` for a2);
fixed. Resumed round 3: approve.

## a2 re-plan (wallet-signed acceptance, light)

### E2. viem's `verifyMessage` on Bun (viem 2.57.1)

A `privateKeyToAccount` signature over a text with both document digests: awaited, `verifyMessage` gave
true on the signed text and false on a changed one, and rejected "invalid signature length" on `0x1234`.
`JSON.stringify(TERMS)` is 13,307 bytes and `PRIVACY` 10,977. Run with `bun -e` from `apps/tools`, since a
script outside the workspace does not resolve its packages.

### C-B1. Codex audit of the a2 re-plan, round 1 (gpt-6.1-sol, high, fresh session)

Verdict: conditional approve, eight findings, all accepted but one phrasing point (plan.md § Audit
verdicts). It showed that `Site:` binds a claimed site, not the signing origin, and that `-32002` survives
a reload. Checked before acting: `terms.ts:67` allows dropped and replaced transactions, so "final" in the
draft copy was wrong.

### C-B2. Round 2 (resumed)

Verdict: approve. All eight fixes verified; the cut to a1's completed steps lost nothing a2 needs.

### C-BF. Final fresh Codex pass on the a2 re-plan (gpt-6.1-sol, high, new session with the ledger)

Round 1: conditional approve, four findings, all accepted (plan.md § Audit verdicts): an open tab keeps
asking for the old version after both deploys (G7), the session fallback had no test, a stale Security
line, and the relabelled-old-signature case. It held D12–D17. Resumed round 2: approve.
