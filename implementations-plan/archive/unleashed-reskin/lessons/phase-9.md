# Phase 9 — testnet deploy and cutover

## Authorization (copied before anything was broadcast)
**Q2**, from plan.md § Approval, verbatim:

> The owner answered "Approve" to: *"Do you approve plan v3.1 as shown in the ELI5 (scope, 3 stacked PRs, every user approving the new tokens once, screenshots committed to the plan folder)?"* This approves the visible surfaces listed under Scope, and those the ELI5's "What you will see change" table lists.
>
> It is also the runbook's Q2 authorization for phase 9's scripted testnet deploy:
> - The deploy reads **no** env files (`--no-env-file`).
> - It creates exactly one credential, the throwaway key under A4's exception.
> - Nothing is broadcast to mainnet, and nothing is broadcast to L1.

**A4**, from plan.md § Assumptions, verbatim:

> **A4 — deploy identity.** The owner chose **option T** by answering "Throwaway key (Recommended)" to the option described as: *"The agent generates a random single-use key in the deploy's own shell and never prints it. Least privilege: nothing of value is exposed. Needs your written exception to AGENTS.md's 'keys are never created by an agent', scoped to this one testnet deploy."* That answer is the written exception. It covers this plan's phase-9 testnet deploy only; no other key, network or run.

## How the deploy runs
A wrapper script runs from the repository root:
- It creates a mode-700 `mktemp -d` directory under the gitignored `apps/tools/.tools-deploy-*`, passes its absolute path as `TOOLS_DEPLOY_DATA_DIR`, and removes it on EXIT, INT and TERM.
- It runs `env -u DEPLOYER_SECRET_KEY -u DEPLOYER_SALT -u AZTEC_NODE_URL DEPLOYER_SECRET="$(openssl rand -hex 32)" TOOLS_DEPLOY_DATA_DIR="$dir" bun --no-env-file apps/tools/scripts/deploy.ts --network testnet`.

Nothing prints the secret. The deployer's PXE store, which holds keys derived from it, is written into that mode-700 directory and nowhere else, and the trap deletes it. The tokens are universal deploys (deployer ZERO, fixed salts), so the throwaway account's identity does not enter any address. The account pays through the testnet Sponsored FPC and holds nothing of value.

## Steps
1. **Deploy.**
   - The wrapper exits 0 (`DEPLOY_EXIT=0`). The data dir `apps/tools/.tools-deploy-D0Gs7n` (mode 700) was gone afterwards, removed by the trap.
   - The throwaway deployer account `0x196bd024…83e2ce` was deployed through the Sponsored FPC.
   - The Dripper at `0x064399d4…5815fd` already existed (`[EXISTING]`). SIGNAL deployed at `0x1bde2612…636e74` and NOISE at `0x295d4518…6d4dad`.
   - `deployments.candidate.json` sha256: `3fdd7775690d0385b94ccc9d2263b4727cda98a3874941cabe105945de10ff3a`.
2. **Candidate against the dry run.** `jq -S` of the candidate and of the phase-8 dry-run JSON are identical in every field ("CANDIDATE == DRY RUN").
3. **Verify.** `bun --no-env-file apps/tools/scripts/verify-deployments.ts --config apps/tools/src/contracts/deployments.candidate.json` checks the Dripper, SIGNAL, SIGNAL minter, NOISE and NOISE minter, all OK; `VERIFY_EXIT=0`.
4. **Canary.** `env -u AZTEC_NODE_URL bun --no-env-file packages/bridge-core/scripts/drip-canary-testnet.ts --config …candidate.json` exits 0 (`CANARY_EXIT=0`). It shows `[OK] SIGNAL: 1000000 units landed`, `[OK] NOISE: 1000000000000000000 units landed`, and "✅ DRIP canary PASSED — SIGNAL + NOISE dripped to a fresh account in 0.7m."
5. **Bridge manifests**, before the deploy and after the cutover:
   - `testnet-bridge.json` `ba7ced36ac19c2a7bc721b82e4c1839a75279f78836746c1871be99cf6c044c0`
   - `mainnet-bridge.json` `62123b9a7a213f1a0329ca6943deb8b894d1dc02f5123e0d9166be8ec832e16e`
6. **Cutover.**
   - The candidate was copied byte for byte over `deployments.json` and then deleted, so no duplicate is committed.
   - Consumers switched: `deployments.ts` (lookups `SIGNAL`/`NOISE`, records `signal`/`noise`, `rebuildSignalInstance`/`rebuildNoiseInstance`), `constants/tokens.ts` (symbols and decimals from `FAUCET_TOKENS`, amounts unchanged at 1,000 and 1), `sandbox/drip.ts` (`DRIP_TOKENS = FAUCET_TOKENS`), `useWalletConnection.ts`, `DripView.vue`, `ActivityView.vue`, `Footer.vue`, `capabilities.ts`, the `fee-juice.ts` comment and the tools README.
   - `useDrip.ts` needed no edit: it takes the symbol type from `constants/tokens.ts`. `index.html`'s meta description said "Test USDC and ETH", which was stale, and now names SIGNAL and NOISE. `.env.example` carries no token name; its wallet-name lines belong to phase 10.
   - Tests, fixtures, page objects and specs: a mechanical rename of the token identifiers in 16 files.
7. **Byte pins.** The live sha256 `3fdd7775…ff3a` equals the candidate's. `jq -S .dripper` on the new live file equals the old live one ("DRIPPER RECORD IDENTICAL"). Both bridge manifest hashes are unchanged.

`verify:deployments` on the new live file: all five checks OK.

**Grep gate:** a grep for the old token symbols across the apps and packages returns nothing.

## Gate
- Steps 1–7 above each exit 0, and the grep gate returns nothing.
- PG (`bun run lint`, `bun run typecheck:all`, `bun run test:all`, the jsdom smokes): PASS.
- BG (both builds, `verify:build-target`, no `data:` fonts, `_headers` unchanged, `verify:deployments`): PASS. `verify:deployments` shows `[OK]` for the Dripper, SIGNAL, the SIGNAL minter, NOISE and the NOISE minter.
- `bun run e2e:tools` on the cutover tree: `69 passed (1.2h)`, `E2E_EXIT=0`. The sandbox deployed SIGNAL and NOISE from the catalog, and the drip specs passed.

## Attempts
- **The canary's wallet store.** `EmbeddedWallet.create` without `ephemeral` persists to `./aztec-wallet-data`. The canary run left its throwaway recipient's store there: 15 MB at the repository root, untracked and not ignored, so one `git add -A` would have committed it. That account is not the deployer; it held only the dripped test tokens. The directory was deleted. The canary now creates its own temporary store directory, stops the wallet and removes the directory in `finally`. `ephemeral: true` was tried first and is not enough: the SDK's `openTmpStore` writes durable directories under the OS temp dir and never removes them. The deployer's store, derived keys included, was written to disk: into the mode-700 `TOOLS_DEPLOY_DATA_DIR`, which the trap removed when the deploy exited.
