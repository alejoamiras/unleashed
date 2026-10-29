---
plan: mainnet-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: audited (final Codex pass: approve); awaiting the orchestrator's approval and the owner's answers (OWNER-ASKS M1–M7)
base: main fb90e36
budget: "recon: 2 Sonnet explorers; code-review: off; Codex gpt-6.1-sol at high"
---

# mainnet-1: the gas-only mainnet app, Drip on mainnet, and links between the two apps

## Summary

Replace the mainnet placeholder with the app's own shell on a network that has a fuel route and no token route: the
user buys Fee Juice for the connected Aztec account from Ethereum, with AZTEC or any token LI.FI swaps to it, public
or private, through sdk-1's fuel flow. Make the Drip catalog deployable on mainnet (the owner's keyed step) and then
offer Drip there with its zero-value labels. Link each app to the other. Every screen is an `OWNER-ASKS.md` entry;
every deploy is the owner's.

## Requirements map

| Item | Arc | Note |
|---|---|---|
| ask8 | a1 | Visible on mainnet only after the owner promotes the mainnet fuel route (R1). |
| ask9 | a2 (deploy tooling and runbook), a3 (the app) | a3 starts after the owner's deploy is read back (R2). |
| ask10 | a1 (both links), or a1 plus a4 | a4 exists only if the owner holds the testnet link until mainnet opens (M6). |
| Issues | none | No open issue; closed known limits: only #27, unrelated. |

## UI impact

The recorded owner decisions are the whole visible budget:
- **P1-12**: "the token bridge is offered on testnet only; the mainnet app offers only the gas flow."
- **P1-09**: "the Cloudflare login wall in front of the mainnet hosts comes down when mainnet opens; opening it is the
  owner's dashboard step."
- **P3-04**: "mainnet's canonical rollup already runs Aztec 6, the SDK's line; an older 5.0 rollup still runs but is
  no longer canonical."
- "No screen of this lane is decided yet: layout, copy and placement go to `OWNER-ASKS.md`."

Per arc: a1 changes the mainnet app (M1–M4) and adds a link to each app (M6); a2 changes no screen; a3 changes the
mainnet Faucet (M5). Testnet changes only by M6's link.

## Outcome & Quality Bar

**For whom.** A person with an Aztec wallet and an Ethereum wallet who needs Fee Juice on Aztec mainnet and holds
AZTEC, USDC or another token, often on a phone; a tester who wants worthless mainnet tokens; the owner, who opens
mainnet and runs the deploys.

**What excellent looks like.**
- A mainnet gas send goes from token to settled claim with the same stepper, journal, recovery and backups as
  testnet; a reload or a closed tab never loses a claim.
- No mainnet screen offers a token bridge, an exit, a cross-chain source or a testnet-only control, and the mainnet
  build fails if its manifest ever carries a token route (P1-12 enforced, not remembered).
- Every surface of ours that shows SIGNAL or NOISE on mainnet says they have no value; the Faucet says each mint
  costs real Fee Juice.
- The owner runs the Drip deploy as one re-runnable command: it never pays twice, never funds a non-canonical
  rollup, and resumes after a crash at any point.

**Good enough.** Ethereum is the only source chain. English only. No USD figures or reference price. The production
mainnet bundle is not browser-tested (it refuses localhost by design); the mainnet-profile local bundle stands in.

## Assumptions

### Facts (verified at fb90e36 unless named; lines and search trails in `recon.md`)

- F1. The canonical mainnet rollup is 6.0.0 (version 2070860440, portal `0x5343…f3b3`); `main` pins the 5.0.1 one.
  sdk-1's branch re-pins it (`45f73f6`) and `aztecLineOf(1)` then names the 6.0.0 descriptor (`bf8b0cf`); its
  `OWNER-ASKS.md` §3 still says mainnet runs 5.0.1.
- F2. The mainnet build renders the placeholder only (`App.vue:16`), with no node, no read RPC and
  `connect-src 'self' data: blob:`; `main.ts:35` skips the node probe there.
- F3. Sections are static (`useShell.ts:8`); every no-bridge state hangs on `IS_PLACEHOLDER`
  (`bridge-generation.ts:31`), which a fuel-only manifest also sets.
- F4. The gas lane sends to the connected Aztec account (`SendWizard.vue:295`) and writes the record the journal,
  Activity, receipt and recovery read (`lib/send-record.ts:59-86`).
- F5. Base, Arbitrum One and OP Mainnet are sources into chain 1 (`source-chains.ts:33-35`).
- F6. The shell requests the drip and SponsoredFPC scopes on every network (`useWalletConnection.ts:100-114`,
  `capabilities.ts:221-231, :307-311`).
- F7. Drip: SIGNAL (salt 4246), NOISE (4247), the Dripper (1337), deployer zero; the mainnet dry-run derives the
  testnet addresses, so `deployments.json` serves both; nothing is deployed or class-published on mainnet 6.0. Toasts
  (`TokenCard.vue:133, :168`) and "Add to wallet" (`useAddDripToken.ts:48`) also show the tokens.
