# Phase P6 — live redeploy (lessons)

## executed live, user-driven (no per-step confirmation, standing authorization)

Full intent-gated, candidate-first redeploy to the live Sepolia v5 testnet. Total spend
**0.0032/0.5 ETH** (only L1 portal-deploy gas + fuel swaps; every L2 deploy was sponsored).

### Sequence (each fund-moving group preceded by `live-intent verify`)
1. `live-intent build` → intent anchored (signer == plan-pinned `0xFcc2238…`; network identity
   byte-matched the committed 5.0.0-arc intent; startingBalance 8.52 ETH). Committed as the anchor.
2. FPC group: predeploy gate green → `deploy-private-fpc-testnet` (sponsored, canonical salt,
   deployer ZERO → address == pinned `0x1a6d21ce`; class `0x032bc73c`) → `require-deployed` green.
3. Bridge candidate: `deploy-bridge-testnet --reuse-token <AZLO>` → AZLO reused (readback-verified
   AZLO/18 + == live manifest l1.usdc), the forked portal `0x6d614378`, L2 proxy/token/bridge (5-arg
   token), 8 readbacks + the `l2Bridge()==ZERO` init preflight, L1 Etherscan-verified.
4. Faucet candidate: `deploy.ts` (sponsored, faucet .env deployer) → Dripper `0x064399d4`,
   the first faucet token `0x0262b24b`, the second faucet token `0x14e0a251`; `verify-deployments --config` green.
5. `verify --candidate` → bridge digest `910421` recorded + L1 privileged readbacks (incl. the
   feeJuice cross-pin). Intent re-committed.
6. Six canaries (candidate-targeted via `--config`): verify-l1, candidate smoke, fueled smoke,
   **PrivateFPC settle (PRIVATE_RUNS=1 — private pay_fee SETTLED through `0x1a6d21ce`)**, direct-FJ,
   drip. All green.
7. `promote` → require-deployed + faucet-derivation re-proven, bridge bytes == recorded digest,
   zero-seed confirmed, atomic temp+rename of both live files, receipt written.
8. Post-promotion: `verify:deployments` GREEN on live, live drip green, caps 0.0032/0.5.

### War stories / gotchas (for the next reset)
- **Prior-generation journal blocks a fresh start (by design).** `deploy-bridge-testnet` hard-stops
  if `testnet-bridge.journal.jsonl` exists ("pass --from-journal or archive for a clean start").
  The 5.0.0 journal (all 15 steps confirmed; live addresses matched) was ARCHIVED out of the deploy
  path — a 5.0.1 redeploy is a fresh generation (new Noir class-ids → new addresses), NOT a resume.
- **Deploy scratch dirs trip tree-discipline.** The faucet + bridge deploys create untracked
  `aztec-wallet-data/` (LMDB) + `.faucet-deploy-testnet/`. `verify --candidate`'s tree gate flagged
  them. Fixed via `.git/info/exclude` (LOCAL, uncommitted) — NOT `.gitignore`: committing .gitignore
  would move HEAD and RESET the intent's spend baseline, breaking caps reconciliation. The intent
  baseline must survive the whole arc, so never rebuild the intent mid-arc.
- **Faucet deploy needs its OWN deployer credential** (`DEPLOYER_SECRET`/`DEPLOYER_SECRET_KEY` in
  `apps/faucet/.env`) — NOT the bridge `.env`. Tokens are universal-deployed (deployer ZERO), so the
  deploying account only pays sponsored fees; its identity doesn't affect the token addresses.
- **Canaries default to the LIVE manifest** — MUST pass `--config <candidate>` for every
  pre-promotion canary (verify-l1 first ran against the old 5.0.0 portal until re-run with --config).
- **5.0.1 artifacts, live 5.0.0 node** — confirmed correct: the deployed FPC is the 5.0.1 one
  (`0x1a6d21ce`, class `0x032bc73c`); the 5.0.0 FPC `0x257aa870` is ABSENT on-chain. The compat map
  + require-deployed gate green-lit it per the owner ruling. "5.0.0" only ever refers to the live
  node version and the prior-arc intent.
- **Commitlint on P6 commits**: lowercase subject, body ≤100 chars/line — bit two commits.
