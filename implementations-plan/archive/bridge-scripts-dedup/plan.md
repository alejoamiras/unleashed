# bridge-scripts-dedup — arc 2 of the complexity-budget burn-down

**Mechanical arc (no blueprint tier)** — commissioned by the burn-down goal via an earlier plan, lead 4. One batched PR into the base branch.

## Outcome

Archived. Seeds retired.

`packages/bridge-core/scripts/` held 31 baseline complexity directives across 14 files and 61 jscpd clones (687 dup lines, 9.8%). This arc removed **16 directives (manifest 219 → 203)** — all 8 on the deploy/smoke testnet↔mainnet siblings, plus fee-juice-canary (2), smoke-swap (2), and fuel-testnet (4, including the nested `runVariant` pair beyond the committed scope). 15 directives remain in the dir (live-intent ×6, deploy-sandbox, deposit-testnet, discover-mainnet-fuel ×2, fpc-dust-canary, check-fpc-version ×2, relay-claim ×2) — arc-3/residue territory.

## ⚠ Mechanism deviation from the commissioning text — owner sign-off requested

The goal prescribed: *"parameterize the testnet↔mainnet twins into shared modules with a network parameter."* Recon disproved the premise: the pairs are **deliberate policy siblings, not near-clone twins** — deploy-bridge-mainnet's own header says "the testnet conductor stays untouched (battle-proven mid-arc)", and the deltas are semantic (Circle-USDC reuse vs token deploy; claim-in-tx vs SponsoredFPC; broadcast staging groups; different flags/env). jscpd showed only 95/1100 (deploy) and 103/613 (smoke) shared lines; a unified diff touches ~727/~337 lines. A single dual-network conductor would be a mega-config with optional `l1Only`/sponsored-fee/token-deploy/redirect-proof/claim-secret hooks — worse than the duplication.

**Dual-position adjudication** (codex session `01a05a55-aee7-7c52-b751-dfcb9acc4967`, position formed independently before seeing mine): both models independently chose the same alternative — keep four network-specific conductors, decompose each at its stage seams, extract only invariant mechanisms into tested shared modules, with parameters describing the *operation*, never a broad `network` switch. Codex flagged (and this record honors) that overriding the prescribed mechanism needs owner sign-off: **the PR is held un-merged until the owner ratifies the deviation** (outcome scope — dedupe + ~13 suppressions + one PR — is met; a twin-merge could still be layered on later as its own arc if wanted).

## What was built

- **Shared modules** (colocated tests where logic warrants): `scripts/script-artifacts.ts` (foundry artifact loaders), `scripts/script-l1.ts` (`ERC20_MIN_ABI`, `assertSame`, router-witness + portal-initializer preflights, `retryOnRevert`, `ensureRouterPermit2`, `depositViaRouter`), `scripts/script-l2.ts` (`universalDeployInstance`, manifest contract/trio registration, `claimTokensUntilSynced`, fresh/deployer Schnorr accounts, `sponsoredFpcFee`, `deployAccountIfAbsent`), and `journaledEvmDeploy` added to the already-tested `deploy-manifest.ts`. The four hand-rolled `nargoArtifact` copies now use `src/artifacts` (same JSONs).
- **Per-file stage decomposition**: both deploy conductors split at their `─── N ───` seams (resume gate / token / portal+init / FJ deposit / L2 group / read-backs / candidate write) preserving journal write ordering, resume semantics, and every preflight; the smokes and canaries split into lane/stage functions.
- **Accepted console/diagnostic-text deltas** (operator-facing only, no programmatic consumer): `retryOnRevert`'s message unified to the testnet wording; smoke-swap gains per-contract "registered" lines; two "deployed" log lines appear on paths that previously logged only "deploying"; mainnet's portal no-contractAddress error now names the forked portal (was "portal:"); mainnet's router read-back label lost the "== FUEL_SWAP" suffix; mainnet's claim-timeout error gained "L1→L2"; deploy-testnet fetches node_getNodeInfo once for registry + l1 addresses (was twice). Everything else — error identities, journal entries, on-chain call order, resume gates, preflights — preserved verbatim.

## Gates

bridge-core suite 283 passed (14 new `it()` cases across the helper tests, including codex-round-2's targeted fakes for `depositViaRouter` forwarding/approval-ordering, `registerManifestTrio` reconstruction order, `claimTokensUntilSynced` selection, and `deployAccountIfAbsent`) · `bun run typecheck` (scripts tsconfig) · root `bun run lint` + baseline check · `test:ci-gating` 64/64 · `audit:vue` — all green. The conductors themselves have no test harness (live-network scripts); validation is typecheck + review + the shared-helper tests, per the adjudication ("never validate by broadcasting").