- F8. `deploy.ts` pays mainnet deploys from public Fee Juice (`:341-348`) and skips a published instance without an
  initialization check (`:245-249`). Fee Juice has no L2 transfer; `fee-juice-canary-testnet.ts --fresh-selfpay`
  (`:223`) is the claim-and-deploy shape, and its `assertManifestIsLive` (`:68`) checks the portal against the node.
  The canonical portal accepts any caller's deposit for any recipient and secret hash.
- F9. The Fee Juice portal's `DepositToAztecPublic` indexes `to`.
- F10. Keyless `aztec-mainnet.drpc.org` (6.0.0) and `ethereum-rpc.publicnode.com` accept CORS from the mainnet host.
- F11. On terms-1's branch: `privacy-providers.test.ts` pins the Policy's rows to every origin `MAINNET_TARGET`
  reaches; `legal-dist.ts` refuses legal URLs in a testnet dist; the legal links ride `App.vue`'s literal fold.
- F12. Workers Builds runs `build:mainnet` without `verify:build-target` (`wrangler.mainnet.jsonc:2`).
- F13. sdk-1's `fuelRoute.fuel` has no `fjPerTx`, which the public gas review prices from (`SendWizard.vue:710-735`).

### Inferences (each settled where named)

- I1. After sdk-1 a3, the app builds a `Network` only when the manifest has a route, and its `bridge` is absent on a
  fuel-only manifest. Settled by 1.1.
- I2. Whether a route exists is known synchronously from the manifest's shape (`parseNetwork` is async). Settled by
  1.1; the predicates read the manifest, not the parsed `Network`.
- I3. sdk-1's sandbox conductor can deploy a fuel route on the browser sandbox (sdk-1 1.3). Settled by 1.4.
- I4. Some wallet that speaks `@aztec-labs/wallet-sdk` accepts the 6.0 mainnet chain (2070860441); the wallet keeps
  its own copy of the identity. A precondition of R3, not of any merge.

### Asks

Owner (`OWNER-ASKS.md`): M1 mainnet before its route is live · M2 the mainnet shell · M3 the gas wizard · M4 the legal
links and the Privacy Policy rows · M5 the zero-value wording, including toasts and "Add to wallet" · M6 the links
between the apps · M7 the Drip deploy's budget and funding key. Orchestrator (coordination, recommended owner sdk-1):
C1 the mainnet identity re-pin lands with sdk-1 a1 (done on its branch); C2 `fjPerTx` in `fuelRoute.fuel` and a
mainnet calibration step in branch F; C3 sdk-1 §3's stale premise. 1.1 asserts C1 and C2 and stops if either is
missing on `main`.

## Architecture & Implementation

### Proposed architecture

One app. Token features gate on what the network offers; product choices gate on the mainnet profile. New module
`src/lib/network-routes.ts`, computed from the manifest's shape:

```ts
export const HAS_ROUTE: boolean        // the manifest has a fuel route or a token route
export const HAS_TOKEN_ROUTE: boolean  // the manifest has a `bridge` block
export function sectionsOn(o: { tokenRoute: boolean; faucet: boolean }): readonly Section[]
```

- `IS_MAINNET` (`network.ts:69`) becomes `target.key === "mainnet" || target.mainnetProfile === true`;
  `LocalTargetConfig` gains the optional `mainnetProfile`, set only by the browser suite's mainnet-profile bundle. Every
  existing mainnet branch (copy, the "Ethereum" label, Drip's wallet-paid fees) then runs on the sandbox.
- `App.vue`: the mainnet build (terms-1's literal `MAINNET_BUILD` fold) mounts the shell when `HAS_ROUTE`, else the
  placeholder; the legal row is a mainnet-only component behind the same fold, so no testnet dist carries its URLs;
  terms-1's acceptance gate, when present, wraps both. A promoted manifest is the switch: no flag, no variable.
- `IS_PLACEHOLDER` means `!HAS_ROUTE`; bridge-only consumers (token lanes, exit lane, hub registration, hub rows) read
  `HAS_TOKEN_ROUTE`. `RailNav` and `syncShellWithUrl` take `sectionsOn`; a hidden section's path falls back to the
  first section, as an unknown path does today.
- Faucet availability (`faucet`: `!IS_MAINNET` in a1, always in a3) gates the Faucet section, the drip capability
  scopes and the Drip contract registration; the SponsoredFPC scope follows `!IS_MAINNET`, the same condition as
  `useDrip`'s fee path.
- The wizard on a network without a token route: gas lane only, Ethereum only, no exit; screens per M3.
  `useTokenCatalog` lists AZTEC and the community list whenever a fuel route exists.
- `MAINNET_TARGET`: the keyless dRPC node, PublicNode for chain 1, and `connect-src` with those, the li.quest origin
  (equal to the SDK's `LI_QUEST_API`) and the token-list CDN; `main.ts` probes the node on every target.
- P1-12 in the build: `makeToolsConfig` throws for the mainnet target when the manifest has a `bridge` block, so CI
  and Workers Builds both fail.

The gas send itself is sdk-1's `depositFuel` and `claimFuel` under the journal engine. Rejected: a separate gas
page (Outline B, D2). Trade-offs: the ledger.

### Data and control flow (the Drip deploy, a2)

`bun run --cwd apps/tools deploy:mainnet [--fund <FJ>]`, the same command at every re-run:
1. Check the destination: the manifest portal equals the node's `feeJuicePortalAddress`, equals the portal of the
   pinned Registry's `getCanonicalRollup()` read over L1, whose version equals `MAINNET_ROLLUP_VERSION`; the asset
   equals the portal's `UNDERLYING()`.
2. Work out what is left: the account's initialization nullifier, each catalog instance's initialization, and the
   public Fee Juice balance. A fully deployed catalog returns here, approving and depositing nothing.
3. Scan, pinned to one L1 block B: the portal's `DepositToAztecPublic` logs with `to` = the deployer, from a start
   block pinned in code (the canonical rollup's deploy block) to B, kept only when the transaction was sent by M7's
   pinned key directly to the portal with calldata matching the event (anyone can deposit under a copied secret
   hash). Match each `secretHash` against the seed-derived secrets n = 1, 2, … and read its nullifier
   (`siloNullifier(FeeJuice, computeFeeJuiceMessageNullifier(key, secret))`). An unconsumed match is resumed.
4. Fund only a shortfall: no unconsumed match, `--fund` given, and the account uninitialized or its balance below the
   next send's maximum fee. Refuse when the signer's nonce at B differs from its pending nonce (a deposit may be in
   flight), when the amount is above M7's cap or below the bootstrap claim's cost, or when the signer is not M7's pin.
   Approve the exact amount; deposit under the next unused derived secret; print the hash at broadcast.
5. Claim only when step 3 recovered, or step 4 created, an unconsumed deposit: claim-and-deploy the account if it is
   not initialized (the `--fresh-selfpay` shape of `fee-juice-canary-testnet.ts`), else in a carrierless
   transaction. Otherwise go straight to step 6.
6. Deploy what is left of the Dripper, SIGNAL and NOISE; a published, uninitialized instance is initialized. Each send
   prints its fee; a short balance stops before the next send, and a re-run with `--fund` tops up. A fee spike that
   outruns a funding is a known limit: the runbook says to wait or fund again by hand.

### File-level change map

| Arc | Files |
|---|---|
| a1 | new `src/lib/network-routes.ts` + test; `lib/network.ts`, `lib/network-targets.ts` + test, `local-target-loader.ts`; `vite.config.ts` (the P1-12 throw) + test; `App.vue`, `App.test.ts`, `main.ts`; `useShell.ts`, `RailNav.vue`, `AppShell.vue`; `useWalletConnection.ts`, `lib/capabilities.ts` + test; `SendWizard.vue`, `ChoiceCards.vue`, `useSourceChain.ts`, `useTokenCatalog.ts`; `SendView.vue`, `ActivityView.vue`, `AddressesView.vue`, `BridgeFooter.vue`; a mainnet-only legal-row component; `packages/legal/src/privacy.ts` (rows, M4 text); `tests/browser/` (the bundle, one spec); `apps/tools/README.md`; `lib/testids.ts`; `.claude/skills/bridge-generation/SKILL.md` (one line, the rollup switch) |
| a2 | `apps/tools/scripts/deploy.ts`, `deploy-config.ts` + tests; `packages/bridge-core/scripts/fee-juice-l2.ts` (the canary's deposit and self-pay claim, lifted) and the canary; one sandbox integration test; `apps/tools/package.json`; new `apps/tools/mainnet-faucet.env.example`; `SKILL.md` (one section); `UPDATE.md` |
| a3 | `network-routes.ts` (`faucet` always); `capabilities.ts`, `useWalletConnection.ts`; `DripView.vue`, `TokenCard.vue`, `AppShell.vue` (Faucet header), `ActivityView.vue`, `AddressesView.vue`, the "Add to wallet" control per M5; `MintFeeAssetCard` gating; tests; one browser cell |

## Security & Adversarial Considerations

- **Threat model.** A hostile LI.FI answer, a lying node or RPC, a phishing clone, a mainnet manifest edited to carry a
  token route, scams selling SIGNAL or NOISE, a compromised dependency in the deploy process. Assets: funds in
  flight, claim secrets, the owner's L1 key, the Drip deployer key.
- **Funds.** Only sdk-1's flows move user funds (persist before every prompt, LI.FI pins, the router's checks, trust
  roots independent of the manifest); this lane adds no signing path in the app. Known limit, sdk-1's domain: the
  floor is LI.FI's own estimate, with no reference price.
- **P1-12** holds in the build (D9); token lanes hide on any network without a token route.
- **CSP and links.** Mainnet's `connect-src` names exactly the node, the read RPC, li.quest and the token-list CDN,
  pinned by `network-targets.test.ts` and terms-1's provider test; no key in the bundle (`node-keys.test.ts`);
  `frame-ancestors 'none'` stays; cross links come from `TARGETS[…].host`.
- **Least privilege.** No drip or sponsor scope on mainnet before a3, then the three exact Drip addresses.
- **Drip.** Permissionless mints cost the minter real Fee Juice. On-chain names cannot carry a label, so the labels
  live in our surfaces and "Add to wallet" is an owner choice (M5).
- **The deploy.** An owner-approved keyed run only: a Registry-anchored destination, exact approval, M7's key and cap,
  L1 as the ledger (D7), the hex deployer key pair only (the salt-zero `DEPLOYER_SECRET` fallback refused on
  mainnet). No secret is printed, written or put on a command line.
- **Known limit.** A canonical-rollup switch makes `main.ts` refuse the page while claims are pending; a runbook
  line says to pause the gate before a scheduled switch.
- **Supply chain, cryptography.** No new dependency; funding secrets use `@aztec-labs/foundation` Poseidon2 with a
  fixed domain tag, as `deriveBridgeSecret` does; a public claim is bound to its recipient (`fuel.ts:38-41`).

## Phases

Every gate includes `bun run lint`, `bun run typecheck:all` and `bun run test:all`, all exit 0, unless it says
otherwise. "Both builds" means, from `apps/tools`, `bun run build:testnet && bun run verify:build-target testnet`, then
`bun run build:mainnet && bun run verify:build-target mainnet`. "Browser suite" means `bun run e2e:tools`, every cell
green, the touched specs at retry 0, the wall-clock before and after recorded for the PR body.

### Arc a1: the gas-only mainnet app and the links

Starts when sdk-1 a3 and a4 and terms-1 a1 have merged and M1–M4 and M6 are answered.

**1.1 Re-map and preconditions.**
1. Merge `origin/main`. In `lessons/phase-1.md`, map each file of the change map to its merged form.
2. Assert on `main`: the whole mainnet identity is the canonical 6.0 rollup's (rollup version, wallet chain id,
   portal, asset, the PrivateFPC descriptor and `aztecLineOf(1)`; C1); the `fuelRoute.fuel` schema has `fjPerTx` and
   branch F calibrates it (C2); I1 and I2 hold. A promoted mainnet route (R1) is not a precondition. If any assertion
   fails, stop the arc and report it.
- Gate: base commands; both builds. Layers: typecheck, lint, unit, build.

**1.2 The mainnet target.**
1. `network-targets.ts`: the node, read RPC and `connect-src`. `main.ts`: probe on every target. `README.md`
   § Production build + hosting: the mainnet host model.
2. `packages/legal/src/privacy.ts`: the provider rows, with M4's approved text.
3. `vite.config.ts`: the P1-12 throw.
4. Tests: `network-targets.test.ts` (exact mainnet `connect-src`; li.quest equals `LI_QUEST_API`); the guard throws
   for a mainnet manifest with a `bridge` block and passes the real one; `privacy-providers.test.ts` passes.
- Gate: base commands; both builds. Layers: unit, build.

**1.3 The shell on a fuel-only network.**
1. Add `network-routes.ts`; re-point the bridge-only consumers of `IS_PLACEHOLDER`; the `mainnetProfile` field.
2. `App.vue` and the legal-row component; `useShell`/`RailNav` take `sectionsOn`; capabilities and registration follow
   the faucet.
3. The wizard, catalog, sources, footer, Activity and Addresses per M2–M4.
4. Tests: `network-routes.test.ts` (each route combination); `App.test.ts` (mainnet with a route mounts the shell,
   without one the placeholder, testnet the shell; with terms-1's gate present, a cold load of each mainnet section's
   path shows the gate first); the connection manifest on the mainnet profile has no drip or sponsor scope and keeps
   FeeJuice and PrivateFPC, on testnet it is unchanged; `SendWizard.test.ts` on a fuel-only fixture (gas lane only, no
   exit, Ethereum only); `useTokenCatalog.test.ts`. Re-point the tests that pin the old placeholder states.
- Gate: base commands; `bun run audit:tools`; both builds (terms-1's `legal-dist` rule). Layers: unit, build.

**1.4 The mainnet-profile browser bundle.**
1. Confirm I3. Turn sdk-1's `/lifi/` local bundle into the mainnet profile (`bridge: null`, the sandbox's fuel route,
   the LI.FI venue, `mainnetProfile`) if sdk-1's LI.FI cells pass on it unchanged; otherwise add `/fuel/` beside it.
   Declare any new handle field in `sandboxHandleSchema` (lessons: zod drops undeclared keys).
   The profile manifest also drops `feeJuice.feeAssetHandler`, as mainnet has none.
2. `specs/deposit-gas-mainnet-profile.spec.ts`, one cell: a private send of a swapped token settles into PrivateFPC
   credit, with the rail and wizard as M2 and M3 say. Failure caught: a path bound to the hub or the token route
   throws during connect, send or claim on a network without one; no unit test drives wallet, send, journal and claim
   together. A public gas send must also run on a `bridge: null` bundle: sdk-1's public LI.FI cell on the converted
   `/lifi/`, or, in the `/fuel/` fallback, the same scenario as a second cell here. Estimate 80 s a cell; measure.
- Gate: base commands; `bun run lint:actions && bun run test:ci-gating` (a new spec joins a shard); the browser
  suite. Layers: unit, e2e.

**1.5 The links.** One link in each shell to the other app's host from `TARGETS`, per M6; if M6 holds the testnet
link, its half moves to a4. Tests: each `href` equals the other target's `https://<host>`.
- Gate: base commands. Layers: unit.

**1.6 Pictures and the draft PR.** Capture every changed screen from the mainnet-profile bundle, the legal row from
the mainnet dev server (`vite --config vite.mainnet.config.mts`, as terms-1 P5), and the testnet link from the local
bundle, at 1280 and 390 px, light and dark, into `implementations-plan/mainnet-1/design/` (gitignored). Claim ports
with `apps/tools/scripts/e2e/resolve-ports.ts`; tear down by process group.
- Gate: `bun run audit:tools && bun run test:all && bun run e2e:tools`; both builds.

### Arc a2: the Drip deploy on mainnet (after sdk-1 a1 merges; no screen)

**2.1 The funding and the deploy.**
1. Lift the canary's deposit and its `--fresh-selfpay` claim into `scripts/fee-juice-l2.ts`; the canary imports it.
2. `deploy.ts --network mainnet`: the six steps of the Drip-deploy flow above; the hex key pair only.
3. Unit tests (`fund.test.ts`, `deploy-config.test.ts`): the mainnet config derives `deployments.json`; a destination
   mismatch, another signer, an amount above the cap or below the bootstrap cost, and a nonce that moved since B each
   refuse before any send; an unconsumed matching deposit is resumed and blocks a new one; a log from another
   emitter, another sender or another secret hash never matches; a fully deployed catalog deposits nothing; a
   published, uninitialized instance is initialized.
4. `packages/bridge-core/test/integration/deployer-funding.integration.test.ts` on the sandbox: a fresh deployer is
   funded; the run is killed after the deposit mines, and the re-run claims-and-deploys without a second deposit; it is
   killed after the claim, and the re-run sends neither a deposit nor a claim; with catalog work left and a balance
   below the next send's maximum fee, a second funding tops up through a carrierless claim; the run then completes,
   and a last re-run sends nothing. Estimate 3 min; measure.
- Gate: base commands; `bun run audit:tools`; `bun run --cwd packages/bridge-core test:integration`. Layers: unit,
  integration.

**2.2 Scripts, template, runbook.**
1. `apps/tools/package.json`: `deploy:mainnet`, `deploy:mainnet:dry`. `mainnet-faucet.env.example`: the deployer key
   pair, the funding key, the L1 RPC and `DRPC_API_KEY`, as names and the owner's 1Password references, no values.
2. `SKILL.md` § "Drip catalog on mainnet": preconditions (the 6.0 identity on `main`, M7, the owner's go); the dry run
   and address equality; the keyed run, re-run until it reports the three instances initialized;
   `verify:deployments`; a `node_getContract` readback; the first drip from the owner's wallet after a3.
- Gate: `bun test scripts/ci-cd/doc-links.test.ts`; base commands. Layers: lint, unit.

### Arc a3: Drip in the mainnet app (after a1 merges and R2 is read back)

**3.1 The Faucet on mainnet.** `faucet` true everywhere; the mainnet capability manifest adds exactly the three Drip
scopes; `MintFeeAssetCard` renders only where a fee-asset handler exists; the M5 labels on each surface, toasts and
"Add to wallet" included. Tests: the manifest delta; each M5 surface renders its label under the mainnet profile and
no testnet-only copy; `MintFeeAssetCard` is absent on the profile bundle; `useDrip` sets no sponsored fee there. Browser cell in `drip.spec.ts` on the mainnet-profile
bundle: a drip paid from the wallet's own Fee Juice settles and its toast carries the label. Failure caught: the
unsponsored path or its capability set fails; only a real wallet send proves it. Estimate 40 s; measure.
- Gate: base commands; `bun run audit:tools`; the browser suite (`drip.spec.ts` at retry 0).

**3.2 Pictures, draft PR, close-out.** As 1.6, for the Faucet; then the close-out (Post-implementation).

### Arc a4 (only if M6 holds the testnet link)

One commit with 1.5's testnet half and its test; the orchestrator merges it after the owner opens mainnet.

## Owner's release steps (named here, never run by a lead)

- R1. sdk-1 branch F: deploy, verify, calibrate (C2) and promote the mainnet fuel route; its promotion makes a1 live.
- R2. The Drip deploy through a2's runbook section, within M7's budget.
- R3. Open the Cloudflare Access wall (P1-09), after terms-1 a2's agree screen wraps the shell and a wallet accepts the
  6.0 mainnet chain (I4).
- R4. After each merge that deploys, open the mainnet hosts in a browser logged in through Access.

## Decision ledger

- **D1 Build on sdk-1's merged app.** a1 after sdk-1 a3 (send lanes, LI.FI client) and a4 (claim lanes), and after
  terms-1 a1 (`packages/legal`, the fold). Planning against today's composables would edit code sdk-1 deletes.
- **D2 One shell (Outline A) over a gas page (Outline B).** B: a page on `@unleashed/sdk/fuel` with its own record
  store; for it, no testnet code in the mainnet bundle. Rejected by all three reviews: it duplicates the journal,
  recovery, backups, Activity and receipt, where claims are kept safe across reloads.
- **D3 Token features gate on routes; product choices on the mainnet profile.** Codex and Opus showed that the
  routes alone leave the mainnet copy, the unsponsored drip and the owner's pictures untested; the profile flag on the
  local config reuses the existing `IS_MAINNET` branches instead of adding per-feature flags.
- **D4 C1–C3 are coordination asks.** Opus: a fallback edit in 1.1 would change another lane's gate; sdk-1 already
  re-pinned on its branch. 1.1 asserts.
- **D5 a2 (tooling) before a3 (app).** The app cannot offer Drip before the contracts exist, and the deploy needs the
  merged tooling. a2 needs only sdk-1 a1's pin (Opus), so ask9 does not wait for the SDK interface.
- **D6 Both links in a1.** One owner page; a4 only if the owner times the testnet link.
- **D7 L1 is the funding ledger.** Opus's scan by `to` with seed-derived secrets over Codex's numbered funding with
  resume by hash: the scan never pays twice and has no "crash before the hash" gap, and it adds no state. The final pass
  added: fund only a shortfall, authenticate candidates by sender and calldata, and pin the scan to one block with the
  signer's nonce. Rejected: a stored claim file; a `live-intent`
  faucet scope (a new lifecycle for one deploy; the owner's keyed-run approval binds the command).
- **D8 Browser coverage.** One new a1 cell and one a3 cell on the mainnet-profile bundle (Opus); a public gas send
  runs on a `bridge: null` bundle in either arrangement (final pass); gating is proven in unit tests.
- **D9 P1-12 in the build, not in the verifier.** Opus: Workers Builds never runs the verifier (F12).

Recorded while implementing a2 (the tree won where it disagreed with the plan):

- **D10 a2 ships first and carries this plan.** Delivery gave the plan commit to a1, which still waits on sdk-1 a3 and
  a4; a2 needed only sdk-1 a1 (#33), so it opens the lane's first PR from `worktree-mainnet-1`.
- **D11 Claim-and-deploy is aztec.js's self-paid account deploy, not the canary's `--fresh-selfpay` shape.** On the
  embedded wallet that shape (`BatchCall([])` from an undeployed account) fails on the account's signing-key note
  (archived `bridge-permit2-recipient-commitment`, `lessons/phase-10-aztec-5.0.1-merge.md`). The deploy sends the
  account's `DeployAccountMethod` from `NO_FROM` with `FeeJuicePaymentMethodWithClaim`, which aztec.js routes through
  the new account's entrypoint. Its explicit limits, `ACCOUNT_CLAIM_DEPLOY_GAS`, were measured on the 6.0.0 sandbox
  (742,498 L2, 864 DA) with `PUBLIC_FUEL_CLAIM_GAS`'s ~2.3× margin. The canary imports the lifted deposit and the
  carrierless claim; its `--fresh-selfpay` flag is unchanged.
- **D12 The flow lives in bridge-core.** `scripts/drip-deploy.ts` (catalog, sends, the run) and
  `scripts/deployer-funding.ts` (secrets, the authenticated scan, `decideFunding`, the pins), exported as
  `@unleashed/bridge-core/drip-deploy`, so the sandbox integration test runs the code the owner runs; `deploy.ts`
  wires the keys, flags and manifest. Unit tests are `deployer-funding.test.ts`, `drip-deploy.test.ts` and
  `deploy-config.test.ts` (the plan named `fund.test.ts`). Testnet and the local network share the catalog path, so a
  published, uninitialized instance is initialized there too, and `deployAccountIfAbsent` replaces
  `ensureAccountDeployed`.
- **D13 The scan starts at the portal's first block**, 26,160,102 (the canonical rollup's too), pinned per portal in
  `PORTAL_FIRST_BLOCKS`; a portal without an entry is refused, so a rollup switch cannot scan from a block that
  misses its fundings. Logs are read in 10,000-block windows (the free-plan ceiling of dRPC's L1 endpoint).
- **D14 P5-07 Option B.** The funding key is new and single-purpose, pinned in `MAINNET_DRIP_FUNDER` (`null` until
  the owner creates it, so every mainnet run refuses); `--cap` is required on every live mainnet run, has no
  default, and bounds every authenticated funding together, the new one included. Each send's balance check uses
  the gas settings the send then commits (simulated gas plus 10%, the predicted worst fee), so the two cannot
  disagree.

## Audit verdicts

Codex ran `gpt-6.1-sol` at high. Every finding was verified against the tree first; `lessons/phase-0.md` logs each
consult.

**Dual audit, Codex (fresh session): conditional approve, 3 High, 5 Medium.**

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | High: funding authenticates signer and amount, not the destination (plausible) | accepted: the Registry-anchored destination check, exact approval (flow step 1, 3). Rejected: a `live-intent` faucet scope (D7) |
| 2 | High: "account absent and no Fee Juice" skips every top-up (demonstrated) | accepted: claim-and-deploy or a carrierless claim, by initialization (flow step 4) |
| 3 | Medium: an emitter alone is weak resume evidence (plausible) | accepted: matched by recipient and derived secret hash; superseded by D7 |
| 4 | High: "either order works" stalls branch F (demonstrated) | accepted: C1 to sdk-1; 1.1 asserts the whole identity |
| 5 | Medium: drip and sponsor scopes requested on mainnet before a3 (demonstrated) | accepted (F6, 1.3) |
| 6 | Medium: one acceptance wrapper over placeholder and shell (plausible) | accepted (`App.vue`, 1.3 test, R3) |
| 7 | Medium: funding helper and unsponsored drip untested (demonstrated) | accepted: 2.1 integration test; the a3 cell on the profile bundle |
| 8 | Medium: M5(b) breaks "every surface"; toasts missing (demonstrated) | accepted: M5 asks wording, not coverage |

**Dual audit, Opus 5.5 Plan agent: conditional approve, 9 Medium, 6 Low.**

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Re-run pays twice while the account is unproven (demonstrated) | accepted: D7 |
| 2 | A deposit can land on a non-canonical rollup (plausible) | accepted: flow step 1 |
| 3 | The pinned bridge signer in a process with every dependency; the cap is only a constant (plausible) | accepted as an M7 option (recommended); hex key pair only on mainnet |
| 4 | "Add to wallet" shows bare names (demonstrated path) | accepted: an M5 row |
| 5 | A published, uninitialized instance is skipped (plausible) | accepted: flow step 5 |
| 6 | A hostile LI.FI rate has no reference price (unsupported: a compromised API) | known limit, sdk-1's domain; noted in Security |
| 7 | terms-1 coupling unsequenced; legal URLs could reach testnet; R3 before the gate | accepted: D1, the fold, both builds in 1.3, R3 |
| 8 | C1 lets this lane edit another lane's gate (demonstrated: `45f73f6`) | accepted: D4 |
| 9 | Pictures lack the mainnet copy (demonstrated) | accepted: the profile bundle, the dev server for the legal row |
| 10 | The funding leg is never run before mainnet (demonstrated) | accepted: 2.1 step 4 |
| 11 | a2 needs only sdk-1 a1 (verified) | accepted: D5 |
| 12 | No calibration for `fjPerTx` in branch F (verified, F13) | accepted: C2 |
| 13 | Workers Builds skips the verifier (verified) | accepted: D9 |
| 14 | Reuse sdk-1's `/lifi/` bundle; one cell (verified) | accepted: 1.4 |
| 15 | A rollup switch kills the page with claims pending (plausible) | known limit, runbook line |

Facts corrected after Opus: F2's line; F8's canary shape (`--fresh-selfpay`); F11 on terms-1's branch only; I2 and I4
added.

**Final pass, Codex (fresh session, with the ledger and the disputed points): conditional approve, 1 High, 3 Medium,
1 Low; all verified and accepted.** D3, D4, D9 and the claim shapes held.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | High: a crash after the claim and a re-run deposits again (demonstrated) | flow step 2 and 4: fund only a shortfall; a crash-after-claim checkpoint in the integration test |
| 2 | Medium: anyone can deposit under a copied secret hash (demonstrated, `FeeJuicePortal.sol:40-57`) | flow step 3: candidates from the pinned key's direct portal calls only; a minimum amount |
| 3 | Medium: a deposit mining between scan and send (plausible) | flow steps 3–4: the scan pinned to block B and the signer's nonce at B |
| 4 | Medium: the `/fuel/` fallback loses the public `bridge: null` proof (demonstrated) | 1.4: a public gas send runs on a `bridge: null` bundle either way |
| 5 | Low: the profile manifest keeps `feeAssetHandler` (demonstrated) | 1.4 drops it; 3.1 asserts the card is absent |

**Final pass, verification (same session resumed): conditional approve, 1 Medium, 1 Low; both accepted.** Step 5
claims only a recovered or new deposit; the integration test tops up while catalog work remains and ends on a re-run
that sends nothing. The five fixes above held.

**Final pass, second verification (same session): approve.** No remaining finding or regression.

**a2 implementation, Codex round 1 (`gpt-6.1-sol`, high): reject, 2 High, 1 Low; all verified and accepted.**

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | High: two runs deciding on one snapshot both fund the shortfall (plausible) | the funding's writes take consecutive nonces from the scanned block's, so the second collides |
| 2 | High: a malformed hex key reduces to a short or zero seed (demonstrated) | the hex shape is checked and a zero seed refused; no error echoes the value |
| 3 | Low: two comments claim more than the code does (verified) | reworded |

**a2 implementation, Opus 5.5 review beside round 1: 1 Medium, 5 Low, three test gaps.**

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: the keyed URLs reach a failure's text (verified: the node client's errors name the host) | the run's failure is printed with every keyed-run value replaced by its name |
| 2 | Low: a lagging log backend hides a funding from the cap and the claim (plausible) | the mainnet scan stops 12 blocks below the head; a funder transaction above it makes the run wait |
| 3 | Low: a funding barely above its claim's fee stalls every run once fees rise (plausible) | a funding must be twice its claim's fee |
| 4 | Low: an undeployed account holding Fee Juice from elsewhere is funded again (needs a deposit the run did not make) | known limit: the extra funding lands in the deployer's balance |
| 5 | Low: a send whose simulated gas passes the node's limit is clamped below its use (verified) | refused before proving |
| 6 | Low: the cap counts the fundings to one deployer (verified) | documented: a new deployer pair starts a new count |
| — | Untested: the null pin, the scan's windows, the scan wiring | unit tests for the first two; the integration test runs the margin's refusal |

## Delivery

One PR per arc against `main`, no stacking. a1 builds on `worktree-mainnet-1` (it carries this plan); every other arc:
`git fetch origin main && git checkout -b mainnet-1-a<n> origin/main && bun install`. Each arc merges `origin/main`
before its last gate run. `code_review: off`.

| Arc | Phases | Depends on | PR | Delivers |
|---|---|---|---|---|
| a1 | 1.1–1.6 | sdk-1 a3, a4; terms-1 a1; M1–M4, M6 | draft until the owner approves its pictures | ask8, ask10 (or part) |
| a2 | 2.1–2.2 | sdk-1 a1; M7 | ready | — |
| a3 | 3.1–3.2 + close-out | a1, a2, R2 read back; M5 | draft until the owner approves its pictures | ask9 |
| a4 | one commit | a1, P1-09 | ready | ask10 |

Parallelism: a2 shares only `apps/tools/package.json` with a1 and can run as soon as sdk-1 a1 merges, so R2 runs
while a1 waits for sdk-1; that removes a2 and R2 from the path to a3. If a2 is in flight when sdk-1 a2 starts, the
later of the two merges `origin/main` and moves the imports. If a4 is pending at the close-out, it becomes an
`owner-decision` issue whose trigger is the wall coming down.

## Post-implementation

The repository has no Post-implementation standard; these are the steps.

**While implementing.** Comments state invariants and reasons only, never a plan or a review. Log each meaningful
attempt in `lessons/phase-N.md`; `agent-worktree status mainnet-1 "<phase> green: <next>"` at each gate. Three
failures on one step stop the arc (five under `/loop`).

**Per arc, after its last phase gate:**
1. Codex: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with the
   arc's diff (`git diff origin/main...HEAD`), this plan, the ledger, the arc map ("arc n of 3 or 4; later arcs add
   X"), an adversarial ask, the lines on `.env` files and `~/.agents/orchy/`, and verbatim:
   - *"Report bugs and small, targeted improvements only. Do not propose speculative abstractions, extra
     configuration surface, new layers, or rewrites — the smallest change that fixes each real problem. If code
     works and is clear, leave it alone."*
   - *"Audit the comments for value per character. Flag any comment that narrates what the code visibly does,
     restates its line, references implementation plans / phases / reviews, or spends a paragraph where a sentence
     works — and flag places where a non-obvious invariant or constraint deserves a comment it doesn't have.
     Comments are permanent context every future reader, human or LLM, pays to re-read: they must be few, dense, and
     exact."*
2. Triage each finding (verify it; write its path and label), fix, commit, log, then `resume-codex.sh "" <followup>
   <codex-dir> high` with the fix diff until a round has no new material finding; at three rounds stop and report. A
   fix that adds persistent state, a lifecycle, a protocol, a recovery policy or a public contract is a plan change:
   stop. One same-family review (`Agent`, `model: "opus"`, `general-purpose`) runs beside round 1.
3. Gates once more on the final head; push; `gh pr create --base main` (`--draft` for a1 and a3) with what changed and
   why, the gates and results, the wall-clock before and after, the pictures, the quoted owner decisions,
   `Delivers askN`. Watch with bounded `gh pr checks <n>` polls; one rerun for a known flake.

**Close-out (a3's final commits).** Merge `origin/main` and read what changed in `index.md` and `lessons.md`. Write
`## Outcome` after the front matter (status, shipped with PR numbers, dispositions, `Known limits:`, `Open items:`,
the seeds retired). Promote general lessons to `lessons.md` (dedupe, retire, under 8 KiB). File open work: a bug or
gap → an issue with a `Record` link; a product call or outside wait → `owner-decision` / `blocked:external`; a
suspected weakness → a private draft advisory; unsupported conditions → a closed `known-limit` issue (the rollup
switch; the LI.FI rate). Delete `STATUS.md`; in its own commit `git mv implementations-plan/mainnet-1
implementations-plan/archive/mainnet-1`, repair links, add one line to `archive/index.md`. No `index.md` row.

**After the close-out merges** (`git fetch -q origin main && git cat-file -e
FETCH_HEAD:implementations-plan/archive/mainnet-1/plan.md`): `agent-worktree done mainnet-1 --merged`; relay a
refusal, never force.

Over the 350-line target: the three audit tables and the deploy flow are evidence the implementer needs.

## Seeds (draft; run none)

```
/goal Arc a<n> of implementations-plan/mainnet-1/plan.md is delivered: each phase of the arc marked ✓ in plan.md, backed by its validation gate reported passing in the transcript; LESSONS_FILE=implementations-plan/mainnet-1/lessons/phase-N.md printed per phase; the Codex fix loop on the arc's diff converged (a resumed pass with no new material finding, quoted); the arc's PR exists against main (gh pr view output), opened only after that; bun run lint and bun run test:all exit 0.
```

```
/loop 15m Drive arc a<n> of implementations-plan/mainnet-1/plan.md. Each firing: read plan.md and lessons/ (not the chat); take the next unticked phase; after each edit run bun run lint and the touched package's tests; at a phase's end run its gate exactly and tick it; at the arc's end run Post-implementation steps 1–3; never merge, deploy, sign or run a keyed command; never build a screen before its OWNER-ASKS entry is answered; stop after three failures on one step.
```

Recommended: `/goal`. Use exactly one per session.
